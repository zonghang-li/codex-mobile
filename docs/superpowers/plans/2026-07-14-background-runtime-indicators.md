# Background External Runtime Indicators Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the existing green working indicator for non-selected sidebar threads that are running in another Codex process, then restore normal unread behavior after completion.

**Architecture:** Add a strict 1–50-thread batch runtime endpoint backed by one shared `/proc` descriptor scan, while leaving `thread/list` non-blocking and the selected-thread runtime lifecycle unchanged. A separate cancellable frontend poller applies batch results only to loaded non-selected, non-local threads and lets the existing unread calculation render the post-completion blue dot.

**Tech Stack:** TypeScript, Node.js HTTP middleware, Vue 3 composables, Vitest, Playwright for deployed mobile acceptance.

## Global Constraints

- Running external background threads use the existing `working` indicator; no indicator CSS, color, animation, or layout changes.
- Externally owned turns remain non-interruptible and never populate the local active-turn lease.
- `thread/list` may register `(threadId, rolloutPath)` candidates but must not wait for runtime inspection.
- The batch request accepts 1–50 unique non-empty thread IDs and rejects extra body keys.
- One batch request performs at most one file-descriptor snapshot pass.
- At most one frontend background batch request is in flight; the next cycle starts 2,000 ms after settlement.
- Poll at most the first 50 loaded threads in sidebar recency order, excluding the selected thread and local running/owned threads.
- `unknown` never clears a confirmed external lease.
- Stale batch results never override local takeover, selected-thread ownership, removed threads, stopped polling, or a newer generation.
- Hidden pages send no batch requests and abort an in-flight request; becoming visible schedules an immediate fresh cycle.
- After external running becomes idle, refresh thread summaries once per batch and let existing unread timestamps decide whether the blue dot appears.
- Do not change notification delivery, polling ownership for the selected thread, authentication, Tailscale exposure, or turn interruption behavior.
- Every production behavior change must be preceded by a focused failing test.

---

## File map

- `src/server/externalThreadRuntime.ts`: prepare multiple rollout states and match all unmatched turns with one descriptor scan.
- `src/server/externalThreadRuntime.test.ts`: batch probe, isolation, shared-scan, and single/batch parity tests.
- `src/server/codexAppServerBridge.ts`: register thread-list candidates and expose the validated batch route.
- `src/server/externalThreadRuntimeBridge.test.ts`: thread-list registration and HTTP route contract tests.
- `src/api/codexGateway.ts`: strict `getThreadRuntimeStates()` client.
- `src/api/codexGateway.test.ts`: batch request, parsing, fallback, and abort tests.
- `src/composables/useDesktopState.ts`: bounded background runtime polling lifecycle and state reconciliation.
- `src/composables/useDesktopState.test.ts`: real timer/request behavior and sidebar state regressions.
- `tests/thread-loading-state/background-external-runtime-indicators.md`: deployed mobile acceptance and rollback.

### Task 1: Add one-scan batch runtime inspection

**Files:**
- Modify: `src/server/externalThreadRuntime.ts:1-640`
- Modify: `src/server/externalThreadRuntime.test.ts:1-1140`

**Interfaces:**
- Consumes: registered `(threadId, rolloutPath)` entries and `ExternalRuntimeSystem`.
- Produces: `ExternalThreadRuntimeProbe.inspectMany(threadIds: readonly string[], excludedPid: number | null): Promise<Record<string, ExternalThreadRuntime>>`.
- Preserves: `inspect(threadId, excludedPid): Promise<ExternalThreadRuntime>` by delegating to `inspectMany()`.

- [ ] **Step 1: Extend the fake system for multiple rollout identities**

In `src/server/externalThreadRuntime.test.ts`, allow `FakeRuntimeSystem` to map each rollout path to independent bytes and identities while preserving existing single-thread defaults. Add helpers:

```ts
type FakeRollout = {
  path: string
  log: string
  dev: string
  ino: string
}

function batchProbe(
  rollouts: FakeRollout[],
  fds: RuntimeFdSnapshot[],
): { probe: ExternalThreadRuntimeProbe; system: FakeRuntimeSystem } {
  const system = fakeRuntimeSystem({ rollouts, fds })
  const probe = new ExternalThreadRuntimeProbe({ sessionsRoot, system })
  for (const rollout of rollouts) {
    probe.registerThread(rollout.path.split('/').at(-1)!, rollout.path)
  }
  return { probe, system }
}
```

Keep `registeredProbe()` and existing tests unchanged by treating its default rollout as `thread-1`.

- [ ] **Step 2: Write failing shared-scan and mixed-state tests**

Add tests with two unmatched rollouts, one terminal rollout, and one unregistered ID:

```ts
it('inspects multiple runtimes with one descriptor snapshot pass', async () => {
  const { probe, system } = batchProbe([
    { path: '/sessions/thread-a', log: lifecycle('task_started', 'turn-a'), dev: '8', ino: '21' },
    { path: '/sessions/thread-b', log: lifecycle('task_started', 'turn-b'), dev: '8', ino: '22' },
    {
      path: '/sessions/thread-c',
      log: lifecycle('task_started', 'turn-c') + lifecycle('task_complete', 'turn-c'),
      dev: '8',
      ino: '23',
    },
  ], [
    writerFd({ dev: '8', ino: '21' }),
  ])

  await expect(probe.inspectMany(
    ['thread-a', 'thread-b', 'thread-c', 'missing'],
    99,
  )).resolves.toEqual({
    'thread-a': {
      state: 'running',
      turnId: 'turn-a',
      interruptible: false,
      source: 'external-session-writer',
    },
    'thread-b': { state: 'idle' },
    'thread-c': { state: 'idle' },
    missing: { state: 'unknown' },
  })
  expect(system.scanCount).toBe(1)
})
```

Add a second test where one rollout path escapes `sessionsRoot`; that entry must be `unknown` while the valid writer remains `running`. Add a parity test asserting `inspect('thread-a', 99)` equals the `thread-a` entry returned by a one-element `inspectMany()` call.

- [ ] **Step 3: Run Task 1 tests and verify RED**

Run:

```bash
pnpm vitest run src/server/externalThreadRuntime.test.ts
```

Expected: FAIL because `inspectMany()` and multi-rollout fake-system support do not exist.

- [ ] **Step 4: Extract per-thread preparation from `inspect()`**

Add:

```ts
type PreparedRuntimeInspection =
  | { state: 'idle' | 'unknown' }
  | {
      state: 'unmatched'
      turnId: string
      identity: RuntimeFileIdentity
    }
```

Move the existing path-containment, identity, checkpoint, incremental JSONL parsing, revalidation, and cache assignment into:

```ts
private async prepareInspection(threadId: string): Promise<PreparedRuntimeInspection> {
  const thread = this.threads.get(threadId)
  if (!thread || this.system.platform !== 'linux' || this.system.uid === null) {
    return { state: 'unknown' }
  }

  try {
    const [resolvedSessionsRoot, resolvedPath] = await Promise.all([
      this.system.realpath(this.sessionsRoot),
      this.system.realpath(thread.rolloutPath),
    ])
    if (!isContainedPath(resolvedSessionsRoot, resolvedPath)) return { state: 'unknown' }

    const identity = await this.system.statFile(resolvedPath)
    if (
      !identity.regular
      || identity.path !== resolvedPath
      || !Number.isSafeInteger(identity.size)
      || identity.size < 0
    ) return { state: 'unknown' }

    const cached = thread.cache
    let mustReset = !cached
      || cached.path !== identity.path
      || cached.dev !== identity.dev
      || cached.ino !== identity.ino
      || identity.size < cached.offset
    if (!mustReset && cached && cached.checkpointBytes.length > 0) {
      const checkpointOffset = cached.offset - cached.checkpointBytes.length
      const currentCheckpoint = await this.system.readRange(
        resolvedPath,
        checkpointOffset,
        cached.checkpointBytes.length,
        identity,
      )
      if (!currentCheckpoint.equals(cached.checkpointBytes)) mustReset = true
    }
    const nextCache = mustReset || !cached ? resetCache(identity) : copyCache(cached)

    while (nextCache.offset < identity.size) {
      const length = Math.min(READ_CHUNK_BYTES, identity.size - nextCache.offset)
      const bytes = await this.system.readRange(
        resolvedPath,
        nextCache.offset,
        length,
        identity,
      )
      const chunk = bytes.subarray(0, length)
      if (chunk.length === 0) return { state: 'unknown' }
      appendCheckpointBytes(nextCache, chunk)
      applyChunk(nextCache, chunk)
      nextCache.offset += chunk.length
    }

    const revalidatedIdentity = await this.system.statFile(resolvedPath)
    if (
      !revalidatedIdentity.regular
      || revalidatedIdentity.path !== identity.path
      || revalidatedIdentity.dev !== identity.dev
      || revalidatedIdentity.ino !== identity.ino
      || revalidatedIdentity.size < nextCache.offset
    ) return { state: 'unknown' }
    thread.cache = nextCache

    if (!nextCache.unmatchedTurnId) return { state: 'idle' }
    return {
      state: 'unmatched',
      turnId: nextCache.unmatchedTurnId,
      identity: {
        path: revalidatedIdentity.path,
        dev: revalidatedIdentity.dev,
        ino: revalidatedIdentity.ino,
        size: revalidatedIdentity.size,
      },
    }
  } catch {
    return { state: 'unknown' }
  }
}
```

Do not move descriptor enumeration into this helper.

- [ ] **Step 5: Implement `inspectMany()` and delegate `inspect()`**

Use insertion-ordered records and one snapshot pass:

```ts
async inspectMany(
  threadIds: readonly string[],
  excludedPid: number | null,
): Promise<Record<string, ExternalThreadRuntime>> {
  const uniqueIds = [...new Set(threadIds)]
  const prepared = await Promise.all(uniqueIds.map(async (threadId) => ({
    threadId,
    runtime: await this.prepareInspection(threadId),
  })))
  const states: Record<string, ExternalThreadRuntime> = Object.create(null)
  const unmatched = prepared.filter((entry) => entry.runtime.state === 'unmatched')

  for (const entry of prepared) {
    if (entry.runtime.state === 'idle') states[entry.threadId] = { state: 'idle' }
    if (entry.runtime.state === 'unknown') states[entry.threadId] = { state: 'unknown' }
  }
  if (unmatched.length === 0) return states

  try {
    const writers = new Set<string>()
    for await (const fd of this.system.listFdSnapshots()) {
      for (const entry of unmatched) {
        const runtime = entry.runtime
        if (runtime.state !== 'unmatched') continue
        if (matchesWriter(fd, runtime.identity, this.system.uid!, excludedPid)) {
          writers.add(entry.threadId)
        }
      }
    }
    for (const entry of unmatched) {
      const runtime = entry.runtime
      if (runtime.state !== 'unmatched') continue
      states[entry.threadId] = writers.has(entry.threadId)
        ? {
            state: 'running',
            turnId: runtime.turnId,
            interruptible: false,
            source: 'external-session-writer',
          }
        : { state: 'idle' }
    }
  } catch {
    for (const entry of unmatched) states[entry.threadId] = { state: 'unknown' }
  }
  return states
}

async inspect(threadId: string, excludedPid: number | null): Promise<ExternalThreadRuntime> {
  const states = await this.inspectMany([threadId], excludedPid)
  return states[threadId] ?? { state: 'unknown' }
}
```

- [ ] **Step 6: Verify Task 1 GREEN**

Run:

```bash
pnpm vitest run src/server/externalThreadRuntime.test.ts
```

Expected: the complete runtime-probe suite passes with the new batch tests and all existing replacement/identity/ancestry tests unchanged.

- [ ] **Step 7: Commit Task 1**

```bash
git add src/server/externalThreadRuntime.ts src/server/externalThreadRuntime.test.ts
git commit -m "feat: batch external runtime inspection"
```

### Task 2: Register thread-list candidates and expose the batch route

**Files:**
- Modify: `src/server/codexAppServerBridge.ts:898-940,7550-7620,8060-8110`
- Modify: `src/server/externalThreadRuntimeBridge.test.ts:1-175`

**Interfaces:**
- Consumes: `ExternalThreadRuntimeProbe.inspectMany()` from Task 1.
- Produces: `POST /codex-api/thread-runtime-states` with `{ threadIds: string[] }` and `{ states: Record<string, ExternalThreadRuntime> }`.
- Preserves: existing single-thread GET route and `thread/read`/`thread/resume` augmentation.

- [ ] **Step 1: Expand the bridge fake probe**

Update `fakeProbe()` and `sharedBridgeForTest()` types so they include:

```ts
inspectMany: vi.fn(async (
  threadIds: readonly string[],
  _excludedPid: number | null,
): Promise<Record<string, ExternalThreadRuntime>> => Object.fromEntries(
  threadIds.map((threadId) => [threadId, runtime]),
)),
```

- [ ] **Step 2: Write failing thread-list registration tests**

Add a test for `augmentThreadResultWithExternalRuntime('thread/list', ...)`:

```ts
it('registers thread-list rollout paths without inspecting them', async () => {
  const probe = fakeProbe({ state: 'idle' })
  const payload = {
    data: [
      { id: 'thread-a', path: '/sessions/a.jsonl' },
      { id: 'thread-b', path: '/sessions/b.jsonl' },
      { id: '', path: '/sessions/invalid.jsonl' },
    ],
  }

  await expect(augmentThreadResultWithExternalRuntime(
    'thread/list', payload, probe, 4242,
  )).resolves.toBe(payload)
  expect(probe.registerThread.mock.calls).toEqual([
    ['thread-a', '/sessions/a.jsonl'],
    ['thread-b', '/sessions/b.jsonl'],
  ])
  expect(probe.inspect).not.toHaveBeenCalled()
  expect(probe.inspectMany).not.toHaveBeenCalled()
})
```

- [ ] **Step 3: Write failing batch HTTP route tests**

Under a new `describe('POST /codex-api/thread-runtime-states')`, assert:

```ts
const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-runtime-states`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ threadIds: ['thread-a', 'thread-b'] }),
})
expect(response.status).toBe(200)
await expect(response.json()).resolves.toEqual({ states: {
  'thread-a': { state: 'running', turnId: 'turn-a', interruptible: false, source: 'external-session-writer' },
  'thread-b': { state: 'idle' },
} })
expect(inspectMany).toHaveBeenCalledWith(['thread-a', 'thread-b'], 4242)
```

Add table cases for `null`, `{}`, `{ threadIds: [] }`, 51 IDs, duplicate IDs, empty/whitespace IDs, non-string IDs, and `{ threadIds: ['a'], extra: true }`; each returns 400 without calling `inspectMany`. Add a security-policy case expecting `isRouteDisabled('POST', '/codex-api/thread-runtime-states')` and HTTP 403.

- [ ] **Step 4: Run bridge tests and verify RED**

Run:

```bash
pnpm vitest run src/server/externalThreadRuntimeBridge.test.ts
```

Expected: FAIL because list registration and the POST batch route are absent.

- [ ] **Step 5: Register list results without inspecting**

Change the bridge probe type:

```ts
type ThreadRuntimeProbe = Pick<
  ExternalThreadRuntimeProbe,
  'registerThread' | 'inspect' | 'inspectMany'
>
```

At the start of `augmentThreadResultWithExternalRuntime()`:

```ts
if (method === 'thread/list') {
  const record = asRecord(result)
  const rows = Array.isArray(record?.data) ? record.data : []
  for (const row of rows) {
    const thread = asRecord(row)
    const threadId = readNonEmptyString(thread?.id)
    const rolloutPath = readNonEmptyString(thread?.path)
    if (threadId && rolloutPath) runtimeProbe.registerThread(threadId, rolloutPath)
  }
  return result
}
if (method !== 'thread/read' && method !== 'thread/resume') return result
```

Do not attach runtime fields to list rows.

- [ ] **Step 6: Validate and implement the batch route**

Add an exact parser near the bridge helpers:

```ts
function readRuntimeBatchThreadIds(value: unknown): string[] | null {
  const body = asRecord(value)
  if (!body || Object.keys(body).length !== 1 || !Array.isArray(body.threadIds)) return null
  if (body.threadIds.length < 1 || body.threadIds.length > 50) return null
  if (!body.threadIds.every((id) => typeof id === 'string' && id.trim() === id && id.length > 0)) return null
  const ids = body.threadIds as string[]
  return new Set(ids).size === ids.length ? ids : null
}
```

Handle the route immediately after the existing GET runtime route:

```ts
if (req.method === 'POST' && url.pathname === '/codex-api/thread-runtime-states') {
  let payload: unknown
  try {
    payload = await readJsonBody(req)
  } catch {
    setJson(res, 400, { error: 'Invalid JSON body' })
    return
  }
  const threadIds = readRuntimeBatchThreadIds(payload)
  if (!threadIds) {
    setJson(res, 400, { error: 'Expected 1-50 unique non-empty threadIds' })
    return
  }
  const states = await runtimeProbe.inspectMany(threadIds, appServer.getPid())
  setJson(res, 200, { states })
  return
}
```

The existing global route-security check must remain before this block.

- [ ] **Step 7: Verify Task 2 GREEN**

Run outside restrictive sandboxes because these tests bind `127.0.0.1`:

```bash
pnpm vitest run src/server/externalThreadRuntimeBridge.test.ts src/server/externalThreadRuntime.test.ts
```

Expected: both suites pass.

- [ ] **Step 8: Commit Task 2**

```bash
git add src/server/codexAppServerBridge.ts src/server/externalThreadRuntimeBridge.test.ts
git commit -m "feat: expose batched thread runtime states"
```

### Task 3: Add the strict batch gateway client

**Files:**
- Modify: `src/api/codexGateway.ts:430-525`
- Modify: `src/api/codexGateway.test.ts:1-480`

**Interfaces:**
- Consumes: `POST /codex-api/thread-runtime-states` from Task 2.
- Produces: `getThreadRuntimeStates(threadIds: readonly string[], signal?: AbortSignal): Promise<Record<string, ExternalThreadRuntime>>`.

- [ ] **Step 1: Write failing request and parser tests**

Import `getThreadRuntimeStates` and add:

```ts
it('posts one ordered runtime batch and parses exact states', async () => {
  let requestUrl = ''
  let requestInit: RequestInit | undefined
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    requestUrl = String(input)
    requestInit = init
    return new Response(JSON.stringify({ states: {
      'thread-a': { state: 'running', turnId: 'turn-a', interruptible: false, source: 'external-session-writer' },
      'thread-b': { state: 'idle' },
    } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))

  await expect(getThreadRuntimeStates(['thread-a', 'thread-b'])).resolves.toEqual({
    'thread-a': { state: 'running', turnId: 'turn-a', interruptible: false, source: 'external-session-writer' },
    'thread-b': { state: 'idle' },
  })
  expect(requestUrl).toBe('/codex-api/thread-runtime-states')
  expect(requestInit).toMatchObject({ method: 'POST' })
  expect(JSON.parse(String(requestInit?.body))).toEqual({ threadIds: ['thread-a', 'thread-b'] })
})
```

Add cases where one requested entry is missing or malformed, the response has an extra state, HTTP is non-OK, JSON is invalid, and fetch rejects. Every requested key must be present in the result; malformed/missing keys are `{ state: 'unknown' }`, and unrequested response keys are ignored. Add an AbortController assertion.

- [ ] **Step 2: Run gateway tests and verify RED**

Run:

```bash
pnpm vitest run src/api/codexGateway.test.ts
```

Expected: FAIL because `getThreadRuntimeStates()` is not exported.

- [ ] **Step 3: Reuse the strict single-runtime parser**

Keep `parseExternalThreadRuntime()` private and implement:

```ts
function unknownRuntimeMap(threadIds: readonly string[]): Record<string, ExternalThreadRuntime> {
  return Object.fromEntries(threadIds.map((threadId) => [threadId, { state: 'unknown' }]))
}

export async function getThreadRuntimeStates(
  threadIds: readonly string[],
  signal?: AbortSignal,
): Promise<Record<string, ExternalThreadRuntime>> {
  const fallback = unknownRuntimeMap(threadIds)
  try {
    const response = await fetch('/codex-api/thread-runtime-states', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadIds }),
      signal,
    })
    if (!response.ok) return fallback
    const payload = asRecord(await response.json())
    const states = asRecord(payload?.states)
    if (!states) return fallback
    return Object.fromEntries(threadIds.map((threadId) => [
      threadId,
      parseExternalThreadRuntime(states[threadId]),
    ]))
  } catch {
    return fallback
  }
}
```

- [ ] **Step 4: Verify Task 3 GREEN**

Run:

```bash
pnpm vitest run src/api/codexGateway.test.ts src/server/externalThreadRuntimeBridge.test.ts
```

Expected: both suites pass.

- [ ] **Step 5: Commit Task 3**

```bash
git add src/api/codexGateway.ts src/api/codexGateway.test.ts
git commit -m "feat: fetch background runtime batches"
```

### Task 4: Reconcile background runtime states in the sidebar

**Files:**
- Modify: `src/composables/useDesktopState.ts:1-60,1410-1550,2385-2535,5810-5910`
- Modify: `src/composables/useDesktopState.test.ts:1-160,1240-1575`

**Interfaces:**
- Consumes: `getThreadRuntimeStates()` from Task 3 and existing `sourceGroups`, `runtimeOwnershipByThreadId`, `inProgressById`, `setThreadRuntimeOwnership()`, `setThreadInProgress()`, and `syncFromNotifications()`.
- Produces: no new public composable API; `startPolling()`/`stopPolling()` own the background batch lifecycle.

- [ ] **Step 1: Add a default gateway mock and background test setup**

Add `getThreadRuntimeStates: vi.fn()` to `gatewayMocks` and reset it to `mockResolvedValue({})` in the existing test reset path. Add:

```ts
async function setupBackgroundRuntimeState(selectedThreadId = 'thread-selected') {
  vi.useFakeTimers()
  installFakeTimerWindow({
    'codex-web-local.thread-unread-cutoff.v1': '2026-01-01T00:00:00.000Z',
  })
  vi.stubGlobal('document', {
    visibilityState: 'visible',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })
  gatewayMocks.getPendingServerRequests.mockResolvedValue([])
  gatewayMocks.getThreadGroupsPage.mockResolvedValue({
    groups: [{ projectName: 'Project', threads: [
      { ...thread('thread-running', '/tmp/project'), updatedAtIso: '2026-07-14T00:00:00.000Z' },
      thread(selectedThreadId, '/tmp/project'),
    ] }],
    nextCursor: null,
  })
  const state = useDesktopState()
  state.primeSelectedThread(selectedThreadId)
  await state.refreshAll({ includeSelectedThreadMessages: false })
  return state
}
```

Restore the stubbed document in the existing cleanup.

- [ ] **Step 2: Write the production regression test and verify RED**

```ts
it('shows a non-selected unread desktop task as working after a running batch result', async () => {
  const state = await setupBackgroundRuntimeState()
  gatewayMocks.getThreadRuntimeStates.mockResolvedValue({
    'thread-running': {
      state: 'running',
      turnId: 'turn-external',
      interruptible: false,
      source: 'external-session-writer',
    },
  })

  expect(state.projectGroups.value[0]?.threads[0]).toMatchObject({
    inProgress: false,
    unread: true,
  })
  state.startPolling()
  await vi.advanceTimersByTimeAsync(0)
  await flushMicrotasks()

  expect(state.projectGroups.value[0]?.threads[0]).toMatchObject({
    inProgress: true,
    unread: false,
  })
  expect(gatewayMocks.getThreadRuntimeStates).toHaveBeenCalledWith(
    ['thread-running'],
    expect.any(AbortSignal),
  )
})
```

Run:

```bash
pnpm vitest run src/composables/useDesktopState.test.ts -t "shows a non-selected unread desktop task as working"
```

Expected: FAIL because no background batch poll occurs and the row remains unread.

- [ ] **Step 3: Write failing lifecycle and race tests**

Add focused tests for:

1. Running then idle: resolve `running`, advance 2,000 ms, resolve `idle`, mock the forced thread-list refresh with a later `updatedAt`, and assert `inProgress: false, unread: true`.
2. Unknown after running retains `inProgress: true`.
3. Deferred idle after a `turn/started` local notification does not clear local `inProgress`.
4. Deferred result for a thread selected during the request is ignored.
5. 55 loaded rows send the first 50 in group/list order and exclude selected plus locally running rows.
6. A pending request prevents a second call after 6,000 ms; the next call occurs 2,000 ms after settlement.
7. Hidden visibility aborts the signal and sends no new calls; visible schedules an immediate call.
8. `stopPolling()` aborts and prevents later calls.

Use the real public `projectGroups`, notification callback, fake timers, AbortSignals, and deferred promises; do not add source-substring tests or production test seams.

- [ ] **Step 4: Add background poller state and candidate selection**

Import `getThreadRuntimeStates`, then add:

```ts
const BACKGROUND_RUNTIME_POLL_MS = 2_000
const BACKGROUND_RUNTIME_BATCH_LIMIT = 50

let backgroundRuntimeTimer: number | null = null
let backgroundRuntimeGeneration = 0
let backgroundRuntimeRequest: {
  generation: number
  controller: AbortController
  promise: Promise<void>
} | null = null
let backgroundRuntimePollingEnabled = false
let backgroundRuntimeVisibilityListenerInstalled = false
const backgroundExternalThreadIds = new Set<string>()
```

Candidate selection must preserve flattened `sourceGroups` order:

```ts
function backgroundRuntimeCandidateIds(): string[] {
  const selectedId = selectedThreadId.value
  const ids: string[] = []
  for (const thread of flattenThreads(sourceGroups.value)) {
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

- [ ] **Step 5: Implement cancellation, scheduling, and visibility**

Add helpers:

```ts
function cancelBackgroundRuntimeRequest(): void {
  backgroundRuntimeGeneration += 1
  if (backgroundRuntimeTimer !== null && typeof window !== 'undefined') {
    window.clearTimeout(backgroundRuntimeTimer)
  }
  backgroundRuntimeTimer = null
  backgroundRuntimeRequest?.controller.abort()
  backgroundRuntimeRequest = null
}

function scheduleBackgroundRuntimePolling(delayMs = BACKGROUND_RUNTIME_POLL_MS): void {
  if (!backgroundRuntimePollingEnabled || typeof window === 'undefined') return
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
  if (backgroundRuntimeTimer !== null || backgroundRuntimeRequest !== null) return
  backgroundRuntimeTimer = window.setTimeout(() => {
    backgroundRuntimeTimer = null
    const threadIds = backgroundRuntimeCandidateIds()
    if (threadIds.length === 0) {
      scheduleBackgroundRuntimePolling()
      return
    }
    const generation = backgroundRuntimeGeneration
    const controller = new AbortController()
    const promise = pollBackgroundRuntimeStates(threadIds, generation, controller.signal)
    backgroundRuntimeRequest = { generation, controller, promise }
    void promise.finally(() => {
      if (backgroundRuntimeRequest?.promise !== promise) return
      backgroundRuntimeRequest = null
      if (generation === backgroundRuntimeGeneration) scheduleBackgroundRuntimePolling()
    })
  }, delayMs)
}

function onBackgroundRuntimeVisibilityChange(): void {
  if (typeof document === 'undefined') return
  cancelBackgroundRuntimeRequest()
  if (document.visibilityState === 'visible') scheduleBackgroundRuntimePolling(0)
}
```

Install the visibility listener once in `startPolling()` and remove it in `stopPolling()`.

- [ ] **Step 6: Apply batch states with authority rechecks**

Implement:

```ts
async function pollBackgroundRuntimeStates(
  requestedThreadIds: readonly string[],
  generation: number,
  signal: AbortSignal,
): Promise<void> {
  const states = await getThreadRuntimeStates(requestedThreadIds, signal)
  if (generation !== backgroundRuntimeGeneration) return
  const loadedIds = new Set(flattenThreads(sourceGroups.value).map((thread) => thread.id))
  let shouldRefreshThreads = false

  for (const threadId of requestedThreadIds) {
    if (!loadedIds.has(threadId) || selectedThreadId.value === threadId) continue
    const ownership = runtimeOwnershipByThreadId.value[threadId] ?? 'idle'
    const locallyRunning = inProgressById.value[threadId] === true && ownership !== 'external'
    if (ownership === 'local' || locallyRunning) {
      backgroundExternalThreadIds.delete(threadId)
      continue
    }
    const runtime = states[threadId] ?? { state: 'unknown' }
    if (runtime.state === 'running') {
      backgroundExternalThreadIds.add(threadId)
      setThreadRuntimeOwnership(threadId, 'external')
      setThreadInProgress(threadId, true)
      continue
    }
    if (runtime.state === 'idle' && backgroundExternalThreadIds.has(threadId)) {
      backgroundExternalThreadIds.delete(threadId)
      setThreadRuntimeOwnership(threadId, 'idle')
      setThreadInProgress(threadId, false)
      shouldRefreshThreads = true
    }
  }

  if (shouldRefreshThreads) {
    pendingThreadsRefresh = true
    pendingThreadsRefreshForce = true
    await syncFromNotifications()
  }
}
```

Prune `backgroundExternalThreadIds` when thread groups are pruned. A selected external thread is adopted by the background set when it becomes a non-selected candidate, so a subsequent idle result can clear it safely.

- [ ] **Step 7: Wire start/stop lifecycle**

In `startPolling()`:

```ts
backgroundRuntimePollingEnabled = true
if (typeof document !== 'undefined' && !backgroundRuntimeVisibilityListenerInstalled) {
  document.addEventListener('visibilitychange', onBackgroundRuntimeVisibilityChange)
  backgroundRuntimeVisibilityListenerInstalled = true
}
scheduleBackgroundRuntimePolling(0)
```

In `stopPolling()`:

```ts
backgroundRuntimePollingEnabled = false
cancelBackgroundRuntimeRequest()
backgroundExternalThreadIds.clear()
if (typeof document !== 'undefined' && backgroundRuntimeVisibilityListenerInstalled) {
  document.removeEventListener('visibilitychange', onBackgroundRuntimeVisibilityChange)
  backgroundRuntimeVisibilityListenerInstalled = false
}
```

Do not alter the existing selected external runtime timer or notification stream behavior.

- [ ] **Step 8: Verify Task 4 GREEN**

Run:

```bash
pnpm vitest run src/composables/useDesktopState.test.ts src/api/codexGateway.test.ts
```

Expected: all desktop-state and gateway tests pass, including the exact unread-to-working regression.

- [ ] **Step 9: Commit Task 4**

```bash
git add src/composables/useDesktopState.ts src/composables/useDesktopState.test.ts
git commit -m "fix: sync background external runtime indicators"
```

### Task 5: Document and verify the deployed regression

**Files:**
- Create: `tests/thread-loading-state/background-external-runtime-indicators.md`

**Interfaces:**
- Consumes: the batch endpoint and background poller from Tasks 1–4.
- Produces: repeatable local/deployed acceptance and rollback evidence.

- [ ] **Step 1: Write the acceptance document**

Create `tests/thread-loading-state/background-external-runtime-indicators.md` with these exact checks:

1. Start a task in desktop Codex and record its thread ID.
2. On mobile, open a different thread and expand the sidebar.
3. Confirm single and batch runtime endpoints both return `running` for the desktop thread.
4. Confirm the desktop thread row has `.thread-status-indicator[data-state="working"]` and not `data-state="unread"` within one poll cycle.
5. Confirm the composer remains non-interruptible after selecting that externally owned thread.
6. Return to another thread, complete the desktop task, and confirm working disappears; an unread conversation becomes `data-state="unread"` after summary refresh.
7. Confirm DevTools shows one batch request at a time, at most 50 IDs, and no requests while hidden.
8. Test 390×844 and 768×1024 in light and dark appearances.

Rollback instructions: revert the feature commits, run `pnpm run install:local`, and restart only `codex-mobile-safe.service`; Tailscale Serve remains unchanged.

- [ ] **Step 2: Run focused integration verification**

Run:

```bash
pnpm vitest run \
  src/server/externalThreadRuntime.test.ts \
  src/server/externalThreadRuntimeBridge.test.ts \
  src/api/codexGateway.test.ts \
  src/composables/useDesktopState.test.ts
```

Expected: all four suites pass with no unhandled errors.

- [ ] **Step 3: Run complete verification**

Run outside restrictive network/process sandboxes:

```bash
pnpm test:unit
pnpm build
node dist-cli/safe.js doctor
git diff --check main..HEAD
```

Expected: all unit tests pass, frontend typecheck and both builds exit 0, doctor prints `codex-mobile-safe doctor: ok`, and diff check prints nothing.

- [ ] **Step 4: Commit Task 5**

```bash
git add tests/thread-loading-state/background-external-runtime-indicators.md
git commit -m "test: document background runtime indicators"
```

### Controller integration and deployment

After every task review and the final whole-branch review are clean:

1. Fetch `origin/main` and verify the feature branch still descends from it.
2. Fast-forward merge `codex/fix-background-runtime-indicators` into `main`.
3. Rerun `pnpm test:unit`, `pnpm build`, `node dist-cli/safe.js doctor`, and `git diff --check origin/main..HEAD` on merged `main`.
4. Push `origin/main` without force.
5. Run `pnpm run install:local` and restart `codex-mobile-safe.service`.
6. Verify the service is active, port 5900 listens only on `127.0.0.1`, and Tailscale Serve remains tailnet-only.
7. Reproduce with a real desktop-running thread and a separate selected mobile thread at 390×844. Record:

```text
single runtime state: running
batch runtime state: running
sidebar state while running: working
sidebar state after completion while unread: unread
```

8. Confirm `main == origin/main` and retain sanitized browser/service evidence under `/tmp`.
