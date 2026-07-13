# Turn Running Lease Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the mobile composer in its running/stop state until the completion event for the currently active Codex turn arrives.

**Architecture:** Extend the pure thread lifecycle decision helper with turn-ID ownership, then use that ownership in `useDesktopState` to guard every terminal UI cleanup. Reconcile backend thread details with an existing local lease so a lagging idle snapshot cannot clear a turn established by `turn/started`.

**Tech Stack:** Vue 3 composables, TypeScript 5.7, Vitest 4, pnpm, Codex app-server RPC notifications.

## Global Constraints

- `turn/started(A)` creates an authoritative local running lease for A.
- Only `turn/completed(A)` may release A; a completion for another turn must not alter the newer turn's live UI state.
- A backend active detail may establish or replace a lease; a backend idle detail may clear state only when no local lease exists.
- Preserve fallback retry, unread, selected-thread, and non-success completion behavior.
- Do not add polling, new RPC endpoints, dependencies, or timeout-based state transitions.

---

## File Structure

- `src/composables/threadLifecycle.ts`: pure turn-completion ownership and unread/running decision.
- `src/composables/threadLifecycle.test.ts`: exhaustive pure decision-table tests.
- `src/composables/useDesktopState.ts`: notification handling and backend-detail reconciliation using the pure decision.
- `src/composables/useDesktopState.test.ts`: integration regressions for stale completion events, stop targeting, and lagging idle details.

### Task 1: Add Turn-ID Ownership to the Pure Lifecycle Decision

**Files:**
- Modify: `src/composables/threadLifecycle.ts`
- Test: `src/composables/threadLifecycle.test.ts`

**Interfaces:**
- Consumes: terminal status, fallback-retry flag, selected-thread flag, local active turn ID, completed turn ID.
- Produces: `resolveTurnCompletionDisposition(status, willRetry, isSelected, activeTurnId?, completedTurnId?)` returning `{ ownsActiveLease, keepRunning, markUnread }`.

- [ ] **Step 1: Write the failing ownership tests**

Add the ownership fields to the existing table and add explicit stale/matching cases:

```ts
expect(resolveTurnCompletionDisposition('completed', false, true, 'turn-b', 'turn-a')).toEqual({
  ownsActiveLease: false,
  keepRunning: true,
  markUnread: false,
})
expect(resolveTurnCompletionDisposition('completed', false, true, 'turn-b', 'turn-b')).toEqual({
  ownsActiveLease: true,
  keepRunning: false,
  markUnread: false,
})
expect(resolveTurnCompletionDisposition('completed', false, false, '', 'turn-a')).toEqual({
  ownsActiveLease: true,
  keepRunning: false,
  markUnread: true,
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm vitest run src/composables/threadLifecycle.test.ts`

Expected: FAIL because `ownsActiveLease` is absent and a stale completion currently returns `keepRunning: false`.

- [ ] **Step 3: Implement the minimal pure decision**

Replace the result type and decision body with:

```ts
export type TurnCompletionDisposition = {
  ownsActiveLease: boolean
  keepRunning: boolean
  markUnread: boolean
}

export function resolveTurnCompletionDisposition(
  status: TurnTerminalStatus,
  willRetry: boolean,
  isSelected: boolean,
  activeTurnId = '',
  completedTurnId = '',
): TurnCompletionDisposition {
  const ownsActiveLease = !activeTurnId || activeTurnId === completedTurnId
  if (!ownsActiveLease) {
    return { ownsActiveLease: false, keepRunning: true, markUnread: false }
  }
  if (willRetry) {
    return { ownsActiveLease: true, keepRunning: true, markUnread: false }
  }
  return {
    ownsActiveLease: true,
    keepRunning: false,
    markUnread: status === 'completed' && !isSelected,
  }
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm vitest run src/composables/threadLifecycle.test.ts`

Expected: PASS with all decision-table and ownership cases green.

- [ ] **Step 5: Commit the pure lifecycle change**

```bash
git add src/composables/threadLifecycle.ts src/composables/threadLifecycle.test.ts
git commit -m "fix: make turn completion ownership explicit"
```

### Task 2: Protect Active UI State from Stale Completion and Idle Detail Races

**Files:**
- Modify: `src/composables/useDesktopState.ts`
- Test: `src/composables/useDesktopState.test.ts`

**Interfaces:**
- Consumes: `TurnCompletionDisposition.ownsActiveLease` from Task 1 and `activeTurnIdByThreadId` as the local lease store.
- Produces: notification cleanup guarded by ownership and detail reconciliation that retains an existing local lease.

- [ ] **Step 1: Write the lagging-idle integration test**

Add a test in `describe('turn completion lifecycle')` that starts A, returns an idle detail, loads it, and verifies both the running flag and interrupt target:

```ts
it('retains an event-established turn across a lagging idle detail', async () => {
  const { state, emit } = await setupTurnLifecycleNotificationState('thread-1')
  gatewayMocks.resumeThread.mockResolvedValue({
    messages: [], inProgress: false, activeTurnId: '', hasMoreOlder: false, turnIndexByTurnId: {},
  })
  gatewayMocks.interruptThreadTurn.mockRejectedValue(new Error('expected stop probe'))

  emit({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-a' } } })
  await state.loadMessages('thread-1', { silent: true })

  expect(state.projectGroups.value[0]?.threads[0]?.inProgress).toBe(true)
  await state.interruptSelectedThreadTurn()
  expect(gatewayMocks.interruptThreadTurn).toHaveBeenCalledWith('thread-1', 'turn-a')
})
```

- [ ] **Step 2: Write the stale-completion integration test**

Add a test that starts A then B, completes A, and proves B still owns the UI and stop request before completing B:

```ts
it('ignores an older completion while a newer turn owns the running lease', async () => {
  const { state, emit } = await setupTurnLifecycleNotificationState('thread-1')
  gatewayMocks.interruptThreadTurn.mockRejectedValue(new Error('expected stop probe'))
  emit({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-a' } } })
  emit({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-b' } } })
  emit({
    method: 'turn/completed',
    params: { threadId: 'thread-1', turn: { id: 'turn-a', status: 'failed', error: { message: 'stale failure' } } },
  })

  expect(state.projectGroups.value[0]?.threads[0]).toMatchObject({ inProgress: true, unread: false })
  expect(state.messages.value.some((message) => message.messageType === 'worked')).toBe(false)
  expect(state.selectedLiveOverlay.value?.errorText).toBe('')
  await state.interruptSelectedThreadTurn()
  expect(gatewayMocks.interruptThreadTurn).toHaveBeenCalledWith('thread-1', 'turn-b')

  emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-b', status: 'completed' } } })
  expect(state.projectGroups.value[0]?.threads[0]?.inProgress).toBe(false)
})
```

- [ ] **Step 3: Run the two integration tests and verify RED**

Run: `pnpm vitest run src/composables/useDesktopState.test.ts -t "lagging idle detail|older completion"`

Expected: FAIL because the idle detail clears A and the completion for A clears B.

- [ ] **Step 4: Add backend-authority coverage without a local lease**

Add a table-driven integration test which loads a selected thread without emitting `turn/started` first:

```ts
it.each([
  [true, 'turn-server', true],
  [false, '', false],
])('uses backend running=%s when no local lease exists', async (serverInProgress, activeTurnId, expected) => {
  const { state } = await setupTurnLifecycleNotificationState('thread-1')
  gatewayMocks.resumeThread.mockResolvedValue({
    messages: [], inProgress: serverInProgress, activeTurnId, hasMoreOlder: false, turnIndexByTurnId: {},
  })
  await state.loadMessages('thread-1', { silent: true })
  expect(state.projectGroups.value[0]?.threads[0]?.inProgress).toBe(expected)
})
```

This proves an active backend turn restores the lease after reload while an idle backend result with no lease stays idle.

- [ ] **Step 5: Run the integration tests and verify RED**

Run: `pnpm vitest run src/composables/useDesktopState.test.ts -t "lagging idle detail|older completion|when no local lease exists"`

Expected: the two backend-authority rows pass on the existing behavior, while both race regressions fail.

- [ ] **Step 6: Reconcile detail state with the local lease**

In `loadMessages`, replace fallback-only retention with local-lease retention:

```ts
const localActiveTurnId = activeTurnIdByThreadId.value[threadId] ?? ''
const retainLocalInProgress = localActiveTurnId.length > 0
const inProgress = serverInProgress || retainLocalInProgress
```

Keep assigning `activeTurnId` when the backend reports one. Only omit a local active ID on backend idle when `retainLocalInProgress` is false.

- [ ] **Step 7: Guard terminal notification cleanup by turn ownership**

Pass IDs into the pure helper before mutating active state:

```ts
const disposition = resolveTurnCompletionDisposition(
  completedTurn.status,
  shouldRetryWithFallback,
  completedTurn.threadId === selectedThreadId.value,
  activeTurnIdByThreadId.value[completedTurn.threadId] ?? '',
  completedTurn.turnId,
)
```

Always remove the completed ID from `pendingTurnStartsById`, but wrap these current-turn mutations in `if (disposition.ownsActiveLease)`: setting the turn summary/error, omitting the active ID, clearing delayed sync, suppressing or marking unread, clearing live activity/reasoning/commands, clearing the pending request, queue refresh, and starting a fallback retry. A stale completion must leave those values untouched; event-driven message synchronization still persists its output.

- [ ] **Step 8: Run the integration tests and verify GREEN**

Run: `pnpm vitest run src/composables/useDesktopState.test.ts -t "lagging idle detail|older completion"`

Expected: PASS; A survives an idle snapshot, stale A cannot clear B, stop targets B, and matching completion B returns idle.

- [ ] **Step 9: Run lifecycle regression tests**

Run: `pnpm vitest run src/composables/threadLifecycle.test.ts src/composables/useDesktopState.test.ts`

Expected: PASS, including fallback retry and unread behavior.

- [ ] **Step 10: Commit the integrated state fix**

```bash
git add src/composables/useDesktopState.ts src/composables/useDesktopState.test.ts
git commit -m "fix: retain running state until active turn completes"
```

### Task 3: Verify, Review, Integrate, and Deploy

**Files:**
- Modify only if verification exposes a defect; otherwise no source changes.

**Interfaces:**
- Consumes: committed lifecycle and desktop-state fixes from Tasks 1 and 2.
- Produces: reviewed main branch, pushed GitHub state, rebuilt local install, and tailnet-only running service.

- [ ] **Step 1: Run static and full automated verification**

```bash
git diff --check main...HEAD
pnpm test:unit
pnpm build
```

Expected: no whitespace errors; all Vitest tests pass; Vue type-check, Vite frontend build, and CLI build succeed.

- [ ] **Step 2: Request independent code review**

Provide the design, plan, and `main...HEAD` diff to a review agent. Expected: no unresolved correctness issue concerning stale events, fallback retry, unread state, error overlays, or active stop targeting.

- [ ] **Step 3: Merge and push**

```bash
git checkout main
git pull --ff-only origin main
git merge --ff-only codex/fix-turn-running-lease
git push origin main
```

Expected: local `main` and `origin/main` point to the same lifecycle-fix commit.

- [ ] **Step 4: Reinstall and restart the safe service**

```bash
pnpm install:local
pnpm service:install
pnpm service:restart
codex-mobile-safe doctor
pnpm service:status
```

Expected: doctor passes and `codex-mobile-safe.service` is active with the application listening only on `127.0.0.1:5900`.

- [ ] **Step 5: Verify tailnet-only exposure and mobile behavior**

Confirm Tailscale Serve still maps `https://l008105.tailbffdfe.ts.net/` to `http://127.0.0.1:5900`, no LAN/public listener exists, and a live mobile turn keeps the stop control visible until its matching terminal event.

- [ ] **Step 6: Record final evidence**

Report the test totals, build result, review outcome, merged commit, GitHub synchronization, service status, loopback bind, and Tailscale Serve mapping.
