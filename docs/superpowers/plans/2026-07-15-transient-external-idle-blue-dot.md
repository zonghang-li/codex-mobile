# Transient External Idle Blue-Dot Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a still-running Desktop or CLI turn from becoming a blue unread dot when one runtime poll temporarily cannot find its rollout writer.

**Architecture:** Keep terminal rollout records authoritative. Change the external runtime probe so an unmatched start without writer evidence is `unknown`, then lock the existing browser lease behavior with a cross-poll regression that proves `running → unknown → unknown → running` never clears the spinner and only a later confirmed `idle` can create unread state. Terminal outcome remains outside the runtime response because every authoritative terminal stops the spinner and follows the same existing unread-summary rule.

**Tech Stack:** TypeScript, Vue 3 composables, Linux rollout runtime probe, Vitest, systemd user service.

## Global Constraints

- A matching `task_complete` or `turn_aborted` remains the only rollout evidence that returns `idle` for a previously started turn.
- An unmatched `task_started` without stable writer evidence returns `{ state: 'unknown' }`.
- Writer disappearance never infers completion.
- An established external browser lease remains `inProgress` across one or repeated `unknown` results.
- A cold `unknown` observation does not invent a new running lease.
- The existing runtime HTTP response schema is reused; do not add routes, fields, listeners, or authentication changes.
- Do not log rollout paths, process details, thread IDs, prompts, or output.
- Background polling remains paused while the browser document is hidden.
- Successful, failed, interrupted, and declined turns all stop the spinner when completion is authoritative, and all may show a blue unread dot when an unselected thread has new summary content.

## File Structure

- Modify `src/server/externalThreadRuntime.ts`: preserve the semantic difference between confirmed terminal and missing writer evidence.
- Modify `src/server/externalThreadRuntime.test.ts`: verify the server-side state mapping and its batch behavior.
- Modify `src/composables/useDesktopState.test.ts`: prove the sidebar remains working through transient `unknown` and becomes unread only after confirmed idle.
- Modify `docs/AGENT_GUIDE.md`: document the fail-closed UI runtime-state invariant.

---

### Task 1: Return Unknown for an Unmatched Start Without Writer Evidence

**Files:**
- Modify: `src/server/externalThreadRuntime.ts`
- Modify: `src/server/externalThreadRuntime.test.ts`

**Interfaces:**
- Consumes: `PreparedRuntimeInspection` values from `prepareInspection()` and one same-UID FD snapshot from `ExternalRuntimeSystem.listFdSnapshots()`.
- Produces: existing `ExternalThreadRuntime` union values `{ state: 'running', ... }`, `{ state: 'idle' }`, or `{ state: 'unknown' }` with no schema change.

- [ ] **Step 1: Change the no-writer test to the required fail-closed state**

Replace the existing expectation in `src/server/externalThreadRuntime.test.ts`:

```ts
it('returns unknown when an unmatched start has no live writer', async () => {
  const system = fakeRuntimeSystem({ log: lifecycle('task_started', 'turn-a') })

  await expect(registeredProbe(system).inspect('thread-1', 99)).resolves.toEqual({
    state: 'unknown',
  })
})
```

Add a batch case proving one missing writer does not change confirmed results for neighboring rows:

```ts
it('keeps missing writer evidence unknown beside running and terminal rows', async () => {
  const { probe } = batchProbe([
    { path: '/sessions/running', log: lifecycle('task_started', 'turn-running'), dev: '8', ino: '21' },
    { path: '/sessions/missing', log: lifecycle('task_started', 'turn-missing'), dev: '8', ino: '22' },
    {
      path: '/sessions/terminal',
      log: lifecycle('task_started', 'turn-terminal') + lifecycle('task_complete', 'turn-terminal'),
      dev: '8',
      ino: '23',
    },
  ], [writerFd({ dev: '8', ino: '21' })])

  await expect(probe.inspectMany(['running', 'missing', 'terminal'], 99)).resolves.toEqual({
    running: {
      state: 'running',
      turnId: 'turn-running',
      interruptible: false,
      source: 'external-session-writer',
    },
    missing: { state: 'unknown' },
    terminal: { state: 'idle' },
  })
})
```

- [ ] **Step 2: Run the server test and observe RED**

Run:

```bash
pnpm exec vitest run src/server/externalThreadRuntime.test.ts
```

Expected: the no-writer and batch expectations fail because unmatched rows without writer evidence currently return `idle`.

- [ ] **Step 3: Implement the one-line state correction**

In `ExternalThreadRuntimeProbe.inspectMany()`, keep writer-backed rows unchanged and replace only the unmatched no-writer fallback:

```ts
states[entry.threadId] = writers.has(entry.threadId)
  ? {
      state: 'running',
      turnId: runtime.turnId,
      interruptible: false,
      source: 'external-session-writer',
    }
  : { state: 'unknown' }
```

Do not change `prepareInspection()`: a rollout whose matching terminal has already been parsed must continue to enter `states` as `{ state: 'idle' }` before FD discovery.

- [ ] **Step 4: Run the server runtime suite**

Run:

```bash
pnpm exec vitest run src/server/externalThreadRuntime.test.ts src/api/codexGateway.test.ts
```

Expected: all tests pass; the gateway continues parsing the existing `{ state: 'unknown' }` response without schema changes.

- [ ] **Step 5: Commit the server correction**

```bash
git add src/server/externalThreadRuntime.ts src/server/externalThreadRuntime.test.ts
git commit -m "fix: keep missing external writers inconclusive"
```

---

### Task 2: Lock the Sidebar Through Transient Unknown Polls

**Files:**
- Modify: `src/composables/useDesktopState.test.ts`
- Modify: `docs/AGENT_GUIDE.md`

**Interfaces:**
- Consumes: `getThreadRuntimeStates()` results and the existing external lease stored in `runtimeOwnershipByThreadId`/`backgroundExternalThreadIds`.
- Produces: regression evidence that repeated `unknown` retains `inProgress` and suppresses `unread`, while confirmed `idle` performs the existing refresh exactly once regardless of terminal outcome.

- [ ] **Step 1: Add the full running/unknown/recovery/terminal regression**

Add beside the existing background external-runtime tests:

```ts
it('keeps the working indicator through missing writer evidence until confirmed idle', async () => {
  const state = await setupBackgroundRuntimeState()
  gatewayMocks.getThreadRuntimeStates
    .mockResolvedValueOnce({
      'thread-running': {
        state: 'running',
        turnId: 'turn-external',
        interruptible: false,
        source: 'external-session-writer',
      },
    })
    .mockResolvedValueOnce({ 'thread-running': { state: 'unknown' } })
    .mockResolvedValueOnce({ 'thread-running': { state: 'unknown' } })
    .mockResolvedValueOnce({
      'thread-running': {
        state: 'running',
        turnId: 'turn-external',
        interruptible: false,
        source: 'external-session-writer',
      },
    })
    .mockResolvedValueOnce({ 'thread-running': { state: 'idle' } })

  state.startPolling()
  pollingCleanups.push(() => state.stopPolling())

  await vi.advanceTimersByTimeAsync(0)
  await flushMicrotasks()
  expect(state.projectGroups.value[0]?.threads[0]).toMatchObject({ inProgress: true, unread: false })

  await vi.advanceTimersByTimeAsync(2_000)
  await flushMicrotasks()
  expect(state.projectGroups.value[0]?.threads[0]).toMatchObject({ inProgress: true, unread: false })

  await vi.advanceTimersByTimeAsync(2_000)
  await flushMicrotasks()
  expect(state.projectGroups.value[0]?.threads[0]).toMatchObject({ inProgress: true, unread: false })

  await vi.advanceTimersByTimeAsync(2_000)
  await flushMicrotasks()
  expect(state.projectGroups.value[0]?.threads[0]).toMatchObject({ inProgress: true, unread: false })

  gatewayMocks.getThreadGroupsPage.mockResolvedValue({
    groups: [{ projectName: 'Project', threads: [
      { ...thread('thread-running', '/tmp/project'), updatedAtIso: '2026-07-14T00:00:01.000Z' },
      thread('thread-selected', '/tmp/project'),
    ] }],
    nextCursor: null,
  })
  const refreshCallsBeforeTerminal = gatewayMocks.getThreadGroupsPage.mock.calls.length
  await vi.advanceTimersByTimeAsync(2_000)
  await flushMicrotasks()

  expect(state.projectGroups.value[0]?.threads[0]).toMatchObject({ inProgress: false, unread: true })
  expect(gatewayMocks.getThreadGroupsPage).toHaveBeenCalledTimes(refreshCallsBeforeTerminal + 1)
})
```

- [ ] **Step 2: Run the composable test before changing browser code**

Run:

```bash
pnpm exec vitest run src/composables/useDesktopState.test.ts
```

Expected: the regression passes with the existing browser `unknown` behavior, including both consecutive `unknown` polls. If it fails, make only the smallest browser fix needed to retain an established external lease; do not add idle debounce timers.

- [ ] **Step 3: Document the runtime invariant**

Add to the external runtime section in `docs/AGENT_GUIDE.md`:

```markdown
- An unmatched external `task_started` record with temporarily missing writer evidence is `unknown`, not `idle`. The browser retains an already-established working indicator across `unknown`; only a matching terminal lifecycle clears it and may create unread state.
- Terminal outcome does not change the sidebar indicator contract: successful, failed, interrupted, and declined turns all stop the spinner and may become unread when an unselected thread has new summary content. Keep the runtime response terminal-neutral.
```

- [ ] **Step 4: Run focused and complete verification**

Run:

```bash
pnpm exec vitest run \
  src/server/externalThreadRuntime.test.ts \
  src/api/codexGateway.test.ts \
  src/composables/useDesktopState.test.ts
pnpm run test:unit
pnpm exec vue-tsc --noEmit
pnpm exec tsc --noEmit -p tsconfig.server.json
pnpm run build
node dist-cli/safe.js doctor
git diff --check
```

Expected: all tests and type checks pass; build has only the existing chunk-size warning; doctor prints `codex-mobile-safe doctor: ok`.

- [ ] **Step 5: Commit the regression and documentation**

```bash
git add src/composables/useDesktopState.test.ts docs/AGENT_GUIDE.md
git commit -m "test: preserve working state through unknown runtime polls"
```

---

### Task 3: Review, Merge, and Redeploy

**Files:**
- No new product files.
- Do not commit build output, runtime state, logs, passwords, topics, or screenshots.

**Interfaces:**
- Consumes: Tasks 1 and 2 on `codex/fix-transient-idle-blue-dot`.
- Produces: reviewed `main`, merged GitHub PR, and restarted Tailnet-only `codex-mobile-safe` service.

- [ ] **Step 1: Request independent full-diff review**

Review `origin/main..HEAD` against the approved design and this plan. Fix every Critical or Important issue, then rerun the focused regression first and the complete verification commands from Task 2.

- [ ] **Step 2: Create and merge the PR**

```bash
git fetch --prune origin
git rebase origin/main
git push -u origin codex/fix-transient-idle-blue-dot
gh pr create --repo zonghang-li/codex-mobile --base main --head codex/fix-transient-idle-blue-dot
gh pr comment <PR_NUMBER> --repo zonghang-li/codex-mobile --body '/review'
gh pr merge <PR_NUMBER> --repo zonghang-li/codex-mobile --rebase --delete-branch
git fetch --prune origin
git switch main
git merge --ff-only origin/main
```

Expected: PR is merged, the remote feature branch is deleted, and local `main` equals `origin/main`.

- [ ] **Step 3: Reinstall and verify the service**

```bash
pnpm run service:install
codex-mobile-safe doctor
codex-mobile-safe status
ss -ltnp '( sport = :5900 )'
tailscale serve status
```

Expected: service is active, doctor passes, port 5900 listens only on `127.0.0.1`, and Tailscale Serve remains Tailnet-only.
