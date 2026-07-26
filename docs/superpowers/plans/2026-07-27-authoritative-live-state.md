# Authoritative Live State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Mobile render active externally owned tasks from writer-owned live snapshots, and never display stale derived footer values such as `Step 2 / 5` when the desktop writer is showing `Step 2 / 6`.

**Architecture:** Add a small server-side live snapshot reader for `~/.codex/live-state/<thread-id>.json`, merge it into `/codex-api/thread-live-state` as the authority for running external tasks, normalize the authority in the gateway, and make the current-conversation footer prefer the writer snapshot over message-derived state. If no fresh writer snapshot exists for an externally running task, Mobile keeps the task running but hides active footer numbers rather than showing stale history-derived values.

**Tech Stack:** TypeScript, Node.js HTTP bridge, Vue 3 computed state, existing Codex app-server RPC bridge, Vitest, `pnpm run build`, deployed `codex-mobile-safe` verification.

## Global Constraints

- The active writer process is the source of truth for running-task presentation state.
- `thread/read` remains valid for persisted history, completed turns, initial hydration, and older-message pagination.
- Mobile must not derive active external footer step totals or file totals from `filteredMessages`.
- Missing or expired writer snapshot while runtime is running must preserve running state and hide active footer values.
- Hidden browser pages must not poll.
- Externally owned tasks remain non-interruptible from Mobile.
- No authentication, Tailscale/LAN exposure, ntfy delivery, or public listener behavior changes.
- Every production behavior change starts with a focused failing test.

---

## File map

- Create `src/server/threadLiveSnapshot.ts`: validate, normalize, freshness-check, and read atomic writer snapshot files.
- Create `src/server/threadLiveSnapshot.test.ts`: parser, stale-revision, expiry, wrong-thread, wrong-turn, malformed, and filesystem tests.
- Modify `src/server/codexAppServerBridge.ts`: merge fresh snapshots into `/codex-api/thread-live-state`; return `liveAuthority`; avoid active external footer authority when missing.
- Modify `src/server/externalThreadRuntimeBridge.test.ts`: endpoint behavior for fresh snapshot, missing snapshot, stale derived plan, and `thread/read` failure with fresh snapshot.
- Modify `src/types/codex.ts`: shared frontend live snapshot and footer types.
- Modify `src/api/codexGateway.ts`: parse `liveAuthority` and `liveSnapshot`, expose them on `getExternalThreadLiveSnapshot()`.
- Modify `src/api/codexGateway.test.ts`: gateway normalization and stale-authority tests.
- Modify `src/components/content/conversationFooterState.ts`: accept an authoritative footer and an external-authority mode.
- Modify `src/components/content/conversationFooterState.test.ts`: prove writer footer wins and missing authority suppresses stale derived state.
- Modify `src/App.vue`: pass gateway authority into footer state selection.
- Modify `src/components/content/conversationRunFooter.wiring.test.ts`: prevent regressions in the selected footer wiring.

---

### Task 1: Writer Live Snapshot Parser and Reader

**Files:**
- Create: `src/server/threadLiveSnapshot.ts`
- Create: `src/server/threadLiveSnapshot.test.ts`

**Interfaces:**
- Produces:

```ts
export type ThreadLiveAuthority = 'writer-snapshot' | 'local-stream' | 'persisted' | 'missing'

export type ThreadLiveSnapshot = {
  schemaVersion: 1
  threadId: string
  activeTurnId: string | null
  revision: number
  generatedAt: string
  expiresAt: string
  source: 'desktop-writer' | 'mobile-writer'
  state: 'running' | 'idle' | 'completed' | 'failed' | 'interrupted'
  footer: ThreadLiveFooter | null
  timeline: unknown[]
  pendingRequest: unknown | null
  sidebar: { indicator: 'none' | 'running' | 'completed' | 'attention' }
}

export type ThreadLiveFooter = {
  stepCurrent: number | null
  stepTotal: number | null
  completedPercent: number | null
  fileCount: number | null
  additions: number | null
  deletions: number | null
  label: string
}

export function parseThreadLiveSnapshot(
  value: unknown,
  options: { threadId: string; activeTurnId: string; nowMs: number; minRevision?: number },
): ThreadLiveSnapshot | null

export async function readThreadLiveSnapshotFile(
  liveStateDir: string,
  threadId: string,
  options: { activeTurnId: string; nowMs: number; minRevision?: number },
): Promise<ThreadLiveSnapshot | null>
```

- Consumes: JSON files named exactly `<threadId>.json` under a configured live-state directory.

- [ ] **Step 1: Write failing parser tests**

Create `src/server/threadLiveSnapshot.test.ts`:

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { parseThreadLiveSnapshot, readThreadLiveSnapshotFile } from './threadLiveSnapshot'

const nowMs = Date.parse('2026-07-27T00:00:00.000Z')

function validSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    threadId: 'thread-1',
    activeTurnId: 'turn-1',
    revision: 12,
    generatedAt: '2026-07-26T23:59:59.000Z',
    expiresAt: '2026-07-27T00:00:30.000Z',
    source: 'desktop-writer',
    state: 'running',
    footer: {
      stepCurrent: 2,
      stepTotal: 6,
      completedPercent: 33.3333,
      fileCount: 29,
      additions: 5485,
      deletions: 417,
      label: 'Step 2 / 6 · 29 files changed +5485 -417',
    },
    timeline: [],
    pendingRequest: null,
    sidebar: { indicator: 'running' },
    ...overrides,
  }
}

describe('thread live snapshots', () => {
  it('accepts a fresh snapshot for the requested thread and active turn', () => {
    expect(parseThreadLiveSnapshot(validSnapshot(), {
      threadId: 'thread-1',
      activeTurnId: 'turn-1',
      nowMs,
    })).toMatchObject({
      threadId: 'thread-1',
      activeTurnId: 'turn-1',
      revision: 12,
      footer: {
        stepCurrent: 2,
        stepTotal: 6,
        fileCount: 29,
        additions: 5485,
        deletions: 417,
      },
    })
  })

  it('rejects expired, wrong-thread, wrong-turn, and stale-revision snapshots', () => {
    expect(parseThreadLiveSnapshot(validSnapshot({ expiresAt: '2026-07-26T23:59:59.000Z' }), {
      threadId: 'thread-1',
      activeTurnId: 'turn-1',
      nowMs,
    })).toBeNull()
    expect(parseThreadLiveSnapshot(validSnapshot({ threadId: 'thread-2' }), {
      threadId: 'thread-1',
      activeTurnId: 'turn-1',
      nowMs,
    })).toBeNull()
    expect(parseThreadLiveSnapshot(validSnapshot({ activeTurnId: 'turn-2' }), {
      threadId: 'thread-1',
      activeTurnId: 'turn-1',
      nowMs,
    })).toBeNull()
    expect(parseThreadLiveSnapshot(validSnapshot({ revision: 9 }), {
      threadId: 'thread-1',
      activeTurnId: 'turn-1',
      nowMs,
      minRevision: 10,
    })).toBeNull()
  })

  it('rejects malformed footer values instead of coercing them', () => {
    expect(parseThreadLiveSnapshot(validSnapshot({
      footer: {
        stepCurrent: '2',
        stepTotal: 6,
        completedPercent: 33,
        fileCount: 29,
        additions: 5485,
        deletions: 417,
        label: 'bad',
      },
    }), {
      threadId: 'thread-1',
      activeTurnId: 'turn-1',
      nowMs,
    })).toBeNull()
  })

  it('reads a snapshot file and returns null for missing or invalid files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-'))
    try {
      await writeFile(join(dir, 'thread-1.json'), JSON.stringify(validSnapshot()), 'utf8')
      await writeFile(join(dir, 'thread-bad.json'), '{not json', 'utf8')

      await expect(readThreadLiveSnapshotFile(dir, 'thread-1', {
        activeTurnId: 'turn-1',
        nowMs,
      })).resolves.toMatchObject({ revision: 12 })
      await expect(readThreadLiveSnapshotFile(dir, 'thread-missing', {
        activeTurnId: 'turn-1',
        nowMs,
      })).resolves.toBeNull()
      await expect(readThreadLiveSnapshotFile(dir, 'thread-bad', {
        activeTurnId: 'turn-1',
        nowMs,
      })).resolves.toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 2: Run Task 1 RED**

Run:

```bash
pnpm vitest run src/server/threadLiveSnapshot.test.ts
```

Expected: FAIL because `src/server/threadLiveSnapshot.ts` does not exist.

- [ ] **Step 3: Implement parser and file reader**

Create `src/server/threadLiveSnapshot.ts`:

```ts
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export type ThreadLiveAuthority = 'writer-snapshot' | 'local-stream' | 'persisted' | 'missing'
export type ThreadLiveSource = 'desktop-writer' | 'mobile-writer'
export type ThreadLiveState = 'running' | 'idle' | 'completed' | 'failed' | 'interrupted'
export type ThreadLiveIndicator = 'none' | 'running' | 'completed' | 'attention'

export type ThreadLiveFooter = {
  stepCurrent: number | null
  stepTotal: number | null
  completedPercent: number | null
  fileCount: number | null
  additions: number | null
  deletions: number | null
  label: string
}

export type ThreadLiveSnapshot = {
  schemaVersion: 1
  threadId: string
  activeTurnId: string | null
  revision: number
  generatedAt: string
  expiresAt: string
  source: ThreadLiveSource
  state: ThreadLiveState
  footer: ThreadLiveFooter | null
  timeline: unknown[]
  pendingRequest: unknown | null
  sidebar: { indicator: ThreadLiveIndicator }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function readNullableNumber(value: unknown): number | null | undefined {
  if (value === null) return null
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readFooter(value: unknown): ThreadLiveFooter | null | undefined {
  if (value === null) return null
  const record = asRecord(value)
  if (!record) return undefined
  const stepCurrent = readNullableNumber(record.stepCurrent)
  const stepTotal = readNullableNumber(record.stepTotal)
  const completedPercent = readNullableNumber(record.completedPercent)
  const fileCount = readNullableNumber(record.fileCount)
  const additions = readNullableNumber(record.additions)
  const deletions = readNullableNumber(record.deletions)
  const label = readString(record.label)
  if (
    stepCurrent === undefined ||
    stepTotal === undefined ||
    completedPercent === undefined ||
    fileCount === undefined ||
    additions === undefined ||
    deletions === undefined ||
    label === null
  ) {
    return undefined
  }
  return { stepCurrent, stepTotal, completedPercent, fileCount, additions, deletions, label }
}

export function parseThreadLiveSnapshot(
  value: unknown,
  options: { threadId: string; activeTurnId: string; nowMs: number; minRevision?: number },
): ThreadLiveSnapshot | null {
  const record = asRecord(value)
  if (!record || record.schemaVersion !== 1) return null
  const threadId = readString(record.threadId)
  if (threadId !== options.threadId) return null
  const activeTurnId = record.activeTurnId === null ? null : readString(record.activeTurnId)
  if (activeTurnId !== options.activeTurnId) return null
  const revision = typeof record.revision === 'number' && Number.isSafeInteger(record.revision)
    ? record.revision
    : null
  if (revision === null || revision < (options.minRevision ?? 0)) return null
  const generatedAt = readString(record.generatedAt)
  const expiresAt = readString(record.expiresAt)
  if (!generatedAt || !expiresAt) return null
  const expiresAtMs = Date.parse(expiresAt)
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= options.nowMs) return null
  const source = record.source === 'desktop-writer' || record.source === 'mobile-writer'
    ? record.source
    : null
  const state = ['running', 'idle', 'completed', 'failed', 'interrupted'].includes(String(record.state))
    ? record.state as ThreadLiveState
    : null
  if (!source || !state) return null
  const footer = readFooter(record.footer)
  if (footer === undefined) return null
  const timeline = Array.isArray(record.timeline) ? record.timeline : []
  const sidebarRecord = asRecord(record.sidebar)
  const indicator = sidebarRecord?.indicator === 'none' ||
    sidebarRecord?.indicator === 'running' ||
    sidebarRecord?.indicator === 'completed' ||
    sidebarRecord?.indicator === 'attention'
      ? sidebarRecord.indicator
      : null
  if (!indicator) return null
  return {
    schemaVersion: 1,
    threadId,
    activeTurnId,
    revision,
    generatedAt,
    expiresAt,
    source,
    state,
    footer,
    timeline,
    pendingRequest: record.pendingRequest ?? null,
    sidebar: { indicator },
  }
}

export async function readThreadLiveSnapshotFile(
  liveStateDir: string,
  threadId: string,
  options: { activeTurnId: string; nowMs: number; minRevision?: number },
): Promise<ThreadLiveSnapshot | null> {
  try {
    const raw = await readFile(join(liveStateDir, `${threadId}.json`), 'utf8')
    return parseThreadLiveSnapshot(JSON.parse(raw), {
      threadId,
      activeTurnId: options.activeTurnId,
      nowMs: options.nowMs,
      minRevision: options.minRevision,
    })
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run Task 1 GREEN**

Run:

```bash
pnpm vitest run src/server/threadLiveSnapshot.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/server/threadLiveSnapshot.ts src/server/threadLiveSnapshot.test.ts
git commit -m "feat: read writer live snapshots"
```

---

### Task 2: Merge Writer Snapshot into `/thread-live-state`

**Files:**
- Modify: `src/server/codexAppServerBridge.ts`
- Modify: `src/server/externalThreadRuntimeBridge.test.ts`

**Interfaces:**
- Consumes: `readThreadLiveSnapshotFile()` from Task 1.
- Produces: `/codex-api/thread-live-state` response fields:

```ts
liveAuthority: 'writer-snapshot' | 'local-stream' | 'persisted' | 'missing'
liveSnapshot: ThreadLiveSnapshot | null
```

- Preserves: existing `conversationState`, `externalRuntime`, `threadTurnStartIndex`, and `hasMoreOlder`.

- [ ] **Step 1: Write failing endpoint tests**

Add to the existing `GET /codex-api/thread-live-state external runtime parity` describe block in `src/server/externalThreadRuntimeBridge.test.ts`:

```ts
it('returns a fresh writer snapshot as authoritative for an externally running task', async () => {
  const liveStateDir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-'))
  try {
    await writeFile(join(liveStateDir, 'thread-external.json'), JSON.stringify({
      schemaVersion: 1,
      threadId: 'thread-external',
      activeTurnId: 'turn-external',
      revision: 3,
      generatedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 30000).toISOString(),
      source: 'desktop-writer',
      state: 'running',
      footer: {
        stepCurrent: 2,
        stepTotal: 6,
        completedPercent: 33.3333,
        fileCount: 29,
        additions: 5485,
        deletions: 417,
        label: 'Step 2 / 6 · 29 files changed +5485 -417',
      },
      timeline: [],
      pendingRequest: null,
      sidebar: { indicator: 'running' },
    }), 'utf8')
    const previousLiveStateDir = process.env.CODEX_MOBILE_LIVE_STATE_DIR
    process.env.CODEX_MOBILE_LIVE_STATE_DIR = liveStateDir
    disposers.push(() => {
      if (previousLiveStateDir === undefined) {
        delete process.env.CODEX_MOBILE_LIVE_STATE_DIR
      } else {
        process.env.CODEX_MOBILE_LIVE_STATE_DIR = previousLiveStateDir
      }
    })
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.appServer, 'rpc').mockResolvedValue({
      thread: {
        id: 'thread-external',
        path: join(liveStateDir, 'thread-external.jsonl'),
        turns: [{
          id: 'turn-external',
          status: 'interrupted',
          items: [{
            id: 'old-plan',
            type: 'plan',
            text: '- [x] old\\n- [~] stale\\n- [ ] stale\\n- [ ] stale\\n- [ ] stale',
          }],
        }],
      },
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running',
      turnId: 'turn-external',
      interruptible: false,
      source: 'external-session-writer',
    })
    const port = await listenWithMiddleware(middleware)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-external`)
      await expect(response.json()).resolves.toMatchObject({
        isInProgress: true,
        liveAuthority: 'writer-snapshot',
        liveSnapshot: {
          activeTurnId: 'turn-external',
          footer: {
            stepCurrent: 2,
            stepTotal: 6,
            fileCount: 29,
            additions: 5485,
            deletions: 417,
          },
        },
      })
  } finally {
    await rm(liveStateDir, { recursive: true, force: true })
  }
})

it('marks external running live state as missing instead of authorizing stale thread/read footer data', async () => {
  const middleware = createCodexBridgeMiddleware()
  const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
    appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
      rpc: (method: string, params: unknown) => Promise<unknown>
    }
  }
  vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
  vi.spyOn(shared.appServer, 'rpc').mockResolvedValue({
    thread: {
      id: 'thread-external',
      turns: [{
        id: 'turn-external',
        status: 'interrupted',
        items: [{
          id: 'stale-plan',
          type: 'plan',
          text: '- [x] old\\n- [~] stale\\n- [ ] stale\\n- [ ] stale\\n- [ ] stale',
        }],
      }],
    },
  })
  vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
    state: 'running',
    turnId: 'turn-external',
    interruptible: false,
    source: 'external-session-writer',
  })
  const port = await listenWithMiddleware(middleware)

  const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-external`)
  await expect(response.json()).resolves.toMatchObject({
    isInProgress: true,
    liveAuthority: 'missing',
    liveSnapshot: null,
  })
})
```

- [ ] **Step 2: Run Task 2 RED**

Run:

```bash
pnpm vitest run src/server/externalThreadRuntimeBridge.test.ts -t "writer snapshot|missing instead of authorizing stale"
```

Expected: FAIL because the endpoint does not return `liveAuthority` or `liveSnapshot`.

- [ ] **Step 3: Add live-state directory resolution**

In `src/server/codexAppServerBridge.ts`, import the reader:

```ts
import { readThreadLiveSnapshotFile } from './threadLiveSnapshot'
```

Add a small helper near other path helpers:

```ts
function getThreadLiveStateDir(): string {
  const configured = process.env.CODEX_MOBILE_LIVE_STATE_DIR?.trim()
  return configured || join(getCodexHomeDir(), 'live-state')
}
```

- [ ] **Step 4: Merge the snapshot in the live-state endpoint**

Inside the `/codex-api/thread-live-state` route, after `externalRuntime` and
`isInProgress` are known and before `responseData` is built:

```ts
const activeExternalTurnId = isExternalInProgress
  ? readNonEmptyString(asRecord(externalRuntime)?.turnId)
  : ''
const liveSnapshot = activeExternalTurnId
  ? await readThreadLiveSnapshotFile(getThreadLiveStateDir(), threadId, {
      activeTurnId: activeExternalTurnId,
      nowMs: Date.now(),
    })
  : null
const liveAuthority = liveSnapshot
  ? 'writer-snapshot'
  : isExternalInProgress
    ? 'missing'
    : isLocallyInProgress
      ? 'local-stream'
      : 'persisted'
```

Add `liveAuthority` and `liveSnapshot` to `responseData`:

```ts
const responseData = {
  threadId,
  threadTurnStartIndex,
  hasMoreOlder: threadTurnStartIndex > 0,
  conversationState: { turns },
  ownerClientId: null,
  liveStateError: null,
  isInProgress,
  externalRuntime,
  liveAuthority,
  liveSnapshot,
}
```

In catch/fallback responses, include:

```ts
liveAuthority: 'missing',
liveSnapshot: null,
```

unless a fresh writer snapshot has already been read in the successful path.

- [ ] **Step 5: Run Task 2 GREEN**

Run:

```bash
pnpm vitest run src/server/externalThreadRuntimeBridge.test.ts -t "writer snapshot|missing instead of authorizing stale"
pnpm vitest run src/server/threadLiveSnapshot.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 2**

```bash
git add src/server/codexAppServerBridge.ts src/server/externalThreadRuntimeBridge.test.ts
git commit -m "feat: expose authoritative live snapshots"
```

---

### Task 3: Normalize Live Authority in the Gateway

**Files:**
- Modify: `src/types/codex.ts`
- Modify: `src/api/codexGateway.ts`
- Modify: `src/api/codexGateway.test.ts`

**Interfaces:**
- Produces frontend types:

```ts
export type UiThreadLiveAuthority = 'writer-snapshot' | 'local-stream' | 'persisted' | 'missing'
export type UiThreadLiveFooter = {
  stepCurrent: number | null
  stepTotal: number | null
  completedPercent: number | null
  fileCount: number | null
  additions: number | null
  deletions: number | null
  label: string
}
export type UiThreadLiveSnapshot = {
  revision: number
  activeTurnId: string | null
  footer: UiThreadLiveFooter | null
}
```

- Adds to external snapshot detail result:

```ts
liveAuthority: UiThreadLiveAuthority
liveSnapshot: UiThreadLiveSnapshot | null
```

- [ ] **Step 1: Write failing gateway tests**

Add to `src/api/codexGateway.test.ts`:

```ts
it('normalizes authoritative writer footer snapshots from thread-live-state', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    threadId: 'external-thread',
    conversationState: { turns: [] },
    threadTurnStartIndex: 8,
    hasMoreOlder: true,
    isInProgress: true,
    externalRuntime: {
      state: 'running',
      turnId: 'turn-external',
      interruptible: false,
      source: 'external-session-writer',
    },
    liveAuthority: 'writer-snapshot',
    liveSnapshot: {
      schemaVersion: 1,
      threadId: 'external-thread',
      activeTurnId: 'turn-external',
      revision: 3,
      generatedAt: '2026-07-27T00:00:00.000Z',
      expiresAt: '2026-07-27T00:01:00.000Z',
      source: 'desktop-writer',
      state: 'running',
      footer: {
        stepCurrent: 2,
        stepTotal: 6,
        completedPercent: 33.3333,
        fileCount: 29,
        additions: 5485,
        deletions: 417,
        label: 'Step 2 / 6 · 29 files changed +5485 -417',
      },
      timeline: [],
      pendingRequest: null,
      sidebar: { indicator: 'running' },
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

  await expect(getExternalThreadLiveSnapshot('external-thread')).resolves.toMatchObject({
    liveAuthority: 'writer-snapshot',
    liveSnapshot: {
      revision: 3,
      activeTurnId: 'turn-external',
      footer: {
        stepCurrent: 2,
        stepTotal: 6,
        fileCount: 29,
        additions: 5485,
        deletions: 417,
      },
    },
  })
})

it('normalizes missing live authority without trusting malformed snapshot payloads', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    threadId: 'external-thread',
    conversationState: { turns: [] },
    isInProgress: true,
    externalRuntime: {
      state: 'running',
      turnId: 'turn-external',
      interruptible: false,
      source: 'external-session-writer',
    },
    liveAuthority: 'writer-snapshot',
    liveSnapshot: { revision: 'bad', footer: { stepTotal: '6' } },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

  await expect(getExternalThreadLiveSnapshot('external-thread')).resolves.toMatchObject({
    liveAuthority: 'missing',
    liveSnapshot: null,
    inProgress: true,
    ownership: 'external',
  })
})
```

- [ ] **Step 2: Run Task 3 RED**

Run:

```bash
pnpm vitest run src/api/codexGateway.test.ts -t "authoritative writer footer|missing live authority"
```

Expected: FAIL because the gateway result lacks `liveAuthority` and `liveSnapshot`.

- [ ] **Step 3: Add frontend live snapshot types**

In `src/types/codex.ts`, add near `ConversationFooterState`:

```ts
export type UiThreadLiveAuthority = 'writer-snapshot' | 'local-stream' | 'persisted' | 'missing'

export type UiThreadLiveFooter = {
  stepCurrent: number | null
  stepTotal: number | null
  completedPercent: number | null
  fileCount: number | null
  additions: number | null
  deletions: number | null
  label: string
}

export type UiThreadLiveSnapshot = {
  revision: number
  activeTurnId: string | null
  footer: UiThreadLiveFooter | null
}
```

- [ ] **Step 4: Parse live authority in the gateway**

In `src/api/codexGateway.ts`, import the new types and add helpers near other
normalization helpers:

```ts
function readLiveAuthority(value: unknown): UiThreadLiveAuthority {
  return value === 'writer-snapshot' ||
    value === 'local-stream' ||
    value === 'persisted' ||
    value === 'missing'
      ? value
      : 'missing'
}

function readNullableLiveNumber(value: unknown): number | null | undefined {
  if (value === null) return null
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readLiveFooter(value: unknown): UiThreadLiveFooter | null | undefined {
  if (value === null) return null
  const record = asRecord(value)
  if (!record) return undefined
  const stepCurrent = readNullableLiveNumber(record.stepCurrent)
  const stepTotal = readNullableLiveNumber(record.stepTotal)
  const completedPercent = readNullableLiveNumber(record.completedPercent)
  const fileCount = readNullableLiveNumber(record.fileCount)
  const additions = readNullableLiveNumber(record.additions)
  const deletions = readNullableLiveNumber(record.deletions)
  const label = readString(record.label)
  if (
    stepCurrent === undefined ||
    stepTotal === undefined ||
    completedPercent === undefined ||
    fileCount === undefined ||
    additions === undefined ||
    deletions === undefined ||
    !label
  ) {
    return undefined
  }
  return { stepCurrent, stepTotal, completedPercent, fileCount, additions, deletions, label }
}

function readLiveSnapshot(value: unknown): UiThreadLiveSnapshot | null {
  const record = asRecord(value)
  if (!record) return null
  const revision = typeof record.revision === 'number' && Number.isSafeInteger(record.revision)
    ? record.revision
    : null
  const activeTurnId = record.activeTurnId === null ? null : readString(record.activeTurnId)
  const footer = readLiveFooter(record.footer)
  if (revision === null || footer === undefined) return null
  return { revision, activeTurnId, footer }
}
```

In `getExternalThreadLiveStateSnapshotV2()`, compute:

```ts
const rawAuthority = readLiveAuthority(payload?.liveAuthority)
const rawSnapshot = readLiveSnapshot(payload?.liveSnapshot)
const liveAuthority = rawAuthority === 'writer-snapshot' && rawSnapshot
  ? 'writer-snapshot'
  : rawAuthority === 'local-stream' || rawAuthority === 'persisted'
    ? rawAuthority
    : 'missing'
```

Return `liveAuthority` and `liveSnapshot: liveAuthority === 'writer-snapshot' ? rawSnapshot : null`.

- [ ] **Step 5: Run Task 3 GREEN**

Run:

```bash
pnpm vitest run src/api/codexGateway.test.ts -t "authoritative writer footer|missing live authority"
```

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/types/codex.ts src/api/codexGateway.ts src/api/codexGateway.test.ts
git commit -m "feat: normalize live snapshot authority"
```

---

### Task 4: Prefer Writer Footer and Suppress Stale External Footer

**Files:**
- Modify: `src/components/content/conversationFooterState.ts`
- Modify: `src/components/content/conversationFooterState.test.ts`
- Modify: `src/App.vue`
- Modify: `src/components/content/conversationRunFooter.wiring.test.ts`

**Interfaces:**
- Extends `ConversationFooterInput`:

```ts
authoritativeFooter?: UiThreadLiveFooter | null
externalLiveAuthority?: UiThreadLiveAuthority | null
```

- Produces: `deriveConversationFooterState()` returns the writer footer when
  `authoritativeFooter` exists, returns `null` when
  `externalLiveAuthority === 'missing'`, otherwise keeps existing local/persisted
  behavior.

- [ ] **Step 1: Write failing footer-state unit tests**

Add to `src/components/content/conversationFooterState.test.ts`:

```ts
it('uses an authoritative writer footer instead of stale message-derived plan data', () => {
  const result = deriveConversationFooterState({
    messages: [{
      id: 'stale-plan',
      role: 'assistant',
      text: '',
      messageType: 'plan',
      turnId: 'turn-1',
      plan: {
        steps: [
          { step: 'old 1', status: 'completed' },
          { step: 'old 2', status: 'inProgress' },
          { step: 'old 3', status: 'pending' },
          { step: 'old 4', status: 'pending' },
          { step: 'old 5', status: 'pending' },
        ],
      },
    }],
    turnId: 'turn-1',
    isTurnInProgress: true,
    externalLiveAuthority: 'writer-snapshot',
    authoritativeFooter: {
      stepCurrent: 2,
      stepTotal: 6,
      completedPercent: 33.3333,
      fileCount: 29,
      additions: 5485,
      deletions: 417,
      label: 'Step 2 / 6 · 29 files changed +5485 -417',
    },
  })

  expect(result).toEqual({
    turnId: 'turn-1',
    stepNumber: 2,
    stepCount: 6,
    completedPercent: 33.3333,
    fileCount: 29,
    additions: 5485,
    deletions: 417,
  })
})

it('suppresses stale message-derived footer when external live authority is missing', () => {
  expect(deriveConversationFooterState({
    messages: [{
      id: 'stale-plan',
      role: 'assistant',
      text: '',
      messageType: 'plan',
      turnId: 'turn-1',
      plan: {
        steps: [
          { step: 'old 1', status: 'completed' },
          { step: 'old 2', status: 'inProgress' },
          { step: 'old 3', status: 'pending' },
          { step: 'old 4', status: 'pending' },
          { step: 'old 5', status: 'pending' },
        ],
      },
    }],
    turnId: 'turn-1',
    isTurnInProgress: true,
    externalLiveAuthority: 'missing',
    authoritativeFooter: null,
  })).toBeNull()
})
```

- [ ] **Step 2: Run Task 4 RED**

Run:

```bash
pnpm vitest run src/components/content/conversationFooterState.test.ts -t "authoritative writer footer|suppresses stale"
```

Expected: FAIL because `deriveConversationFooterState()` ignores the new inputs.

- [ ] **Step 3: Implement authoritative footer handling**

In `src/components/content/conversationFooterState.ts`, import the new types:

```ts
import type { UiThreadLiveAuthority, UiThreadLiveFooter } from '../../types/codex'
```

Extend `ConversationFooterInput`:

```ts
authoritativeFooter?: UiThreadLiveFooter | null
externalLiveAuthority?: UiThreadLiveAuthority | null
```

At the start of `deriveConversationFooterState()`, after validating
`isTurnInProgress` and `turnId`:

```ts
if (input.authoritativeFooter) {
  const footer = input.authoritativeFooter
  return {
    turnId,
    stepNumber: footer.stepCurrent,
    stepCount: footer.stepTotal ?? 0,
    completedPercent: footer.completedPercent ?? 0,
    fileCount: footer.fileCount ?? 0,
    additions: footer.additions ?? 0,
    deletions: footer.deletions ?? 0,
  }
}

if (input.externalLiveAuthority === 'missing') return null
```

Keep the existing message-derived logic below this branch for local and
persisted states.

- [ ] **Step 4: Wire App.vue to pass live authority**

Find the selected-thread detail state that stores results from
`getExternalThreadLiveSnapshot()`. Add reactive storage for:

```ts
const liveAuthorityByThreadId = ref<Record<string, UiThreadLiveAuthority>>({})
const liveSnapshotByThreadId = ref<Record<string, UiThreadLiveSnapshot | null>>({})
```

When reconciling a live snapshot detail, store:

```ts
liveAuthorityByThreadId.value = {
  ...liveAuthorityByThreadId.value,
  [threadId]: detail.liveAuthority ?? 'persisted',
}
liveSnapshotByThreadId.value = {
  ...liveSnapshotByThreadId.value,
  [threadId]: detail.liveSnapshot ?? null,
}
```

When pruning or clearing selected thread state, omit these keys using the
existing `omitKey()` helper.

Change `selectedConversationFooterState` in `src/App.vue`:

```ts
const selectedLiveAuthority = computed(() =>
  selectedThreadId.value ? liveAuthorityByThreadId.value[selectedThreadId.value] ?? null : null,
)
const selectedLiveSnapshot = computed(() =>
  selectedThreadId.value ? liveSnapshotByThreadId.value[selectedThreadId.value] ?? null : null,
)
const selectedConversationFooterState = computed(() => deriveConversationFooterState({
  messages: filteredMessages.value,
  turnId: selectedActiveTurnId.value,
  isTurnInProgress: isSelectedThreadInProgress.value,
  worktreeChangeSummary: isThreadActiveTurnChangeSummaryLoaded.value
    ? threadActiveTurnChangeSummary.value
    : null,
  externalLiveAuthority: selectedThreadRuntimeOwnership.value === 'external'
    ? selectedLiveAuthority.value
    : null,
  authoritativeFooter: selectedThreadRuntimeOwnership.value === 'external'
    ? selectedLiveSnapshot.value?.footer ?? null
    : null,
}))
```

Use existing state names if the live snapshot reconciliation lives in
`useDesktopState`; the public behavior must match this data flow.

- [ ] **Step 5: Add wiring regression**

In `src/components/content/conversationRunFooter.wiring.test.ts`, assert:

```ts
expect(appSource).toContain('externalLiveAuthority:')
expect(appSource).toContain('authoritativeFooter:')
expect(appSource).toContain('selectedThreadRuntimeOwnership')
```

- [ ] **Step 6: Run Task 4 GREEN**

Run:

```bash
pnpm vitest run src/components/content/conversationFooterState.test.ts -t "authoritative writer footer|suppresses stale"
pnpm vitest run src/components/content/conversationRunFooter.wiring.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 4**

```bash
git add src/components/content/conversationFooterState.ts src/components/content/conversationFooterState.test.ts src/App.vue src/components/content/conversationRunFooter.wiring.test.ts
git commit -m "fix: use authoritative active footer state"
```

---

### Task 5: Full Verification and Deployment

**Files:**
- No planned file changes. If any verification step fails, return to the task
  that owns the failing file, add a focused failing test there, and complete
  that task's RED/GREEN/commit cycle before repeating Task 5.

**Interfaces:**
- Consumes: all previous tasks.
- Produces: deployed `codex-mobile-safe` with safe stale-footer behavior and snapshot authority support.

- [ ] **Step 1: Run focused tests**

Run:

```bash
pnpm vitest run src/server/threadLiveSnapshot.test.ts
pnpm vitest run src/server/externalThreadRuntimeBridge.test.ts -t "writer snapshot|missing instead of authorizing stale"
pnpm vitest run src/api/codexGateway.test.ts -t "authoritative writer footer|missing live authority"
pnpm vitest run src/components/content/conversationFooterState.test.ts -t "authoritative writer footer|suppresses stale"
pnpm vitest run src/components/content/conversationRunFooter.wiring.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 2: Run broad regression**

Run:

```bash
pnpm run test:unit
pnpm run build
git diff --check
```

Expected: unit tests pass, build exits 0, whitespace check exits 0.

- [ ] **Step 3: Manually seed a writer snapshot for current production verification**

Create the live-state directory and write a test snapshot for the active cross-LAN thread:

```bash
mkdir -p ~/.codex/live-state
node - <<'NODE'
const fs = require('fs')
const path = require('path')
const threadId = '019f6447-fe48-7060-9a5a-9ce860569859'
const activeTurnId = '019f9e07-68bb-79b0-a00e-2eeb3455819a'
const now = Date.now()
const snapshot = {
  schemaVersion: 1,
  threadId,
  activeTurnId,
  revision: now,
  generatedAt: new Date(now).toISOString(),
  expiresAt: new Date(now + 5 * 60 * 1000).toISOString(),
  source: 'desktop-writer',
  state: 'running',
  footer: {
    stepCurrent: 2,
    stepTotal: 6,
    completedPercent: 33.3333,
    fileCount: 29,
    additions: 5485,
    deletions: 417,
    label: 'Step 2 / 6 · 29 files changed +5485 -417',
  },
  timeline: [],
  pendingRequest: null,
  sidebar: { indicator: 'running' },
}
const finalPath = path.join(process.env.HOME, '.codex/live-state', `${threadId}.json`)
const tmpPath = `${finalPath}.tmp-${process.pid}`
fs.writeFileSync(tmpPath, JSON.stringify(snapshot), 'utf8')
fs.renameSync(tmpPath, finalPath)
NODE
```

This proves Mobile can consume the authoritative contract before the desktop
writer integration exists. Remove or let this snapshot expire after validation.

- [ ] **Step 4: Restart service**

Run:

```bash
systemctl --user restart codex-mobile-safe.service
systemctl --user status codex-mobile-safe.service --no-pager
curl -fsS http://127.0.0.1:5900/ >/dev/null
```

Expected: service active, local HTTP root returns success.

- [ ] **Step 5: Verify backend response**

Run:

```bash
curl -fsS 'http://127.0.0.1:5900/codex-api/thread-live-state?threadId=019f6447-fe48-7060-9a5a-9ce860569859' | node -e '
let s = ""; process.stdin.on("data", c => s += c); process.stdin.on("end", () => {
  const p = JSON.parse(s)
  console.log(JSON.stringify({
    isInProgress: p.isInProgress,
    liveAuthority: p.liveAuthority,
    footer: p.liveSnapshot && p.liveSnapshot.footer,
  }, null, 2))
})'
```

Expected while the seeded snapshot is fresh:

```json
{
  "isInProgress": true,
  "liveAuthority": "writer-snapshot",
  "footer": {
    "stepCurrent": 2,
    "stepTotal": 6,
    "completedPercent": 33.3333,
    "fileCount": 29,
    "additions": 5485,
    "deletions": 417,
    "label": "Step 2 / 6 · 29 files changed +5485 -417"
  }
}
```

Expected after deleting or expiring the snapshot while runtime is still running:

```json
{
  "isInProgress": true,
  "liveAuthority": "missing",
  "footer": null
}
```

- [ ] **Step 6: Verify mobile UI**

Open the current mobile URL and select "跨 LAN 分布式架构":

- with the seeded fresh snapshot, the footer shows `Step 2 / 6`;
- after deleting `~/.codex/live-state/019f6447-fe48-7060-9a5a-9ce860569859.json`, the task remains running but the footer does not show `Step 2 / 5`;
- refreshing the page does not reintroduce stale footer values.

- [ ] **Step 7: Confirm no Task 5-only changes remain**

Run:

```bash
git status --short
```

Expected: no uncommitted files from Task 5. If this shows changes caused by a
failed verification fix, move the work to the exact owning task:

- `src/server/threadLiveSnapshot.ts` or `src/server/threadLiveSnapshot.test.ts`
  belongs to Task 1;
- `src/server/codexAppServerBridge.ts` or
  `src/server/externalThreadRuntimeBridge.test.ts` belongs to Task 2;
- `src/types/codex.ts`, `src/api/codexGateway.ts`, or
  `src/api/codexGateway.test.ts` belongs to Task 3;
- `src/components/content/conversationFooterState.ts`,
  `src/components/content/conversationFooterState.test.ts`, `src/App.vue`, or
  `src/components/content/conversationRunFooter.wiring.test.ts` belongs to
  Task 4.

Add the missing focused test in that task, rerun that task's checks, and commit
under that task's listed commit message.
