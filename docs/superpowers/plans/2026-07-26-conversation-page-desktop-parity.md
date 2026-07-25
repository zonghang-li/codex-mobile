# Current Conversation Page Desktop Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the mobile current-conversation page use the Codex desktop client's content model, active/completed turn presentation, footer status, goal state, composer controls, and interaction rules.

**Architecture:** Add pure presentation projectors between normalized Codex state and Vue components, then move active-turn status into a dedicated footer above the composer. Extend the existing thread state with authoritative goal events and keep mutations behind gateway functions; refactor the composer around one desktop-compatible control model without changing runtime synchronization, notification, network-mode, or safe-service behavior.

**Tech Stack:** Vue 3, TypeScript 5.7, Vitest, Tailwind CSS 4, Vite, Codex app-server v2 RPC.

## Global Constraints

- Follow `docs/superpowers/specs/2026-07-26-conversation-page-desktop-parity-design.md`.
- Scope is the selected current-conversation page only; do not change the sidebar, home page, settings, automation management, review page, or standalone terminal interface.
- Codex desktop behavior is the source of truth; mobile width may change layout but not event meaning, control state, or action outcome.
- Keep the composer text input at `16px` on narrow touch screens to prevent iOS focus zoom.
- Keep the status footer outside the conversation scroll container and directly above the goal strip/composer.
- Do not render child-agent transcripts, collab `message` payloads, raw tool JSON, or transport directives as parent assistant prose.
- Preserve the unrelated dirty changes already present in `src/App.vue`, `src/components/content/mobileRouteViewport.wiring.test.ts`, `src/composables/useDesktopState.ts`, `src/composables/useDesktopState.test.ts`, `src/server/codexAppServerBridge.ts`, `src/server/codexAppServerBridge.security.test.ts`, and `src/server/externalThreadRuntimeBridge.test.ts`.
- Add a failing focused test before each production change.
- Do not claim visual parity from unit tests or HTTP checks. Browser-driven visual QA requires the user's browser permission and a same-state reference comparison.
- Run requirements review before code-quality review at the merge gate.

---

## File Structure

### New files

- `src/components/content/conversationFooterState.ts`: pure active-turn plan/diff projector.
- `src/components/content/conversationFooterState.test.ts`: step-selection, aggregation, and visibility tests.
- `src/components/content/ConversationProgressDonut.vue`: accessible compact plan-progress ring.
- `src/components/content/ConversationRunFooter.vue`: status pill and goal-strip renderer.
- `src/components/content/conversationRunFooter.wiring.test.ts`: footer placement and interaction wiring tests.
- `src/components/content/conversationTurnPresentation.ts`: pure current/completed turn presentation projector.
- `src/components/content/conversationTurnPresentation.test.ts`: collapse, final-answer, dedupe, and fallback tests.
- `src/components/content/composerControlState.ts`: pure desktop-compatible composer control model.
- `src/components/content/composerControlState.test.ts`: permission, goal, model, effort, speed, submit, and stop tests.
- `src/components/content/conversationPageParity.wiring.test.ts`: page-level semantic order and mobile overflow regressions.
- `src/components/content/queuedMessagesDesktopParity.wiring.test.ts`: queued-message action/order regressions.
- `src/components/content/contentHeaderDesktopParity.wiring.test.ts`: selected-thread header control regressions.
- `src/components/icons/IconTablerTargetArrow.vue`: official Tabler target-arrow icon wrapper.
- `src/components/icons/IconTablerPlayerPause.vue`: official Tabler pause icon wrapper.

### Existing files modified

- `src/types/codex.ts`: goal and presentation-safe thread types.
- `src/api/codexGateway.ts`: typed goal get/set/clear RPC functions.
- `src/api/codexGateway.test.ts`: goal RPC request/response tests.
- `src/composables/useDesktopState.ts`: thread-scoped plan/diff/goal state and notifications.
- `src/composables/useDesktopState.test.ts`: authoritative live-state and reconnect tests.
- `src/components/content/ThreadConversation.vue`: render projected turn sections and remove live inline footer duplicates.
- `src/components/content/threadConversationActivity.ts`: expose stable activity/final-answer helpers to the projector.
- `src/components/content/ThreadComposer.vue`: desktop control order, menus, and action states.
- `src/components/content/ThreadPendingRequestPanel.vue`: desktop request interaction states and stale-resolution feedback.
- `src/components/content/QueuedMessages.vue`: desktop queue edit/send/delete/reorder affordances.
- `src/components/content/ContentHeader.vue`: selected-thread title and control semantics.
- `src/components/content/HeaderGitBranchDropdown.vue`: selected-thread branch trigger/menu semantics.
- `src/App.vue`: mount footer/goal/composer stack and pass semantic actions.
- `src/style.css`: shared current-conversation type and color tokens only when component-scoped rules cannot express them.
- `src/composables/useUiLanguage.ts`: new desktop labels used by the selected conversation page.
- `docs/manual-test-catalog.md`: manual scenarios for running, completed, pending-request, goal, and narrow viewport states.

---

### Task 1: Derive the desktop active-turn footer state

**Files:**

- Create: `src/components/content/conversationFooterState.ts`
- Create: `src/components/content/conversationFooterState.test.ts`
- Modify: `src/types/codex.ts`

**Interfaces:**

- Consumes: normalized `UiMessage[]`, current `turnId`, and `isTurnInProgress`.
- Produces: `deriveConversationFooterState(input): ConversationFooterState | null`.

- [ ] **Step 1: Write the failing footer projector tests**

Create fixtures covering desktop step selection, progress, and per-turn diff aggregation:

```ts
const footer = deriveConversationFooterState({
  messages: [
    planMessage([
      { step: 'Inspect', status: 'completed' },
      { step: 'Implement', status: 'inProgress' },
      { step: 'Verify', status: 'pending' },
    ], 'turn-7'),
    fileChangeMessage('turn-7', [
      {
        path: 'src/App.vue',
        operation: 'update',
        movedToPath: null,
        diff: '@@ -1 +1 @@',
        addedLineCount: 10,
        removedLineCount: 3,
      },
    ]),
  ],
  turnId: 'turn-7',
  isTurnInProgress: true,
})

expect(footer).toMatchObject({
  stepNumber: 2,
  stepCount: 3,
  completedPercent: 100 / 3,
  fileCount: 1,
  additions: 10,
  deletions: 3,
})
```

Also assert:

```ts
expect(stepNumber(allPendingPlan)).toBe(1)
expect(stepNumber(allCompletedPlan)).toBe(allCompletedPlan.length)
expect(deriveConversationFooterState({ messages, turnId: 'other', isTurnInProgress: true }))
  .toBeNull()
expect(aggregateDuplicatePathMessages).toEqual({
  fileCount: 1,
  additions: 12,
  deletions: 4,
})
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```shell
pnpm test:unit -- src/components/content/conversationFooterState.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Add the presentation types and minimal projector**

Add to `src/types/codex.ts`:

```ts
export type ConversationFooterState = {
  turnId: string
  stepNumber: number | null
  stepCount: number
  completedPercent: number
  fileCount: number
  additions: number
  deletions: number
}
```

Implement:

```ts
export function selectDesktopPlanStep(steps: readonly UiPlanStep[]): number | null {
  if (steps.length === 0) return null
  const inProgress = steps.findIndex((step) => step.status === 'inProgress')
  if (inProgress >= 0) return inProgress
  const firstOpen = steps.findIndex((step) => step.status !== 'completed')
  return firstOpen >= 0 ? firstOpen : steps.length - 1
}

export function deriveConversationFooterState(
  input: ConversationFooterInput,
): ConversationFooterState | null
```

Filter every source message to `input.turnId`, keep the newest plan, merge file
changes by `path + movedToPath`, and return `null` when the active turn has
neither plan nor diff data.

- [ ] **Step 4: Run the focused tests and confirm GREEN**

Run:

```shell
pnpm test:unit -- src/components/content/conversationFooterState.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the footer projector**

```shell
git add src/types/codex.ts \
  src/components/content/conversationFooterState.ts \
  src/components/content/conversationFooterState.test.ts
git commit -m "feat: derive desktop conversation footer state"
```

---

### Task 2: Project desktop turn sections and completion folding

**Files:**

- Create: `src/components/content/conversationTurnPresentation.ts`
- Create: `src/components/content/conversationTurnPresentation.test.ts`
- Modify: `src/components/content/threadConversationActivity.ts`
- Modify: `src/components/content/ThreadConversation.vue`
- Test: `src/components/content/threadConversationDesktopParity.wiring.test.ts`

**Interfaces:**

- Consumes: ordered, deduplicated `UiMessage[]` plus authoritative running state.
- Produces: `projectConversationTurns(input): ConversationTurnSection[]`.

- [ ] **Step 1: Write failing turn-presentation tests**

Cover a running turn:

```ts
expect(projectConversationTurns({
  messages: [
    user('u1', 'Run tests', 'turn-1'),
    command('c1', 'pnpm test', 'turn-1'),
    subAgent('a1', 'Reviewer', 'turn-1'),
    assistant('draft', '', 'turn-1'),
  ],
  activeTurnId: 'turn-1',
})).toMatchObject([{
  turnId: 'turn-1',
  isCollapsed: false,
  activityMessageIds: ['c1', 'a1'],
  finalMessageId: null,
}])
```

Cover a completed turn:

```ts
expect(projectConversationTurns({
  messages: [
    user('u1', 'Run tests', 'turn-1'),
    command('c1', 'pnpm test', 'turn-1'),
    assistant('final', 'All tests pass.', 'turn-1'),
    worked('w1', 85_000, 'turn-1'),
  ],
  activeTurnId: null,
})).toMatchObject([{
  turnId: 'turn-1',
  isCollapsed: true,
  activityMessageIds: ['c1'],
  finalMessageId: 'final',
  completionLabel: 'Worked for 1m 25s',
}])
```

Also prove:

- live and persisted copies with the same item identity render once;
- a child-agent `message` never becomes `finalMessageId`;
- `turnError` and interrupted turns use their desktop boundary;
- unknown tool activity remains a neutral activity row;
- the latest non-empty parent assistant message is the final response.

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```shell
pnpm test:unit -- src/components/content/conversationTurnPresentation.test.ts
```

Expected: FAIL because the projector does not exist.

- [ ] **Step 3: Implement stable turn projection**

Define:

```ts
export type ConversationTurnSection = {
  turnId: string
  userMessageIds: string[]
  activityMessageIds: string[]
  finalMessageId: string | null
  completionMessageId: string | null
  completionLabel: string | null
  isCollapsed: boolean
}

export function projectConversationTurns(
  input: ConversationTurnPresentationInput,
): ConversationTurnSection[]
```

Use `turnId` as the primary boundary and `turnIndex` only as a recovery fallback.
Treat `activity.kind === 'subAgent'` and collab lifecycle content as activity
only. Reuse the existing activity classifier for commands, files, tools,
skills, image views, searches, plans, and compaction.

- [ ] **Step 4: Render projected sections in `ThreadConversation`**

Replace scattered turn-fold ownership with a section loop:

```vue
<section
  v-for="section in conversationTurnSections"
  :key="section.turnId"
  class="conversation-turn"
>
  <button
    v-if="section.completionLabel"
    type="button"
    class="worked-separator"
    :aria-expanded="!isTurnCollapsed(section)"
    @click="toggleTurn(section.turnId)"
  >
    <span class="worked-separator-line" aria-hidden="true" />
    <span class="worked-chevron" aria-hidden="true">▶</span>
    <span class="worked-separator-text">{{ section.completionLabel }}</span>
    <span class="worked-separator-line" aria-hidden="true" />
  </button>
  <!-- render activity IDs only when expanded/running -->
  <!-- render finalMessageId outside the disclosure -->
</section>
```

Keep existing Markdown, code-block copy, directive, math, and file-link renderers.
Remove only duplicate inline live plan/file-summary rendering; historical diff
activity remains inside completed turn disclosure.

- [ ] **Step 5: Run focused activity and conversation tests**

Run:

```shell
pnpm test:unit -- \
  src/components/content/conversationTurnPresentation.test.ts \
  src/components/content/threadConversationActivity.test.ts \
  src/components/content/threadConversationDesktopParity.wiring.test.ts \
  src/components/content/threadConversationSubAgent.wiring.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the turn projector**

```shell
git add src/components/content/conversationTurnPresentation.ts \
  src/components/content/conversationTurnPresentation.test.ts \
  src/components/content/threadConversationActivity.ts \
  src/components/content/threadConversationActivity.test.ts \
  src/components/content/ThreadConversation.vue \
  src/components/content/threadConversationDesktopParity.wiring.test.ts
git commit -m "feat: project desktop conversation turns"
```

---

### Task 3: Render the persistent plan/diff footer above the composer

**Files:**

- Create: `src/components/content/ConversationRunFooter.vue`
- Create: `src/components/content/ConversationProgressDonut.vue`
- Create: `src/components/content/conversationRunFooter.wiring.test.ts`
- Modify: `src/App.vue`
- Modify: `src/composables/useDesktopState.ts`
- Modify: `src/composables/useDesktopState.test.ts`
- Modify: `src/composables/useUiLanguage.ts`

**Interfaces:**

- Consumes: `ConversationFooterState | null` and current thread ownership.
- Produces: a non-scrolling footer pill directly above the composer.

- [ ] **Step 1: Write failing wiring tests**

Assert source order:

```ts
expect(appSource.indexOf('<ConversationRunFooter'))
  .toBeGreaterThan(appSource.indexOf('<QueuedMessages'))
expect(appSource.indexOf('<ConversationRunFooter'))
  .toBeLessThan(appSource.indexOf('<ThreadComposer'))
expect(appSource).toContain(':footer-state=\"selectedConversationFooterState\"')
```

Mount the footer and assert:

```ts
expect(wrapper.text()).toContain('Step 3 / 5')
expect(wrapper.text()).toContain('3 files changed')
expect(wrapper.text()).toContain('+10')
expect(wrapper.text()).toContain('-3')
expect(wrapper.find('[aria-valuenow=\"40\"]').exists()).toBe(true)
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run:

```shell
pnpm test:unit -- \
  src/components/content/conversationRunFooter.wiring.test.ts \
  src/composables/useDesktopState.test.ts
```

Expected: FAIL because the component and selected footer state do not exist.

- [ ] **Step 3: Expose authoritative current-turn inputs**

In `useDesktopState`, expose:

```ts
const selectedActiveTurnId = computed(() => {
  const threadId = selectedThreadId.value
  return threadId ? activeTurnIdByThreadId.value[threadId] ?? '' : ''
})
```

Ensure `turn/plan/updated`, `turn/diff/updated`, item file-change notifications,
`turn/completed`, and external refresh reconciliation retain correct `turnId`
metadata until the completed turn has been re-read. Do not clear the footer from
a heuristic idle timer.

- [ ] **Step 4: Implement the accessible progress ring and `ConversationRunFooter.vue`**

Create `ConversationProgressDonut.vue` as a native progress primitive rather
than an image asset:

```vue
<template>
  <span
    class="conversation-progress-donut"
    role="progressbar"
    aria-valuemin="0"
    aria-valuemax="100"
    :aria-valuenow="roundedValue"
    :style="{ '--progress': `${roundedValue * 3.6}deg` }"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ value: number }>()
const roundedValue = computed(() =>
  Math.max(0, Math.min(100, Math.round(props.value))),
)
</script>

<style scoped>
.conversation-progress-donut {
  display: inline-block;
  width: 1rem;
  height: 1rem;
  border-radius: 9999px;
  background: conic-gradient(
    currentColor var(--progress),
    color-mix(in srgb, currentColor 18%, transparent) 0
  );
  mask: radial-gradient(circle, transparent 42%, #000 44%);
}
</style>
```

Render a centered desktop-style pill:

```vue
<div v-if="footerState" class="conversation-run-footer" aria-live="polite">
  <div class="conversation-run-footer-pill">
    <ConversationProgressDonut
      v-if="footerState.stepNumber"
      :value="footerState.completedPercent"
    />
    <span v-if="footerState.stepNumber">
      {{ t('Step {step} / {count}', {
        step: footerState.stepNumber,
        count: footerState.stepCount,
      }) }}
    </span>
    <span v-if="footerState.fileCount">· {{ fileSummary }}</span>
    <span v-if="footerState.additions" class="is-added">+{{ footerState.additions }}</span>
    <span v-if="footerState.deletions" class="is-deleted">-{{ footerState.deletions }}</span>
  </div>
</div>
```

The ring is a semantic progress element and not a decorative image. All action
icons continue to use the project's existing icon component pattern.

- [ ] **Step 5: Mount footer in the composer stack**

In `App.vue`, derive:

```ts
const selectedConversationFooterState = computed(() =>
  deriveConversationFooterState({
    messages: filteredMessages.value,
    turnId: selectedActiveTurnId.value,
    isTurnInProgress: isSelectedThreadInProgress.value,
  }),
)
```

Place `ConversationRunFooter` after queued/pending panels that desktop places
above status, but immediately before the goal strip/composer. Keep it outside
`.content-thread`.

- [ ] **Step 6: Run focused tests**

Run:

```shell
pnpm test:unit -- \
  src/components/content/conversationFooterState.test.ts \
  src/components/content/conversationRunFooter.wiring.test.ts \
  src/composables/useDesktopState.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit the footer UI**

```shell
git add src/App.vue src/composables/useDesktopState.ts \
  src/composables/useDesktopState.test.ts \
  src/composables/useUiLanguage.ts \
  src/components/content/ConversationProgressDonut.vue \
  src/components/content/ConversationRunFooter.vue \
  src/components/content/conversationRunFooter.wiring.test.ts
git commit -m "feat: pin turn progress above the composer"
```

---

### Task 4: Add authoritative Codex thread goal state

**Files:**

- Modify: `src/types/codex.ts`
- Modify: `src/api/codexGateway.ts`
- Modify: `src/api/codexGateway.test.ts`
- Modify: `src/composables/useDesktopState.ts`
- Modify: `src/composables/useDesktopState.test.ts`
- Modify: `src/components/content/ConversationRunFooter.vue`
- Modify: `src/components/content/conversationRunFooter.wiring.test.ts`
- Create: `src/components/icons/IconTablerTargetArrow.vue`
- Create: `src/components/icons/IconTablerPlayerPause.vue`

**Interfaces:**

- Produces:
  - `getThreadGoal(threadId): Promise<UiThreadGoal | null>`
  - `setThreadGoal(input): Promise<UiThreadGoal>`
  - `clearThreadGoal(threadId): Promise<void>`
  - `selectedThreadGoal: ComputedRef<UiThreadGoal | null>`

- [ ] **Step 1: Write failing goal normalization and RPC tests**

Define the protocol fixture:

```ts
const goal = {
  objective: 'Finish desktop parity',
  status: 'active',
  updatedAt: 1_753_500_000,
  timeUsedSeconds: 45,
  tokensUsed: 1_200,
  tokenBudget: 10_000,
}
```

Assert:

```ts
await getThreadGoal('thread-1')
expect(fetchRpc).toHaveBeenCalledWith('thread/goal/get', { threadId: 'thread-1' })

await setThreadGoal({
  threadId: 'thread-1',
  objective: 'Finish desktop parity',
  status: 'active',
})
expect(fetchRpc).toHaveBeenCalledWith('thread/goal/set', {
  threadId: 'thread-1',
  objective: 'Finish desktop parity',
  status: 'active',
})
```

Also cover `paused`, `blocked`, `usageLimited`, `budgetLimited`, `complete`, and
malformed response rejection.

- [ ] **Step 2: Run goal tests and confirm RED**

Run:

```shell
pnpm test:unit -- src/api/codexGateway.test.ts src/composables/useDesktopState.test.ts
```

Expected: FAIL because goal types, RPCs, and state do not exist.

- [ ] **Step 3: Add goal types and gateway functions**

Add:

```ts
export type UiThreadGoalStatus =
  | 'active'
  | 'paused'
  | 'blocked'
  | 'usageLimited'
  | 'budgetLimited'
  | 'complete'

export type UiThreadGoal = {
  objective: string
  status: UiThreadGoalStatus
  updatedAt: number
  timeUsedSeconds: number
  tokensUsed: number
  tokenBudget: number | null
}
```

Use exactly `thread/goal/get`, `thread/goal/set`, and `thread/goal/clear`.
`setThreadGoal` changes pause/resume by sending `status: 'paused'` or
`status: 'active'`; do not invent separate pause/resume methods.

- [ ] **Step 4: Reconcile goal notifications in `useDesktopState`**

Add a thread-scoped map and handlers:

```ts
if (notification.method === 'thread/goal/updated') {
  const { threadId, goal } = readThreadGoalNotification(notification)
  setThreadGoalForThread(threadId, goal)
}

if (notification.method === 'thread/goal/cleared') {
  clearThreadGoalForThread(threadId)
}
```

Load `thread/goal/get` after a selected thread resumes. Ignore an unsupported
method response without breaking thread load; expose `threadGoalSupported` so
mutation controls can be hidden.

- [ ] **Step 5: Render and interact with the desktop goal strip**

Add the two missing icons using the same official Tabler wrapper convention as
the existing `src/components/icons/IconTabler*.vue` files. The target icon uses
the official target-arrow geometry:

```vue
<template>
  <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" aria-hidden="true">
    <g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">
      <path d="M12 2a10 10 0 1 0 10 10" />
      <path d="M12 6a6 6 0 1 0 6 6" />
      <path d="M12 10a2 2 0 1 0 2 2" />
      <path d="m22 2l-6 6" />
      <path d="M16 2h6v6" />
    </g>
  </svg>
</template>
```

The pause icon uses the official Tabler player-pause geometry:

```vue
<template>
  <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" aria-hidden="true">
    <g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">
      <path d="M6 5v14" />
      <path d="M18 5v14" />
    </g>
  </svg>
</template>
```

Extend `ConversationRunFooter` with:

```vue
<div v-if="goal" class="conversation-goal-strip">
  <component :is="goalStatusIcon" class="conversation-goal-icon" />
  <strong>{{ goalStatusLabel }}</strong>
  <span class="conversation-goal-objective">{{ goal.objective }}</span>
  <span class="conversation-goal-time">{{ goalProgressLabel }}</span>
  <button v-if="canEditGoal" @click="$emit('edit-goal')">…</button>
  <button v-if="canPauseGoal" @click="$emit('pause-goal')">…</button>
  <button v-if="canClearGoal" @click="$emit('clear-goal')">…</button>
</div>
```

Map `active` to `IconTablerTargetArrow`, `paused` to
`IconTablerPlayerPause`, limited/blocked statuses to existing status icons, and
complete to the existing completion icon. Use existing file-pencil, trash, and
chevron components for actions. Add confirmation/edit dialogs that submit only
after explicit user action and roll back optimistic state on RPC failure.

- [ ] **Step 6: Run goal tests**

Run:

```shell
pnpm test:unit -- \
  src/api/codexGateway.test.ts \
  src/composables/useDesktopState.test.ts \
  src/components/content/conversationRunFooter.wiring.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit goal support**

```shell
git add src/types/codex.ts src/api/codexGateway.ts src/api/codexGateway.test.ts \
  src/composables/useDesktopState.ts src/composables/useDesktopState.test.ts \
  src/components/content/ConversationRunFooter.vue \
  src/components/content/conversationRunFooter.wiring.test.ts \
  src/components/icons/IconTablerTargetArrow.vue \
  src/components/icons/IconTablerPlayerPause.vue
git commit -m "feat: mirror Codex thread goal state"
```

---

### Task 5: Derive and render desktop composer controls

**Files:**

- Create: `src/components/content/composerControlState.ts`
- Create: `src/components/content/composerControlState.test.ts`
- Modify: `src/components/content/ThreadComposer.vue`
- Modify: `src/components/content/externalThreadRuntimeUi.ts`
- Modify: `src/components/content/externalThreadRuntimeUi.test.ts`
- Modify: `src/composables/useUiLanguage.ts`

**Interfaces:**

- Consumes: runtime ownership, active turn, pending request, content, model,
  reasoning effort, speed, dictation, goal capability, and fixed safe runtime
  permission policy.
- Produces: `deriveComposerControlState(input): ComposerControlState`.

- [ ] **Step 1: Write failing composer state tests**

Cover:

```ts
expect(deriveComposerControlState(localIdle)).toMatchObject({
  primaryAction: 'send',
  permissionLabel: 'Approve for me',
  canEditConfiguration: true,
  canToggleGoal: true,
})

expect(deriveComposerControlState(localRunningEmpty)).toMatchObject({
  primaryAction: 'stop',
  canEditConfiguration: false,
})

expect(deriveComposerControlState(externalRunning)).toMatchObject({
  primaryAction: 'externalRunning',
  canSubmit: false,
  canStop: false,
})

expect(deriveComposerControlState(pendingApproval)).toMatchObject({
  primaryAction: 'hidden',
  composerVisible: false,
})
```

Also assert that unsupported effort values are never offered for the selected
model and the combined label contains fast mode, model display name, and effort.

- [ ] **Step 2: Run focused tests and confirm RED**

Run:

```shell
pnpm test:unit -- src/components/content/composerControlState.test.ts
```

Expected: FAIL because the control projector does not exist.

- [ ] **Step 3: Implement the pure composer state**

Define:

```ts
export type ComposerPrimaryAction =
  | 'send'
  | 'stop'
  | 'externalRunning'
  | 'hidden'

export type ComposerControlState = {
  composerVisible: boolean
  primaryAction: ComposerPrimaryAction
  canSubmit: boolean
  canStop: boolean
  canEditConfiguration: boolean
  canToggleGoal: boolean
  permissionLabel: string
  modelEffortLabel: string
  showFastIcon: boolean
}
```

Use the actual safe runtime policy: `approvalPolicy: 'never'` with
`workspace-write` is presented as `Approve for me`; do not expose a menu option
that would silently change the server process policy. Unsupported selectable
profiles are hidden rather than simulated.

- [ ] **Step 4: Reorder `ThreadComposer` to desktop semantic order**

Render:

```vue
<div class="thread-composer-controls">
  <button class="thread-composer-attach-trigger">…</button>
  <button class="thread-composer-permission-trigger">Approve for me</button>
  <button v-if="goalSupported" class="thread-composer-goal-trigger">Goal</button>

  <div class="thread-composer-actions">
    <ComposerDropdown
      :model-value="selectedModel"
      :options="desktopModelEffortOptions"
      :selected-prefix-icon="composerControlState.showFastIcon ? IconTablerBolt : null"
      :placeholder="composerControlState.modelEffortLabel"
      open-direction="up"
      @update:model-value="onDesktopModelEffortSelect"
    />
    <button class="thread-composer-mic">…</button>
    <button v-if="primaryAction === 'stop'" class="thread-composer-stop">…</button>
    <button v-else class="thread-composer-submit">…</button>
  </div>
</div>
```

Move Skills, model, effort, speed, queue/steer, and plan controls into the
corresponding desktop-style menus without deleting their existing handlers.
Keep the visible placeholder `Do anything` for a selected thread.

- [ ] **Step 5: Match desktop interaction contracts**

Preserve:

- `Enter`/send preference behavior;
- stop only for locally owned active turns;
- queue versus steer behavior while running;
- attachment and dictation cancellation on external takeover;
- disabled controls during pending mutation;
- menu dismissal on outside click, Escape, submit, and runtime takeover;
- focus restoration to the composer after a successful menu action.

- [ ] **Step 6: Run composer tests**

Run:

```shell
pnpm test:unit -- \
  src/components/content/composerControlState.test.ts \
  src/components/content/externalThreadRuntimeUi.test.ts \
  src/components/content/externalThreadRuntime.wiring.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit composer parity**

```shell
git add src/components/content/composerControlState.ts \
  src/components/content/composerControlState.test.ts \
  src/components/content/ThreadComposer.vue \
  src/components/content/externalThreadRuntimeUi.ts \
  src/components/content/externalThreadRuntimeUi.test.ts \
  src/composables/useUiLanguage.ts
git commit -m "feat: match Codex composer controls"
```

---

### Task 6: Match pending-request and tool interaction behavior

**Files:**

- Modify: `src/components/content/ThreadPendingRequestPanel.vue`
- Modify: `src/components/content/QueuedMessages.vue`
- Create: `src/components/content/queuedMessagesDesktopParity.wiring.test.ts`
- Modify: `src/components/content/externalThreadRuntime.wiring.test.ts`
- Modify: `src/components/content/ThreadConversation.vue`
- Modify: `src/components/content/threadConversationDesktopParity.wiring.test.ts`
- Modify: `src/composables/useDesktopState.ts`
- Modify: `src/composables/useDesktopState.test.ts`

**Interfaces:**

- Consumes: `UiServerRequest[]`, authoritative request-resolution notifications,
  and projected activity items.
- Produces: one desktop-compatible actionable request and accurate tool-row
  disclosure affordances.

- [ ] **Step 1: Add failing request lifecycle tests**

Assert:

```ts
expect(renderPending('item/commandExecution/requestApproval')).not
  .toContain('TOOL CALL WAITING FOR RESPONSE')
expect(renderPending('item/permissions/requestApproval')).toContain('Approve for me')
expect(resolveTwiceSameRequest).toIssueOneRpc()
expect(staleResolvedRequestAfterRefresh).toBeNull()
```

Add component assertions that rows without output/details have no click handler,
tab index, chevron, or hover affordance, while command rows with output retain
the desktop disclosure interaction.

Add queued-message assertions:

```ts
expect(queuedSource).toContain("emit('edit'")
expect(queuedSource).toContain("emit('steer'")
expect(queuedSource).toContain("emit('delete'")
expect(queuedSource).toContain("emit('reorder'")
expect(queuedSource).not.toContain('draggable="true"')
```

The last assertion keeps touch reordering on explicit controls instead of HTML
dragging, matching a phone-safe version of the desktop action.

- [ ] **Step 2: Run focused tests and confirm RED**

Run:

```shell
pnpm test:unit -- \
  src/components/content/externalThreadRuntime.wiring.test.ts \
  src/components/content/queuedMessagesDesktopParity.wiring.test.ts \
  src/composables/useDesktopState.test.ts \
  src/components/content/threadConversationDesktopParity.wiring.test.ts
```

Expected: at least one new assertion fails.

- [ ] **Step 3: Make request resolution idempotent**

Track request IDs in a pending-submit set:

```ts
if (resolvingRequestIds.value.has(request.id)) return
resolvingRequestIds.value.add(request.id)
try {
  await respondServerRequest(request, response)
} finally {
  resolvingRequestIds.value.delete(request.id)
}
```

Remove the request only after an accepted response or authoritative
`serverRequest/resolved` notification. On stale/not-found resolution, refresh
the thread request state and return the composer to the correct mode.

- [ ] **Step 4: Align request and activity affordances**

Use the existing desktop-derived labels and actual option payloads. Do not show
a chevron/cursor/keyboard focus for status-only subagent, skill, compaction, or
tool rows. Keep expansion for command output, plan details, review details, and
other rows whose desktop item exposes content.

Align `QueuedMessages` with the same semantic actions as desktop: edit returns
content to the composer, send-now steers the active turn, delete removes only
the selected queue item, and explicit up/down controls reorder without losing
attachment metadata. Disable every mutation for an externally owned thread.

- [ ] **Step 5: Run focused tests**

Run:

```shell
pnpm test:unit -- \
  src/components/content/externalThreadRuntime.wiring.test.ts \
  src/components/content/queuedMessagesDesktopParity.wiring.test.ts \
  src/composables/useDesktopState.test.ts \
  src/components/content/threadConversationDesktopParity.wiring.test.ts \
  src/components/content/threadConversationSubAgent.wiring.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit interaction parity**

```shell
git add src/components/content/ThreadPendingRequestPanel.vue \
  src/components/content/QueuedMessages.vue \
  src/components/content/ThreadConversation.vue \
  src/components/content/externalThreadRuntime.wiring.test.ts \
  src/components/content/queuedMessagesDesktopParity.wiring.test.ts \
  src/components/content/threadConversationDesktopParity.wiring.test.ts \
  src/composables/useDesktopState.ts src/composables/useDesktopState.test.ts
git commit -m "fix: align conversation request interactions"
```

---

### Task 7: Match current-page typography, spacing, and mobile layout

**Files:**

- Create: `src/components/content/conversationPageParity.wiring.test.ts`
- Modify: `src/App.vue`
- Modify: `src/components/content/ThreadConversation.vue`
- Modify: `src/components/content/ConversationRunFooter.vue`
- Modify: `src/components/content/ThreadComposer.vue`
- Modify: `src/components/content/ContentHeader.vue`
- Modify: `src/components/content/HeaderGitBranchDropdown.vue`
- Modify: `src/style.css`
- Modify: `src/components/content/mobileRouteViewport.wiring.test.ts`
- Create: `src/components/content/contentHeaderDesktopParity.wiring.test.ts`

**Interfaces:**

- Produces: one responsive current-conversation visual system with no horizontal
  overflow and desktop semantic order.

- [ ] **Step 1: Write failing style and source-order regressions**

Assert:

```ts
expect(appSource).toMatch(/content-thread[\\s\\S]*conversation-run-footer[\\s\\S]*thread-composer/)
expect(styleSource).toContain('overflow-x: hidden')
expect(composerSource).toContain('font-size: 16px')
expect(conversationSource).toContain('var(--codex-conversation-font')
expect(headerSource).toContain(':aria-expanded')
expect(headerSource).toContain('text-overflow: ellipsis')
```

Add width-contract tests for `320px`, `390px`, and `430px` that ensure the
footer, goal strip, composer controls, code blocks, long paths, and inline code
do not increase `documentElement.scrollWidth`.

Assert selected-thread header actions retain title editing, terminal control,
branch selection, sidebar toggle, and their disabled/read-only states. The
branch menu must close on selection, outside click, Escape, and thread change.

- [ ] **Step 2: Run focused tests and confirm RED**

Run:

```shell
pnpm test:unit -- \
  src/components/content/conversationPageParity.wiring.test.ts \
  src/components/content/mobileRouteViewport.wiring.test.ts
```

Expected: FAIL on the new desktop token/order/overflow assertions.

- [ ] **Step 3: Apply desktop client visual tokens**

Add scoped tokens:

```css
.content-root {
  --codex-conversation-font:
    ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --codex-conversation-mono:
    ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  overflow-x: hidden;
}
```

Match the supplied reference for:

- selected-thread header title, branch/runtime controls, truncation, and touch
  targets;
- body size and line height;
- muted activity text;
- inline-code pill radius/background;
- activity icon size and alignment;
- footer/goal/composer background, border, radius, and gaps;
- input dock safe-area and keyboard behavior.

Use the existing icon component library. Do not add emoji, handwritten SVG,
ASCII icons, or CSS illustrations.

- [ ] **Step 4: Add narrow-width layout rules**

Use min-width guards and truncation:

```css
.conversation-run-footer-pill,
.conversation-goal-strip,
.thread-composer-controls {
  min-width: 0;
  max-width: 100%;
}

.conversation-goal-objective,
.composer-runtime-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

Keep every primary action reachable. A secondary label may truncate but its menu
and selected value must remain accessible.

- [ ] **Step 5: Run focused style tests**

Run:

```shell
pnpm test:unit -- \
  src/components/content/conversationPageParity.wiring.test.ts \
  src/components/content/contentHeaderDesktopParity.wiring.test.ts \
  src/components/content/mobileRouteViewport.wiring.test.ts \
  src/components/content/threadConversationTypography.wiring.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit visual parity**

```shell
git add src/App.vue src/style.css \
  src/components/content/ThreadConversation.vue \
  src/components/content/ConversationRunFooter.vue \
  src/components/content/ThreadComposer.vue \
  src/components/content/ContentHeader.vue \
  src/components/content/HeaderGitBranchDropdown.vue \
  src/components/content/conversationPageParity.wiring.test.ts \
  src/components/content/contentHeaderDesktopParity.wiring.test.ts \
  src/components/content/mobileRouteViewport.wiring.test.ts
git commit -m "style: match Codex conversation page"
```

---

### Task 8: Verify regressions, compare visuals, and redeploy

**Files:**

- Modify: `docs/manual-test-catalog.md`

**Interfaces:**

- Consumes: completed Tasks 1-7.
- Produces: verified build and updated running Tailnet service.

- [ ] **Step 1: Update the manual test catalog**

Add exact scenarios:

```md
- Running local turn with a five-step plan and live file changes
- Desktop-owned running turn viewed from mobile
- Completed turn with Worked for disclosure and visible final answer
- Subagent spawn/wait/complete without child transcript leakage
- Command approval, permission approval, and user-input request
- Active, paused, blocked, limited, and completed goal
- Queue, steer, stop, dictation, attachment, model/effort/speed menus
- 320 px, 390 px, and 430 px viewport with software keyboard
```

- [ ] **Step 2: Run the focused current-page suite**

Run:

```shell
pnpm test:unit -- \
  src/components/content/conversationFooterState.test.ts \
  src/components/content/conversationTurnPresentation.test.ts \
  src/components/content/conversationRunFooter.wiring.test.ts \
  src/components/content/composerControlState.test.ts \
  src/components/content/conversationPageParity.wiring.test.ts \
  src/components/content/contentHeaderDesktopParity.wiring.test.ts \
  src/components/content/queuedMessagesDesktopParity.wiring.test.ts \
  src/components/content/threadConversationActivity.test.ts \
  src/components/content/threadConversationDesktopParity.wiring.test.ts \
  src/components/content/threadConversationSubAgent.wiring.test.ts \
  src/components/content/mobileRouteViewport.wiring.test.ts \
  src/components/content/externalThreadRuntime.wiring.test.ts \
  src/composables/useDesktopState.test.ts \
  src/api/codexGateway.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run the complete unit suite and build**

Run:

```shell
pnpm test:unit
pnpm build
```

Expected: every Vitest file passes; `vue-tsc`, Vite, and CLI build complete
without errors.

- [ ] **Step 4: Request browser permission and compare the same states**

Use the user's chosen browser only after explicit permission. Capture the
implemented mobile page and combine it with the supplied Codex desktop
references for inspection. Compare:

```text
content categories
activity/final-answer boundary
icon and label semantics
footer order and progress values
goal strip controls
composer button order and states
font roles, size, line height, spacing, borders, and radii
horizontal overflow and keyboard-safe positioning
```

Fix visible mismatches, repeat the focused tests/build, and compare again.

- [ ] **Step 5: Run requirements review, then code-quality review**

Review the complete diff against every acceptance criterion in the design.
After requirements pass, inspect projector complexity, duplicated state,
thread-isolation risks, stale event handling, accessibility, and unrelated
working-tree overlap.

- [ ] **Step 6: Commit verification documentation**

```shell
git add docs/manual-test-catalog.md
git commit -m "docs: cover conversation page parity"
```

- [ ] **Step 7: Install and redeploy the existing Tailnet mode**

Run:

```shell
pnpm install:local
pnpm network:tailnet
pnpm network:status
curl -fsS http://127.0.0.1:5900/ -o /dev/null
curl -fsS https://l008105.tailbffdfe.ts.net/ -o /dev/null
```

Expected:

- `codex-mobile-safe-tailnet.service` is active;
- the service binds `127.0.0.1:5900`;
- local and Tailnet requests return success;
- no persistent LAN service is left competing for the port.
