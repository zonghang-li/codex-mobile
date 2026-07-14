# Selected Idle External Turn Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a mobile page that is already showing an idle task automatically discover a new desktop-owned turn and display its input, reasoning summary, and output without reload.

**Architecture:** Reuse the existing background runtime batch as an idle-to-external discovery probe for the eligible selected task. Capture whether each request began with that task selected, apply strict selection/local-authority/generation fences, then hand a newly running selected task immediately to the existing marked external detail poller.

**Tech Stack:** TypeScript, Vue 3 composables, Vitest fake timers, pnpm, systemd user service, Tailscale Serve.

## Global Constraints

- The runtime batch cadence remains 2,000 ms after settlement and at most one batch request is in flight.
- At most one selected external detail request is in flight; discovery must hand off immediately without adding a timer or endpoint.
- Selected local and already-external tasks are excluded from idle discovery.
- Hidden pages issue no runtime or detail requests and resume with one immediate eligible probe.
- Desktop-owned work never receives local interrupt authority or a local active-turn lease.
- Keep the service on `127.0.0.1:5900`; do not change authentication, Tailscale Serve, ntfy, or notification behavior.

---

### Task 1: Discover and hand off a selected idle task

**Files:**
- Modify: `src/composables/useDesktopState.test.ts`
- Modify: `src/composables/useDesktopState.ts:2547-2770`

**Interfaces:**
- Consumes: `getThreadRuntimeStates(threadIds, signal)`, `setThreadRuntimeOwnership()`, `setThreadInProgress()`, and `scheduleExternalRuntimePolling()`.
- Produces: `backgroundRuntimeCandidateIds()` that reserves a batch slot for an eligible selected task; `pollBackgroundRuntimeStates(..., requestedSelectedThreadId, ...)` that can safely promote that same task; `setThreadRuntimeOwnership(..., { externalPollDelayMs })` for immediate detail handoff.

- [ ] **Step 1: Write the failing selected-idle discovery test**

Add this case under `describe('external runtime ownership', ...)`:

```ts
it('discovers a new desktop turn for the selected idle task and immediately loads its output', async () => {
  const state = await setupBackgroundRuntimeState()
  gatewayMocks.getThreadRuntimeStates.mockResolvedValue({
    'thread-selected': {
      state: 'running',
      turnId: 'turn-external',
      interruptible: false,
      source: 'external-session-writer',
    },
  })
  gatewayMocks.getExternalThreadLiveSnapshot.mockResolvedValue({
    ...externalDetail('turn-external'),
    messages: [
      { id: 'user-external', role: 'user', text: 'desktop input', messageType: 'userMessage', turnId: 'turn-external' },
      { id: 'reasoning-external', role: 'assistant', text: '**Inspecting state**', messageType: 'reasoning', turnId: 'turn-external' },
      { id: 'agent-external', role: 'assistant', text: 'desktop output', messageType: 'agentMessage', turnId: 'turn-external' },
    ],
  })

  state.startPolling()
  pollingCleanups.push(() => state.stopPolling())
  await vi.advanceTimersByTimeAsync(0)
  await flushMicrotasks()

  expect(gatewayMocks.getThreadRuntimeStates).toHaveBeenCalledWith(
    ['thread-selected', 'thread-running'],
    expect.any(AbortSignal),
  )
  expect(state.selectedThreadRuntimeOwnership.value).toBe('external')
  expect(state.selectedThread.value).toMatchObject({ inProgress: true })

  await vi.advanceTimersByTimeAsync(0)
  await flushMicrotasks()
  expect(gatewayMocks.getExternalThreadLiveSnapshot).toHaveBeenCalledTimes(1)
  expect(state.messages.value).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'user-external', text: 'desktop input' }),
    expect.objectContaining({ id: 'agent-external', text: 'desktop output' }),
  ]))
  expect(state.selectedLiveOverlay.value?.activityLabel).toBe('Inspecting state')
})
```

- [ ] **Step 2: Run the focused test and verify the blind spot**

Run:

```bash
pnpm exec vitest run src/composables/useDesktopState.test.ts -t 'discovers a new desktop turn for the selected idle task'
```

Expected: FAIL because the batch contains only `thread-running`, the selected task remains `idle`, and no external snapshot is requested.

- [ ] **Step 3: Add selected-task eligibility and request-scope capture**

Refactor the candidate builder so it reserves the first slot for an eligible selected task and then preserves group order for the remaining rows:

```ts
function isBackgroundRuntimeCandidate(threadId: string): boolean {
  if (!threadId) return false
  const ownership = runtimeOwnershipByThreadId.value[threadId] ?? 'idle'
  const locallyRunning = inProgressById.value[threadId] === true && ownership !== 'external'
  return ownership !== 'local' && ownership !== 'external' && !locallyRunning
}

function backgroundRuntimeCandidateIds(): string[] {
  const threads = flattenThreads(sourceGroups.value)
  const selectedId = selectedThreadId.value
  const ids: string[] = []
  if (threads.some((thread) => thread.id === selectedId) && isBackgroundRuntimeCandidate(selectedId)) {
    ids.push(selectedId)
  }
  for (const thread of threads) {
    if (ids.length >= BACKGROUND_RUNTIME_BATCH_LIMIT) break
    if (!thread.id || thread.id === selectedId) continue
    const ownership = runtimeOwnershipByThreadId.value[thread.id] ?? 'idle'
    const locallyRunning = inProgressById.value[thread.id] === true && ownership !== 'external'
    if (ownership === 'local' || locallyRunning) continue
    ids.push(thread.id)
    if (ownership === 'external') backgroundExternalThreadIds.add(thread.id)
  }
  return ids
}
```

Capture `selectedThreadId.value` when the batch begins and pass it to `pollBackgroundRuntimeStates`:

```ts
const requestedSelectedThreadId = selectedThreadId.value
const promise = pollBackgroundRuntimeStates(
  threadIds,
  requestedSelectedThreadId,
  localAuthorityVersions,
  selectionVersions,
  generation,
  controller.signal,
)
```

- [ ] **Step 4: Apply the selected result behind stale-result fences and hand off immediately**

Add `requestedSelectedThreadId: string` to `pollBackgroundRuntimeStates`. Before applying each result, distinguish selected-at-request from background-at-request:

```ts
const wasSelectedAtRequest = requestedSelectedThreadId === threadId
const isSelectedNow = selectedThreadId.value === threadId
if (wasSelectedAtRequest !== isSelectedNow) continue
```

Keep the existing selection-version and local-authority checks. Promote a valid selected `running` result with a zero-delay detail handoff:

```ts
if (runtime.state === 'running') {
  backgroundExternalThreadIds.add(threadId)
  setThreadRuntimeOwnership(threadId, 'external', {
    externalPollDelayMs: isSelectedNow ? 0 : undefined,
  })
  setThreadInProgress(threadId, true)
  continue
}
```

Extend the ownership setter without changing existing callers:

```ts
function setThreadRuntimeOwnership(
  threadId: string,
  ownership: ThreadRuntimeOwnership,
  options: { externalPollDelayMs?: number } = {},
): void {
  // existing state and authority updates remain unchanged
  if (selectedThreadId.value !== threadId) return
  if (ownership === 'external') {
    scheduleExternalRuntimePolling(threadId, options.externalPollDelayMs)
  } else if (currentOwnership === 'external' || ownership === 'local') {
    cancelExternalRuntimePolling()
  }
}
```

- [ ] **Step 5: Run the focused test and update exact batch expectations**

Run:

```bash
pnpm exec vitest run src/composables/useDesktopState.test.ts -t 'external runtime ownership'
```

Expected: PASS after updating existing exact candidate expectations to include the eligible selected task first. The 50-row test must expect `thread-selected` followed by `thread-0` through `thread-48`, preserving the hard limit of 50.

- [ ] **Step 6: Commit the independently working discovery path**

```bash
git add src/composables/useDesktopState.ts src/composables/useDesktopState.test.ts
git commit -m "fix: discover desktop turns in selected idle tasks"
```

---

### Task 2: Lock down authority, visibility, cadence, and manual coverage

**Files:**
- Modify: `src/composables/useDesktopState.test.ts`
- Create: `tests/chat-composer-rendering/selected-idle-desktop-turn-live-sync.md`
- Modify: `tests/chat-composer-rendering/index.md`

**Interfaces:**
- Consumes: the selected-idle batch discovery and immediate external detail handoff from Task 1.
- Produces: regression coverage for idle/unknown, local/external exclusion, stale selection/local takeover, hidden/visible lifecycle, and request cardinality; a repeatable manual acceptance procedure.

- [ ] **Step 1: Add exclusion and no-op result tests**

Add focused cases which assert:

```ts
expect(runtimeBatchIds).toContain('thread-selected')
expect(gatewayMocks.getExternalThreadLiveSnapshot).not.toHaveBeenCalled()
```

for selected `idle` and `unknown` results, then create local and external selected states and assert:

```ts
expect(runtimeBatchIds).not.toContain('thread-selected')
```

The local state should be established with a `turn/started` notification. The external state should be established by `loadMessages()` returning `externalDetail()` so the existing detail poller, not the batch, owns it.

- [ ] **Step 2: Add deferred stale-result tests**

Use `deferred()` to hold a selected `running` batch result. Cover deselection and local takeover before resolution:

```ts
const pending = deferred<Record<string, {
  state: 'running'
  turnId: string
  interruptible: false
  source: string
}>>()
gatewayMocks.getThreadRuntimeStates.mockReturnValue(pending.promise)
state.startPolling()
await vi.advanceTimersByTimeAsync(0)

state.primeSelectedThread('thread-running')
pending.resolve({
  'thread-selected': {
    state: 'running',
    turnId: 'turn-stale',
    interruptible: false,
    source: 'external-session-writer',
  },
})
await flushMicrotasks()

expect(gatewayMocks.getExternalThreadLiveSnapshot).not.toHaveBeenCalled()
expect(state.projectGroups.value[0]?.threads.find((row) => row.id === 'thread-selected'))
  .toMatchObject({ inProgress: false })
```

For local takeover, emit `turn/started` for `thread-selected` before resolving and assert ownership remains `local` and no external detail request starts.

Add one stopped-poller variant: call `state.stopPolling()` before resolving the selected `running` result, then assert the aborted/stale response cannot establish external ownership or schedule a detail read. Add one rejection variant where the first batch rejects and the next scheduled batch succeeds with `idle`; assert current state is preserved and the second call occurs 2,000 ms after the rejected request settles.

- [ ] **Step 3: Add hidden/visible and request-cardinality tests**

Start with `document.visibilityState = 'hidden'`, call `startPolling()`, advance ten seconds, and assert neither runtime nor detail requests occur. Change visibility to `visible`, invoke the registered handler, and assert exactly one immediate batch request.

Resolve that batch as selected `running`, advance zero milliseconds, and assert exactly one detail request. Advance time while the detail promise remains pending and assert it stays at one. Resolve it, advance 1,999 ms and then 1 ms, and assert the second detail request begins only at the post-settlement 2,000 ms boundary.

- [ ] **Step 4: Run all desktop-state tests**

Run:

```bash
pnpm exec vitest run src/composables/useDesktopState.test.ts
```

Expected: all tests pass with no unhandled promise rejection and no request-count regression.

- [ ] **Step 5: Add the manual acceptance procedure and index entry**

Create `tests/chat-composer-rendering/selected-idle-desktop-turn-live-sync.md` with:

```markdown
### Selected idle desktop turn live sync

#### Prerequisites

- Install and run the current `codex-mobile-safe` checkout on `127.0.0.1:5900`.
- Keep Tailscale Serve Tailnet-only and open the HTTPS URL on the phone.
- Have the same idle task visible in Codex desktop and selected in mobile Chrome.

#### Steps

1. Leave the task selected and idle on mobile.
2. Send a new prompt in that task from Codex desktop.
3. Without refreshing mobile, wait one normal two-second discovery cycle.
4. Confirm mobile changes to running and shows the desktop input, detailed reasoning summary, and output.
5. Confirm runtime discovery stops for the selected task after external detail polling starts.
6. Background mobile Chrome, advance the desktop turn, and confirm no mobile requests occur while hidden.
7. Foreground Chrome and confirm one immediate probe or detail refresh catches up.
8. Finish the desktop turn and confirm final output appears before the running state clears.

#### Expected Results

- The idle-to-running transition and messages appear without reload.
- Runtime and detail requests never overlap within their respective pollers.
- Local turns remain interruptible; desktop-owned turns remain non-interruptible.
- No authentication, Tailnet exposure, or completion-notification behavior changes.

#### Rollback/Cleanup

- Finish or interrupt the test task from its owning desktop client.
- Revert the selected-idle candidate and handoff commit to restore the previous polling behavior.
```

Add its link to `tests/chat-composer-rendering/index.md`.

- [ ] **Step 6: Commit regression and manual coverage**

```bash
git add src/composables/useDesktopState.test.ts tests/chat-composer-rendering/selected-idle-desktop-turn-live-sync.md tests/chat-composer-rendering/index.md
git commit -m "test: cover selected idle desktop turn sync"
```

---

### Task 3: Verify, integrate, install, and accept

**Files:**
- Verify only: all changed files and built artifacts
- Evidence: sanitized files under `/tmp`

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: reviewed commit history, merged and pushed `main`, installed safe service, Tailnet-only runtime, and acceptance evidence.

- [ ] **Step 1: Run focused and full verification**

Run:

```bash
pnpm exec vitest run src/composables/useDesktopState.test.ts
pnpm run test:unit
pnpm run build
node dist-cli/index.js --help
node dist-cli/safe.js doctor
```

Expected: all tests pass, frontend/CLI builds succeed, compatibility help exits zero, and doctor reports all safe invariants passing.

- [ ] **Step 2: Perform the required performance audit**

Inspect the focused fake-timer request counts and the production code path. Record evidence under `/tmp` showing:

```text
visible selected idle: one lightweight batch request per settled 2000 ms cycle
new external transition: one immediate detail request
selected external: absent from subsequent batch candidates
hidden: zero runtime and detail requests
detail pending: maximum in-flight detail requests = 1
```

Reject completion if selected external tasks appear in both pollers or if any request overlaps.

- [ ] **Step 3: Review branch state and diff before integration**

Run:

```bash
git status --short
git diff --check main...HEAD
git diff --stat main...HEAD
git log --oneline main..HEAD
```

Expected: clean feature branch, no whitespace errors, and only the design, plan, state implementation/tests, and manual test docs are changed.

- [ ] **Step 4: Rebase, push, and integrate through GitHub**

Follow `AGENTS.md`: fetch `origin`, inspect any existing PR, rebase the feature branch on current `main`, rerun focused tests after the rebase, push the branch, create/update the PR, and merge only when checks are green. Then synchronize local `main` with `origin/main` and verify it contains the implementation commits.

- [ ] **Step 5: Reinstall and restart the safe service**

From synchronized `main`, run:

```bash
pnpm run service:install
codex-mobile-safe status
codex-mobile-safe urls
ss -ltnp
tailscale serve status
```

Expected: the user service is active, the backend listens only on `127.0.0.1:5900`, and the HTTPS mapping remains Tailnet-only with no Funnel or LAN listener.

- [ ] **Step 6: Execute live acceptance**

Run the eight steps in `tests/chat-composer-rendering/selected-idle-desktop-turn-live-sync.md`. Save sanitized request timing and DOM-state evidence under `/tmp`, and confirm the mobile browser updates without a manual refresh.
