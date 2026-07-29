# Active-turn Reasoning History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display every reasoning item from the last externally owned running turn in chronological order without duplicating the newest item in the live overlay.

**Architecture:** Keep the server snapshot as the sole transcript authority. Remove the frontend-only external reasoning snapshot that hides persisted messages and replace its message filtering with an explicit boundary: external running threads expose reasoning only for their active turn; external idle threads expose none. The existing activity projection renders those messages and the existing `Worked for…` projection folds them after completion.

**Tech Stack:** TypeScript, Vue 3 Composition API, Vitest, pnpm, systemd user service

## Global Constraints

- Preserve every reasoning item in the last running turn in source order.
- New reasoning appends by stable source item ID and never replaces an older item.
- The running overlay must not repeat the latest visible reasoning text.
- Historical non-active reasoning remains hidden.
- Existing command, tool, collaboration, subagent, compaction, and completed-turn folding behavior remains unchanged.
- Do not include the four pre-existing upload lifecycle modifications in reasoning-history commits.
- At execution start, record `BASE_COMMIT=$(git rev-parse HEAD)` and create the
  isolated worktree from that exact commit.
- Do not change polling cadence, server protocol, session logs, or notification frequency.

---

### Task 1: Replace the single-label external reasoning overlay with authoritative transcript rows

**Files:**
- Modify: `src/composables/useDesktopState.test.ts`
- Modify: `src/composables/useDesktopState.ts`
- Delete: `src/composables/externalLiveSnapshot.test.ts`
- Delete: `src/composables/externalLiveSnapshot.ts`

**Interfaces:**
- Consumes: `UiMessage.messageType`, `UiMessage.turnId`, `activeTurnIdByThreadId`, `runtimeOwnershipByThreadId`, and `inProgressById`
- Produces: the existing `messages: ComputedRef<UiMessage[]>` with all active external reasoning messages visible exactly once
- Produces: the existing `selectedLiveOverlay: ComputedRef<UiLiveOverlay | null>` with a generic non-duplicating running label

- [ ] **Step 1: Rewrite the external reasoning behavior tests to state the required transcript contract**

In `src/composables/useDesktopState.test.ts`, replace the tests that expect
active reasoning to be hidden with the following behavior tests:

```ts
describe('external live reasoning transcript', () => {
  it('shows every active-turn reasoning item and keeps the live overlay generic', async () => {
    installTestWindow()
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.getThreadDetail.mockResolvedValue({
      ...externalDetail('turn-external'),
      messages: [
        {
          id: 'reasoning-1',
          role: 'assistant',
          text: '**Inspecting fixtures**',
          messageType: 'reasoning',
          turnId: 'turn-external',
        },
        {
          id: 'codegraph-1',
          role: 'system',
          text: 'Used codegraph integration',
          messageType: 'dynamicToolCall',
          turnId: 'turn-external',
        },
        {
          id: 'reasoning-2',
          role: 'assistant',
          text: '**Reading development-workflow.md**',
          messageType: 'reasoning',
          turnId: 'turn-external',
        },
        {
          id: 'compact-1',
          role: 'system',
          text: 'Context automatically compacting',
          messageType: 'contextCompaction',
          turnId: 'turn-external',
        },
      ],
    })

    const state = useDesktopState()
    state.primeSelectedThread('thread-external')
    await state.loadMessages('thread-external')

    expect(state.selectedLiveOverlay.value?.activityLabel).toBe('Thinking')
    expect(state.messages.value.map((message) => message.id)).toEqual([
      'reasoning-1',
      'codegraph-1',
      'reasoning-2',
      'compact-1',
    ])
  })

  it('preserves earlier reasoning and appends a new item across bounded snapshots', async () => {
    installTestWindow()
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.getThreadDetail
      .mockResolvedValueOnce({
        ...externalDetail('turn-external'),
        messages: [
          {
            id: 'reasoning-1',
            role: 'assistant',
            text: '**Inspecting fixtures**',
            messageType: 'reasoning',
            turnId: 'turn-external',
          },
          {
            id: 'agent-1',
            role: 'assistant',
            text: 'First output',
            messageType: 'agentMessage',
            turnId: 'turn-external',
          },
        ],
      })
      .mockResolvedValueOnce({
        ...externalDetail('turn-external'),
        messages: [{
          id: 'agent-2',
          role: 'assistant',
          text: 'Second output',
          messageType: 'agentMessage',
          turnId: 'turn-external',
        }],
      })
      .mockResolvedValueOnce({
        ...externalDetail('turn-external'),
        messages: [
          {
            id: 'reasoning-2',
            role: 'assistant',
            text: '**Continuing analysis**',
            messageType: 'reasoning',
            turnId: 'turn-external',
          },
          {
            id: 'agent-3',
            role: 'assistant',
            text: 'Third output',
            messageType: 'agentMessage',
            turnId: 'turn-external',
          },
        ],
      })

    const state = useDesktopState()
    state.primeSelectedThread('thread-external')
    await state.loadMessages('thread-external')
    await state.loadMessages('thread-external', { silent: true, force: true })
    await state.loadMessages('thread-external', { silent: true, force: true })

    expect(state.messages.value.map((message) => message.id)).toEqual([
      'reasoning-1',
      'agent-1',
      'agent-2',
      'reasoning-2',
      'agent-3',
    ])
    expect(state.messages.value.filter((message) => message.id === 'reasoning-1')).toHaveLength(1)
    expect(state.messages.value.filter((message) => message.id === 'reasoning-2')).toHaveLength(1)
  })

  it('does not expose reasoning when the external thread is no longer active', async () => {
    installTestWindow()
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.getThreadDetail.mockResolvedValue({
      ...idleDetail(),
      ownership: 'external',
      messages: [{
        id: 'historical-reasoning',
        role: 'assistant',
        text: 'Historical reasoning must stay hidden',
        messageType: 'reasoning',
        turnId: 'turn-completed',
      }],
    })

    const state = useDesktopState()
    state.primeSelectedThread('thread-external')
    await state.loadMessages('thread-external')

    expect(state.messages.value.map((message) => message.id)).not.toContain('historical-reasoning')
  })
})
```

Keep the existing test that proves final idle output lands before the overlay clears. Update the external polling test that currently expects `Reading development-workflow.md` so it expects `Thinking` and the `reasoning-live` message in `state.messages`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
pnpm exec vitest run src/composables/useDesktopState.test.ts \
  -t "external live reasoning transcript|refreshes external reasoning and agent output"
```

Expected: failures show that active reasoning IDs are missing from `state.messages` and the overlay still contains the newest reasoning label.

- [ ] **Step 3: Remove the obsolete external reasoning snapshot state**

In `src/composables/useDesktopState.ts`:

1. Remove this import:

```ts
import {
  mergeExternalReasoningSnapshots,
  readExternalReasoningSnapshot,
  type ExternalReasoningSnapshot,
} from './externalLiveSnapshot'
```

2. Remove `externalReasoningSnapshotByThreadId` and every prune, clear, reset, and reconciliation branch that only maintains it.
3. Remove `reconcileExternalReasoningSnapshot` and its call from `reconcileThreadDetailSnapshot`.
4. Make the live overlay independent from persisted reasoning:

```ts
const selectedLiveOverlay = computed<UiLiveOverlay | null>(() => {
  const threadId = selectedThreadId.value
  if (!threadId) return null

  const isInProgress = inProgressById.value[threadId] === true
  const activity = isInProgress ? turnActivityByThreadId.value[threadId] : undefined
  const reasoningText = isInProgress
    ? (liveReasoningTextByThreadId.value[threadId] ?? '').trim()
    : ''
  const liveErrorText = (turnErrorByThreadId.value[threadId]?.message ?? '').trim()
  let latestPersistedTurnErrorText = ''
  if (!isInProgress && liveErrorText) {
    const persistedMessages = persistedMessagesByThreadId.value[threadId] ?? []
    for (let index = persistedMessages.length - 1; index >= 0; index -= 1) {
      const message = persistedMessages[index]
      if (message.messageType !== 'turnError') continue
      latestPersistedTurnErrorText = normalizeMessageText(message.text)
      break
    }
  }
  const errorText =
    !isInProgress && liveErrorText && latestPersistedTurnErrorText === liveErrorText
      ? ''
      : liveErrorText

  if (!isInProgress && !activity && !reasoningText && !errorText) return null
  return {
    activityLabel: activity?.label || 'Thinking',
    activityDetails: activity?.details ?? [],
    reasoningText,
    errorText,
  }
})
```

Local notification-driven `reasoningText` remains unchanged. The removed external label was derived from already persisted messages and is the source of the duplication/overwrite behavior.

- [ ] **Step 4: Replace hidden-ID filtering with the active-turn boundary**

In the `messages` computed value, replace `hiddenReasoningIds` and
`visibleCombined` with:

```ts
const ownership = runtimeOwnershipByThreadId.value[threadId] ?? 'idle'
const isExternal = ownership === 'external'
const isRunning = inProgressById.value[threadId] === true
const activeTurnId = activeTurnIdByThreadId.value[threadId] ?? ''
const visibleCombined = isExternal
  ? combined.filter((message) => (
      message.messageType !== 'reasoning'
      || (isRunning && activeTurnId.length > 0 && message.turnId === activeTurnId)
    ))
  : combined
```

This is an allow rule for active external reasoning, not a list of messages to
hide. Stable message IDs continue to deduplicate consecutive snapshots through
the existing `mergeMessages` and `mergeLiveProjectionMessages` helpers.

- [ ] **Step 5: Delete the now-unused helper and its unit tests**

Delete:

```text
src/composables/externalLiveSnapshot.ts
src/composables/externalLiveSnapshot.test.ts
```

Run:

```bash
rg -n "ExternalReasoningSnapshot|readExternalReasoningSnapshot|mergeExternalReasoningSnapshots|hiddenMessageIds" src
```

Expected: no matches.

- [ ] **Step 6: Run focused GREEN verification**

Run:

```bash
pnpm exec vitest run \
  src/composables/useDesktopState.test.ts \
  src/components/content/threadConversationActivity.test.ts \
  src/server/codexAppServerBridge.liveSnapshot.test.ts \
  src/api/normalizers/v2.test.ts
```

Expected: all selected test files pass. The activity test continues to prove
that reasoning, CodeGraph/tool activity, subagents, and compaction keep their
relative order, and the server test continues to prove only active-turn
reasoning survives pruning.

- [ ] **Step 7: Verify the patch does not include upload lifecycle work**

Run:

```bash
git diff --check
git diff --name-only "$BASE_COMMIT"
```

Expected changed paths:

```text
src/composables/externalLiveSnapshot.test.ts
src/composables/externalLiveSnapshot.ts
src/composables/useDesktopState.test.ts
src/composables/useDesktopState.ts
```

- [ ] **Step 8: Commit the reasoning-history fix**

```bash
git add \
  src/composables/externalLiveSnapshot.test.ts \
  src/composables/externalLiveSnapshot.ts \
  src/composables/useDesktopState.test.ts \
  src/composables/useDesktopState.ts
git commit -m "fix(conversation): preserve active-turn reasoning history"
```

---

### Task 2: Verify, integrate, deploy, and perform live acceptance

**Files:**
- Modify: none
- Test: complete repository unit and production build suites

**Interfaces:**
- Consumes: Task 1 commit `fix(conversation): preserve active-turn reasoning history`
- Produces: deployed `codex-mobile-safe` service with preserved local upload lifecycle modifications

- [ ] **Step 1: Run complete automated verification in the isolated worktree**

Run:

```bash
pnpm test:unit
pnpm run build
node dist-cli/safe.js doctor
git diff --check
```

Expected:

- every Vitest file and test passes;
- frontend and CLI production builds succeed;
- `codex-mobile-safe doctor: ok`;
- `git diff --check` prints nothing.

- [ ] **Step 2: Request code review before integration**

Review the exact range:

```bash
git diff "$BASE_COMMIT"..HEAD
```

The review must explicitly confirm:

- no active-turn reasoning is hidden;
- historical external reasoning remains hidden;
- consecutive partial snapshots retain and deduplicate reasoning by item ID;
- the overlay does not repeat persisted external reasoning;
- no upload lifecycle diff is included.

Do not integrate with unresolved Critical or Important findings.

- [ ] **Step 3: Fast-forward the original dirty checkout**

From `/home/zonghangli/codex-mobile`, first verify the original state:

```bash
git status --short
git rev-parse HEAD
```

Expected HEAD: the recorded `BASE_COMMIT`.

Expected pre-existing modifications only:

```text
src/composables/useDesktopState.test.ts
src/composables/useDesktopState.ts
src/server/codexAppServerBridge.security.test.ts
src/server/codexAppServerBridge.ts
```

Fast-forward merge the isolated feature branch. Abort and report rather than
overwriting if Git reports an overlap with the existing modifications.

- [ ] **Step 4: Re-run focused tests in the merged dirty checkout**

Run:

```bash
pnpm exec vitest run \
  src/composables/useDesktopState.test.ts \
  src/components/content/threadConversationActivity.test.ts \
  src/server/codexAppServerBridge.liveSnapshot.test.ts \
  src/api/normalizers/v2.test.ts
```

Expected: all selected tests pass with both reasoning-history and upload
lifecycle changes present.

- [ ] **Step 5: Install and asynchronously restart the safe service**

Record the old PID:

```bash
systemctl --user show codex-mobile-safe.service -p MainPID -p ActiveState -p SubState
```

Build, install, and queue the restart:

```bash
pnpm run service:install
```

Expected: the command returns after printing
`Queued codex-mobile-safe service restart.`

- [ ] **Step 6: Verify service health and security invariants**

Run:

```bash
systemctl --user show codex-mobile-safe.service \
  -p MainPID -p ActiveState -p SubState
ss -ltnp 'sport = :5900'
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5900/
stat -c '%U %a %s %n' /home/zonghangli/.codex/codex-mobile-safe-password
tailscale serve status
```

Expected:

- PID changed;
- service is `active/running`;
- listener is only `127.0.0.1:5900`;
- HTTP status is `200`;
- password file remains owner `zonghangli`, mode `600`;
- Tailscale remains tailnet-only.

- [ ] **Step 7: Perform browser acceptance on a running external turn**

Open or refresh the running `跨 LAN 分布式架构` session and verify:

1. all existing reasoning rows from its active turn appear;
2. CodeGraph/tool, subagent, command, and compaction rows remain ordered;
3. when a new reasoning item arrives, it appears after the old reasoning rather
   than replacing it;
4. the bottom running indicator does not duplicate the newest reasoning;
5. after completion, internal activity folds under `Worked for…`;
6. completed historical turns do not regain reasoning.
