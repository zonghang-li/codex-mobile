# Collaboration Activity, Response Actions, and Activity Icons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore desktop-equivalent parent coordination rows, semantic activity icons, and completion-gated Copy/Fork actions on the mobile conversation page.

**Architecture:** Recover only allowlisted coordination call metadata from the bounded rollout cache, merge it into app-server turns without duplicating native subagent interactions, and normalize it as typed UI activity. Aggregate and render activity from semantic kinds rather than message text, while deriving response-action visibility from authoritative turn/runtime state.

**Tech Stack:** TypeScript 5.7, Vue 3, Vite, Tailwind CSS, Vitest, Express app-server bridge.

## Global Constraints

- Work in an isolated worktree created from commit `bfe791f`; do not include the six pre-existing modifications in `/home/zonghangli/codex-mobile`.
- Recover only call ID and an allowlisted semantic kind; never recover function arguments, prompts, child output, or thread messages.
- Preserve existing `spawn_agent` lifecycle chips and subagent transcript isolation.
- Render `Sent message to chat, wait threads` as normal turn activity and fold it under `Worked for…` only after completion.
- Hide Copy and Fork for the active response; uncertainty about which turn is active must hide both actions.
- Completed-response actions are Copy then Fork, icon-only, transparent, accessible, and at least 44 by 44 pixels on coarse pointers.
- Do not add Like or Dislike actions.
- Use the existing local Tabler-style icon system; do not add an icon package or raster assets.
- Preserve Tailnet-only exposure, password protection, and `approval-policy=never`.

## File Structure

- `src/server/codexAppServerBridge.ts`: parse, redact, order, deduplicate, and merge recovered coordination activity.
- `src/server/externalThreadRuntimeBridge.test.ts`: integration coverage for rollout recovery through both live-state and normal RPC responses.
- `src/types/codex.ts`: typed collaboration activity metadata shared by normalization and presentation.
- `src/api/normalizers/v2.ts`: convert recovered DTOs into presentation-safe `UiMessage` values.
- `src/api/normalizers/v2.test.ts`: normalization, label, and redaction assertions.
- `src/components/content/threadConversationActivity.ts`: aggregate adjacent collaboration rows and choose semantic icon kinds.
- `src/components/content/threadConversationActivity.test.ts`: aggregation, ordering, folding, and icon-precedence tests.
- `src/components/content/ThreadActivityIcon.vue`: one semantic icon renderer used in active and completed activity sections.
- `src/components/icons/IconTablerBook2.vue`: desktop-style read activity icon.
- `src/components/icons/IconTablerAffiliate.vue`: desktop-style integration/collaboration icon.
- `src/components/icons/IconTablerPhoto.vue`: image activity icon.
- `src/components/icons/IconTablerInfoCircle.vue`: neutral status activity icon.
- `src/components/content/ThreadConversation.vue`: render semantic icons and completion-gated response actions.
- `src/components/content/conversationRunFooter.wiring.test.ts`: structural regression coverage for toolbar order, labels, and touch targets.

---

### Task 1: Recover Safe Parent Coordination Activity

**Files:**
- Modify: `src/server/codexAppServerBridge.ts:3660-3815`
- Modify: `src/server/codexAppServerBridge.ts:4291-4375`
- Test: `src/server/externalThreadRuntimeBridge.test.ts:1010-1230`

**Interfaces:**
- Consumes: rollout `response_item.function_call` rows and app-server turn items.
- Produces: `SessionRecoveredCollaborationActivity` items with `type: 'collaborationActivity'`, `activityKind`, and `sourceCallId`.
- Produces: merged turn item order in which matched `subAgentActivity(kind='interacted')` items are replaced and omitted waits are inserted.

- [ ] **Step 1: Write failing RPC recovery and redaction tests**

Add a test that writes a rollout containing an assistant message, `send_message`, `wait_agent`, `list_agents`, an unknown tool, and another assistant message. Return one native interacted subagent item for the send call:

```ts
it('recovers allowlisted parent coordination activity without leaking payloads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-rpc-collaboration-'))
  disposers.push(() => {
    void rm(dir, { recursive: true, force: true })
  })
  const rolloutPath = join(dir, 'thread-collaboration.jsonl')
  await writeFile(rolloutPath, [
    JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-collaboration' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant' } }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'send_message',
        call_id: 'call-send',
        arguments: JSON.stringify({ target: '/root/reviewer', message: 'secret child prompt' }),
      },
    }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'wait_agent',
        call_id: 'call-wait',
        arguments: JSON.stringify({ timeout_ms: 30000 }),
      },
    }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'list_agents',
        call_id: 'call-list',
        arguments: '{}',
      },
    }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'send_message_to_thread',
        call_id: 'call-send-thread',
        arguments: JSON.stringify({ threadId: 'thread-child', message: 'private thread message' }),
      },
    }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'followup_task',
        call_id: 'call-followup',
        arguments: JSON.stringify({ target: '/root/reviewer', message: 'private follow-up' }),
      },
    }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'wait_threads',
        call_id: 'call-wait-threads',
        arguments: JSON.stringify({ targets: [{ threadId: 'thread-child' }] }),
      },
    }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'send_message',
        arguments: JSON.stringify({ message: 'missing call id' }),
      },
    }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'untrusted_private_tool',
        call_id: 'call-private',
        arguments: JSON.stringify({ token: 'must-not-appear' }),
      },
    }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant' } }),
    '',
  ].join('\n'))

  const middleware = createCodexBridgeMiddleware()
  const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
    appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
      rpc: (method: string, params: unknown) => Promise<unknown>
    }
  }
  vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
  vi.spyOn(shared.appServer, 'rpc').mockResolvedValue({
    thread: {
      id: 'thread-collaboration',
      path: rolloutPath,
      turns: [{
        id: 'turn-collaboration',
        status: 'completed',
        items: [
          { id: 'agent-1', type: 'agentMessage', text: 'first' },
          {
            id: 'call-send',
            type: 'subAgentActivity',
            agentThreadId: 'thread-reviewer',
            agentPath: '/root/reviewer',
            kind: 'interacted',
          },
          {
            id: 'call-spawn',
            type: 'subAgentActivity',
            agentThreadId: 'thread-started',
            agentPath: '/root/started',
            kind: 'started',
          },
          { id: 'agent-2', type: 'agentMessage', text: 'second' },
        ],
      }],
    },
  })
  vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({ state: 'idle' })
  const port = await listenWithMiddleware(middleware)

  const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      method: 'thread/read',
      params: { threadId: 'thread-collaboration', includeTurns: true },
    }),
  })
  const payload = await response.json() as {
    result?: { thread?: { turns?: Array<{ items?: Array<Record<string, unknown>> }> } }
  }
  const items = payload.result?.thread?.turns?.[0]?.items ?? []
  const serialized = JSON.stringify(items)

  expect(items.map((item) => item.id)).toEqual([
    'agent-1',
    'session-collab-call-send',
    'session-collab-call-wait',
    'session-collab-call-list',
    'session-collab-call-send-thread',
    'session-collab-call-followup',
    'session-collab-call-wait-threads',
    'call-spawn',
    'agent-2',
  ])
  expect(items.slice(1, 7)).toEqual([
    {
      id: 'session-collab-call-send',
      type: 'collaborationActivity',
      activityKind: 'sendMessage',
      sourceCallId: 'call-send',
    },
    {
      id: 'session-collab-call-wait',
      type: 'collaborationActivity',
      activityKind: 'waitThreads',
      sourceCallId: 'call-wait',
    },
    {
      id: 'session-collab-call-list',
      type: 'collaborationActivity',
      activityKind: 'listAgents',
      sourceCallId: 'call-list',
    },
    {
      id: 'session-collab-call-send-thread',
      type: 'collaborationActivity',
      activityKind: 'sendMessage',
      sourceCallId: 'call-send-thread',
    },
    {
      id: 'session-collab-call-followup',
      type: 'collaborationActivity',
      activityKind: 'sendMessage',
      sourceCallId: 'call-followup',
    },
    {
      id: 'session-collab-call-wait-threads',
      type: 'collaborationActivity',
      activityKind: 'waitThreads',
      sourceCallId: 'call-wait-threads',
    },
  ])
  expect(serialized).not.toContain('secret child prompt')
  expect(serialized).not.toContain('private thread message')
  expect(serialized).not.toContain('private follow-up')
  expect(serialized).not.toContain('thread-child')
  expect(serialized).not.toContain('missing call id')
  expect(serialized).not.toContain('must-not-appear')
  expect(serialized).not.toContain('thread-reviewer')
})
```

- [ ] **Step 2: Run the focused server test and verify failure**

Run:

```bash
pnpm vitest run src/server/externalThreadRuntimeBridge.test.ts -t "parent coordination|collaboration"
```

Expected: FAIL because no `collaborationActivity` slots are recovered and the native interaction is still returned.

- [ ] **Step 3: Add the bounded recovery types and allowlist**

Add these definitions next to `SessionRecoveredFileChangeItem`:

```ts
type SessionRecoveredCollaborationKind = 'sendMessage' | 'waitThreads' | 'listAgents'

type SessionRecoveredCollaborationActivity = {
  id: string
  type: 'collaborationActivity'
  activityKind: SessionRecoveredCollaborationKind
  sourceCallId: string
}

const SESSION_COLLABORATION_KIND_BY_FUNCTION = new Map<string, SessionRecoveredCollaborationKind>([
  ['send_message', 'sendMessage'],
  ['send_message_to_thread', 'sendMessage'],
  ['followup_task', 'sendMessage'],
  ['wait_agent', 'waitThreads'],
  ['wait_threads', 'waitThreads'],
  ['list_agents', 'listAgents'],
])

type SessionItemSlot =
  | { type: 'agentMessage' }
  | { type: 'commandExecution'; command: SessionRecoveredCommand }
  | { type: 'fileChange'; fileChange: SessionRecoveredFileChangeItem }
  | { type: 'collaborationActivity'; collaborationActivity: SessionRecoveredCollaborationActivity }
```

In `buildSessionItemOrder`, add this branch before `exec_command`; it intentionally does not parse `payload.arguments`:

```ts
if (payload.type === 'function_call') {
  const functionName = readNonEmptyString(payload.name)
  const activityKind = SESSION_COLLABORATION_KIND_BY_FUNCTION.get(functionName)
  if (activityKind) {
    const callId = readNonEmptyString(payload.call_id)
    if (!callId) continue
    slots.push({
      type: 'collaborationActivity',
      collaborationActivity: {
        id: `session-collab-${callId}`,
        type: 'collaborationActivity',
        activityKind,
        sourceCallId: callId,
      },
    })
    continue
  }
}
```

- [ ] **Step 4: Replace matched interaction items and insert omitted activity**

In `mergeSessionCommandsIntoTurns`, collect recovered coordination calls before merging:

```ts
const recoveredCollaborationByCallId = new Map(
  slots
    .filter((slot): slot is Extract<SessionItemSlot, { type: 'collaborationActivity' }> =>
      slot.type === 'collaborationActivity',
    )
    .map((slot) => [slot.collaborationActivity.sourceCallId, slot.collaborationActivity]),
)
```

Extend `appendRecoveredSlot` so every recovered coordination row is emitted in
the rollout slot order:

```ts
} else if (slot.type === 'collaborationActivity') {
  recovered = slot.collaborationActivity as unknown as Record<string, unknown>
}
```

At the start of the existing-item loop, suppress only the native
`kind='interacted'` row that corresponds to a recovered call. The recovered row
has already been placed from the authoritative rollout slots:

```ts
const itemId = readNonEmptyString(item.id)
if (item.type === 'subAgentActivity' && item.kind === 'interacted') {
  if (recoveredCollaborationByCallId.has(itemId)) continue
}
```

Change `alreadyHasRecoveredItems` to include `session-collab-`, so cached/RPC re-entry stays idempotent:

```ts
return id.startsWith('session-cmd-')
  || id.startsWith('session-fc-')
  || id.startsWith('session-collab-')
```

- [ ] **Step 5: Run server recovery tests**

Run:

```bash
pnpm vitest run src/server/externalThreadRuntimeBridge.test.ts -t "session command|parent coordination|collaboration"
```

Expected: PASS, including existing command-order and output-truncation cases.

- [ ] **Step 6: Commit safe recovery**

```bash
git add src/server/codexAppServerBridge.ts src/server/externalThreadRuntimeBridge.test.ts
git commit -m "fix: recover parent collaboration activity"
```

---

### Task 2: Normalize and Aggregate Collaboration Activity

**Files:**
- Modify: `src/types/codex.ts:130-165`
- Modify: `src/api/normalizers/v2.ts:513-565`
- Test: `src/api/normalizers/v2.test.ts:330-490`
- Modify: `src/components/content/threadConversationActivity.ts:1-225`
- Test: `src/components/content/threadConversationActivity.test.ts:1-230`

**Interfaces:**
- Consumes: recovered `{ type: 'collaborationActivity'; activityKind; sourceCallId }`.
- Produces: `UiActivityData.kind = 'collaboration'` with `collaborationKind`.
- Produces: one adjacent `ThreadActivitySegment(kind='event')` with ordered, unique labels and `iconKind: 'integration'`.

- [ ] **Step 1: Write failing normalization tests**

Add three recovered items to `v2.test.ts` and assert the exact labels and absence of raw sensitive payload:

```ts
it('normalizes recovered collaboration activity to safe desktop labels', () => {
  const messages = normalizeThreadMessagesV2(threadReadResponseWithContent([
    {
      id: 'session-collab-send',
      type: 'collaborationActivity',
      activityKind: 'sendMessage',
      sourceCallId: 'send',
    },
    {
      id: 'session-collab-wait',
      type: 'collaborationActivity',
      activityKind: 'waitThreads',
      sourceCallId: 'wait',
    },
    {
      id: 'session-collab-list',
      type: 'collaborationActivity',
      activityKind: 'listAgents',
      sourceCallId: 'list',
    },
  ]))

  expect(messages.map((message) => ({
    text: message.text,
    type: message.messageType,
    activity: message.activity,
  }))).toEqual([
    {
      text: 'Sent message to chat',
      type: 'collaborationActivity',
      activity: {
        kind: 'collaboration',
        label: 'Sent message to chat',
        collaborationKind: 'sendMessage',
      },
    },
    {
      text: 'Wait threads',
      type: 'collaborationActivity',
      activity: {
        kind: 'collaboration',
        label: 'Wait threads',
        collaborationKind: 'waitThreads',
      },
    },
    {
      text: 'Listed agents',
      type: 'collaborationActivity',
      activity: {
        kind: 'collaboration',
        label: 'Listed agents',
        collaborationKind: 'listAgents',
      },
    },
  ])
  expect(messages.every((message) => message.rawPayload === undefined)).toBe(true)
})
```

- [ ] **Step 2: Run normalizer test and verify failure**

Run:

```bash
pnpm vitest run src/api/normalizers/v2.test.ts -t "recovered collaboration"
```

Expected: FAIL because `toUiMessages` currently drops `collaborationActivity`.

- [ ] **Step 3: Add typed normalization**

Extend `UiActivityData`:

```ts
export type UiCollaborationActivityKind = 'sendMessage' | 'waitThreads' | 'listAgents'

export type UiActivityData = {
  kind: 'command' | 'fileChange' | 'tool' | 'subAgent' | 'image' | 'search' | 'status' | 'plan' | 'collaboration'
  label: string
  status?: string
  agentThreadId?: string
  agentPath?: string
  subAgentKind?: UiSubAgentActivityKind
  collabAgent?: UiCollabAgentActivity
  collaborationKind?: UiCollaborationActivityKind
}
```

Add a safe label helper and branch at the start of `toUiMessages`:

```ts
function normalizeRecoveredCollaborationKind(value: string): {
  kind: UiCollaborationActivityKind
  label: string
} | null {
  if (value === 'sendMessage') return { kind: value, label: 'Sent message to chat' }
  if (value === 'waitThreads') return { kind: value, label: 'Wait threads' }
  if (value === 'listAgents') return { kind: value, label: 'Listed agents' }
  return null
}

if (rawType === 'collaborationActivity') {
  const normalized = normalizeRecoveredCollaborationKind(readString(rawItem.activityKind))
  if (!normalized) return []
  return [{
    id: item.id,
    role: 'system',
    text: normalized.label,
    messageType: 'collaborationActivity',
    activity: {
      kind: 'collaboration',
      label: normalized.label,
      collaborationKind: normalized.kind,
    },
  }]
}
```

Import `UiCollaborationActivityKind` from `../../types/codex`.

- [ ] **Step 4: Run normalizer tests**

Run:

```bash
pnpm vitest run src/api/normalizers/v2.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing aggregation and completed-folding tests**

Add `collaborationActivity` to the activity-type table and add:

```ts
it('aggregates adjacent unique parent collaboration actions in desktop order', () => {
  const collaboration = (
    id: string,
    text: string,
    collaborationKind: 'sendMessage' | 'waitThreads' | 'listAgents',
  ): UiMessage => ({
    ...message(id, 'system', text, 'collaborationActivity'),
    activity: {
      kind: 'collaboration',
      label: text,
      collaborationKind,
    },
  })
  const messages = [
    collaboration('send-1', 'Sent message to chat', 'sendMessage'),
    collaboration('wait-1', 'Wait threads', 'waitThreads'),
    collaboration('wait-2', 'Wait threads', 'waitThreads'),
  ]

  expect(buildThreadActivitySegments(messages)).toEqual([{
    kind: 'event',
    id: 'wait-2',
    label: 'Sent message to chat, wait threads',
    iconKind: 'integration',
    sourceMessageIds: ['send-1', 'wait-1', 'wait-2'],
  }])
})

it('keeps collaboration activity in the completed Worked for fold', () => {
  const messages: UiMessage[] = [
    {
      ...message('send', 'system', 'Sent message to chat', 'collaborationActivity'),
      activity: {
        kind: 'collaboration',
        label: 'Sent message to chat',
        collaborationKind: 'sendMessage',
      },
    },
    message('worked', 'system', 'Worked for 1m 25s', 'worked'),
  ]

  expect(getHiddenCompletedActivityMessageIds(messages)).toEqual(new Set(['send']))
  expect(getTurnActivitySegmentsForWorked(messages, 1)).toEqual([
    expect.objectContaining({
      kind: 'event',
      label: 'Sent message to chat',
      iconKind: 'integration',
    }),
  ])
})
```

Import `getTurnActivitySegmentsForWorked` in the test.

- [ ] **Step 6: Run aggregation tests and verify failure**

Run:

```bash
pnpm vitest run src/components/content/threadConversationActivity.test.ts -t "collaboration"
```

Expected: FAIL because the message type is not activity and adjacent rows are not aggregated.

- [ ] **Step 7: Implement adjacent collaboration aggregation**

Add `'collaborationActivity'` to `TURN_ACTIVITY_MESSAGE_TYPES`. Extend the segment and icon types:

```ts
export type ThreadActivityIconKind =
  | 'book'
  | 'search'
  | 'edit'
  | 'terminal'
  | 'integration'
  | 'image'
  | 'agent'
  | 'status'

// Add to both reasoning and event variants:
iconKind: ThreadActivityIconKind
```

Add these helpers:

```ts
function isCollaborationActivity(message: UiMessage): boolean {
  return message.messageType === 'collaborationActivity'
    && message.activity?.kind === 'collaboration'
}

function collaborationLabelPart(message: UiMessage): string {
  if (message.activity?.collaborationKind === 'sendMessage') return 'sent message to chat'
  if (message.activity?.collaborationKind === 'waitThreads') return 'wait threads'
  if (message.activity?.collaborationKind === 'listAgents') return 'listed agents'
  return ''
}

function capitalizeFirst(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value
}
```

Before the subagent branch in `buildThreadActivitySegments`, consume the adjacent collaboration cluster:

```ts
if (isCollaborationActivity(message)) {
  const sourceMessageIds: string[] = []
  const parts: string[] = []
  const seenParts = new Set<string>()
  while (index < messages.length && isCollaborationActivity(messages[index])) {
    const collaborationMessage = messages[index]
    sourceMessageIds.push(collaborationMessage.id)
    const part = collaborationLabelPart(collaborationMessage)
    if (part && !seenParts.has(part)) {
      seenParts.add(part)
      parts.push(part)
    }
    index += 1
  }
  if (parts.length > 0) {
    segments.push({
      kind: 'event',
      id: sourceMessageIds.at(-1) ?? '',
      label: capitalizeFirst(parts.join(', ')),
      iconKind: 'integration',
      sourceMessageIds,
    })
  }
  continue
}
```

Give reasoning and ordinary event segments the semantic icon returned by the Task 3 helper contract:

```ts
iconKind: activityMessageIconKind(message)
```

Define the helper in the same file:

```ts
function activityMessageIconKind(message: UiMessage): ThreadActivityIconKind {
  const type = message.messageType ?? ''
  if (type === 'webSearch') return 'search'
  if (type === 'imageView' || type === 'imageGeneration') return 'image'
  if (type === 'mcpToolCall' || type === 'dynamicToolCall' || type === 'collaborationActivity') {
    return 'integration'
  }
  if (type === 'subAgentActivity' || type === 'collabAgentToolCall') return 'agent'
  if (type === 'contextCompaction' || type === 'reasoning' || type === 'plan') return 'status'
  return 'status'
}
```

Task 3 will connect these semantic values to the visual components.

Update the existing reasoning-segment expectation so its complete shape remains
typed:

```ts
{
  kind: 'reasoning',
  id: 'reasoning-1',
  label: 'Closing the final review',
  iconKind: 'status',
  sourceMessageIds: ['reasoning-1'],
}
```

- [ ] **Step 8: Run normalization and aggregation tests**

Run:

```bash
pnpm vitest run src/api/normalizers/v2.test.ts src/components/content/threadConversationActivity.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit the typed activity pipeline**

```bash
git add src/types/codex.ts src/api/normalizers/v2.ts src/api/normalizers/v2.test.ts src/components/content/threadConversationActivity.ts src/components/content/threadConversationActivity.test.ts
git commit -m "feat: present parent collaboration activity"
```

---

### Task 3: Render Desktop-Semantic Activity Icons

**Files:**
- Create: `src/components/icons/IconTablerBook2.vue`
- Create: `src/components/icons/IconTablerAffiliate.vue`
- Create: `src/components/icons/IconTablerPhoto.vue`
- Create: `src/components/icons/IconTablerInfoCircle.vue`
- Create: `src/components/content/ThreadActivityIcon.vue`
- Modify: `src/components/content/threadConversationActivity.ts:30-130`
- Modify: `src/components/content/ThreadConversation.vue:45-80`
- Modify: `src/components/content/ThreadConversation.vue:455-500`
- Modify: `src/components/content/ThreadConversation.vue:1215-1235`
- Test: `src/components/content/threadConversationActivity.test.ts`
- Test: `src/components/content/conversationRunFooter.wiring.test.ts`

**Interfaces:**
- Consumes: `ThreadActivityIconKind`.
- Produces: `<ThreadActivityIcon :kind="...">` with a consistent 24-pixel view box, `currentColor`, and no interactive behavior.
- Produces: `book` for Read files, `integration` for CodeGraph/MCP/dynamic/collaboration rows, `image` for image rows, and `status` for compaction/neutral state.

- [ ] **Step 1: Write failing semantic-icon tests**

Update the existing read test and add integration/image/status assertions:

```ts
expect(buildThreadActivitySegments([command('read', 'read')])).toEqual([
  expect.objectContaining({ iconKind: 'book' }),
])
expect(buildThreadActivitySegments([
  message('codegraph', 'system', 'Used codegraph integration', 'dynamicToolCall'),
])).toEqual([
  expect.objectContaining({ iconKind: 'integration' }),
])
expect(buildThreadActivitySegments([
  message('image', 'assistant', 'Viewed an image', 'imageView'),
])).toEqual([
  expect.objectContaining({ iconKind: 'image' }),
])
expect(buildThreadActivitySegments([
  message('compact', 'system', 'Context automatically compacting', 'contextCompaction'),
])).toEqual([
  expect.objectContaining({ iconKind: 'status' }),
])
```

Add source-wiring assertions:

```ts
it('renders semantic activity through the shared desktop-style icon component', () => {
  expect(conversationSource).toContain("import ThreadActivityIcon from './ThreadActivityIcon.vue'")
  expect(conversationSource).toContain('<ThreadActivityIcon')
  expect(conversationSource).toContain(':kind="activitySegmentIconKind(')
  expect(conversationSource).not.toContain(
    'message.messageType === \\'imageView\\' || message.messageType === \\'imageGeneration\\'',
  )
})
```

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
pnpm vitest run src/components/content/threadConversationActivity.test.ts src/components/content/conversationRunFooter.wiring.test.ts -t "icon|read-only"
```

Expected: FAIL because reads still use `search` and the shared icon component does not exist.

- [ ] **Step 3: Create the four local Tabler icon components**

Create `IconTablerBook2.vue`:

```vue
<template>
  <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="2"
      d="M3 19a9 9 0 0 1 9 0a9 9 0 0 1 9 0M3 6a9 9 0 0 1 9 0a9 9 0 0 1 9 0M3 6v13M12 6v13M21 6v13"
    />
  </svg>
</template>
```

Create `IconTablerAffiliate.vue`:

```vue
<template>
  <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="2"
      d="M5 5a2 2 0 1 0 0 .01M19 5a2 2 0 1 0 0 .01M5 19a2 2 0 1 0 0 .01M19 19a2 2 0 1 0 0 .01M12 12a2 2 0 1 0 0 .01M6.5 6.5l4 4M17.5 6.5l-4 4M6.5 17.5l4-4M17.5 17.5l-4-4"
    />
  </svg>
</template>
```

Create `IconTablerPhoto.vue`:

```vue
<template>
  <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="2"
      d="M15 8h.01M6 3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3M3 16l5-5a2.1 2.1 0 0 1 3 0l5 5M14 14l1-1a2.1 2.1 0 0 1 3 0l3 3"
    />
  </svg>
</template>
```

Create `IconTablerInfoCircle.vue`:

```vue
<template>
  <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="2"
      d="M12 9h.01M11 12h1v4h1M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18"
    />
  </svg>
</template>
```

These are single-path forms in the same local Tabler style as
`IconTablerCopy.vue`; retain `currentColor`, line caps, and line joins exactly.

- [ ] **Step 4: Create the semantic icon renderer**

Create `ThreadActivityIcon.vue`:

```vue
<template>
  <IconTablerBook2 v-if="kind === 'book'" class="icon-svg codex-activity-icon" />
  <IconTablerSearch v-else-if="kind === 'search'" class="icon-svg codex-activity-icon" />
  <IconTablerFilePencil v-else-if="kind === 'edit'" class="icon-svg codex-activity-icon" />
  <IconTablerTerminal v-else-if="kind === 'terminal'" class="icon-svg codex-activity-icon" />
  <IconTablerAffiliate v-else-if="kind === 'integration' || kind === 'agent'" class="icon-svg codex-activity-icon" />
  <IconTablerPhoto v-else-if="kind === 'image'" class="icon-svg codex-activity-icon" />
  <IconTablerInfoCircle v-else class="icon-svg codex-activity-icon" />
</template>

<script setup lang="ts">
import type { ThreadActivityIconKind } from './threadConversationActivity'
import IconTablerAffiliate from '../icons/IconTablerAffiliate.vue'
import IconTablerBook2 from '../icons/IconTablerBook2.vue'
import IconTablerFilePencil from '../icons/IconTablerFilePencil.vue'
import IconTablerInfoCircle from '../icons/IconTablerInfoCircle.vue'
import IconTablerPhoto from '../icons/IconTablerPhoto.vue'
import IconTablerSearch from '../icons/IconTablerSearch.vue'
import IconTablerTerminal from '../icons/IconTablerTerminal.vue'

defineProps<{ kind: ThreadActivityIconKind }>()
</script>
```

- [ ] **Step 5: Complete semantic icon selection**

In `threadConversationActivity.ts`, make action-summary precedence exact:

```ts
function actionSummaryIconKind(state: ActionSummaryState): ThreadActivityIconKind {
  if (state.editedFileCount > 0) return 'edit'
  if (state.readCount > 0 || state.listCount > 0) return 'book'
  if (state.searchCount > 0) return 'search'
  return 'terminal'
}
```

Implement event selection:

```ts
function activityMessageIconKind(message: UiMessage): ThreadActivityIconKind {
  const type = message.messageType ?? ''
  if (type === 'webSearch') return 'search'
  if (type === 'imageView' || type === 'imageGeneration') return 'image'
  if (type === 'mcpToolCall' || type === 'dynamicToolCall' || type === 'collaborationActivity') {
    return 'integration'
  }
  if (type === 'subAgentActivity' || type === 'collabAgentToolCall') return 'agent'
  if (type === 'contextCompaction' || type === 'reasoning' || type === 'plan') return 'status'
  return 'status'
}
```

- [ ] **Step 6: Replace duplicated icon branches in both active and Worked sections**

Import `ThreadActivityIcon`. Replace each activity icon `v-if` chain with:

```vue
<ThreadActivityIcon :kind="activitySegmentIconKind(readActivitySegment(message))" />
```

and in completed activity:

```vue
<ThreadActivityIcon :kind="activitySegmentIconKind(segment)" />
```

For the legacy direct activity row, use:

```vue
<ThreadActivityIcon :kind="activityIconKind(message)" />
```

and replace its old three-value helper with:

```ts
function activityIconKind(message: UiMessage): ThreadActivityIconKind {
  const segment = readActivitySegment(message)
  if (segment && segment.kind !== 'subAgent') return segment.iconKind
  return 'status'
}
```

Change the helper to preserve the segment semantic kind:

```ts
function activitySegmentIconKind(segment: ThreadActivitySegment | null): ThreadActivityIconKind {
  if (!segment || segment.kind === 'subAgent') return 'status'
  return segment.iconKind
}
```

Keep subagent chips non-clickable and retain their existing transparent, subtle presentation.

- [ ] **Step 7: Run activity and wiring tests**

Run:

```bash
pnpm vitest run src/components/content/threadConversationActivity.test.ts src/components/content/conversationRunFooter.wiring.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit semantic icons**

```bash
git add src/components/icons/IconTablerBook2.vue src/components/icons/IconTablerAffiliate.vue src/components/icons/IconTablerPhoto.vue src/components/icons/IconTablerInfoCircle.vue src/components/content/ThreadActivityIcon.vue src/components/content/threadConversationActivity.ts src/components/content/threadConversationActivity.test.ts src/components/content/ThreadConversation.vue src/components/content/conversationRunFooter.wiring.test.ts
git commit -m "fix: align mobile activity icons with desktop"
```

---

### Task 4: Gate and Restyle Completed Response Actions

**Files:**
- Modify: `src/components/content/ThreadConversation.vue:875-925`
- Modify: `src/components/content/ThreadConversation.vue:2285-2320`
- Modify: `src/components/content/ThreadConversation.vue:5215-5285`
- Test: `src/components/content/conversationRunFooter.wiring.test.ts:105-155`
- Test: `src/components/content/conversationTurnPresentation.test.ts`

**Interfaces:**
- Consumes: `message.turnId`, `props.activeTurnId`, and `isLiveTurnRuntime`.
- Produces: `isResponseActionSuppressed(message): boolean`.
- Produces: completed-response toolbar ordered Copy then Fork, with no visible labels.

- [ ] **Step 1: Write failing action-visibility unit tests**

Export a pure helper from `conversationTurnPresentation.ts`:

```ts
export type ResponseActionVisibilityInput = {
  messageTurnId: string
  activeTurnId: string
  runtimeActive: boolean
}

export function suppressResponseActions(input: ResponseActionVisibilityInput): boolean
```

Add tests:

```ts
describe('response action visibility', () => {
  it('suppresses the authoritative active turn', () => {
    expect(suppressResponseActions({
      messageTurnId: 'turn-active',
      activeTurnId: 'turn-active',
      runtimeActive: true,
    })).toBe(true)
    expect(suppressResponseActions({
      messageTurnId: 'turn-complete',
      activeTurnId: 'turn-active',
      runtimeActive: true,
    })).toBe(false)
  })

  it('fails closed while runtime is active and active turn identity is unknown', () => {
    expect(suppressResponseActions({
      messageTurnId: 'turn-unknown',
      activeTurnId: '',
      runtimeActive: true,
    })).toBe(true)
    expect(suppressResponseActions({
      messageTurnId: 'turn-complete',
      activeTurnId: '',
      runtimeActive: false,
    })).toBe(false)
  })
})
```

- [ ] **Step 2: Update failing toolbar wiring expectations**

Change the structural test to require Copy before Fork and no visible action labels:

```ts
expect(copyIndex).toBeGreaterThan(toolbarIndex)
expect(forkIndex).toBeGreaterThan(copyIndex)
expect(conversationSource).not.toContain('class="message-copy-label"')
expect(conversationSource).not.toContain('class="message-fork-label"')
expect(conversationSource).toContain("aria-label=\"Fork thread from this response\"")
expect(conversationSource).toContain("copiedResponseAnchorId === message.id ? 'Response copied' : 'Copy response'")
```

Require transparent controls and coarse-pointer targets:

```ts
expect(conversationSource).toMatch(
  /\.message-copy-button,[\s\S]*\.message-fork-button\s*\{[\s\S]*@apply [^;]*bg-transparent[^;]*border-0/u,
)
expect(conversationSource).toMatch(
  /@media \(hover: none\), \(pointer: coarse\) \{[\s\S]*\.message-fork-button,[\s\S]*\.message-copy-button[\s\S]*min-h-11[^;]*min-w-11/u,
)
```

- [ ] **Step 3: Run focused tests and verify failure**

Run:

```bash
pnpm vitest run src/components/content/conversationTurnPresentation.test.ts src/components/content/conversationRunFooter.wiring.test.ts -t "response action|Fork|Copy"
```

Expected: FAIL because the helper does not exist, Fork precedes Copy, labels remain, and active turns are not checked.

- [ ] **Step 4: Implement fail-closed response visibility**

Add the pure helper:

```ts
export function suppressResponseActions(input: ResponseActionVisibilityInput): boolean {
  const activeTurnId = input.activeTurnId.trim()
  if (activeTurnId) return input.messageTurnId.trim() === activeTurnId
  return input.runtimeActive
}
```

Import it into `ThreadConversation.vue` and add:

```ts
function isResponseActionSuppressed(message: UiMessage): boolean {
  return suppressResponseActions({
    messageTurnId: message.turnId ?? '',
    activeTurnId: props.activeTurnId ?? '',
    runtimeActive: isLiveTurnRuntime.value,
  })
}

function showCopyResponseButton(message: UiMessage): boolean {
  return !isResponseActionSuppressed(message)
    && typeof copyableResponseContentByAnchorId.value[message.id] === 'string'
}

function showForkResponseButton(message: UiMessage): boolean {
  return !isResponseActionSuppressed(message)
    && typeof forkableTurnIndexByAnchorId.value[message.id] === 'number'
}
```

- [ ] **Step 5: Render completed actions in desktop order**

Include all three possible actions in the toolbar guard:

```vue
v-if="showEditMessageButton(message) || showCopyResponseButton(message) || showForkResponseButton(message)"
```

Move Copy before Fork and remove both label spans:

```vue
<button
  v-if="showCopyResponseButton(message)"
  type="button"
  class="message-copy-button"
  :data-copied="copiedResponseAnchorId === message.id"
  :aria-label="copiedResponseAnchorId === message.id ? 'Response copied' : 'Copy response'"
  :title="copiedResponseAnchorId === message.id ? 'Response copied' : 'Copy response'"
  @click="copyResponse(message.id)"
>
  <IconTablerCopy class="icon-svg message-copy-icon" />
</button>
<button
  v-if="showForkResponseButton(message)"
  type="button"
  class="message-fork-button"
  aria-label="Fork thread from this response"
  title="Fork thread from this response"
  @click="forkResponse(message.id)"
>
  <IconTablerGitFork class="icon-svg message-fork-icon" />
</button>
```

Keep edit-message behavior separate for user messages.

- [ ] **Step 6: Replace pill styling with transparent icon controls**

Use:

```css
.message-toolbar {
  @apply mt-1 self-start flex items-center gap-0.5 opacity-[0.01] transition-opacity duration-200;
}

.message-copy-button,
.message-fork-button {
  @apply inline-flex h-7 w-7 items-center justify-center rounded-md border-0 bg-transparent p-0 text-slate-500 transition hover:bg-slate-200/60 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60;
}

.message-copy-button[data-copied='true'] {
  @apply bg-transparent text-emerald-500;
}

.message-copy-icon,
.message-fork-icon {
  @apply h-4 w-4;
}

@media (hover: none), (pointer: coarse) {
  .message-toolbar {
    @apply opacity-100;
  }

  .message-fork-button,
  .message-copy-button,
  .message-edit-button {
    @apply min-h-11 min-w-11;
  }
}
```

Do not add Like/Dislike markup.

- [ ] **Step 7: Run action tests**

Run:

```bash
pnpm vitest run src/components/content/conversationTurnPresentation.test.ts src/components/content/conversationRunFooter.wiring.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit response actions**

```bash
git add src/components/content/conversationTurnPresentation.ts src/components/content/conversationTurnPresentation.test.ts src/components/content/ThreadConversation.vue src/components/content/conversationRunFooter.wiring.test.ts
git commit -m "fix: show response actions only after completion"
```

---

### Task 5: Full Verification and Tailnet Deployment

**Files:**
- Verify: all files changed in Tasks 1-4.
- Modify only when a failing verification identifies a concrete regression.

**Interfaces:**
- Consumes: the four independently passing task commits.
- Produces: one deployable branch with verified unit, type, build, doctor, service, and endpoint behavior.

- [ ] **Step 1: Review the complete diff for scope and payload safety**

Run:

```bash
git diff --check bfe791f...HEAD
git diff --stat bfe791f...HEAD
git diff bfe791f...HEAD -- src/server/codexAppServerBridge.ts src/api/normalizers/v2.ts src/components/content/threadConversationActivity.ts src/components/content/ThreadConversation.vue
```

Expected: no whitespace errors; no parsing or copying of collaboration call arguments/output; no Like/Dislike markup.

- [ ] **Step 2: Run focused regression tests**

Run:

```bash
pnpm vitest run src/server/externalThreadRuntimeBridge.test.ts src/api/normalizers/v2.test.ts src/components/content/threadConversationActivity.test.ts src/components/content/conversationTurnPresentation.test.ts src/components/content/conversationRunFooter.wiring.test.ts
```

Expected: all focused files PASS.

- [ ] **Step 3: Run the full unit suite**

Run:

```bash
pnpm test:unit
```

Expected: all test files PASS with zero failed tests.

- [ ] **Step 4: Run type checking and production builds**

Run:

```bash
pnpm run build
```

Expected: `vue-tsc --noEmit`, Vite production build, and CLI `tsup` build all succeed.

- [ ] **Step 5: Run CLI safety diagnostics**

Run:

```bash
codex-mobile-safe doctor
```

Expected: doctor reports all required checks passing.

- [ ] **Step 6: Install and restart the Tailnet-only service**

Run:

```bash
pnpm run install:local
pnpm run network:tailnet
pnpm run network:status
```

Expected: the service is active, listens only on `127.0.0.1:5900`, publishes through the existing Tailscale URL, remains password protected, and reports `approval-policy=never`.

- [ ] **Step 7: Verify local and Tailnet health**

Run:

```bash
curl -fsS http://127.0.0.1:5900/codex-api/health
curl -fsS https://l008105.tailbffdfe.ts.net/codex-api/health
```

Expected: both endpoints return healthy JSON; no LAN listener or public tunnel is opened.

- [ ] **Step 8: Manually compare the requested states**

In the mobile browser, verify:

1. An active desktop task shows no Copy or Fork action.
2. Its completed response shows icon-only Copy then Fork beneath the final text.
3. A turn with parent coordination shows `Sent message to chat, wait threads`.
4. After completion, that row moves under the collapsed `Worked for…` detail.
5. Read files uses the book icon.
6. CodeGraph integration uses the connected-nodes icon.
7. Subagent chips remain status-only, transparent, and non-clickable.

- [ ] **Step 9: Confirm the verified branch is clean**

```bash
git status --short
git log -4 --oneline
```

Expected: no uncommitted files; the latest four commits are the scoped Task
1-4 commits.
