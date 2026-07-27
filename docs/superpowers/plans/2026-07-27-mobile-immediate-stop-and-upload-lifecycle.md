# Mobile Immediate Stop and Upload Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep submitted user messages continuously visible, make pending turns immediately stoppable, queue new input during a running turn, converge the composer to idle at completion, remove sent-message editing, and retain uploaded images until Codex safely accepts or rejects them.

**Architecture:** Separate optimistic submissions from persisted thread snapshots, and reconcile them only when an equivalent server user row arrives. Model submit/stop as generation-scoped pending operations so Stop can be requested before a turn ID exists and terminal reconciliation cannot mutate a newer turn. Move managed-upload ownership synchronously from composer to submission state before asynchronous startup.

**Tech Stack:** Vue 3 Composition API, TypeScript, Vitest, Codex app-server JSON-RPC, Vite, pnpm.

## Global Constraints

- Sent user messages are immutable; queued unsent messages retain existing edit/reorder behavior.
- A local running turn shows Stop only when the composer has no sendable draft.
- New input during a local running turn always enters the queue.
- Mobile never interrupts or mutates an externally owned turn.
- User uploads remain text-only `@filename` tokens and temporary paths are not persisted in drafts.
- Managed-upload cleanup remains idempotent and capability-scoped.
- Preserve all unrelated dirty-worktree changes.

---

## File Structure

- `src/components/content/composerControlState.ts`: pure primary-action derivation.
- `src/components/content/composerControlState.test.ts`: send/stop control contract.
- `src/components/content/ThreadComposer.vue`: emits queue submissions while running.
- `src/components/content/ThreadConversation.vue`: removes sent-message editing UI and rollback emission.
- `src/App.vue`: removes transcript rollback wiring and routes home-thread Stop.
- `src/composables/useDesktopState.ts`: optimistic-submission store, pending-stop generations, terminal convergence, and upload ownership.
- `src/composables/useDesktopState.test.ts`: state-machine and attachment lifecycle regression tests.
- `tests/chat-composer-rendering/*.md`: manual acceptance coverage.

### Task 1: Immutable Sent Messages and Running-Draft Queue Action

**Files:**
- Modify: `src/components/content/composerControlState.ts`
- Modify: `src/components/content/composerControlState.test.ts`
- Modify: `src/components/content/ThreadComposer.vue`
- Modify: `src/components/content/ThreadConversation.vue`
- Modify: `src/App.vue`
- Create: `src/components/content/conversationMessageActions.wiring.test.ts`

**Interfaces:**
- Consumes: `ComposerControlStateInput.hasSubmitContent` and `isTurnInProgress`.
- Produces: `deriveComposerControlState()` returning `primaryAction: 'send'` for a local running turn with content and `'stop'` for a local running turn without content.

- [ ] **Step 1: Write failing control and wiring tests**

```ts
it('uses Send for a local running draft and Stop after the draft clears', () => {
  expect(deriveComposerControlState({
    ...localIdle,
    runtimeOwnership: 'local',
    isTurnInProgress: true,
    hasSubmitContent: true,
  }).primaryAction).toBe('send')
  expect(deriveComposerControlState({
    ...localIdle,
    runtimeOwnership: 'local',
    isTurnInProgress: true,
    hasSubmitContent: false,
  }).primaryAction).toBe('stop')
})
```

```ts
expect(conversationSource).not.toContain('Edit message')
expect(conversationSource).not.toContain("emit('rollback'")
expect(appSource).not.toContain('@rollback="onRollback"')
expect(composerSource).toContain("props.isTurnInProgress ? 'queue' : 'steer'")
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm vitest run src/components/content/composerControlState.test.ts src/components/content/conversationMessageActions.wiring.test.ts
```

Expected: FAIL because a running draft still derives Stop and transcript rollback wiring still exists.

- [ ] **Step 3: Implement minimal UI behavior**

Change primary action selection to:

```ts
const primaryAction: ComposerPrimaryAction = !composerVisible
  ? 'hidden'
  : isExternal && input.isTurnInProgress
    ? 'externalRunning'
    : input.isTurnInProgress && !input.hasSubmitContent
      ? 'stop'
      : 'send'
```

In `ThreadComposer.vue`, make every running-turn submit path emit queue:

```ts
const submitMode = computed<'steer' | 'queue'>(() =>
  props.isTurnInProgress ? 'queue' : 'steer',
)
```

Use `submitMode` for form submit, button click, Enter, and dictation auto-send. Remove the user-message edit button, its edit lookup/helper, the `rollback` emit, `@rollback` in `App.vue`, and `onRollback`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
pnpm vitest run src/components/content/composerControlState.test.ts src/components/content/conversationMessageActions.wiring.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/content/composerControlState.ts src/components/content/composerControlState.test.ts src/components/content/ThreadComposer.vue src/components/content/ThreadConversation.vue src/App.vue src/components/content/conversationMessageActions.wiring.test.ts
git commit -m "fix(mobile): make running drafts queue-only"
```

### Task 2: Dedicated Optimistic Submission Layer

**Files:**
- Modify: `src/composables/useDesktopState.ts`
- Modify: `src/composables/useDesktopState.test.ts`

**Interfaces:**
- Produces: `optimisticUserMessagesByThreadId: Ref<Record<string, UiMessage[]>>`.
- Produces: `reconcileOptimisticUserMessages(threadId: string, persisted: UiMessage[]): void`.
- Consumes: existing `hasEquivalentUserMessage()` normalization.

- [ ] **Step 1: Write failing continuity tests**

Add tests that submit while `startThreadTurn` is unresolved, then reconcile a
detail/live snapshot without the new user row:

```ts
expect(state.messages.value.some((message) => message.text === 'next question')).toBe(true)
await state.loadMessages('thread-1', { force: true })
expect(state.messages.value.some((message) => message.text === 'next question')).toBe(true)
```

Then return an equivalent persisted user row and assert one visible copy:

```ts
expect(state.messages.value.filter((message) => message.text === 'next question')).toHaveLength(1)
expect(state.messages.value.find((message) => message.text === 'next question')?.messageType)
  .not.toBe('userMessage.optimistic')
```

- [ ] **Step 2: Run test and verify RED**

Run:

```bash
pnpm vitest run src/composables/useDesktopState.test.ts -t "optimistic"
```

Expected: FAIL when snapshot replacement removes the optimistic row or leaves a duplicate.

- [ ] **Step 3: Implement the optimistic layer**

Store optimistic rows outside persisted messages:

```ts
const optimisticUserMessagesByThreadId = ref<Record<string, UiMessage[]>>({})

function appendOptimisticUserMessage(
  threadId: string,
  text: string,
  imageUrls: string[] = [],
  skills: Array<{ name: string; path: string }> = [],
  fileAttachments: FileAttachment[] = [],
): string {
  const message = buildOptimisticUserMessage(
    threadId,
    text,
    imageUrls,
    skills,
    fileAttachments,
  )
  optimisticUserMessagesByThreadId.value = {
    ...optimisticUserMessagesByThreadId.value,
    [threadId]: [...(optimisticUserMessagesByThreadId.value[threadId] ?? []), message],
  }
  return message.id
}
```

Compose them without exposing them to snapshot replacement:

```ts
const optimistic = optimisticUserMessagesByThreadId.value[threadId] ?? []
const combined = [...persisted, ...optimistic, ...livePlan, ...liveCommands, ...liveFileChanges, ...liveAgent]
```

After every persisted reconciliation, remove only acknowledged optimistic rows:

```ts
function reconcileOptimisticUserMessages(threadId: string, persisted: UiMessage[]): void {
  const pending = optimisticUserMessagesByThreadId.value[threadId] ?? []
  const remaining = pending.filter((message) => !hasEquivalentUserMessage(message, persisted))
  optimisticUserMessagesByThreadId.value = remaining.length > 0
    ? { ...optimisticUserMessagesByThreadId.value, [threadId]: remaining }
    : omitKey(optimisticUserMessagesByThreadId.value, threadId)
}
```

Clear the store in thread removal/pruning/global reset paths.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
pnpm vitest run src/composables/useDesktopState.test.ts -t "optimistic"
```

Expected: PASS with continuous single-row rendering.

- [ ] **Step 5: Commit**

```bash
git add src/composables/useDesktopState.ts src/composables/useDesktopState.test.ts
git commit -m "fix(mobile): preserve optimistic user submissions"
```

### Task 3: Pending Stop Before Turn ID

**Files:**
- Modify: `src/composables/useDesktopState.ts`
- Modify: `src/composables/useDesktopState.test.ts`
- Modify: `src/App.vue`

**Interfaces:**
- Produces: `requestStopForSelectedSubmission(): Promise<void>`.
- Produces: `interruptPendingNewThreadSubmission(): void`.
- Maintains: generation-scoped pending stop entries keyed by thread ID, plus one pre-thread new-submission generation.

- [ ] **Step 1: Write failing pending-stop tests**

```ts
const pendingTurn = deferred<string>()
gatewayMocks.startThreadTurn.mockReturnValue(pendingTurn.promise)
const send = state.sendMessageToSelectedThread('run')
await flushMicrotasks()
const stop = state.interruptSelectedThreadTurn()
expect(gatewayMocks.interruptThreadTurn).not.toHaveBeenCalled()
pendingTurn.resolve('turn-new')
await send
await stop
expect(gatewayMocks.interruptThreadTurn).toHaveBeenCalledTimes(1)
expect(gatewayMocks.interruptThreadTurn).toHaveBeenCalledWith('thread-1', 'turn-new')
```

Add notification-first coverage where `turn/started` supplies `turn-new` before
the start RPC resolves, and new-thread coverage where Stop is clicked while
`thread/start` is pending.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm vitest run src/composables/useDesktopState.test.ts -t "pending stop|immediate stop"
```

Expected: FAIL because Stop returns when no active turn ID exists.

- [ ] **Step 3: Implement generation-scoped stop latches**

Use:

```ts
type PendingStopRequest = {
  generation: number
  interruptPromise: Promise<void> | null
}
```

On Stop without a turn ID, store the latch instead of returning. When
`startThreadTurn` or `turn/started` supplies the ID, atomically claim the latch
and call `interruptThreadTurn(threadId, turnId)` once. If cancellation is
requested before `turn/start` is issued, skip that RPC and settle the submission
as interrupted.

Expose new-thread pending state to the home composer:

```vue
:is-turn-in-progress="isSendingMessage"
@interrupt="onInterruptTurn"
```

Route `onInterruptTurn()` to pending-new-thread cancellation on the home route
and normal selected-thread interruption otherwise.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
pnpm vitest run src/composables/useDesktopState.test.ts -t "pending stop|immediate stop"
```

Expected: PASS; each submission interrupts at most once.

- [ ] **Step 5: Commit**

```bash
git add src/composables/useDesktopState.ts src/composables/useDesktopState.test.ts src/App.vue
git commit -m "fix(mobile): allow stop before turn id"
```

### Task 4: Terminal-State Convergence

**Files:**
- Modify: `src/composables/useDesktopState.ts`
- Modify: `src/composables/useDesktopState.test.ts`
- Modify: `src/composables/threadLifecycle.ts`
- Modify: `src/composables/threadLifecycle.test.ts`

**Interfaces:**
- Consumes: `resolveTurnCompletionDisposition()`.
- Produces: one generation-checked authoritative detail reconciliation for a mismatched local completion.

- [ ] **Step 1: Write failing completion tests**

Cover matching completion immediately clearing running state and mismatched
completion probing detail:

```ts
emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'stale-id', status: 'completed' } } })
gatewayMocks.getThreadDetail.mockResolvedValue(idleDetail())
await flushTimersAndPromises()
expect(state.selectedThread.value?.inProgress).toBe(false)
expect(state.selectedActiveTurnId.value).toBe('')
```

Add the inverse case where detail reports a newer local turn and assert running
state adopts that turn ID.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm vitest run src/composables/threadLifecycle.test.ts src/composables/useDesktopState.test.ts -t "completion|terminal"
```

Expected: FAIL because mismatched completion keeps the cached lease indefinitely.

- [ ] **Step 3: Implement authoritative mismatch repair**

Keep matching completion synchronous. For mismatches, capture selection/runtime
generation, fetch one detail snapshot, discard stale responses, then either:

```ts
if (!detail.inProgress) {
  activeTurnIdByThreadId.value = omitKey(activeTurnIdByThreadId.value, threadId)
  setThreadRuntimeOwnership(threadId, 'idle')
  setThreadInProgress(threadId, false)
  setTurnActivityForThread(threadId, null)
} else if (detail.ownership === 'local' && detail.activeTurnId) {
  activeTurnIdByThreadId.value = { ...activeTurnIdByThreadId.value, [threadId]: detail.activeTurnId }
  setThreadInProgress(threadId, true)
}
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
pnpm vitest run src/composables/threadLifecycle.test.ts src/composables/useDesktopState.test.ts -t "completion|terminal"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/composables/useDesktopState.ts src/composables/useDesktopState.test.ts src/composables/threadLifecycle.ts src/composables/threadLifecycle.test.ts
git commit -m "fix(mobile): converge stale terminal state"
```

### Task 5: Managed Upload Handoff and Missing Screenshot

**Files:**
- Modify: `src/composables/managedUploadLease.ts`
- Modify: `src/composables/managedUploadLease.test.ts`
- Modify: `src/composables/useDesktopState.ts`
- Modify: `src/composables/useDesktopState.test.ts`
- Modify: `src/components/content/ThreadComposer.vue`
- Modify: `src/server/codexAppServerBridge.security.test.ts`

**Interfaces:**
- Extends: `ManagedUploadLease` with explicit ownership transfer performed synchronously at submission acceptance.
- Consumes: `PendingTurnRequest` as the owner through final acceptance/failure.

- [ ] **Step 1: Write failing ownership-order tests**

Instrument a lease cleanup mock and an unresolved resume/start promise. Assert
that composer cleanup/release cannot delete the upload after submit accepts it:

```ts
const send = state.sendMessageToSelectedThread('inspect', [managedImageUrl])
await flushMicrotasks()
expect(gatewayMocks.cleanupManagedUploads).not.toHaveBeenCalled()
expect(gatewayMocks.startThreadTurn).toHaveBeenCalledWith(
  'thread-1',
  'inspect',
  [managedImageUrl],
  expect.anything(),
  expect.anything(),
  undefined,
  [],
  'default',
)
```

Add immediate-stop-before-acceptance, fallback retry, final failure, and
idempotent server cleanup cases.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm vitest run src/composables/managedUploadLease.test.ts src/composables/useDesktopState.test.ts src/server/codexAppServerBridge.security.test.ts -t "upload|attachment|screenshot"
```

Expected: at least one lifecycle race test FAILS before ownership is transferred at the synchronous boundary.

- [ ] **Step 3: Implement explicit handoff**

Transfer capability ownership before the first awaited operation and keep the
pending request as owner:

```ts
setPendingTurnRequest(threadId, request)
onPendingTurnEstablished?.()
// Only now may resume/start await.
```

Ensure every caller invokes `uploadLease.transfer` from that synchronous
callback and only `releasePendingTurnRequest()` performs terminal/final-failure
cleanup after transfer. Preserve the same pending request across unsupported
model fallback. Do not shorten the one-hour reaper TTL.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
pnpm vitest run src/composables/managedUploadLease.test.ts src/composables/useDesktopState.test.ts src/server/codexAppServerBridge.security.test.ts -t "upload|attachment|screenshot"
```

Expected: PASS with no early cleanup and exactly-once final cleanup.

- [ ] **Step 5: Commit**

```bash
git add src/composables/managedUploadLease.ts src/composables/managedUploadLease.test.ts src/composables/useDesktopState.ts src/composables/useDesktopState.test.ts src/components/content/ThreadComposer.vue src/server/codexAppServerBridge.security.test.ts
git commit -m "fix(mobile): retain uploads through turn handoff"
```

### Task 6: Acceptance Documentation, Full Verification, and Redeployment

**Files:**
- Modify: `tests/chat-composer-rendering/index.md`
- Create: `tests/chat-composer-rendering/immutable-submit-immediate-stop-and-queue.md`
- Modify: `tests/chat-composer-rendering/ephemeral-user-image-attachment-tokens.md`

**Interfaces:**
- Consumes all prior tasks.
- Produces manual acceptance coverage and a verified deployed service.

- [ ] **Step 1: Add the manual scenario**

Document these checks:

```text
1. Submit and confirm the user row never disappears.
2. Click Stop before any model output and confirm the task interrupts.
3. While running, type a second message; confirm Send replaces Stop.
4. Submit it; confirm it appears in the queue and Stop returns.
5. Let the final turn finish; confirm Send returns without refresh.
6. Attach a screenshot, submit, and confirm Codex can read it.
7. Confirm sent user rows have no Edit message action.
```

- [ ] **Step 2: Run focused and full verification**

Run:

```bash
pnpm vitest run src/components/content/composerControlState.test.ts src/components/content/conversationMessageActions.wiring.test.ts src/composables/threadLifecycle.test.ts src/composables/managedUploadLease.test.ts src/composables/useDesktopState.test.ts src/server/codexAppServerBridge.security.test.ts
pnpm run test:unit
pnpm run build
```

Expected: all tests and the production build PASS.

- [ ] **Step 3: Restart and inspect the service**

Run:

```bash
codex-mobile-safe stop
codex-mobile-safe start /home/zonghangli/Desktop/prima.cpp --port 5900 --no-open --sandbox-mode danger-full-access --approval-policy never
codex-mobile-safe status
codex-mobile-safe urls
```

Expected: a new live PID, port `5900`, password protection enabled, and the configured access mode unchanged from before restart.

- [ ] **Step 4: Commit acceptance docs**

```bash
git add tests/chat-composer-rendering/index.md tests/chat-composer-rendering/immutable-submit-immediate-stop-and-queue.md tests/chat-composer-rendering/ephemeral-user-image-attachment-tokens.md
git commit -m "test(mobile): cover immediate submit lifecycle"
```
