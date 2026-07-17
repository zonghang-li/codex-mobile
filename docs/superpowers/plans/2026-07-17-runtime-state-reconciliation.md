# Unified Thread Runtime Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make mobile sidebar and selected-task running state converge after missed local lifecycle notifications, while preserving external detection, hidden-page pause behavior, and final-output ordering.

**Architecture:** Add a server-side active-local-turn ledger beside the mobile app-server, overlay it on the existing external batch probe, and extend the frontend batch reconciler to understand local observations. Rotate bounded batches and use one guarded detail read before releasing a selected stale local lease.

**Tech Stack:** TypeScript, Node.js HTTP/WebSocket bridge, Vue 3 composables, Vitest, Playwright for deployed acceptance.

## Global Constraints

- Preserve the exact 2,000 ms post-settlement visible-page polling cadence.
- Preserve the 50-ID batch request limit and one in-flight batch request.
- Send no runtime or detail requests while `document.visibilityState === 'hidden'`.
- Preserve established local and external leases on `unknown` or request failure.
- External turns remain non-interruptible; local app-server turns remain interruptible.
- Apply selected terminal detail before clearing its live overlay and running state.
- Do not change authentication, Tailscale Serve, ntfy, or notification thresholds.
- Start every production change with a focused failing test and observe the expected failure.

---

## File Structure

- Create `src/server/localThreadRuntime.ts`: parse app-server lifecycle notifications and retain only active local turn ownership.
- Create `src/server/localThreadRuntime.test.ts`: focused ledger lifecycle and stale-completion tests.
- Modify `src/types/threadRuntime.ts`: add the exact local-running batch observation and combined runtime type.
- Modify `src/server/codexAppServerBridge.ts`: feed the ledger before browser broadcast, expose it in shared bridge state, and overlay local running observations on the batch endpoint after external inspection.
- Modify `src/server/externalThreadRuntimeBridge.test.ts`: prove route-level local override, post-scan authority, validation, and external behavior.
- Modify `src/api/codexGateway.ts`: strictly parse local-running batch responses without weakening the external single-thread parser.
- Modify `src/api/codexGateway.test.ts`: cover accepted and malformed local-running records.
- Modify `src/composables/useDesktopState.ts`: rotate candidates, reconcile local observations, and recover selected terminal detail safely.
- Modify `src/composables/useDesktopState.test.ts`: reproduce missed starts, missed completions, stale races, rotation, and visibility behavior.
- Modify `tests/thread-loading-state/background-external-runtime-indicators.md`: document unified local/external manual acceptance.

---

### Task 1: Active Local Turn Ledger

**Files:**
- Create: `src/server/localThreadRuntime.ts`
- Create: `src/server/localThreadRuntime.test.ts`

**Interfaces:**
- Consumes: app-server notifications shaped as `{ method: string; params: unknown }`.
- Produces: `LocalThreadRuntimeLedger.record(notification)`, `getRunning(threadId)`, and `clear()`.
- Produces: `LocalRunningTurn = { threadId: string; turnId: string }`.

- [ ] **Step 1: Write failing lifecycle tests**

```ts
import { describe, expect, it } from 'vitest'
import { LocalThreadRuntimeLedger } from './localThreadRuntime'

describe('LocalThreadRuntimeLedger', () => {
  it('records a start and removes only its matching completion', () => {
    const ledger = new LocalThreadRuntimeLedger()
    ledger.record({ method: 'turn/started', params: { threadId: 'thread-a', turn: { id: 'turn-a' } } })
    expect(ledger.getRunning('thread-a')).toEqual({ threadId: 'thread-a', turnId: 'turn-a' })
    ledger.record({ method: 'turn/completed', params: { threadId: 'thread-a', turn: { id: 'turn-a' } } })
    expect(ledger.getRunning('thread-a')).toBeNull()
  })

  it('does not let an older completion clear a newer turn', () => {
    const ledger = new LocalThreadRuntimeLedger()
    ledger.record({ method: 'turn/started', params: { threadId: 'thread-a', turn: { id: 'turn-old' } } })
    ledger.record({ method: 'turn/started', params: { threadId: 'thread-a', turn: { id: 'turn-new' } } })
    ledger.record({ method: 'turn/completed', params: { threadId: 'thread-a', turn: { id: 'turn-old' } } })
    expect(ledger.getRunning('thread-a')).toEqual({ threadId: 'thread-a', turnId: 'turn-new' })
  })

  it('ignores malformed lifecycle notifications and clears on disposal', () => {
    const ledger = new LocalThreadRuntimeLedger()
    ledger.record({ method: 'turn/started', params: { threadId: '', turn: { id: 'turn-a' } } })
    ledger.record({ method: 'item/started', params: { threadId: 'thread-a', turnId: 'turn-a' } })
    expect(ledger.getRunning('thread-a')).toBeNull()
    ledger.record({ method: 'turn/started', params: { threadId: 'thread-a', turn: { id: 'turn-a' } } })
    ledger.clear()
    expect(ledger.getRunning('thread-a')).toBeNull()
  })
})
```

- [ ] **Step 2: Run the ledger test and verify RED**

Run: `pnpm vitest run src/server/localThreadRuntime.test.ts`

Expected: FAIL because `./localThreadRuntime` does not exist.

- [ ] **Step 3: Implement the minimal ledger**

```ts
export type AppServerLifecycleNotification = { method: string; params: unknown }
export type LocalRunningTurn = { threadId: string; turnId: string }

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readLifecycle(notification: AppServerLifecycleNotification): LocalRunningTurn | null {
  const params = asRecord(notification.params)
  const turn = asRecord(params?.turn)
  const threadId = typeof params?.threadId === 'string' ? params.threadId.trim() : ''
  const turnId = typeof turn?.id === 'string' ? turn.id.trim() : ''
  return threadId && turnId ? { threadId, turnId } : null
}

export class LocalThreadRuntimeLedger {
  private readonly activeByThreadId = new Map<string, string>()

  record(notification: AppServerLifecycleNotification): void {
    if (notification.method !== 'turn/started' && notification.method !== 'turn/completed') return
    const lifecycle = readLifecycle(notification)
    if (!lifecycle) return
    if (notification.method === 'turn/started') {
      this.activeByThreadId.set(lifecycle.threadId, lifecycle.turnId)
      return
    }
    if (this.activeByThreadId.get(lifecycle.threadId) === lifecycle.turnId) {
      this.activeByThreadId.delete(lifecycle.threadId)
    }
  }

  getRunning(threadId: string): LocalRunningTurn | null {
    const normalizedThreadId = threadId.trim()
    const turnId = this.activeByThreadId.get(normalizedThreadId)
    return turnId ? { threadId: normalizedThreadId, turnId } : null
  }

  clear(): void {
    this.activeByThreadId.clear()
  }
}
```

- [ ] **Step 4: Run the ledger test and verify GREEN**

Run: `pnpm vitest run src/server/localThreadRuntime.test.ts`

Expected: 1 test file and 3 tests pass.

- [ ] **Step 5: Commit the ledger**

```bash
git add src/server/localThreadRuntime.ts src/server/localThreadRuntime.test.ts
git commit -m "feat: track active local app-server turns"
```

---

### Task 2: Unified Server Batch Observation

**Files:**
- Modify: `src/types/threadRuntime.ts`
- Modify: `src/server/codexAppServerBridge.ts`
- Modify: `src/server/externalThreadRuntimeBridge.test.ts`

**Interfaces:**
- Consumes: `LocalThreadRuntimeLedger.getRunning(threadId)` from Task 1.
- Consumes: `ExternalThreadRuntimeProbe.inspectMany(threadIds, excludedPid)`.
- Produces: `LocalAppServerRunningRuntime` and `ThreadRuntimeObservation`.
- Produces: `observeThreadRuntimeStates(threadIds, runtimeProbe, ledger, excludedPid)`.

- [ ] **Step 1: Add failing route and post-scan authority tests**

Add a test that records a local start in the shared ledger, makes the external
probe return `idle`, calls `POST /codex-api/thread-runtime-states`, and expects:

```ts
{
  states: {
    'thread-local': {
      state: 'running',
      turnId: 'turn-local',
      interruptible: true,
      source: 'local-app-server',
    },
  },
}
```

Add a deferred `inspectMany` test that records the local start after inspection
begins but before it resolves. The response must still return the local-running
shape, proving the ledger is read after the external scan.

Add a completion test that records matching completion before the next request
and makes the external probe return `idle`; the endpoint must return `{ state:
'idle' }`.

- [ ] **Step 2: Run the bridge test and verify RED**

Run: `pnpm vitest run src/server/externalThreadRuntimeBridge.test.ts`

Expected: FAIL because shared bridge state has no local ledger and the endpoint
returns the external probe result unchanged.

- [ ] **Step 3: Add the combined observation type**

```ts
export type LocalAppServerRunningRuntime = {
  state: 'running'
  turnId: string
  interruptible: true
  source: 'local-app-server'
}

export type ThreadRuntimeObservation =
  | ExternalThreadRuntime
  | LocalAppServerRunningRuntime
```

- [ ] **Step 4: Overlay the ledger after external inspection**

Add this exported helper beside the existing bridge runtime helpers:

```ts
export async function observeThreadRuntimeStates(
  threadIds: readonly string[],
  runtimeProbe: Pick<ExternalThreadRuntimeProbe, 'inspectMany'>,
  localRuntimeLedger: Pick<LocalThreadRuntimeLedger, 'getRunning'>,
  excludedPid: number | null,
): Promise<Record<string, ThreadRuntimeObservation>> {
  const states: Record<string, ThreadRuntimeObservation> = {
    ...await runtimeProbe.inspectMany(threadIds, excludedPid),
  }
  for (const threadId of threadIds) {
    const local = localRuntimeLedger.getRunning(threadId)
    if (!local) continue
    states[threadId] = {
      state: 'running',
      turnId: local.turnId,
      interruptible: true,
      source: 'local-app-server',
    }
  }
  return states
}
```

Make `AppServerProcess.emitNotification()` call `localRuntimeLedger.record()`
before notifying listeners. Clear the ledger on child exit and `dispose()`.
Add the ledger to `SharedBridgeState`, bump `SHARED_BRIDGE_VERSION`, and make the
batch route call `observeThreadRuntimeStates()`. Keep the single-thread external
endpoint unchanged.

- [ ] **Step 5: Run focused server tests and verify GREEN**

Run: `pnpm vitest run src/server/localThreadRuntime.test.ts src/server/externalThreadRuntimeBridge.test.ts src/server/externalThreadRuntime.test.ts`

Expected: all focused server tests pass.

- [ ] **Step 6: Commit unified server observation**

```bash
git add src/types/threadRuntime.ts src/server/codexAppServerBridge.ts src/server/externalThreadRuntimeBridge.test.ts
git commit -m "feat: reconcile local turns in runtime batches"
```

---

### Task 3: Strict Gateway Parsing for Local Runtime

**Files:**
- Modify: `src/api/codexGateway.ts`
- Modify: `src/api/codexGateway.test.ts`

**Interfaces:**
- Consumes: `ThreadRuntimeObservation` from Task 2.
- Produces: `getThreadRuntimeStates(...): Promise<Record<string, ThreadRuntimeObservation>>`.
- Preserves: `getThreadRuntimeState()` external-only parsing.

- [ ] **Step 1: Write failing parser tests**

Add one response containing a valid local-running record and assert it is
returned exactly. Add table cases that must become `{ state: 'unknown' }`:

```ts
[
  { state: 'running', turnId: 'turn-a', interruptible: false, source: 'local-app-server' },
  { state: 'running', turnId: 'turn-a', interruptible: true, source: 'external-session-writer' },
  { state: 'running', turnId: '', interruptible: true, source: 'local-app-server' },
  { state: 'running', turnId: 'turn-a', interruptible: true, source: 'local-app-server', extra: true },
]
```

- [ ] **Step 2: Run gateway tests and verify RED**

Run: `pnpm vitest run src/api/codexGateway.test.ts`

Expected: valid local-running input is currently parsed as `unknown`.

- [ ] **Step 3: Add a batch-only strict parser**

```ts
function parseThreadRuntimeObservation(value: unknown): ThreadRuntimeObservation {
  const external = parseExternalThreadRuntime(value)
  if (external.state !== 'unknown') return external
  const runtime = asRecord(value)
  if (
    runtime
    && hasOnlyKeys(runtime, ['state', 'turnId', 'interruptible', 'source'])
    && runtime.state === 'running'
    && typeof runtime.turnId === 'string'
    && runtime.turnId.trim().length > 0
    && runtime.interruptible === true
    && runtime.source === 'local-app-server'
  ) {
    return {
      state: 'running',
      turnId: runtime.turnId.trim(),
      interruptible: true,
      source: 'local-app-server',
    }
  }
  return { state: 'unknown' }
}
```

Use this parser only in `getThreadRuntimeStates()` and update its result type.

- [ ] **Step 4: Run gateway tests and verify GREEN**

Run: `pnpm vitest run src/api/codexGateway.test.ts`

Expected: all gateway tests pass.

- [ ] **Step 5: Commit gateway support**

```bash
git add src/api/codexGateway.ts src/api/codexGateway.test.ts
git commit -m "feat: parse local runtime observations"
```

---

### Task 4: Candidate Rotation and Missed-Start Repair

**Files:**
- Modify: `src/composables/useDesktopState.ts`
- Modify: `src/composables/useDesktopState.test.ts`

**Interfaces:**
- Consumes: local-running results from `getThreadRuntimeStates()`.
- Produces: rotating `backgroundRuntimeCandidateIds()` behavior.
- Preserves: selected external detail polling and hidden-page cancellation.

- [ ] **Step 1: Write failing missed-start and rotation tests**

Create a loaded non-selected row whose updated time makes it unread but whose
browser state has no start event. Return `running/local-app-server` from the
batch and assert `{ inProgress: true, unread: false }` plus local ownership.

Create 55 eligible rows, run two settled cycles, and assert the union of request
IDs includes every row. The selected non-external row must be present in both
cycles; each request must contain at most 50 IDs.

- [ ] **Step 2: Run desktop-state tests and verify RED**

Run: `pnpm vitest run src/composables/useDesktopState.test.ts -t "local runtime|rotates runtime"`

Expected: local-running is treated as external or unknown, and rows after the
first fixed 50 never appear.

- [ ] **Step 3: Implement prioritized rotating candidates**

Keep a non-reactive `backgroundRuntimeCursor`. Build the eligible non-selected
array in current sidebar order without excluding local ownership. Reserve one
slot for a selected thread unless it is externally owned. Select the remaining
IDs circularly from the cursor and advance it by the number consumed. Reset the
cursor when polling stops.

For `running/local-app-server`, set the observed active turn ID, establish local
ownership, set progress true, and remove the thread from the external-only
tracking set. Keep the existing external-running path unchanged.

- [ ] **Step 4: Run focused desktop-state tests and verify GREEN**

Run: `pnpm vitest run src/composables/useDesktopState.test.ts -t "local runtime|rotates runtime|background runtime"`

Expected: missed-start and rotation tests pass with all existing background
runtime tests.

- [ ] **Step 5: Commit candidate reconciliation**

```bash
git add src/composables/useDesktopState.ts src/composables/useDesktopState.test.ts
git commit -m "fix: repair missed starts from runtime batches"
```

---

### Task 5: Missed Completion and Selected Final Detail

**Files:**
- Modify: `src/composables/useDesktopState.ts`
- Modify: `src/composables/useDesktopState.test.ts`

**Interfaces:**
- Consumes: authoritative batch `idle` after a local ledger has released a turn.
- Produces: guarded selected local terminal detail reconciliation.
- Preserves: local authority version, detail epoch, selection, and generation race guards.

- [ ] **Step 1: Write failing completion recovery tests**

Add these independent tests:

1. A background thread receives `turn/started`, never receives completion, then
   gets batch `idle`; assert progress clears and one forced summary refresh can
   make it unread.
2. A selected local thread gets batch `idle`; return terminal detail containing
   the final assistant message and assert that message is present when ownership
   and progress become idle.
3. Reject the terminal detail read; assert the local lease remains.
4. Start a newer local turn while the idle/detail request is in flight; assert
   the stale response cannot clear the newer turn.
5. Return `unknown`; assert the local lease and unread suppression remain.

- [ ] **Step 2: Run completion tests and verify RED**

Run: `pnpm vitest run src/composables/useDesktopState.test.ts -t "missed local completion|selected local terminal"`

Expected: local ownership is excluded from the existing idle-clearing path and
the selected final detail is not reconciled.

- [ ] **Step 3: Add guarded local terminal recovery**

Extend `reconcileThreadDetailSnapshot()` options with:

```ts
allowIdleLocalLeaseRelease?: boolean
```

Calculate `retainLocal` as false only when that option is true and the detail
itself reports neither local nor external running. In the batch idle path:

- unselected local: clear its active turn ID, ownership, and progress, then
  force one summary refresh;
- selected local: acquire one shared abortable detail request, verify generation,
  selection, detail epoch, and local authority version, then reconcile with
  `allowIdleLocalLeaseRelease: true`;
- on failure or invalidation, keep the lease for the next cycle.

Do not clear local state before the selected detail is applied.

- [ ] **Step 4: Run completion and race tests and verify GREEN**

Run: `pnpm vitest run src/composables/useDesktopState.test.ts -t "missed local completion|selected local terminal|stale idle|unknown"`

Expected: all focused completion, stale-response, and unknown-retention tests pass.

- [ ] **Step 5: Run the entire desktop-state test file**

Run: `pnpm vitest run src/composables/useDesktopState.test.ts`

Expected: the complete file passes without timer leaks or unhandled rejections.

- [ ] **Step 6: Commit completion recovery**

```bash
git add src/composables/useDesktopState.ts src/composables/useDesktopState.test.ts
git commit -m "fix: reconcile missed local completions"
```

---

### Task 6: Documentation, Full Verification, and Deployment Acceptance

**Files:**
- Modify: `tests/thread-loading-state/background-external-runtime-indicators.md`
- Verify: all files changed by Tasks 1-5.

**Interfaces:**
- Consumes: completed server, gateway, and frontend reconciliation behavior.
- Produces: reproducible manual acceptance and deployment evidence.

- [ ] **Step 1: Update the manual acceptance document**

Add local missed-start and missed-completion scenarios, preserve the existing
desktop external scenario, add a 51+-row rotation check, and explicitly state
that hidden pages send no runtime/detail requests and foreground resume sends
one immediate correction.

- [ ] **Step 2: Run focused runtime suites**

Run:

```bash
pnpm vitest run \
  src/server/localThreadRuntime.test.ts \
  src/server/externalThreadRuntime.test.ts \
  src/server/externalThreadRuntimeBridge.test.ts \
  src/api/codexGateway.test.ts \
  src/composables/useDesktopState.test.ts
```

Expected: all focused files pass with zero failures.

- [ ] **Step 3: Run the complete unit suite**

Run: `pnpm test:unit`

Expected: all test files pass with zero failures.

- [ ] **Step 4: Run the production build**

Run: `pnpm build`

Expected: Vue type checking, Vite frontend build, and tsup CLI build all exit 0.

- [ ] **Step 5: Perform requirements review, then code-quality review**

Compare the diff line by line with
`docs/superpowers/specs/2026-07-17-runtime-state-reconciliation-design.md`.
Confirm every acceptance item has a test or manual check, then inspect ownership
transitions, abort paths, timers, and exact parser shapes for unnecessary scope.

- [ ] **Step 6: Commit documentation**

```bash
git add tests/thread-loading-state/background-external-runtime-indicators.md \
  docs/superpowers/specs/2026-07-17-runtime-state-reconciliation-design.md \
  docs/superpowers/plans/2026-07-17-runtime-state-reconciliation.md
git commit -m "docs: document runtime reconciliation"
```

- [ ] **Step 7: Deploy the verified branch for acceptance**

Stop and restart `codex-mobile-safe` from this worktree using the existing
password file and port 5900. Confirm status reports the new PID and loopback
listener before checking Tailscale Serve still proxies only to
`127.0.0.1:5900`.

- [ ] **Step 8: Run deployed browser acceptance**

At 390x844, verify a current local and external running row use
`.thread-status-indicator[data-state="working"]`. Simulate or exercise a missed
local completion and confirm final detail appears before the composer becomes
idle. Hide the page for more than one cycle, confirm request counts do not
advance, restore visibility, and confirm one immediate reconciliation.

- [ ] **Step 9: Record final repository state**

Run:

```bash
git status --short --branch
git log --oneline --decorate -8
git diff main...HEAD --stat
```

Expected: clean feature worktree with only intentional commits ahead of main.
