# External Thread Runtime Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the true running state after mobile refresh when a selected Codex thread is owned by another app-server on the same Linux host, while keeping that external turn read-only and non-interruptible.

**Architecture:** A server-side incremental rollout-log probe combines an unmatched lifecycle start with a same-user external app-server write descriptor. The bridge attaches that evidence to read/resume responses and exposes a small authenticated polling endpoint; the client models `idle`, `local`, and `external` ownership separately so only external state is revocable by polling.

**Tech Stack:** TypeScript, Node.js filesystem and Linux `/proc`, bridge middleware, Vue 3 Composition API, Vitest.

## Global Constraints

- Confirm external running only from both an unmatched `task_started` and a live external Codex app-server writer for the same rollout device/inode.
- Never count the bridge's own child app-server PID as an external writer.
- Do not use timestamps or the private desktop app-server control socket.
- External ownership is read-only: no interrupt, submit, queue, steer, attachments, model changes, or queue mutation.
- Poll only the selected external thread every 2,000 ms, single-flight; external results cannot clear a local turn-ID lease.
- Non-Linux and inconclusive probes return `unknown`; `unknown` may retain but never establish external running.
- Resolve regular rollout files beneath the configured Codex `sessions` directory; reject escapes.
- Stream the initial rollout and parse only appended bytes later; reset on replacement or truncation.
- Preserve safe authentication, loopback binding, and tailnet-only exposure.

---

## File Structure

- Create `src/types/threadRuntime.ts` for transport-safe runtime types shared by browser and server.
- Create `src/server/externalThreadRuntime.ts` and `.test.ts` for trusted incremental lifecycle and Linux writer probing.
- Modify `src/server/codexAppServerBridge.ts`; create `src/server/externalThreadRuntimeBridge.test.ts` for response augmentation and the status endpoint.
- Modify `src/api/codexGateway.ts` and `.test.ts` for normalized ownership and status polling.
- Modify `src/composables/useDesktopState.ts` and `.test.ts` for external leases, precedence, polling, and mutation guards.
- Modify `ThreadComposer.vue`, `QueuedMessages.vue`, `App.vue`, and `useUiLanguage.ts`; create `externalThreadRuntime.wiring.test.ts` for read-only UI wiring.

---

### Task 1: Incremental External Runtime Probe

**Files:**
- Create: `src/types/threadRuntime.ts`
- Create: `src/server/externalThreadRuntime.ts`
- Create: `src/server/externalThreadRuntime.test.ts`

**Interfaces:**
- Consumes: configured sessions root and current bridge child PID.
- Produces:

```ts
export type ExternalThreadRuntime =
  | { state: 'running'; turnId: string; interruptible: false; source: 'external-session-writer' }
  | { state: 'idle' }
  | { state: 'unknown' }

export type ThreadRuntimeOwnership = 'idle' | 'local' | 'external'
export type ThreadDetailRuntime = {
  inProgress: boolean
  activeTurnId: string
  ownership: ThreadRuntimeOwnership
  canInterrupt: boolean
}

// The remaining adapter types live in src/server/externalThreadRuntime.ts.
export type RuntimeFileIdentity = { path: string; dev: string; ino: string; size: number }
export type RuntimeFdSnapshot = {
  pid: number; uid: number; cmdline: string; dev: string; ino: string
  position: number; flags: number
}
export interface ExternalRuntimeSystem {
  readonly platform: NodeJS.Platform
  readonly uid: number | null
  realpath(path: string): Promise<string>
  statFile(path: string): Promise<RuntimeFileIdentity & { regular: boolean }>
  readRange(path: string, offset: number, length: number): Promise<Buffer>
  listFdSnapshots(): AsyncIterable<RuntimeFdSnapshot>
}
export class ExternalThreadRuntimeProbe {
  constructor(options: { sessionsRoot: string; system?: ExternalRuntimeSystem })
  registerThread(threadId: string, rolloutPath: string): void
  inspect(threadId: string, excludedPid: number | null): Promise<ExternalThreadRuntime>
  clear(): void
}
```

- [ ] **Step 1: Write failing parser and evidence tests**

Use an in-memory `ExternalRuntimeSystem`. Cover matching/mismatched terminal IDs, writer presence/absence, own-PID exclusion, read-only descriptors, unsupported platforms, path escape, partial lines, append-only reads, truncation, and inode replacement.

```ts
it('requires an unmatched start and a live external writer', async () => {
  const system = fakeRuntimeSystem({
    log: lifecycle('task_started', 'turn-a'),
    fds: [writerFd({ pid: 42, turnPath: rolloutPath })],
  })
  const probe = new ExternalThreadRuntimeProbe({ sessionsRoot, system })
  probe.registerThread('thread-1', rolloutPath)
  await expect(probe.inspect('thread-1', 99)).resolves.toEqual({
    state: 'running', turnId: 'turn-a', interruptible: false,
    source: 'external-session-writer',
  })
})

it('does not let an older terminal event clear a newer start', async () => {
  system.append(lifecycle('task_started', 'turn-b') + lifecycle('task_complete', 'turn-a'))
  await expect(probe.inspect('thread-1', 99)).resolves.toMatchObject({
    state: 'running', turnId: 'turn-b',
  })
})
```

- [ ] **Step 2: Run the focused tests and verify RED**

```bash
pnpm vitest run src/server/externalThreadRuntime.test.ts
```

Expected: FAIL because `./externalThreadRuntime` does not exist.

- [ ] **Step 3: Implement trusted incremental parsing and injected Linux evidence scanning**

Read 64 KiB chunks and retain incomplete trailing bytes until a newline. Apply only lifecycle events:

```ts
function applyLifecycleLine(currentTurnId: string, line: string): string {
  const row = asRecord(safeJsonParse(line))
  if (row?.type !== 'event_msg') return currentTurnId
  const payload = asRecord(row.payload)
  const turnId = readNonEmptyString(payload?.turn_id)
  if (payload?.type === 'task_started' && turnId) return turnId
  if ((payload?.type === 'task_complete' || payload?.type === 'turn_aborted') && turnId === currentTurnId) return ''
  return currentTurnId
}
```

Validate containment with `relative(resolvedSessionsRoot, resolvedPath)`. Cache `{ dev, ino, offset, trailingBytes, unmatchedTurnId }`; reset on device/inode change or `size < offset`. Writer evidence requires same UID, external PID, Codex app-server cmdline, same dev/inode, writable access mode, and `position > 0`:

```ts
const accessMode = fd.flags & 0b11
const isWritable = accessMode === 1 || accessMode === 2
const matches = fd.uid === system.uid
  && fd.pid !== excludedPid
  && /(?:^|[\s/])codex(?:\s+app-server|$)/u.test(fd.cmdline.replace(/\0/g, ' '))
  && fd.dev === identity.dev && fd.ino === identity.ino
  && isWritable && fd.position > 0
```

The default adapter scans numeric `/proc` entries, parses the `fdinfo` `flags` field as octal, and tolerates `ENOENT`, `EACCES`, and process exit races. Return `unknown` if the scan cannot be conclusive.

- [ ] **Step 4: Run the focused tests and verify GREEN**

```bash
pnpm vitest run src/server/externalThreadRuntime.test.ts
```

Expected: all probe tests PASS.

- [ ] **Step 5: Commit the probe**

```bash
git add src/types/threadRuntime.ts src/server/externalThreadRuntime.ts src/server/externalThreadRuntime.test.ts
git commit -m "feat: detect externally running Codex turns"
```

---

### Task 2: Bridge Metadata, Runtime Endpoint, and Gateway Normalization

**Files:**
- Modify: `src/server/codexAppServerBridge.ts`
- Create: `src/server/externalThreadRuntimeBridge.test.ts`
- Modify: `src/api/codexGateway.ts`
- Modify: `src/api/codexGateway.test.ts`

**Interfaces:**
- Consumes: `ExternalThreadRuntimeProbe`, `ExternalThreadRuntime`, `ThreadRuntimeOwnership`, and `ThreadDetailRuntime` from Task 1.
- Produces:

```ts
export function readThreadDetailRuntime(payload: ThreadReadResponse): ThreadDetailRuntime
export async function getThreadRuntimeState(threadId: string): Promise<ExternalThreadRuntime>
```

- [ ] **Step 1: Write failing bridge and gateway tests**

Test idle result augmentation, local-active precedence, missing endpoint `threadId`, detail/resume ownership, and strict polling parsing:

```ts
expect(readThreadDetailRuntime(payloadWithExternalRuntime('turn-external'))).toMatchObject({
  inProgress: true, activeTurnId: 'turn-external',
  ownership: 'external', canInterrupt: false,
})
expect(readThreadDetailRuntime(payloadWithLocalTurn)).toMatchObject({
  inProgress: true, ownership: 'local', canInterrupt: true,
})
```

- [ ] **Step 2: Run focused tests and verify RED**

```bash
pnpm vitest run src/server/externalThreadRuntimeBridge.test.ts src/api/codexGateway.test.ts
```

Expected: missing bridge helper and gateway export failures.

- [ ] **Step 3: Add bridge augmentation and endpoint**

Add `AppServerProcess.getPid()`, one probe to `SharedBridgeState`, and clear it during disposal. After sanitizing `thread/read` and `thread/resume`, register `thread.path`; only if the returned app-server state is idle, attach `thread.externalRuntime` without changing persisted turn status.

```ts
runtimeProbe.registerThread(threadId, readNonEmptyString(thread?.path))
if (!readThreadResultInProgress(thread)) {
  thread.externalRuntime = await runtimeProbe.inspect(threadId, appServer.getPid())
}
```

Add inside the existing authenticated/security middleware:

```ts
if (req.method === 'GET' && url.pathname === '/codex-api/thread-runtime-state') {
  const threadId = url.searchParams.get('threadId')?.trim() ?? ''
  if (!threadId) { setJson(res, 400, { error: 'Missing threadId' }); return }
  setJson(res, 200, await runtimeProbe.inspect(threadId, appServer.getPid()))
  return
}
```

- [ ] **Step 4: Normalize explicit client ownership**

Use app-server activity first and external metadata second in both detail and resume:

```ts
export function readThreadDetailRuntime(payload: ThreadReadResponse): ThreadDetailRuntime {
  if (readThreadInProgressFromResponse(payload)) {
    return { inProgress: true, activeTurnId: readActiveTurnIdFromResponse(payload), ownership: 'local', canInterrupt: true }
  }
  const external = readExternalRuntime(payload)
  if (external.state === 'running') {
    return { inProgress: true, activeTurnId: external.turnId, ownership: 'external', canInterrupt: false }
  }
  return { inProgress: false, activeTurnId: '', ownership: 'idle', canInterrupt: false }
}
```

For `thread-1`, `getThreadRuntimeState()` requests `/codex-api/thread-runtime-state?threadId=thread-1`; malformed data becomes `unknown`.

- [ ] **Step 5: Run focused tests and verify GREEN**

```bash
pnpm vitest run src/server/externalThreadRuntimeBridge.test.ts src/api/codexGateway.test.ts
```

Expected: all bridge and gateway runtime tests PASS.

- [ ] **Step 6: Commit bridge and gateway integration**

```bash
git add src/server/codexAppServerBridge.ts src/server/externalThreadRuntimeBridge.test.ts src/api/codexGateway.ts src/api/codexGateway.test.ts
git commit -m "feat: expose external thread runtime state"
```

---

### Task 3: Client Ownership State Machine and Targeted Polling

**Files:**
- Modify: `src/composables/useDesktopState.ts`
- Modify: `src/composables/useDesktopState.test.ts`

**Interfaces:**
- Consumes: `ThreadRuntimeOwnership`, detail runtime fields, and `getThreadRuntimeState()` from Task 2.
- Produces: `selectedThreadRuntimeOwnership: ComputedRef<ThreadRuntimeOwnership>` and guarded thread/queue mutation methods.

- [ ] **Step 1: Write failing ownership and polling tests**

Add `getThreadRuntimeState` to `gatewayMocks`. With fake timers, cover external restoration, one request after 2,000 ms, single-flight behavior, `idle` forced refresh, `unknown` retention, local-start precedence, stale-result rejection, selection/disposal cancellation, and mutation guards.

```ts
it('restores and polls an externally owned selected thread', async () => {
  gatewayMocks.resumeThread.mockResolvedValue(externalDetail('turn-external'))
  gatewayMocks.getThreadRuntimeState.mockResolvedValue({
    state: 'running', turnId: 'turn-external', interruptible: false,
    source: 'external-session-writer',
  })
  const state = useDesktopState()
  state.primeSelectedThread('thread-1')
  await state.loadMessages('thread-1')
  expect(state.selectedThreadRuntimeOwnership.value).toBe('external')
  expect(state.selectedThread.value?.inProgress).toBe(true)
  await vi.advanceTimersByTimeAsync(2_000)
  expect(gatewayMocks.getThreadRuntimeState).toHaveBeenCalledWith('thread-1')
})

it('never lets stale external idle clear a local lease', async () => {
  const pending = deferred<{ state: 'idle' }>()
  gatewayMocks.getThreadRuntimeState.mockReturnValue(pending.promise)
  await establishExternalOwnership(state)
  await vi.advanceTimersByTimeAsync(2_000)
  emit(turnStarted('thread-1', 'turn-local'))
  pending.resolve({ state: 'idle' })
  await flushMicrotasks()
  expect(state.selectedThreadRuntimeOwnership.value).toBe('local')
  expect(state.selectedThread.value?.inProgress).toBe(true)
})
```

- [ ] **Step 2: Run state tests and verify RED**

```bash
pnpm vitest run src/composables/useDesktopState.test.ts
```

Expected: missing runtime mock/export assertions FAIL.

- [ ] **Step 3: Implement ownership precedence and forced detail refresh**

Add `runtimeOwnershipByThreadId`, with absent keys representing `idle`. App-server-active detail and `turn/started` establish `local`; external metadata establishes `external` only if no local active turn ID. A matching local completion clears local ownership. Do not place external turn IDs in `activeTurnIdByThreadId`, which remains the interruptible local lease.

Extend message loading so external completion cannot hit the recent-load cache:

```ts
async function loadMessages(
  threadId: string,
  options: { silent?: boolean; force?: boolean } = {},
) {
  const canReuseLoadedMessages = options.force !== true && alreadyLoaded && (
    loadedRecently || ((version.length === 0 || loadedVersion === version) && inProgressById.value[threadId] !== true)
  )
}
```

Apply precedence explicitly:

```ts
const retainLocal = (activeTurnIdByThreadId.value[threadId] ?? '').length > 0
const ownership = retainLocal ? 'local' : detail.ownership
setThreadRuntimeOwnership(threadId, ownership)
setThreadInProgress(threadId, retainLocal || detail.inProgress)
```

- [ ] **Step 4: Implement selected-only, generation-guarded polling**

Use one timer, one request, and a generation counter:

```ts
const EXTERNAL_RUNTIME_POLL_MS = 2_000
let externalRuntimeTimer: number | null = null
let externalRuntimeGeneration = 0
let externalRuntimeRequest: Promise<void> | null = null

function cancelExternalRuntimePolling(): void {
  externalRuntimeGeneration += 1
  if (externalRuntimeTimer !== null && typeof window !== 'undefined') {
    window.clearTimeout(externalRuntimeTimer)
  }
  externalRuntimeTimer = null
}
```

Before applying a response require unchanged generation, selected ID, and current `external` ownership. `running` reschedules; `unknown`/failure retain and reschedule; `idle` clears only external ownership, clears `inProgress`, then calls `loadMessages(threadId, { silent: true, force: true })`. Selection changes, local starts, `stopPolling()`, and teardown cancel. A later recovered external detail starts a new cycle.

- [ ] **Step 5: Add programmatic mutation guards**

```ts
function isExternallyOwned(threadId: string): boolean {
  return runtimeOwnershipByThreadId.value[threadId] === 'external'
}

async function interruptSelectedThreadTurn(): Promise<void> {
  const threadId = selectedThreadId.value
  if (!threadId || isExternallyOwned(threadId)) return
}
```

Keep the current interrupt RPC body immediately after this guard; the test must prove no RPC occurs for external ownership and the unchanged RPC occurs for local ownership.

Apply the same early return to `sendMessageToSelectedThread`, `removeQueuedMessage`, `reorderQueuedMessage`, and `steerQueuedMessage`.

- [ ] **Step 6: Run state tests and verify GREEN**

```bash
pnpm vitest run src/composables/useDesktopState.test.ts
```

Expected: all state tests PASS, including existing local turn-ID lease regressions.

- [ ] **Step 7: Commit the state machine**

```bash
git add src/composables/useDesktopState.ts src/composables/useDesktopState.test.ts
git commit -m "fix: preserve external running state after refresh"
```

---

### Task 4: Read-Only External Runtime UI

**Files:**
- Modify: `src/components/content/ThreadComposer.vue`
- Modify: `src/components/content/QueuedMessages.vue`
- Modify: `src/App.vue`
- Modify: `src/composables/useUiLanguage.ts`
- Create: `src/components/content/externalThreadRuntime.wiring.test.ts`

**Interfaces:**
- Consumes: `selectedThreadRuntimeOwnership` from Task 3.
- Produces: disabled external stop control, read-only composer, and disabled queue controls.

- [ ] **Step 1: Write failing UI wiring tests**

```ts
expect(appSource).toContain(':runtime-ownership="selectedThreadRuntimeOwnership"')
expect(composerSource).toContain('runtimeOwnership?: ThreadRuntimeOwnership')
expect(composerSource).toContain("const isExternallyOwned = computed(() => props.runtimeOwnership === 'external')")
expect(composerSource).toContain("t('Running in another client')")
expect(queueSource).toContain(':draggable="!disabled"')
expect(queueSource).toContain(':disabled="disabled"')
```

- [ ] **Step 2: Run the UI wiring test and verify RED**

```bash
pnpm vitest run src/components/content/externalThreadRuntime.wiring.test.ts
```

Expected: runtime props and disabled queue wiring are absent.

- [ ] **Step 3: Wire external read-only behavior**

Add `runtimeOwnership` to `ThreadComposer`; include external ownership in `isInteractionDisabled`, `isComposerConfigDisabled`, and `canSubmit`. Keep the stop icon visible for any running turn, but disable and relabel it externally:

```vue
:aria-label="isExternallyOwned ? t('Running in another client') : stopControlLabel"
:title="isExternallyOwned ? t('Running in another client') : stopControlLabel"
:disabled="isExternallyOwned || disabled || !activeThreadId || isInterruptingTurn || isStopPending"
```

Guard `onSubmit` and `onInterrupt` against keyboard/programmatic emission. Add `disabled?: boolean` to `QueuedMessages`, use `:draggable="!disabled"`, disable edit/steer/delete/drag controls, and return early in drag/drop handlers. From `App.vue`, pass ownership to `ThreadComposer` and `:disabled="selectedThreadRuntimeOwnership === 'external'"` to `QueuedMessages`.

```ts
'Running in another client': '正在其他客户端中运行',
```

- [ ] **Step 4: Run UI and state tests and verify GREEN**

```bash
pnpm vitest run src/components/content/externalThreadRuntime.wiring.test.ts src/composables/useDesktopState.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit the read-only UI**

```bash
git add src/components/content/ThreadComposer.vue src/components/content/QueuedMessages.vue src/App.vue src/composables/useUiLanguage.ts src/components/content/externalThreadRuntime.wiring.test.ts
git commit -m "feat: show externally running threads as read-only"
```

---

### Task 5: Regression, Acceptance, and Deployment Handoff

**Files:**
- Verify: all files changed in Tasks 1–4
- Reference: `docs/superpowers/specs/2026-07-13-external-thread-runtime-design.md`

**Interfaces:**
- Consumes: complete server/client feature.
- Produces: review evidence proving it is safe to integrate and deploy.

- [ ] **Step 1: Run focused regression tests**

```bash
pnpm vitest run src/server/externalThreadRuntime.test.ts src/server/externalThreadRuntimeBridge.test.ts src/api/codexGateway.test.ts src/composables/useDesktopState.test.ts src/components/content/externalThreadRuntime.wiring.test.ts
```

Expected: all focused tests PASS.

- [ ] **Step 2: Run the complete suite and production build**

```bash
pnpm test:unit
pnpm build
```

Expected: all Vitest tests, `vue-tsc`, Vite, and CLI `tsup` PASS.

- [ ] **Step 3: Audit the complete change**

```bash
git diff --check main...HEAD
git status --short
git log --oneline --decorate main..HEAD
```

Expected: no whitespace errors or untracked artifacts; only intentional commits.

- [ ] **Step 4: Perform the two-app-server acceptance scenario**

Run a long desktop turn, start this branch on loopback port `5901`, and request the diagnosed thread:

```bash
curl -fsS "http://127.0.0.1:5901/codex-api/thread-runtime-state?threadId=019f50f7-b8d9-72a3-9861-5ca7c3a0ea1e" \
  | jq -e '.state == "running" and (.turnId | type == "string" and length > 0) and .interruptible == false and .source == "external-session-writer"'
```

Expected while desktop owns the turn:

```text
true
```

Refresh mobile and confirm the sidebar spinner, disabled stop-shaped control, and `正在其他客户端中运行`. Finish the desktop turn. Within one poll interval expect `{"state":"idle"}` and terminal output loaded without another refresh.

- [ ] **Step 5: Request code review before integration**

Use `requesting-code-review` to inspect spec coverage, `/proc` safety, parser cache correctness, state-race precedence, and regression coverage. Resolve confirmed findings and rerun Steps 1–3.

- [ ] **Step 6: Integrate and deploy only after review passes**

Use `finishing-a-development-branch` for integration. After merging to `main`, push `origin/main`, install, and restart:

```bash
pnpm install:local
systemctl --user restart codex-mobile-safe.service
codex-mobile-safe doctor
codex-mobile-safe status
codex-mobile-safe urls
```

Expected: doctor PASS, service active, Codex bound only to `127.0.0.1:5900`, and the public URL remains Tailscale tailnet-only.
