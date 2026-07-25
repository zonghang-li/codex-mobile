# Subagent Activity Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render Codex subagent activity as compact, neutral, non-interactive status pills while keeping child-agent output out of the parent transcript and updating lifecycle state without a manual refresh.

**Architecture:** Preserve bounded subagent lifecycle metadata during app-server normalization, then aggregate adjacent `subAgentActivity` and `collabAgentToolCall` items by child thread ID before rendering. The conversation component receives only presentation-safe agent names and lifecycle states; child result messages remain diagnostic payload only. Item-level app-server notifications trigger a debounced authoritative thread refresh so the aggregation stays current.

**Tech Stack:** Vue 3, TypeScript 5.7, Vitest, Tailwind CSS 4, Codex app-server v2 protocol.

## Global Constraints

- Follow the approved design in `docs/superpowers/specs/2026-07-26-subagent-activity-isolation-design.md`.
- Do not render `agentsStates[*].message`, child-thread assistant text, raw JSON, or child tool output in the parent transcript.
- Subagent pills are status-only: no click handler, no keyboard focus, no disclosure affordance, and no child-thread navigation.
- Use a neutral existing icon component and existing typography/tokens; do not introduce per-agent colors or handmade SVG assets.
- Preserve the unrelated dirty changes already present in `src/App.vue`, `src/composables/useDesktopState.ts`, bridge files, and their tests.
- Add a failing focused test before each production change.

---

## Task 1: Preserve bounded subagent lifecycle metadata

**Files:**

- Modify: `src/types/codex.ts`
- Modify: `src/api/normalizers/v2.ts`
- Test: `src/api/normalizers/v2.test.ts`

**Interfaces**

- Consumes: app-server `subAgentActivity` and `collabAgentToolCall` thread items.
- Produces: presentation-safe `UiActivityData` metadata with stable child-thread identity and lifecycle state.

- [ ] **Step 1: Add RED normalizer coverage**

Extend the existing “newer Codex desktop activity items” fixture with `agentThreadId`, and add a collab fixture whose `agentsStates` contains a child result message:

```ts
{
  type: 'subAgentActivity',
  id: 'subagent-updated',
  agentThreadId: 'thread-docs',
  agentPath: '/root/updated_docs_coverage_review',
  kind: 'interacted',
}
```

```ts
{
  type: 'collabAgentToolCall',
  id: 'agent-wait',
  tool: 'wait',
  status: 'completed',
  senderThreadId: 'thread-parent',
  receiverThreadIds: ['thread-docs'],
  agentsStates: {
    'thread-docs': {
      status: 'completed',
      message: 'private child result that must not render',
    },
  },
}
```

Assert that `agentThreadId`, `subAgentKind`, receiver IDs, and bounded agent statuses survive normalization, while no normalized `text`, `label`, or lifecycle metadata contains the child result message.

- [ ] **Step 2: Run the focused test and confirm failure**

Run:

```shell
pnpm test:unit -- src/api/normalizers/v2.test.ts
```

Expected: failure because `UiActivityData` does not yet expose identity/kind/collab lifecycle metadata.

- [ ] **Step 3: Add typed lifecycle metadata**

Add these presentation-safe types:

```ts
export type UiSubAgentActivityKind = 'started' | 'interacted' | 'interrupted'

export type UiCollabAgentStatus =
  | 'pendingInit'
  | 'running'
  | 'interrupted'
  | 'completed'
  | 'errored'
  | 'shutdown'
  | 'notFound'

export type UiCollabAgentActivity = {
  tool: string
  status?: string
  receiverThreadIds: string[]
  agentsStates: Record<string, UiCollabAgentStatus>
}
```

Extend `UiActivityData` with:

```ts
agentThreadId?: string
agentPath?: string
subAgentKind?: UiSubAgentActivityKind
collabAgent?: UiCollabAgentActivity
```

Do not add the collab `message` field to the UI types.

- [ ] **Step 4: Normalize bounded metadata**

Update `normalizeSubAgentActivity` to preserve `agentThreadId` and the original protocol kind. Add a helper that:

1. accepts only string receiver IDs;
2. accepts only the known status strings above;
3. builds `Record<string, UiCollabAgentStatus>`;
4. deliberately ignores every `message` property.

Normalize `collabAgentToolCall` as `activity.kind === 'subAgent'` with the existing human label and the new `collabAgent` object.

- [ ] **Step 5: Run focused tests**

Run:

```shell
pnpm test:unit -- src/api/normalizers/v2.test.ts
```

Expected: all normalizer tests pass.

- [ ] **Step 6: Commit the normalization slice**

```shell
git add src/types/codex.ts src/api/normalizers/v2.ts src/api/normalizers/v2.test.ts
git commit -m "fix: preserve subagent lifecycle metadata"
```

---

## Task 2: Aggregate child lifecycle events into desktop-style status groups

**Files:**

- Create: `src/components/content/subAgentActivity.ts`
- Create: `src/components/content/subAgentActivity.test.ts`
- Modify: `src/components/content/threadConversationActivity.ts`
- Modify: `src/components/content/threadConversationActivity.test.ts`

**Interfaces**

- Consumes: ordered, normalized parent-thread `UiMessage[]`.
- Produces: one presentation segment per adjacent subagent activity cluster, with one row per stable child thread and one shared status label.

- [ ] **Step 1: Add RED lifecycle reducer tests**

Cover these cases:

```ts
started -> waiting
started + running -> working
interacted + running -> updated
completed -> done / shared "finished"
completed wait with no explicit child terminal state -> done / shared "finished"
interrupted -> interrupted
errored | notFound -> failed
parent turn completed with no terminal child event -> done / shared "finished"
```

Also prove:

- two adjacent child starts become one segment with two pills;
- repeated events for the same `agentThreadId` never duplicate the pill;
- collab `message` text never appears in labels or status;
- an item with no `agentThreadId` uses a deterministic `agentPath` fallback key.

- [ ] **Step 2: Run reducer tests and confirm failure**

Run:

```shell
pnpm test:unit -- src/components/content/subAgentActivity.test.ts
```

Expected: failure because the reducer does not exist.

- [ ] **Step 3: Implement the pure reducer**

Create:

```ts
export type SubAgentDisplayState =
  | 'waiting'
  | 'working'
  | 'updated'
  | 'done'
  | 'interrupted'
  | 'failed'

export type SubAgentDisplayItem = {
  id: string
  label: string
  state: SubAgentDisplayState
}

export type SubAgentActivityGroup = {
  agents: SubAgentDisplayItem[]
  status: 'started working' | 'updated' | 'interrupted' | 'failed' | 'finished'
  sourceMessageIds: string[]
}

export function buildSubAgentActivityGroup(
  messages: readonly UiMessage[],
  options?: { parentTurnCompleted?: boolean },
): SubAgentActivityGroup | null
```

Use lifecycle precedence:

```ts
failed > interrupted > updated > working/waiting > done
```

Map app-server collab states as follows:

```ts
pendingInit -> waiting
running -> working
completed | shutdown -> done
interrupted -> interrupted
errored | notFound -> failed
```

When a completed `wait` call names a receiver but omits a terminal
`agentsStates` entry, close that receiver as `done`. Do not apply this
inference to spawn, send-input, resume, or close calls.

Apply parent completion only to children still in `waiting`, `working`, or `updated`.

- [ ] **Step 4: Integrate adjacent-message grouping**

Change the subagent segment shape to:

```ts
{
  kind: 'subAgent'
  id: string
  agents: SubAgentDisplayItem[]
  status: SubAgentActivityGroup['status']
  sourceMessageIds: string[]
}
```

In `buildThreadActivitySegments`, consume each adjacent run of `subAgentActivity` and `collabAgentToolCall` messages once, pass it to the reducer, and anchor the resulting segment on the last source message ID. Do not emit `collabAgentToolCall` again as a generic event row.

Call the builder with `{ parentTurnCompleted: true }` from `getTurnActivitySegmentsForWorked`.

- [ ] **Step 5: Run focused aggregation tests**

Run:

```shell
pnpm test:unit -- src/components/content/subAgentActivity.test.ts src/components/content/threadConversationActivity.test.ts
```

Expected: all lifecycle and conversation grouping tests pass.

- [ ] **Step 6: Commit the aggregation slice**

```shell
git add src/components/content/subAgentActivity.ts src/components/content/subAgentActivity.test.ts src/components/content/threadConversationActivity.ts src/components/content/threadConversationActivity.test.ts
git commit -m "fix: aggregate subagent lifecycle activity"
```

---

## Task 3: Render neutral, non-interactive subagent pills

**Files:**

- Modify: `src/components/content/ThreadConversation.vue`
- Create: `src/components/content/threadConversationSubAgent.wiring.test.ts`
- Reuse: `src/components/icons/IconTablerSparkles.vue` if present; otherwise use the closest existing neutral icon component.

**Interfaces**

- Consumes: aggregated `ThreadActivitySegment` objects.
- Produces: status-only, non-interactive subagent UI matching the desktop Codex visual hierarchy.

- [ ] **Step 1: Add RED source-wiring assertions**

The wiring test must assert that the component:

- loops over `segment.agents`;
- renders each entry as a `<span>`, not a `<button>` or `<a>`;
- contains no subagent click handler or `tabindex`;
- renders the shared status once;
- does not reference `IconTablerGitFork` in a subagent row;
- uses the neutral chip/icon classes in both normal and dark themes.

- [ ] **Step 2: Run the wiring test and confirm failure**

Run:

```shell
pnpm test:unit -- src/components/content/threadConversationSubAgent.wiring.test.ts
```

Expected: failure because the current template renders one Git-fork chip per raw event.

- [ ] **Step 3: Replace both live and worked subagent templates**

Use the same markup in the normal transcript and expanded `Worked for…` details:

```vue
<article class="codex-agent-activity-row" aria-label="Subagent status">
  <span
    v-for="agent in segment.agents"
    :key="agent.id"
    class="codex-agent-activity-chip"
    :data-agent-state="agent.state"
  >
    <NeutralIcon class="icon-svg codex-agent-activity-icon" aria-hidden="true" />
    <span class="codex-agent-activity-label">{{ agent.label }}</span>
  </span>
  <span class="codex-agent-activity-status">{{ segment.status }}</span>
</article>
```

Keep the elements non-interactive and remove the obsolete single-label helper.

- [ ] **Step 4: Match the approved desktop visual target**

Update styles so:

- the row and pills wrap cleanly on narrow screens;
- the pill border/background remain close to the conversation background;
- the icon and text use neutral zinc tones in light and dark themes;
- no success/error colors are applied to individual agents;
- label size remains compact and consistent with other desktop-style activity rows.

- [ ] **Step 5: Run focused UI tests**

Run:

```shell
pnpm test:unit -- src/components/content/threadConversationSubAgent.wiring.test.ts src/components/content/threadConversationActivity.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Commit the UI slice**

```shell
git add src/components/content/ThreadConversation.vue src/components/content/threadConversationSubAgent.wiring.test.ts
git commit -m "fix: match desktop subagent status UI"
```

---

## Task 4: Refresh authoritative thread messages on subagent item events

**Files:**

- Create: `src/composables/notificationSyncPolicy.ts`
- Create: `src/composables/notificationSyncPolicy.test.ts`
- Modify: `src/composables/useDesktopState.ts`
- Modify: `src/composables/useDesktopState.test.ts`

**Interfaces**

- Consumes: app-server `RpcNotification`.
- Produces: a debounced selected-thread detail refresh for subagent/collaboration item lifecycle changes.

- [ ] **Step 1: Add RED notification policy tests**

Add a pure policy test for:

```ts
item/started + subAgentActivity -> refresh messages
item/completed + subAgentActivity -> refresh messages
item/started + collabAgentToolCall -> refresh messages
item/completed + collabAgentToolCall -> refresh messages
item/started + unrelated item -> no new authoritative refresh requirement
```

Add one composable integration test that emits a child lifecycle item notification and expects the selected thread detail loader to run after the debounce.

- [ ] **Step 2: Run focused tests and confirm failure**

Run:

```shell
pnpm test:unit -- src/composables/notificationSyncPolicy.test.ts src/composables/useDesktopState.test.ts
```

Expected: the policy test fails, and the integration test shows no detail refresh.

- [ ] **Step 3: Implement and wire the policy**

Export:

```ts
export function shouldRefreshMessagesForNotification(notification: RpcNotification): boolean
```

Return `true` for existing turn start/completion/error cases and for item start/completion whose item type is `subAgentActivity` or `collabAgentToolCall`.

Use this helper inside `queueEventDrivenSync` without changing the existing debounce, visibility pause, or thread-list refresh behavior.

- [ ] **Step 4: Run focused sync tests**

Run:

```shell
pnpm test:unit -- src/composables/notificationSyncPolicy.test.ts src/composables/useDesktopState.test.ts
```

Expected: all notification sync tests pass.

- [ ] **Step 5: Commit only the intended sync hunks**

Because `useDesktopState.ts` and its test already contain unrelated dirty work, inspect the staged diff and stage only this task’s hunks:

```shell
git diff -- src/composables/useDesktopState.ts src/composables/useDesktopState.test.ts
git add src/composables/notificationSyncPolicy.ts src/composables/notificationSyncPolicy.test.ts
git add -p src/composables/useDesktopState.ts src/composables/useDesktopState.test.ts
git diff --cached --check
git commit -m "fix: refresh subagent activity from item events"
```

---

## Task 5: Regression verification and local service handoff

**Files:**

- Verify all files changed in Tasks 1–4.
- Do not modify deployment scripts unless verification finds a directly related defect.

**Interfaces**

- Consumes: the completed implementation.
- Produces: a built frontend and restarted local `codex-mobile-safe` service with preserved unrelated working-tree changes.

- [ ] **Step 1: Run all focused tests together**

```shell
pnpm test:unit -- src/api/normalizers/v2.test.ts src/components/content/subAgentActivity.test.ts src/components/content/threadConversationActivity.test.ts src/components/content/threadConversationSubAgent.wiring.test.ts src/composables/notificationSyncPolicy.test.ts src/composables/useDesktopState.test.ts
```

Expected: all selected test files pass.

- [ ] **Step 2: Run the full unit suite**

```shell
pnpm test:unit
```

Expected: zero failed tests.

- [ ] **Step 3: Run the production build**

```shell
pnpm build
```

Expected: `vue-tsc`, Vite, and CLI bundling all succeed.

- [ ] **Step 4: Review the final diff and transcript-isolation invariant**

```shell
git diff --check
git status --short
git log --oneline -6
```

Manually confirm:

- no UI field was added for child result messages;
- no subagent chip is clickable or focusable;
- no raw child output can flow through `UiMessage.text`;
- unrelated pre-existing dirty files/hunks remain intact.

- [ ] **Step 5: Restart and inspect the safe service**

```shell
systemctl --user restart codex-mobile-safe.service
systemctl --user --no-pager --full status codex-mobile-safe.service
```

Expected: service is active with the newly built frontend.

- [ ] **Step 6: Report the exact result**

Report focused/full test counts, build status, service status, commits created, remaining unrelated dirty files, and any browser refresh required. Do not claim GitHub synchronization unless a push is separately requested and succeeds.
