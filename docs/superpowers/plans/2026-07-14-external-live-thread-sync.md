# External Live Thread Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the selected mobile view of a desktop-owned Codex task updated with the latest visible output and desktop reasoning summary, while pausing all polling in a hidden browser.

**Architecture:** Replace the selected external thread's runtime-only request with one abortable, bounded `thread/read` detail request that already includes the external runtime result. Share normal detail reconciliation with the polling path, derive an overlay-only summary from visible reasoning summary messages, and coordinate selected/background poll cancellation through one visibility lifecycle.

**Tech Stack:** TypeScript, Vue 3 composables, existing Codex app-server RPC bridge, Vitest fake timers, Playwright mobile acceptance.

## Global Constraints

- Only the currently selected externally owned thread receives live detail snapshots; non-selected threads remain on the lightweight batch runtime endpoint.
- The next selected external snapshot starts 2,000 ms after the previous request settles; at most one selected snapshot request is in flight.
- A hidden page aborts selected and background runtime requests and schedules no new requests; a visible page schedules both eligible pollers immediately.
- The selected external snapshot uses one abortable `thread/read` RPC and must not also call `/codex-api/thread-runtime-state` in the same cycle.
- Existing RPC response trimming remains the payload bound: at most the most recent ten turns cross the normal RPC endpoint.
- New output merges by stable message ID while preserving older messages omitted from the bounded response.
- The latest non-empty reasoning summary paragraph for the active external turn replaces `Thinking`; one matching outer `**...**` wrapper is removed.
- Only the visible reasoning `summary` is eligible; hidden reasoning `content` is never read or displayed.
- Active external reasoning is displayed in the live overlay without a duplicate transcript item, then returns to the transcript after completion.
- An idle snapshot applies final output before clearing external ownership, in-progress state, and the live overlay.
- `unknown`, request failure, or abort never clears a confirmed external lease or the last detailed summary.
- Stale requests never mutate messages or summaries after selection, ownership, generation, visibility, or polling-stop changes.
- Externally owned work remains non-interruptible and never populates a local active-turn lease.
- Local notification-driven live output, authentication, Tailscale exposure, notification delivery, ntfy behavior, and sidebar batch semantics do not change.
- Every production behavior change must be preceded by a focused failing test.

---

## File map

- `src/api/codexRpcClient.ts`: accept an optional abort signal for RPC fetches.
- `src/api/codexGateway.ts`: pass an optional signal through `getThreadDetail()`.
- `src/api/codexGateway.test.ts`: verify exact signal propagation and unchanged detail normalization.
- `src/composables/externalLiveSnapshot.ts`: normalize the latest visible active-turn reasoning summary and identify active reasoning items hidden during live display.
- `src/composables/externalLiveSnapshot.test.ts`: cover summary selection, Markdown-wrapper removal, whitespace, and turn scoping.
- `src/composables/useDesktopState.ts`: share detail reconciliation, merge external snapshots, manage overlay state, and coordinate visibility-aware polling.
- `src/composables/useDesktopState.test.ts`: cover output refresh, summary refresh, idle/failure behavior, cadence, visibility, cancellation, and stale-result fences.
- `tests/thread-loading-state/external-live-thread-sync.md`: repeatable deployed desktop/mobile acceptance and rollback procedure.

### Task 1: Make thread detail reads abortable

**Files:**
- Modify: `src/api/codexRpcClient.ts:24-43`
- Modify: `src/api/codexGateway.ts:650-661,869-894,967-983`
- Modify: `src/api/codexGateway.test.ts:192-248`

**Interfaces:**
- Consumes: existing `rpcCall<T>(method, params)` and `getThreadDetail(threadId)` callers.
- Produces: `rpcCall<T>(method: string, params?: unknown, signal?: AbortSignal): Promise<T>` and `getThreadDetail(threadId: string, signal?: AbortSignal): Promise<ThreadDetail>`.
- Preserves: every existing two-argument RPC call and one-argument detail call.

- [ ] **Step 1: Write the failing signal-propagation test**

Add to the `getThreadDetail` describe block in `src/api/codexGateway.test.ts`:

```ts
it('forwards the caller abort signal to thread/read', async () => {
  const controller = new AbortController()
  let requestSignal: AbortSignal | null | undefined
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestSignal = init?.signal
    return new Response(JSON.stringify({
      result: {
        thread: {
          id: 'external-thread',
          turns: [],
          externalRuntime: {
            state: 'running',
            turnId: 'turn-external',
            interruptible: false,
            source: 'external-session-writer',
          },
        },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))

  await expect(getThreadDetail('external-thread', controller.signal)).resolves.toMatchObject({
    ownership: 'external',
    activeTurnId: 'turn-external',
  })
  expect(requestSignal).toBe(controller.signal)
})
```

- [ ] **Step 2: Run Task 1 test and verify RED**

Run:

```bash
pnpm vitest run src/api/codexGateway.test.ts -t "forwards the caller abort signal"
```

Expected: FAIL because `getThreadDetail()` does not accept or forward the signal and `requestSignal` is `undefined`.

- [ ] **Step 3: Add the optional signal through the RPC stack**

Change `src/api/codexRpcClient.ts`:

```ts
export async function rpcCall<T>(
  method: string,
  params?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const body: RpcRequestBody = { method, params: params ?? null }

  let response: Response
  try {
    response = await fetch('/codex-api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  } catch (error) {
    // Keep the existing CodexApiError normalization unchanged.
```

Change the local wrapper and detail functions in `src/api/codexGateway.ts`:

```ts
async function callRpc<T>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
  try {
    return await rpcCall<T>(method, params, signal)
  } catch (error) {
    throw normalizeCodexApiError(error, `RPC ${method} failed`, method)
  }
}

async function getThreadDetailV2(threadId: string, signal?: AbortSignal): Promise<ThreadDetailResult> {
  const payload = await callRpc<ThreadReadResponse>('thread/read', {
    threadId,
    includeTurns: true,
  }, signal)
  // Preserve the existing normalization and return object.
}

export async function getThreadDetail(
  threadId: string,
  signal?: AbortSignal,
): Promise<ThreadDetailResult> {
  try {
    return await getThreadDetailV2(threadId, signal)
  } catch (error) {
    throw normalizeCodexApiError(error, `Failed to load thread ${threadId}`, 'thread/read')
  }
}
```

Use the existing inferred/exported detail return shape rather than introducing a second incompatible interface.

- [ ] **Step 4: Run Task 1 verification**

Run:

```bash
pnpm vitest run src/api/codexGateway.test.ts
pnpm run build
```

Expected: all gateway tests pass; Vue typecheck, frontend build, and CLI build exit 0. The existing Vite chunk-size advisory is allowed.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/api/codexRpcClient.ts src/api/codexGateway.ts src/api/codexGateway.test.ts
git commit -m "feat: make thread detail reads abortable"
```

### Task 2: Reconcile external summaries and bounded output snapshots

**Files:**
- Create: `src/composables/externalLiveSnapshot.ts`
- Create: `src/composables/externalLiveSnapshot.test.ts`
- Modify: `src/composables/useDesktopState.ts:1400-1665,2280-2360,2780-3035,4790-4955,6080-6120`
- Modify: `src/composables/useDesktopState.test.ts:50-125,2420-2470`

**Interfaces:**
- Consumes: normalized `UiMessage[]`, `ThreadDetail` from Task 1, existing `mergeMessages()`, `setPersistedMessagesForThread()`, and runtime ownership state.
- Produces:

```ts
export type ExternalReasoningSnapshot = {
  turnId: string
  label: string
  hiddenMessageIds: string[]
}

export function readExternalReasoningSnapshot(
  messages: readonly UiMessage[],
  activeTurnId: string,
): ExternalReasoningSnapshot
```

- Preserves: local live reasoning and normal persisted history rendering.

- [ ] **Step 1: Write failing pure summary tests**

Create `src/composables/externalLiveSnapshot.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { UiMessage } from '../types/codex'
import { readExternalReasoningSnapshot } from './externalLiveSnapshot'

function reasoning(id: string, turnId: string, text: string): UiMessage {
  return { id, turnId, role: 'assistant', text, messageType: 'reasoning' }
}

describe('external live reasoning snapshot', () => {
  it('uses the latest active-turn summary paragraph and removes one outer bold wrapper', () => {
    const result = readExternalReasoningSnapshot([
      reasoning('old-turn', 'turn-old', '**Ignore me**'),
      reasoning('reasoning-1', 'turn-active', '**Inspecting fixtures**\n\n**Reading development-workflow.md**'),
    ], 'turn-active')

    expect(result).toEqual({
      turnId: 'turn-active',
      label: 'Reading development-workflow.md',
      hiddenMessageIds: ['reasoning-1'],
    })
  })

  it('hides every active-turn reasoning item but takes the newest non-empty label', () => {
    expect(readExternalReasoningSnapshot([
      reasoning('reasoning-1', 'turn-active', '**Planning**'),
      reasoning('reasoning-2', 'turn-active', '  Designing   tests  '),
    ], 'turn-active')).toEqual({
      turnId: 'turn-active',
      label: 'Designing tests',
      hiddenMessageIds: ['reasoning-1', 'reasoning-2'],
    })
  })

  it('returns an empty fallback state without exposing another turn', () => {
    expect(readExternalReasoningSnapshot([
      reasoning('reasoning-1', 'turn-old', '**Old summary**'),
    ], 'turn-active')).toEqual({
      turnId: 'turn-active',
      label: '',
      hiddenMessageIds: [],
    })
  })
})
```

- [ ] **Step 2: Run pure tests and verify RED**

Run:

```bash
pnpm vitest run src/composables/externalLiveSnapshot.test.ts
```

Expected: FAIL because the module and export do not exist.

- [ ] **Step 3: Implement visible-summary normalization**

Create `src/composables/externalLiveSnapshot.ts`:

```ts
import type { UiMessage } from '../types/codex'

export type ExternalReasoningSnapshot = {
  turnId: string
  label: string
  hiddenMessageIds: string[]
}

function normalizeSummaryParagraph(value: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim()
  if (normalized.length > 4 && normalized.startsWith('**') && normalized.endsWith('**')) {
    return normalized.slice(2, -2).trim()
  }
  return normalized
}

export function readExternalReasoningSnapshot(
  messages: readonly UiMessage[],
  activeTurnId: string,
): ExternalReasoningSnapshot {
  if (!activeTurnId) return { turnId: '', label: '', hiddenMessageIds: [] }
  const rows = messages.filter((message) => (
    message.messageType === 'reasoning'
    && message.turnId === activeTurnId
    && message.text.trim().length > 0
  ))
  const latest = rows.at(-1)
  const paragraphs = latest?.text
    .split(/\n\s*\n/gu)
    .map(normalizeSummaryParagraph)
    .filter(Boolean) ?? []
  return {
    turnId: activeTurnId,
    label: paragraphs.at(-1) ?? '',
    hiddenMessageIds: rows.map((message) => message.id),
  }
}
```

- [ ] **Step 4: Write failing public state tests for initial external detail**

Add to `src/composables/useDesktopState.test.ts` near the live overlay tests:

```ts
it('shows the latest visible external reasoning summary without duplicating its message', async () => {
  installTestWindow()
  gatewayMocks.getPendingServerRequests.mockResolvedValue([])
  gatewayMocks.resumeThread.mockResolvedValue({
    ...externalDetail('turn-external'),
    messages: [
      {
        id: 'reasoning-1',
        role: 'assistant',
        text: '**Inspecting fixtures**\n\n**Reading development-workflow.md**',
        messageType: 'reasoning',
        turnId: 'turn-external',
      },
      {
        id: 'agent-1',
        role: 'assistant',
        text: 'Initial desktop output',
        messageType: 'agentMessage',
        turnId: 'turn-external',
      },
    ],
  })

  const state = useDesktopState()
  state.primeSelectedThread('thread-external')
  await state.loadMessages('thread-external')

  expect(state.selectedLiveOverlay.value?.activityLabel).toBe('Reading development-workflow.md')
  expect(state.messages.value).toEqual([
    expect.objectContaining({ id: 'agent-1', text: 'Initial desktop output' }),
  ])
})

it('falls back to Thinking until the external turn has a visible summary', async () => {
  installTestWindow()
  gatewayMocks.getPendingServerRequests.mockResolvedValue([])
  gatewayMocks.resumeThread.mockResolvedValue(externalDetail('turn-external'))

  const state = useDesktopState()
  state.primeSelectedThread('thread-external')
  await state.loadMessages('thread-external')

  expect(state.selectedLiveOverlay.value?.activityLabel).toBe('Thinking')
})
```

- [ ] **Step 5: Run state tests and verify RED**

Run:

```bash
pnpm vitest run src/composables/useDesktopState.test.ts -t "external reasoning summary|falls back to Thinking"
```

Expected: the fallback test passes and the detailed-summary/hiding test fails because persisted reasoning is still rendered and the overlay remains `Thinking`.

- [ ] **Step 6: Extract and reuse detail reconciliation**

In `useDesktopState.ts`, introduce an inferred detail type and a synchronous reconciliation helper:

```ts
type ThreadDetailSnapshot = Awaited<ReturnType<typeof getThreadDetail>>

function reconcileThreadDetailSnapshot(
  threadId: string,
  detail: ThreadDetailSnapshot,
  options: { preserveMissing: boolean; markRead: boolean },
): void {
  // Move the existing model/provider, ownership, pagination, turn-index,
  // persisted-message merge, live-command/file-change cleanup, loaded-state,
  // active-turn, in-progress, transient-error, and mark-read assignments from
  // loadMessages() here without changing their order or semantics.
}
```

The persisted merge inside the helper must use:

```ts
const previousPersisted = persistedMessagesByThreadId.value[threadId] ?? []
const mergedMessages = mergeMessages(previousPersisted, detail.messages, {
  preserveMissing: options.preserveMissing || hasOptimisticUserMessages(previousPersisted),
})
setPersistedMessagesForThread(threadId, mergedMessages)
```

After resolving `ownership` and `inProgress`, update external reasoning state:

```ts
const externalReasoningSnapshotByThreadId = ref<Record<string, ExternalReasoningSnapshot>>({})

function reconcileExternalReasoningSnapshot(
  threadId: string,
  detail: ThreadDetailSnapshot,
  ownership: ThreadRuntimeOwnership,
  inProgress: boolean,
): void {
  if (ownership !== 'external' || !inProgress || !detail.activeTurnId) {
    externalReasoningSnapshotByThreadId.value = omitKey(
      externalReasoningSnapshotByThreadId.value,
      threadId,
    )
    return
  }
  const incoming = readExternalReasoningSnapshot(detail.messages, detail.activeTurnId)
  const previous = externalReasoningSnapshotByThreadId.value[threadId]
  const next = !incoming.label && previous?.turnId === incoming.turnId
    ? { ...incoming, label: previous.label }
    : incoming
  externalReasoningSnapshotByThreadId.value = {
    ...externalReasoningSnapshotByThreadId.value,
    [threadId]: next,
  }
}
```

Use it in `selectedLiveOverlay`:

```ts
const externalReasoning = runtimeOwnershipByThreadId.value[threadId] === 'external'
  ? externalReasoningSnapshotByThreadId.value[threadId]
  : undefined

return {
  activityLabel: externalReasoning?.label || activity?.label || 'Thinking',
  activityDetails: activity?.details ?? [],
  reasoningText,
  errorText,
}
```

Filter only active external reasoning from the computed `messages` result:

```ts
const hiddenReasoningIds = runtimeOwnershipByThreadId.value[threadId] === 'external'
  && inProgressById.value[threadId] === true
  ? new Set(externalReasoningSnapshotByThreadId.value[threadId]?.hiddenMessageIds ?? [])
  : new Set<string>()
const visibleCombined = hiddenReasoningIds.size > 0
  ? combined.filter((message) => !hiddenReasoningIds.has(message.id))
  : combined
```

Use `visibleCombined` for the existing turn-summary insertion. Prune the new map in `pruneThreadScopedState()`, clear it in `stopPolling()`, and clear the thread entry whenever ownership/in-progress becomes terminal.

Finally, reduce `loadMessages()` to fetching/resuming detail and calling the helper with:

```ts
reconcileThreadDetailSnapshot(threadId, detail, {
  preserveMissing: options.silent === true,
  markRead: true,
})
```

- [ ] **Step 7: Run Task 2 verification**

Run:

```bash
pnpm vitest run \
  src/composables/externalLiveSnapshot.test.ts \
  src/composables/useDesktopState.test.ts
pnpm run build
```

Expected: both suites and typecheck/build pass with no new warnings beyond the existing Vite chunk advisory.

- [ ] **Step 8: Commit Task 2**

```bash
git add \
  src/composables/externalLiveSnapshot.ts \
  src/composables/externalLiveSnapshot.test.ts \
  src/composables/useDesktopState.ts \
  src/composables/useDesktopState.test.ts
git commit -m "feat: reconcile external live thread snapshots"
```

### Task 3: Poll external output and pause all runtime refresh in background

**Files:**
- Modify: `src/composables/useDesktopState.ts:1530-1555,2455-2665,4790-4955,5995-6075`
- Modify: `src/composables/useDesktopState.test.ts:1269-2025`

**Interfaces:**
- Consumes: abortable `getThreadDetail(threadId, signal)` from Task 1 and `reconcileThreadDetailSnapshot()` from Task 2.
- Produces: one visibility-aware selected external snapshot loop with a 2,000 ms post-settlement cadence.
- Preserves: `getThreadRuntimeStates()` background batching and its authority/selection version fences.

- [ ] **Step 1: Replace selected runtime-only test expectations with failing snapshot expectations**

Update the selected external polling tests to use `getThreadDetail` rather than `getThreadRuntimeState`. Add this focused regression:

```ts
it('refreshes external reasoning and agent output without a page reload', async () => {
  const { state } = await setupExternalRuntimeState()
  gatewayMocks.resumeThread.mockResolvedValue(externalDetail('turn-external'))
  gatewayMocks.getThreadDetail.mockResolvedValue({
    ...externalDetail('turn-external'),
    messages: [
      {
        id: 'reasoning-live',
        role: 'assistant',
        text: '**Reading development-workflow.md**',
        messageType: 'reasoning',
        turnId: 'turn-external',
      },
      {
        id: 'agent-live',
        role: 'assistant',
        text: 'New desktop output',
        messageType: 'agentMessage',
        turnId: 'turn-external',
      },
    ],
  })
  await state.loadMessages('thread-1')

  await vi.advanceTimersByTimeAsync(2_000)
  await flushMicrotasks()

  expect(gatewayMocks.getThreadDetail).toHaveBeenCalledWith(
    'thread-1',
    expect.any(AbortSignal),
  )
  expect(gatewayMocks.getThreadRuntimeState).not.toHaveBeenCalled()
  expect(state.selectedLiveOverlay.value?.activityLabel).toBe('Reading development-workflow.md')
  expect(state.messages.value).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'agent-live', text: 'New desktop output' }),
  ]))
})
```

Add a stable-ID update assertion by returning `agent-live` again with `text: 'New desktop output updated'` on the next cycle and asserting exactly one message with that ID.

- [ ] **Step 2: Run the refresh regression and verify RED**

Run:

```bash
pnpm vitest run src/composables/useDesktopState.test.ts -t "refreshes external reasoning and agent output"
```

Expected: FAIL because the poller calls `getThreadRuntimeState` and never reconciles the detail snapshot.

- [ ] **Step 3: Replace the selected external poll request**

Change `pollExternalRuntime()` to one detail read:

```ts
async function pollExternalRuntime(
  threadId: string,
  generation: number,
  signal: AbortSignal,
): Promise<void> {
  try {
    const detail = await getThreadDetail(threadId, signal)
    if (generation !== externalRuntimeGeneration) return
    if (selectedThreadId.value !== threadId) return
    if (runtimeOwnershipByThreadId.value[threadId] !== 'external') return

    reconcileThreadDetailSnapshot(threadId, detail, {
      preserveMissing: true,
      markRead: true,
    })
  } catch {
    // Abort and read failures retain the confirmed external lease, output, and summary.
  }
}
```

The reconciliation helper must apply messages before it clears external state on an idle detail. Do not call `loadMessages()` or `getThreadRuntimeState()` inside this poll path.

- [ ] **Step 4: Add failing idle/failure and post-settlement tests**

Add or adapt tests that prove:

```ts
it('applies final external output before clearing the live overlay', async () => {
  // Initial resume returns externalDetail(). Poll returns idleDetail() plus final agent/reasoning.
  // Assert final messages are present, ownership is idle, inProgress is false,
  // and the external overlay is gone after the same settled request.
})

it('retains the last detailed summary and output when a snapshot read fails', async () => {
  // First poll returns running detail with a detailed summary/output.
  // Second poll rejects. Assert the prior label/output and external lease remain.
})

it('starts the next external snapshot two seconds after settlement', async () => {
  const pending = deferred<ReturnType<typeof externalDetail>>()
  // Advance well beyond two seconds while pending and assert one call.
  // Resolve, flush, advance 1,999 ms and assert one; advance 1 ms and assert two.
})
```

Use real assertions from the existing external runtime tests; do not leave comment-only test bodies.

- [ ] **Step 5: Run lifecycle tests and verify RED**

Run:

```bash
pnpm vitest run src/composables/useDesktopState.test.ts -t "final external output|last detailed summary|two seconds after settlement"
```

Expected: at least the summary/output tests fail until the selected poller uses and reconciles detail snapshots.

- [ ] **Step 6: Make both runtime pollers visibility-aware through one listener**

Replace the background-only visibility handler with:

```ts
function onRuntimeVisibilityChange(): void {
  if (typeof document === 'undefined') return
  cancelBackgroundRuntimeRequest()
  cancelExternalRuntimePolling()
  if (document.visibilityState !== 'visible') return
  scheduleBackgroundRuntimePolling(0)
  const selectedId = selectedThreadId.value
  if (selectedId && runtimeOwnershipByThreadId.value[selectedId] === 'external') {
    scheduleExternalRuntimePolling(selectedId, 0)
  }
}
```

Change the selected scheduler signature and guard:

```ts
function scheduleExternalRuntimePolling(
  threadId: string,
  delayMs = EXTERNAL_RUNTIME_POLL_MS,
): void {
  if (!externalRuntimePollingEnabled || typeof window === 'undefined') return
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
  // Preserve selected ID, ownership, timer, and in-flight guards.
  externalRuntimeTimer = window.setTimeout(() => {
    // Preserve generation/controller/single-flight/finally behavior.
  }, delayMs)
}
```

Install/remove `onRuntimeVisibilityChange` once in `startPolling()`/`stopPolling()`. Rename the boolean to `runtimeVisibilityListenerInstalled` so it reflects both pollers.

- [ ] **Step 7: Add failing visibility and stale-result tests**

Add a test with a deferred detail request and the existing stubbed document:

```ts
it('aborts selected and background requests while hidden and refreshes immediately when visible', async () => {
  // Establish one selected external thread and one eligible background thread.
  // Start both deferred requests, fire hidden visibilitychange, and assert both signals aborted.
  // Advance 10 seconds and assert no extra calls.
  // Fire visible visibilitychange, advance 0, and assert one fresh selected detail
  // call plus one fresh background batch call.
})
```

Adapt the existing selection, local-takeover, stop, and delayed terminal-detail tests so deferred `getThreadDetail()` results cannot mutate state after their signal/generation becomes stale.

- [ ] **Step 8: Run Task 3 verification**

Run:

```bash
pnpm vitest run \
  src/api/codexGateway.test.ts \
  src/composables/externalLiveSnapshot.test.ts \
  src/composables/useDesktopState.test.ts
pnpm test:unit
pnpm run build
```

Expected: focused suites, all unit suites, typecheck, frontend build, and CLI build pass. HTTP/process tests must be rerun outside restrictive sandboxes rather than weakened.

- [ ] **Step 9: Commit Task 3**

```bash
git add src/composables/useDesktopState.ts src/composables/useDesktopState.test.ts
git commit -m "fix: live-sync selected external threads"
```

### Task 4: Document and verify deployed external live sync

**Files:**
- Create: `tests/thread-loading-state/external-live-thread-sync.md`

**Interfaces:**
- Consumes: Tasks 1-3 and the existing safe installation/service workflow.
- Produces: repeatable mobile acceptance, sanitized evidence fields, and rollback instructions.

- [ ] **Step 1: Write the acceptance document**

Create `tests/thread-loading-state/external-live-thread-sync.md` with this exact sequence:

1. Start a desktop Codex turn that emits at least two visible reasoning summaries and two commentary/agent messages.
2. Record the desktop thread ID and open the same thread in mobile Chrome without reloading again.
3. At 390×844, confirm the live overlay changes from `Thinking` to the newest desktop-visible summary within one settled polling cycle.
4. Confirm each new desktop commentary message appears without reload and each stable message ID renders once.
5. Confirm the externally owned composer remains non-interruptible.
6. Record DevTools requests and confirm one selected `thread/read` RPC request at a time, no selected `/codex-api/thread-runtime-state` request, and the next detail read starts at least 2,000 ms after settlement.
7. Hide the page for at least five seconds; confirm the in-flight detail/batch requests abort and no new detail or batch request starts.
8. Return visible; confirm one immediate detail refresh catches up both summary and output.
9. Complete the desktop task; confirm the final output appears before the live overlay disappears and persisted reasoning becomes visible in history.
10. Repeat layout checks at 768×1024 and in light/dark appearances.

Evidence template:

```text
selected external thread: <sanitized ID suffix>
summary before/after: Thinking -> <visible summary>
output message count before/after: <n> -> <n+1>
duplicate stable IDs: 0
max selected detail requests in flight: 1
runtime-only selected requests: 0
requests while hidden: 0
foreground catch-up: passed
final output before overlay clear: passed
```

Rollback: revert the feature commits, run `pnpm run install:local`, and restart only `codex-mobile-safe.service`; do not change or restart Tailscale Serve.

- [ ] **Step 2: Run focused verification**

Run:

```bash
pnpm vitest run \
  src/api/codexGateway.test.ts \
  src/composables/externalLiveSnapshot.test.ts \
  src/composables/useDesktopState.test.ts
```

Expected: all focused suites pass with no unhandled errors.

- [ ] **Step 3: Run complete verification**

Run outside restrictive network/process sandboxes:

```bash
pnpm test:unit
pnpm run build
node dist-cli/safe.js doctor
git diff --check main..HEAD
```

Expected: every unit test passes; Vue typecheck, frontend build, and both CLI builds exit 0; doctor prints `codex-mobile-safe doctor: ok`; diff check prints nothing.

- [ ] **Step 4: Commit Task 4**

```bash
git add tests/thread-loading-state/external-live-thread-sync.md
git commit -m "test: document external live thread sync"
```

## Controller integration and deployment

After every task review and the final whole-branch review are clean:

1. Fetch `origin/main` and verify `origin/main` is an ancestor of `codex/fix-external-live-sync`.
2. Fast-forward merge the feature branch into local `main`.
3. On merged `main`, rerun `pnpm test:unit`, `pnpm run build`, `node dist-cli/safe.js doctor`, and `git diff --check origin/main..HEAD`.
4. Push `origin/main` without force.
5. Run `pnpm run install:local` and restart `codex-mobile-safe.service`.
6. Verify the service is active, port 5900 listens only on `127.0.0.1`, and Tailscale Serve remains `tailnet only`.
7. Perform the acceptance document against a real desktop-owned running thread at 390×844, retaining sanitized JSON, request timing, and screenshots under `/tmp`.
8. Confirm `main == origin/main`, the main worktree is clean, and remove the owned feature worktree/branch only after successful deployment verification.
