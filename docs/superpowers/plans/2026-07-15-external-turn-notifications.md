# External Turn Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Notify through the existing ntfy pipeline when any same-user local Codex client finishes a turn that ran for at least 600,000 milliseconds, even when no browser is connected.

**Architecture:** Discover external `codex app-server` rollout writers through the hardened Linux `/proc` inspection already used by `ExternalThreadRuntimeProbe`, parse append-only rollout lifecycle records into authoritative timestamped events, and feed those events into the existing durable notifier. Keep discovery disabled without validated ntfy configuration and retain the existing notifier state schema, delivery behavior, loopback listener, password authentication, and Tailscale Serve exposure.

**Tech Stack:** TypeScript, Node.js filesystem and `/proc`, JSONL rollout records, Vitest, Express lifecycle wiring, systemd user service, ntfy HTTPS publishing.

## Global Constraints

- Production notification threshold remains exactly `600_000` ms.
- Production discovery interval defaults to `15_000` ms.
- Only same-UID Linux `codex app-server` writers with stable process/FD identity are eligible.
- Rollout paths must canonicalize under the canonical Codex sessions root and be regular `.jsonl` files.
- Do not infer completion from writer disappearance; require `task_complete` or `turn_aborted`.
- Do not replay terminal events whose completion timestamp predates monitor startup.
- Active cursors and notifier active/pending/sent collections remain capped at 256.
- Missing ntfy configuration creates no monitor, timer, filesystem scan, subscription, or network request.
- Never log or persist rollout content, prompts, assistant text, ntfy URLs, topics, or Tailscale credentials.
- Do not add HTTP routes, RPC methods, public listeners, Cloudflare tunnels, Tailscale Funnel, LAN binding, or authentication bypasses.

## File Structure

- Modify `src/server/externalThreadRuntime.ts`: expose canonical external rollout writer discovery while preserving the current runtime probe.
- Modify `src/server/externalThreadRuntime.test.ts`: prove writer-path discovery and all existing process/FD hardening.
- Create `src/server/rolloutLifecycle.ts`: parse only session metadata and authoritative turn lifecycle JSONL records.
- Create `src/server/rolloutLifecycle.test.ts`: pure parser coverage for timestamps, duration, malformed input, and unknown records.
- Create `src/server/externalTurnMonitor.ts`: serialized timer, cursor recovery, incremental reads, event ordering, and bounded eviction.
- Create `src/server/externalTurnMonitor.test.ts`: deterministic fake filesystem/process/timer integration tests.
- Modify `src/server/ntfyCompletionNotifier.ts`: accept authoritative observed lifecycle timestamps in addition to direct app-server notifications.
- Modify `src/server/ntfyCompletionNotifier.test.ts`: threshold, restart, cross-source dedupe, and authoritative-time tests.
- Modify `src/server/httpServer.ts`: own optional monitor lifecycle with the notifier.
- Modify `src/server/codexAppServerBridge.ts`: expose safe app-server PID and sessions-root getters to the lifecycle.
- Modify `src/server/securityPolicy.test.ts`: assert disabled mode creates no monitor and enabled mode wires one monitor.
- Modify `src/safe/doctor.ts` and `src/safe/doctor.test.ts`: statically verify optional external-monitor wiring.
- Modify `docs/AGENT_GUIDE.md`: document cross-client monitoring, restart semantics, and diagnostics.
- Modify `tests/cli-network-platform/ntfy-long-task-completion-notifications.md`: add exact Desktop/CLI/background/restart acceptance steps.

---

### Task 1: Expose Hardened External Rollout Writer Discovery

**Files:**
- Modify: `src/server/externalThreadRuntime.ts`
- Modify: `src/server/externalThreadRuntime.test.ts`

**Interfaces:**
- Consumes: existing `ExternalRuntimeSystem`, `RuntimeFdSnapshot`, stable Linux process ancestry checks, and canonical containment helpers.
- Produces:

```ts
export type ExternalRolloutWriter = {
  path: string
  dev: string
  ino: string
  size: number
  pid: number
}

export async function discoverExternalRolloutWriters(
  sessionsRoot: string,
  excludedPid: number | null,
  system?: ExternalRuntimeSystem,
): Promise<ExternalRolloutWriter[]>
```

- [ ] **Step 1: Add failing discovery tests**

Extend the test FD factory with a canonical target path and add cases that accept one same-user external rollout, deduplicate two descriptors for the same device/inode, and reject the safe app-server tree, other UID, read-only descriptors, non-Codex commands, paths outside the sessions root, non-JSONL files, non-regular files, and identity mismatch:

```ts
function writerFd(overrides: Partial<RuntimeFdSnapshot> = {}): RuntimeFdSnapshot {
  return {
    path: rolloutPath,
    pid: 42,
    ancestorPids: [],
    uid: 1000,
    cmdline: '/usr/local/bin/codex\0app-server\0',
    dev: '8',
    ino: '21',
    position: 10,
    flags: 0o100001,
    ...overrides,
  }
}

it('discovers one canonical same-user external rollout writer', async () => {
  const system = fakeRuntimeSystem({ fds: [writerFd()] })
  await expect(discoverExternalRolloutWriters(sessionsRoot, 900, system)).resolves.toEqual([
    { path: rolloutPath, dev: '8', ino: '21', size: 0, pid: 42 },
  ])
})

it('rejects writers outside the canonical sessions root', async () => {
  const system = fakeRuntimeSystem({
    fds: [writerFd({ path: '/tmp/outside.jsonl' })],
  })
  await expect(discoverExternalRolloutWriters(sessionsRoot, null, system)).resolves.toEqual([])
})
```

- [ ] **Step 2: Run the focused test and observe RED**

Run:

```bash
pnpm exec vitest run src/server/externalThreadRuntime.test.ts
```

Expected: FAIL because `RuntimeFdSnapshot.path` and `discoverExternalRolloutWriters` do not exist.

- [ ] **Step 3: Add canonical target paths to FD snapshots**

Add `path` to `RuntimeFdSnapshot`. During default `/proc` inspection, resolve `/proc/<pid>/fd/<fd>` between identity checks and return the canonical target only when the descriptor identity remains unchanged:

```ts
export type RuntimeFdSnapshot = {
  path: string
  pid: number
  ancestorPids: number[]
  uid: number
  cmdline: string
  dev: string
  ino: string
  position: number
  flags: number
}
```

Keep the existing PID start-time, UID, ancestry, flags, position, device, and inode checks intact.

- [ ] **Step 4: Implement bounded writer discovery**

Implement the exported function with one FD scan and one dedupe map:

```ts
export async function discoverExternalRolloutWriters(
  sessionsRoot: string,
  excludedPid: number | null,
  system: ExternalRuntimeSystem = createDefaultSystem(),
): Promise<ExternalRolloutWriter[]> {
  if (system.platform !== 'linux' || system.uid === null) return []
  const canonicalRoot = await system.realpath(sessionsRoot)
  const writers = new Map<string, ExternalRolloutWriter>()
  for await (const fd of system.listFdSnapshots()) {
    if (fd.uid !== system.uid || belongsToExcludedProcessTree(fd, excludedPid)) continue
    if (!isCodexAppServerCommand(fd.cmdline) || !isWritableDescriptor(fd.flags)) continue
    const path = await system.realpath(fd.path).catch(() => '')
    if (!path.endsWith('.jsonl') || !isContainedPath(canonicalRoot, path)) continue
    const identity = await system.statFile(path).catch(() => null)
    if (!identity?.regular || identity.dev !== fd.dev || identity.ino !== fd.ino) continue
    const key = `${identity.dev}:${identity.ino}`
    if (!writers.has(key)) {
      writers.set(key, { path, dev: identity.dev, ino: identity.ino, size: identity.size, pid: fd.pid })
    }
  }
  return [...writers.values()]
}
```

Use a small `isWritableDescriptor(flags)` helper shared with `matchesWriter`; do not duplicate access-mode arithmetic.

- [ ] **Step 5: Run discovery and existing runtime tests**

Run:

```bash
pnpm exec vitest run src/server/externalThreadRuntime.test.ts
```

Expected: all existing runtime-state tests and new discovery tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/externalThreadRuntime.ts src/server/externalThreadRuntime.test.ts
git commit -m "refactor: expose external Codex rollout writers"
```

---

### Task 2: Parse Authoritative Rollout Lifecycle Records

**Files:**
- Create: `src/server/rolloutLifecycle.ts`
- Create: `src/server/rolloutLifecycle.test.ts`

**Interfaces:**
- Consumes: complete UTF-8 JSONL lines only.
- Produces:

```ts
export type ParsedRolloutRecord =
  | { kind: 'session'; threadId: string }
  | { kind: 'started'; turnId: string; occurredAt: number }
  | {
      kind: 'terminal'
      turnId: string
      status: 'completed' | 'interrupted'
      occurredAt: number
      durationMs: number | null
    }

export function parseRolloutRecord(line: string): ParsedRolloutRecord | null
```

- [ ] **Step 1: Write failing pure parser tests**

Cover real rollout shapes without conversation content:

```ts
it('parses session metadata and lifecycle timestamps', () => {
  expect(parseRolloutRecord(JSON.stringify({
    timestamp: '2026-07-14T22:47:19.971Z',
    type: 'session_meta',
    payload: { id: 'thread-1' },
  }))).toEqual({ kind: 'session', threadId: 'thread-1' })

  expect(parseRolloutRecord(JSON.stringify({
    timestamp: '2026-07-14T22:47:19.971Z',
    type: 'event_msg',
    payload: { type: 'task_started', turn_id: 'turn-1' },
  }))).toEqual({
    kind: 'started',
    turnId: 'turn-1',
    occurredAt: Date.parse('2026-07-14T22:47:19.971Z'),
  })
})

it('prefers completed_at and preserves terminal duration', () => {
  expect(parseRolloutRecord(JSON.stringify({
    timestamp: '2026-07-14T22:58:00.000Z',
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      turn_id: 'turn-1',
      completed_at: '2026-07-14T22:57:59.971Z',
      duration_ms: 600_000,
    },
  }))).toEqual({
    kind: 'terminal',
    turnId: 'turn-1',
    status: 'completed',
    occurredAt: Date.parse('2026-07-14T22:57:59.971Z'),
    durationMs: 600_000,
  })
})
```

Add invalid JSON, missing/empty IDs, invalid timestamps, negative/non-finite duration, `turn_aborted`, unrelated `agent_message`, unknown lifecycle types, and arrays/primitives.

- [ ] **Step 2: Run the parser test and observe RED**

```bash
pnpm exec vitest run src/server/rolloutLifecycle.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the total parser**

Use small record/string/timestamp/duration readers and return `null` for every untrusted or unknown shape:

```ts
export function parseRolloutRecord(line: string): ParsedRolloutRecord | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  const root = asRecord(value)
  const payload = asRecord(root?.payload)
  if (!root || !payload) return null

  if (root.type === 'session_meta') {
    const threadId = readString(payload.id)
    return threadId ? { kind: 'session', threadId } : null
  }
  if (root.type !== 'event_msg') return null

  const turnId = readString(payload.turn_id)
  if (!turnId) return null
  if (payload.type === 'task_started') {
    const occurredAt = readTimestamp(root.timestamp)
    return occurredAt === null ? null : { kind: 'started', turnId, occurredAt }
  }
  if (payload.type !== 'task_complete' && payload.type !== 'turn_aborted') return null
  const occurredAt = readTimestamp(payload.completed_at, root.timestamp)
  if (occurredAt === null) return null
  return {
    kind: 'terminal',
    turnId,
    status: payload.type === 'task_complete' ? 'completed' : 'interrupted',
    occurredAt,
    durationMs: readDuration(payload.duration_ms),
  }
}
```

- [ ] **Step 4: Run parser tests**

```bash
pnpm exec vitest run src/server/rolloutLifecycle.test.ts
```

Expected: all parser tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/rolloutLifecycle.ts src/server/rolloutLifecycle.test.ts
git commit -m "feat: parse external rollout lifecycle records"
```

---

### Task 3: Build the Serialized External Turn Monitor

**Files:**
- Create: `src/server/externalTurnMonitor.ts`
- Create: `src/server/externalTurnMonitor.test.ts`

**Interfaces:**
- Consumes: `discoverExternalRolloutWriters()`, `ExternalRuntimeSystem`, and `parseRolloutRecord()`.
- Produces:

```ts
export type ObservedTurnLifecycle = {
  method: 'turn/started' | 'turn/completed'
  threadId: string
  turnId: string
  status: 'inProgress' | 'completed' | 'interrupted'
  occurredAt: number
  durationMs?: number
}

export type ExternalTurnMonitor = {
  start(): Promise<void>
  dispose(): Promise<void>
}

export function createExternalTurnMonitor(options: ExternalTurnMonitorOptions): ExternalTurnMonitor
```

- [ ] **Step 1: Create a deterministic fake monitor system and failing tests**

The fake must expose mutable rollout bytes, stable identity, discovered writers, fake clock, and captured scheduled callback. Start with these acceptance cases:

```ts
it('emits an external start and later completion without a browser', async () => {
  const fixture = monitorFixture({ now: 1_000 })
  fixture.rollout.set(sessionMeta('thread-1') + started('turn-1', 1_000))
  await fixture.monitor.start()
  expect(fixture.events).toEqual([observedStarted('thread-1', 'turn-1', 1_000)])

  fixture.rollout.append(completed('turn-1', 601_000, 600_000))
  await fixture.runScheduledScan()
  expect(fixture.events.at(-1)).toEqual(observedCompleted('thread-1', 'turn-1', 601_000, 600_000))
})

it('recovers a turn that was already running at monitor startup', async () => {
  const fixture = monitorFixture({ now: 500_000 })
  fixture.rollout.set(sessionMeta('thread-1') + started('turn-1', 0))
  await fixture.monitor.start()
  fixture.rollout.append(completed('turn-1', 600_000, 600_000))
  await fixture.runScheduledScan()
  expect(fixture.events.map(({ occurredAt }) => occurredAt)).toEqual([0, 600_000])
})
```

Add tests for terminal-before-startup suppression, terminal-after-startup race reconstruction from `duration_ms`, split lines, two rollouts, duplicate records, file replacement/truncation, unsafe identity, writer disappearance without terminal, cursor limit 256, one scheduled scan at a time, and `dispose()` clearing the timer.

- [ ] **Step 2: Run monitor tests and observe RED**

```bash
pnpm exec vitest run src/server/externalTurnMonitor.test.ts
```

Expected: FAIL because the monitor module does not exist.

- [ ] **Step 3: Implement bounded cursor state and line application**

Use these internal structures and constants:

```ts
export const EXTERNAL_TURN_SCAN_INTERVAL_MS = 15_000
const READ_CHUNK_BYTES = 64 * 1024
const MAX_TRAILING_BYTES = 256 * 1024
const DEFAULT_CURSOR_LIMIT = 256

type RolloutCursor = {
  key: string
  path: string
  dev: string
  ino: string
  offset: number
  trailing: Buffer
  threadId: string
  activeTurn: { turnId: string; startedAt: number } | null
  lastObservedAt: number
}
```

`applyCompleteLine()` must parse session metadata before lifecycle records, ignore lifecycle records until `threadId` is known, emit a start once, and emit a matching terminal once. For a terminal discovered after startup without a prior emitted start, emit a synthetic start only when `durationMs !== null`, `occurredAt >= monitorStartedAt`, and `occurredAt - durationMs <= monitorStartedAt`.

- [ ] **Step 4: Implement initial recovery and forward incremental reads**

On first registration:

1. validate the writer identity again;
2. read the bounded prefix until `session_meta` is found;
3. scan backwards in 64 KiB chunks until the most recent lifecycle line is found;
4. recover an unmatched start or set the initial forward boundary;
5. process bytes appended after that verified boundary.

All later scans call `readRange(path, offset, size - offset, expectedIdentity)` in 64 KiB chunks and preserve only a bounded incomplete trailing line. If the trailing fragment exceeds `MAX_TRAILING_BYTES`, discard the cursor with the redacted warning `Unable to parse external turn lifecycle`.

- [ ] **Step 5: Implement serialized scheduling and bounded eviction**

Use a recursive timeout after each scan rather than overlapping intervals:

```ts
async function runAndSchedule(): Promise<void> {
  if (disposed) return
  await scan().catch(() => warnOnce('Unable to inspect external Codex turns'))
  if (!disposed) timer = setTimer(() => void runAndSchedule(), scanIntervalMs)
}
```

`start()` records `monitorStartedAt`, performs one immediate scan, and schedules the next. `dispose()` clears the timer and awaits the current serialized work. Evict only terminal/inactive oldest cursors before active ones, with the final map bounded to `cursorLimit`.

- [ ] **Step 6: Run monitor, parser, and discovery tests**

```bash
pnpm exec vitest run \
  src/server/externalTurnMonitor.test.ts \
  src/server/rolloutLifecycle.test.ts \
  src/server/externalThreadRuntime.test.ts
```

Expected: all three files PASS; fake read-call assertions show unchanged files read zero additional payload bytes.

- [ ] **Step 7: Commit**

```bash
git add src/server/externalTurnMonitor.ts src/server/externalTurnMonitor.test.ts
git commit -m "feat: monitor external Codex turn lifecycles"
```

---

### Task 4: Feed Authoritative Events into the Durable Notifier

**Files:**
- Modify: `src/server/ntfyCompletionNotifier.ts`
- Modify: `src/server/ntfyCompletionNotifier.test.ts`

**Interfaces:**
- Consumes: `ObservedTurnLifecycle` from `externalTurnMonitor.ts`.
- Produces: public `handleObserved(event: ObservedTurnLifecycle): void` alongside the existing `handle(notification)`.

- [ ] **Step 1: Write failing authoritative-time and cross-source tests**

```ts
it('qualifies an observed turn using authoritative timestamps', async () => {
  const fixture = harness({ now: () => 9_999_999 })
  await fixture.notifier.start()
  fixture.notifier.handleObserved(observedStarted('thread-1', 'turn-1', 1_000))
  fixture.notifier.handleObserved(observedCompleted('thread-1', 'turn-1', 601_000, 600_000))
  await fixture.notifier.dispose()
  expect(fixture.send).toHaveBeenCalledTimes(1)
})

it('deduplicates direct and external observations for one turn', async () => {
  let now = 1_000
  const fixture = harness({ now: () => now })
  await fixture.notifier.start()
  fixture.notifier.handle(started())
  fixture.notifier.handleObserved(observedStarted('thread-1', 'turn-1', 1_000))
  now = 601_000
  fixture.notifier.handleObserved(observedCompleted('thread-1', 'turn-1', 601_000, 600_000))
  fixture.notifier.handle(completed())
  await fixture.notifier.dispose()
  expect(fixture.send).toHaveBeenCalledTimes(1)
})
```

Also assert 599,999/600,000 authoritative boundaries and interrupted title/fallback.

- [ ] **Step 2: Run notifier tests and observe RED**

```bash
pnpm exec vitest run src/server/ntfyCompletionNotifier.test.ts
```

Expected: FAIL because `handleObserved` does not exist.

- [ ] **Step 3: Normalize both event sources through one queue**

Implement:

```ts
handleObserved(event: ObservedTurnLifecycle): void {
  if (!this.started) return
  this.enqueue(async () => {
    await this.processNotification(event, event.occurredAt)
    this.requestDrain()
  })
}

handle(notification: Notification): void {
  if (!this.started) return
  const event = readEvent(notification)
  if (!event) return
  this.handleObserved({ ...event, occurredAt: this.now() })
}
```

Keep duplicate-start behavior: the earliest active timestamp wins. Keep completion requiring a matching active record. The monitor guarantees a synthetic start precedes a restart-race terminal event.

- [ ] **Step 4: Run notifier and state tests**

```bash
pnpm exec vitest run src/server/ntfyCompletionNotifier.test.ts src/safe/ntfyState.test.ts
```

Expected: all tests PASS; the persisted JSON schema remains `{ active, pending, sent }` with unchanged record shapes.

- [ ] **Step 5: Commit**

```bash
git add src/server/ntfyCompletionNotifier.ts src/server/ntfyCompletionNotifier.test.ts
git commit -m "feat: qualify external turn completion events"
```

---

### Task 5: Wire the Monitor Only for Enabled Safe Notifications

**Files:**
- Modify: `src/server/httpServer.ts`
- Modify: `src/server/codexAppServerBridge.ts`
- Modify: `src/server/securityPolicy.test.ts`
- Modify: `src/safe/doctor.ts`
- Modify: `src/safe/doctor.test.ts`

**Interfaces:**
- Consumes: `createExternalTurnMonitor()` and `NtfyCompletionNotifier.handleObserved()`.
- Produces two bridge getters:

```ts
getAppServerPidForNotifier(): number | null
getSessionsRootForNotifier(): string
```

- [ ] **Step 1: Add failing disabled/enabled lifecycle tests**

In `securityPolicy.test.ts`, inject a monitor factory and assert disabled mode never calls it:

```ts
const createExternalMonitor = vi.fn()
const lifecycle = createNtfyNotifierLifecycle({
  bridge: fakeBridge,
  createExternalMonitor,
})
expect(createExternalMonitor).not.toHaveBeenCalled()
lifecycle.dispose()
```

For enabled mode, capture `onLifecycle`, assert `start()` is called once, feed an observed completion pair, and assert disposal unsubscribes, awaits monitor disposal, and disposes the notifier once.

- [ ] **Step 2: Run lifecycle tests and observe RED**

```bash
pnpm exec vitest run src/server/securityPolicy.test.ts src/safe/doctor.test.ts
```

Expected: FAIL because the lifecycle has no external-monitor factory or bridge getters.

- [ ] **Step 3: Expose notifier-only bridge metadata**

Extend the middleware type and assignments:

```ts
middleware.getAppServerPidForNotifier = () => appServer.getPid()
middleware.getSessionsRootForNotifier = () => join(getCodexHomeDir(), 'sessions')
```

These are in-process functions only; do not add routes or response fields.

- [ ] **Step 4: Own both lifecycles in `createNtfyNotifierLifecycle`**

After `notifier.start()` succeeds, construct the monitor with:

```ts
const externalMonitor = createExternalMonitor({
  sessionsRoot: options.bridge.getSessionsRootForNotifier(),
  getExcludedPid: options.bridge.getAppServerPidForNotifier,
  onLifecycle: (event) => notifier.handleObserved(event),
  warn,
})
void externalMonitor.start().catch(() => warn('Unable to start external turn monitoring'))
```

Disabled mode must return before creating the notifier, monitor, subscription, state store, or timer. Disposal order is: unsubscribe direct notifications, dispose monitor, then flush/dispose notifier.

- [ ] **Step 5: Extend doctor invariants**

Require source evidence that optional ntfy wiring owns `createExternalTurnMonitor`, passes `getSessionsRootForNotifier`, and routes `onLifecycle` into `handleObserved`. Keep existing ntfy URL, state, and subscription checks unchanged.

- [ ] **Step 6: Run focused lifecycle and safety tests**

```bash
pnpm exec vitest run \
  src/server/securityPolicy.test.ts \
  src/server/externalTurnMonitor.test.ts \
  src/server/ntfyCompletionNotifier.test.ts \
  src/safe/doctor.test.ts \
  src/cli/safe.entry.test.ts \
  src/safe/packaging.test.ts
```

Expected: all files PASS; disabled-mode spies show zero monitor/timer/scan work.

- [ ] **Step 7: Commit**

```bash
git add src/server/httpServer.ts src/server/codexAppServerBridge.ts src/server/securityPolicy.test.ts src/safe/doctor.ts src/safe/doctor.test.ts
git commit -m "feat: wire external turns into safe notifications"
```

---

### Task 6: Document Cross-Client Notification Operation

**Files:**
- Modify: `docs/AGENT_GUIDE.md`
- Modify: `tests/cli-network-platform/ntfy-long-task-completion-notifications.md`

**Interfaces:**
- Consumes: implemented external monitor behavior.
- Produces: operator and manual acceptance guidance without secrets.

- [ ] **Step 1: Update the agent guide**

Add the monitor module to Architecture, add same-UID/canonical-root/incremental-scan invariants, extend the change-to-test matrix, and document:

```text
With ntfy enabled, codex-mobile-safe observes qualifying turns from the mobile UI,
Codex Desktop, and Codex CLI. Detection is server-side and continues with no browser
connection. A turn already running when the service restarts is eligible using its
rollout timestamp; turns already terminal before restart are not replayed.
```

State that a missing terminal lifecycle is not inferred from process exit.

- [ ] **Step 2: Extend manual acceptance steps**

Add exact cases:

1. close all mobile browser tabs;
2. start a controlled external Desktop/CLI turn;
3. verify no inbound/public listener appears;
4. complete at 599,999 ms in the deterministic harness and observe no send;
5. complete at 600,000 ms and observe one captured send;
6. restart the safe service between start and completion and observe one send;
7. complete a historical fixture before monitor startup and observe no send;
8. lock the phone and verify the real ntfy app receives a qualifying production notification according to device Focus/sound settings.

Keep real topic values out of the document and command output.

- [ ] **Step 3: Run documentation and shell safety checks**

```bash
git diff --check
sh -n scripts/install-local.sh scripts/install-user-service.sh scripts/uninstall-user-service.sh
```

Expected: no whitespace errors and shell syntax exit code 0.

- [ ] **Step 4: Commit**

```bash
git add docs/AGENT_GUIDE.md tests/cli-network-platform/ntfy-long-task-completion-notifications.md
git commit -m "docs: explain cross-client completion notifications"
```

---

### Task 7: Verify Performance, Runtime Safety, and Deployment

**Files:**
- Create outside repository: `/tmp/codex-mobile-external-turn-performance-audit-2026-07-15.txt`
- No committed generated build, service, state, topic, or screenshot secrets.

**Interfaces:**
- Consumes: completed backend implementation.
- Produces: verification evidence and a running Tailnet-only service.

- [ ] **Step 1: Run focused and complete automated verification**

```bash
pnpm exec vitest run \
  src/server/externalThreadRuntime.test.ts \
  src/server/rolloutLifecycle.test.ts \
  src/server/externalTurnMonitor.test.ts \
  src/server/ntfyCompletionNotifier.test.ts \
  src/server/securityPolicy.test.ts \
  src/safe/ntfyState.test.ts \
  src/safe/doctor.test.ts
pnpm run test:unit
pnpm exec vue-tsc --noEmit
pnpm run build
node dist-cli/index.js --help
node dist-cli/safe.js --help
node dist-cli/safe.js doctor
```

Expected: every command exits 0; production build retains only the pre-existing chunk-size warning.

- [ ] **Step 2: Run the deterministic no-browser integration harness**

Use injected fake clock/send operations, never the real ntfy topic. Assert the report contains:

```json
{
  "browserConnections": 0,
  "thresholdMs": 600000,
  "capturedSends": 1,
  "duplicateSends": 0,
  "historicalReplaySends": 0
}
```

Repeat with monitor restart between start and terminal append.

- [ ] **Step 3: Record the performance audit**

Measure one unchanged scan and one append scan. Record process count, descriptor count, tracked rollouts, payload bytes read, duration, overlapping scans, and app-server RPC delta. Required acceptance:

```text
unchanged payload bytes: 0
overlapping scans: 0
extra app-server RPC calls per scan: 0
tracked cursors: <= 256
```

Create the audit file with `apply_patch`; do not put it in Git.

- [ ] **Step 4: Request independent code review and fix all Critical/Important issues**

Use `requesting-code-review` with base `origin/main`, the two approved specs/plans, and the full feature HEAD. Re-run the smallest failing regression first for every accepted review fix, then the complete verification commands above.

- [ ] **Step 5: Merge through GitHub**

Push the feature branch, create a ready PR in `zonghang-li/codex-mobile`, update the PR verification notes, post a plain comment containing exactly `/review`, merge by rebase, delete the remote feature branch, fetch/prune, switch to `main`, and fast-forward to `origin/main`.

- [ ] **Step 6: Reinstall and verify the safe service**

```bash
pnpm run service:install
codex-mobile --help
codex-mobile-safe doctor
codex-mobile-safe status
codex-mobile-safe urls
ss -ltnp '( sport = :5900 )'
tailscale serve status
journalctl --user -u codex-mobile-safe -n 50 --no-pager
```

Expected: service active; listener only on `127.0.0.1:5900`; HTTPS URL remains Tailnet-only; journal contains no ntfy URL/topic, password, prompt, assistant text, or repeated monitor errors.
