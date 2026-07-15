# Top-Level ntfy Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop ntfy notifications for subagents and ambiguous threads while preserving one notification for each verified top-level Codex turn that runs at least 10 minutes.

**Architecture:** Add one shared, fail-closed thread-scope classifier. The external rollout monitor uses it to suppress child/unknown lifecycle events at the source, and the notifier reuses the existing `thread/read` result to verify top-level scope immediately before creating a pending notification and extracting the parent turn summary.

**Tech Stack:** TypeScript, Node.js filesystem/process inspection, Codex app-server v2 thread shape, Vitest, systemd user service, Tailscale Serve.

## Global Constraints

- A notification requires verified top-level scope, an authoritative terminal event, a duration of at least `600_000` milliseconds, and a not-yet-sent `(threadId, turnId)` pair.
- Recognized top-level sources are exactly `cli`, `vscode`, `exec`, and `appServer` with no non-empty parent thread ID.
- A non-empty `parent_thread_id`/`parentThreadId` or `source.subagent`/`source.subAgent` classifies the thread as `child` and suppresses notification.
- Custom, unknown, malformed, missing, or unreadable scope evidence classifies as `unknown` and suppresses notification.
- Child or unknown completion removes only its matching active record; it never creates pending/sent records or calls ntfy.
- The verified top-level `thread/read` result is reused for final-assistant summary extraction; never read a child turn to construct a parent message.
- Preserve the durable ntfy state file shape and its 256-record bounds; do not delete historical `sent` records.
- Do not log thread IDs, turn IDs, rollout paths, prompts, responses, ntfy URLs, passwords, topics, or notification bodies.
- Do not add routes, listeners, authentication changes, LAN binding, Funnel, public tunnels, or inbound network dependencies.
- Keep the backend on `127.0.0.1:5900` behind Tailnet-only Tailscale Serve.

## File Structure

- Create `src/server/ntfyThreadScope.ts`: shared fail-closed classification of rollout metadata and app-server thread objects.
- Create `src/server/ntfyThreadScope.test.ts`: focused table tests for supported top-level, child, and unknown shapes.
- Modify `src/server/rolloutLifecycle.ts`: attach `notificationScope` to parsed `session_meta` records.
- Modify `src/server/rolloutLifecycle.test.ts`: verify classification is retained without reading conversation fields.
- Modify `src/server/externalTurnMonitor.ts`: persist cursor scope and suppress non-top-level lifecycle emission.
- Modify `src/server/externalTurnMonitor.test.ts`: keep existing fixtures top-level and prove child/unknown rollouts emit nothing.
- Modify `src/server/ntfyCompletionNotifier.ts`: verify scope from `thread/read` before pending creation and reuse the result for summary extraction.
- Modify `src/server/ntfyCompletionNotifier.test.ts`: prove direct, persisted, ambiguous, and read-failure child cases are silent while top-level delivery remains intact.
- Modify `docs/AGENT_GUIDE.md`: document top-level-only notification eligibility and fail-closed diagnosis.

---

### Task 1: Shared Scope Classifier and Rollout Metadata

**Files:**
- Create: `src/server/ntfyThreadScope.ts`
- Create: `src/server/ntfyThreadScope.test.ts`
- Modify: `src/server/rolloutLifecycle.ts`
- Modify: `src/server/rolloutLifecycle.test.ts`

**Interfaces:**
- Produces: `NtfyThreadScope = 'topLevel' | 'child' | 'unknown'`.
- Produces: `classifyNtfyThreadScope(value: unknown): NtfyThreadScope` for both raw `session_meta.payload` and app-server thread objects.
- Changes: parsed session records to `{ kind: 'session'; threadId: string; notificationScope: NtfyThreadScope }`.

- [ ] **Step 1: Write failing classifier and parser tests**

Create `src/server/ntfyThreadScope.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { classifyNtfyThreadScope } from './ntfyThreadScope'

describe('classifyNtfyThreadScope', () => {
  it.each(['cli', 'vscode', 'exec', 'appServer'] as const)(
    'accepts parentless %s threads',
    (source) => {
      expect(classifyNtfyThreadScope({ parentThreadId: null, source })).toBe('topLevel')
    },
  )

  it.each([
    { parent_thread_id: 'parent-1', source: 'vscode' },
    { parentThreadId: 'parent-1', source: 'appServer' },
    { source: { subagent: { thread_spawn: {} } } },
    { source: { subAgent: 'review' } },
  ])('rejects child evidence %#', (value) => {
    expect(classifyNtfyThreadScope(value)).toBe('child')
  })

  it.each([
    null,
    {},
    { source: 'unknown' },
    { source: { custom: 'desktop-future' } },
    { source: 'vscode', parentThreadId: 42 },
    { source: ['vscode'] },
  ])('fails closed for inconclusive evidence %#', (value) => {
    expect(classifyNtfyThreadScope(value)).toBe('unknown')
  })
})
```

In `src/server/rolloutLifecycle.test.ts`, replace the session expectation with:

```ts
expect(parseRolloutRecord(JSON.stringify({
  timestamp: '2026-07-14T22:47:19.971Z',
  type: 'session_meta',
  payload: { id: 'thread-1', source: 'vscode' },
}))).toEqual({
  kind: 'session',
  threadId: 'thread-1',
  notificationScope: 'topLevel',
})
```

Add parser cases for child and ambiguous sessions:

```ts
it.each([
  [{ id: 'child-1', parent_thread_id: 'parent-1', source: 'vscode' }, 'child'],
  [{ id: 'child-2', source: { subagent: 'review' } }, 'child'],
  [{ id: 'unknown-1', source: 'unknown' }, 'unknown'],
] as const)('retains notification scope from session metadata %#', (payload, notificationScope) => {
  expect(parseRolloutRecord(JSON.stringify({ type: 'session_meta', payload }))).toEqual({
    kind: 'session',
    threadId: payload.id,
    notificationScope,
  })
})
```

- [ ] **Step 2: Run the focused tests and observe RED**

Run:

```bash
pnpm exec vitest run src/server/ntfyThreadScope.test.ts src/server/rolloutLifecycle.test.ts
```

Expected: the new module import fails and the old session parser result lacks `notificationScope`.

- [ ] **Step 3: Implement the shared fail-closed classifier**

Create `src/server/ntfyThreadScope.ts`:

```ts
export type NtfyThreadScope = 'topLevel' | 'child' | 'unknown'

const TOP_LEVEL_SOURCES = new Set(['cli', 'vscode', 'exec', 'appServer'])

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function parentEvidence(value: Record<string, unknown>): 'none' | 'child' | 'invalid' {
  for (const key of ['parentThreadId', 'parent_thread_id'] as const) {
    if (!hasOwn(value, key)) continue
    const candidate = value[key]
    if (candidate === null || candidate === undefined || candidate === '') continue
    if (typeof candidate === 'string') return 'child'
    return 'invalid'
  }
  return 'none'
}

export function classifyNtfyThreadScope(value: unknown): NtfyThreadScope {
  const record = asRecord(value)
  if (!record) return 'unknown'

  const source = record.source
  const sourceRecord = asRecord(source)
  if (sourceRecord && (hasOwn(sourceRecord, 'subagent') || hasOwn(sourceRecord, 'subAgent'))) {
    return 'child'
  }

  const parent = parentEvidence(record)
  if (parent === 'child') return 'child'
  if (parent === 'invalid') return 'unknown'

  return typeof source === 'string' && TOP_LEVEL_SOURCES.has(source)
    ? 'topLevel'
    : 'unknown'
}
```

- [ ] **Step 4: Attach scope to parsed session records**

In `src/server/rolloutLifecycle.ts`, import the classifier and type:

```ts
import {
  classifyNtfyThreadScope,
  type NtfyThreadScope,
} from './ntfyThreadScope'
```

Replace only the first session union member with:

```ts
| { kind: 'session'; threadId: string; notificationScope: NtfyThreadScope }
```

Replace the `session_meta` parser branch with:

```ts
if (root.type === 'session_meta') {
  const threadId = readString(payload.id)
  return threadId
    ? {
        kind: 'session',
        threadId,
        notificationScope: classifyNtfyThreadScope(payload),
      }
    : null
}
```

- [ ] **Step 5: Run focused tests and commit**

Run:

```bash
pnpm exec vitest run src/server/ntfyThreadScope.test.ts src/server/rolloutLifecycle.test.ts
```

Expected: both files pass with no warnings.

Commit:

```bash
git add src/server/ntfyThreadScope.ts src/server/ntfyThreadScope.test.ts src/server/rolloutLifecycle.ts src/server/rolloutLifecycle.test.ts
git commit -m "feat: classify ntfy thread scope"
```

---

### Task 2: Suppress Child Rollouts at the External Monitor

**Files:**
- Modify: `src/server/externalTurnMonitor.ts`
- Modify: `src/server/externalTurnMonitor.test.ts`

**Interfaces:**
- Consumes: parsed session `{ threadId, notificationScope }` from Task 1.
- Produces: no `ObservedTurnLifecycle` events for `child` or `unknown` cursors.
- Preserves: existing lifecycle, cursor, checkpoint, writer, expiry, and deduplication behavior for `topLevel` cursors.

- [ ] **Step 1: Make existing monitor fixtures explicitly top-level**

Replace the test helper with:

```ts
function sessionMeta(
  threadId: string,
  metadata: Record<string, unknown> = { source: 'vscode' },
): string {
  return `${JSON.stringify({
    type: 'session_meta',
    payload: { id: threadId, ...metadata },
  })}\n`
}
```

Add the regression:

```ts
it.each([
  ['child-parent', { source: 'vscode', parent_thread_id: 'parent-1' }],
  ['child-source', { source: { subagent: 'review' } }],
  ['unknown-source', { source: 'unknown' }],
] as const)('does not emit lifecycle events for %s rollouts', async (_label, metadata) => {
  const fixture = monitorFixture({ now: 1_000 })
  const rollout = fixture.system.add(
    '/sessions/rollout-1.jsonl',
    sessionMeta('thread-1', metadata) + started('turn-1', 1_000),
    '1',
  )

  await fixture.monitor.start()
  fixture.system.append(rollout, completed('turn-1', 601_000, 600_000))
  await fixture.runScheduledScan()

  expect(fixture.events).toEqual([])
})
```

- [ ] **Step 2: Run the monitor test and observe RED**

Run:

```bash
pnpm exec vitest run src/server/externalTurnMonitor.test.ts
```

Expected: child and unknown rows currently emit start and completion events.

- [ ] **Step 3: Persist scope on each cursor**

In `src/server/externalTurnMonitor.ts`, import `NtfyThreadScope`, add it to `RolloutCursor`, and return session metadata instead of only the ID:

```ts
import type { NtfyThreadScope } from './ntfyThreadScope'

type RolloutSession = { threadId: string; notificationScope: NtfyThreadScope }
```

Insert this field immediately after `threadId` in `RolloutCursor`:

```ts
notificationScope: NtfyThreadScope
```

Replace `readSessionThreadId()` with:

```ts
async function readSessionMetadata(identity: RuntimeFileIdentity): Promise<RolloutSession | null> {
  let offset = 0
  let trailing = Buffer.alloc(0)
  const limit = Math.min(identity.size, MAX_TRAILING_BYTES)
  while (offset < limit) {
    const length = Math.min(READ_CHUNK_BYTES, limit - offset)
    const chunk = await system.readRange(identity.path, offset, length, identity)
    if (chunk.length === 0) return null
    offset += chunk.length
    const bytes = trailing.length > 0 ? Buffer.concat([trailing, chunk]) : chunk
    let lineStart = 0
    let newline = bytes.indexOf(0x0a)
    while (newline !== -1) {
      const record = parseRolloutRecord(bytes.subarray(lineStart, newline).toString('utf8'))
      if (record?.kind === 'session') {
        return {
          threadId: record.threadId,
          notificationScope: record.notificationScope,
        }
      }
      lineStart = newline + 1
      newline = bytes.indexOf(0x0a, lineStart)
    }
    trailing = Buffer.from(bytes.subarray(lineStart))
    if (trailing.length > MAX_TRAILING_BYTES) return null
  }
  if (offset === identity.size && trailing.length > 0) {
    const record = parseRolloutRecord(trailing.toString('utf8'))
    if (record?.kind === 'session') {
      return {
        threadId: record.threadId,
        notificationScope: record.notificationScope,
      }
    }
  }
  return null
}
```

Replace the old `threadId` read/guard in `register()` with:

```ts
const session = await readSessionMetadata(stableIdentity)
if (!session) return
```

Replace the cursor's old `threadId` property with these two properties:

```ts
  threadId: session.threadId,
  notificationScope: session.notificationScope,
```

- [ ] **Step 4: Gate lifecycle application before notifier emission**

Immediately after the `record.kind === 'session'` branch in `applyRecord()` add:

```ts
if (cursor.notificationScope !== 'topLevel') return
```

Do not gate session parsing, identity revalidation, checkpoint maintenance, or
cursor expiry. Only lifecycle state/emission is suppressed.

- [ ] **Step 5: Run monitor and adjacent notifier suites, then commit**

Run:

```bash
pnpm exec vitest run \
  src/server/ntfyThreadScope.test.ts \
  src/server/rolloutLifecycle.test.ts \
  src/server/externalTurnMonitor.test.ts \
  src/server/ntfyCompletionNotifier.test.ts
```

Expected: all tests pass; existing top-level lifecycle and notifier tests remain green.

Commit:

```bash
git add src/server/externalTurnMonitor.ts src/server/externalTurnMonitor.test.ts
git commit -m "fix: ignore child rollout completions"
```

---

### Task 3: Verify Top-Level Scope Before ntfy Delivery

**Files:**
- Modify: `src/server/ntfyCompletionNotifier.ts`
- Modify: `src/server/ntfyCompletionNotifier.test.ts`

**Interfaces:**
- Consumes: `classifyNtfyThreadScope(threadReadResult.thread ?? threadReadResult)` from Task 1.
- Produces: pending records only for verified `topLevel` results.
- Preserves: threshold, status title/fallback, durable ordering, immediate retry, sequence-ID, and `(threadId, turnId)` deduplication behavior.

- [ ] **Step 1: Make the notifier harness return verified top-level metadata**

Add this helper in `src/server/ntfyCompletionNotifier.test.ts`:

```ts
function topLevelThread(turns: unknown[] = []): unknown {
  return {
    thread: {
      parentThreadId: null,
      source: 'appServer',
      turns,
    },
  }
}
```

Change the harness default:

```ts
const readThread = vi.fn(options.readThread ?? (async () => topLevelThread([
  { id: 'turn-1', items: [{ type: 'agentMessage', text: '工作完成。更多内容' }] },
])))
```

Update every existing test-specific `readThread` result that expects delivery
to include `parentThreadId: null` and `source: 'appServer'`, preferably by using
`topLevelThread(...)`. Tests for malformed assistant items may continue calling
`readLatestAssistantText()` directly because they do not exercise delivery.

- [ ] **Step 2: Add failing direct child, ambiguous, and read-error tests**

Add:

```ts
it.each([
  ['parent field', {
    thread: { parentThreadId: 'parent-1', source: 'appServer', turns: [] },
  }],
  ['subagent source', {
    thread: { parentThreadId: null, source: { subAgent: 'review' }, turns: [] },
  }],
] as const)('silently removes a completed child active record identified by %s', async (
  _label,
  child,
) => {
  const fixture = await runTurn(NTFY_MIN_DURATION_MS, {
    readThread: async () => child,
  })

  expect(fixture.readThread).toHaveBeenCalledTimes(1)
  expect(fixture.send).not.toHaveBeenCalled()
  expect(fixture.store.state).toEqual(createEmptyNtfyState())
})

it.each([
  ['unknown source', async () => ({ thread: { parentThreadId: null, source: 'unknown', turns: [] } })],
  ['malformed parent', async () => ({ thread: { parentThreadId: 42, source: 'appServer', turns: [] } })],
  ['read failure', async () => { throw new Error('thread unavailable') }],
] as const)('fails closed for %s at send time', async (_label, readThread) => {
  const fixture = await runTurn(NTFY_MIN_DURATION_MS, { readThread })

  expect(fixture.send).not.toHaveBeenCalled()
  expect(fixture.store.state).toEqual(createEmptyNtfyState())
})
```

Add a persisted-state case:

```ts
it('silently clears a child active record persisted by an older process', async () => {
  const store = new MemoryStateStore({
    active: [{
      key: 'thread-1:turn-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      startedAt: 0,
    }],
    pending: [],
    sent: [],
  })
  const fixture = harness({
    store,
    now: () => NTFY_MIN_DURATION_MS,
    readThread: async () => ({
      thread: { parentThreadId: 'parent-1', source: { subAgent: 'review' }, turns: [] },
    }),
  })
  await fixture.notifier.start()
  fixture.notifier.handle(completed())
  await fixture.notifier.dispose()

  expect(fixture.send).not.toHaveBeenCalled()
  expect(store.state).toEqual(createEmptyNtfyState())
})
```

- [ ] **Step 3: Run the notifier test and observe RED**

Run:

```bash
pnpm exec vitest run src/server/ntfyCompletionNotifier.test.ts
```

Expected: child, ambiguous, and failed reads currently create/send fallback notifications.

- [ ] **Step 4: Verify scope and reuse the thread result before pending creation**

In `src/server/ntfyCompletionNotifier.ts`, import the classifier:

```ts
import { classifyNtfyThreadScope } from './ntfyThreadScope'
```

Add a helper beside `readLatestAssistantText()`:

```ts
function readThreadObject(threadReadResult: unknown): Record<string, unknown> | null {
  const response = asRecord(threadReadResult)
  return asRecord(response?.thread) ?? response
}
```

In `processNotification()`, replace the current assistant-read block with:

```ts
let threadReadResult: unknown
try {
  threadReadResult = await this.options.readThread(event.threadId)
} catch {
  await this.persistState(stateWithoutActive)
  this.warn('Unable to verify top-level long-task notification')
  return
}

const thread = readThreadObject(threadReadResult)
if (classifyNtfyThreadScope(thread) !== 'topLevel') {
  await this.persistState(stateWithoutActive)
  return
}

const classification = classifyStatus(event.status)
const assistantText = readLatestAssistantText(threadReadResult, event.turnId)
const message = summarizeAssistantResponse(assistantText) || classification.fallback
```

Keep the duration check before `thread/read`, so short turns do not add RPC
load. Keep pending persistence and delivery exactly as they are after this
block.

- [ ] **Step 5: Run notifier and security wiring tests**

Run:

```bash
pnpm exec vitest run \
  src/server/ntfyCompletionNotifier.test.ts \
  src/server/securityPolicy.test.ts \
  src/server/codexAppServerBridge.security.test.ts
```

Expected: top-level sends, child/unknown/read-failure suppresses, persisted
child active state clears, and safe wiring/security tests pass.

- [ ] **Step 6: Commit the unified send gate**

```bash
git add src/server/ntfyCompletionNotifier.ts src/server/ntfyCompletionNotifier.test.ts
git commit -m "fix: notify only verified top-level turns"
```

---

### Task 4: Documentation, Full Review, Merge, and Safe Deployment

**Files:**
- Modify: `docs/AGENT_GUIDE.md`
- Do not commit build output, service state, logs, screenshots, passwords, ntfy URLs/topics, or `/tmp` review artifacts.

**Interfaces:**
- Consumes: Tasks 1-3 on `codex/filter-subagent-ntfy`.
- Produces: reviewed GitHub PR, synchronized `main`, and verified Tailnet-only service.

- [ ] **Step 1: Document the top-level-only invariant**

Add beside the current ntfy external-monitor guidance:

```markdown
- Long-task ntfy delivery is top-level-only. A non-empty parent thread ID or subagent source suppresses the lifecycle at the external monitor, and every eligible terminal is verified again through `thread/read` before pending creation. Unknown or unreadable hierarchy fails closed without delivery. The verified top-level read is reused for the final assistant summary; never use a child worker report as the parent notification body.
```

- [ ] **Step 2: Run focused and complete verification**

Run:

```bash
pnpm exec vitest run \
  src/server/ntfyThreadScope.test.ts \
  src/server/rolloutLifecycle.test.ts \
  src/server/externalTurnMonitor.test.ts \
  src/server/ntfyCompletionNotifier.test.ts \
  src/server/securityPolicy.test.ts \
  src/server/codexAppServerBridge.security.test.ts
pnpm run test:unit
pnpm exec vue-tsc --noEmit
pnpm exec tsc --noEmit -p tsconfig.server.json
pnpm run build
node dist-cli/safe.js doctor
git diff --check
```

Expected: all tests and type checks pass; build completes with only the existing
chunk-size warning; doctor prints `codex-mobile-safe doctor: ok`.

- [ ] **Step 3: Commit documentation and request full-diff review**

```bash
git add docs/AGENT_GUIDE.md
git commit -m "docs: explain top-level ntfy filtering"
```

Review `origin/main..HEAD` against the approved design and this plan. Fix every
Critical or Important finding, rerun its covering focused tests, then rerun the
complete verification from Step 2.

- [ ] **Step 4: Create, review, and merge the PR**

```bash
git fetch --prune origin
git rebase origin/main
git push -u origin codex/filter-subagent-ntfy
gh pr create --repo zonghang-li/codex-mobile --base main --head codex/filter-subagent-ntfy
PR_NUMBER="$(gh pr view --repo zonghang-li/codex-mobile --json number --jq .number)"
gh pr comment "$PR_NUMBER" --repo zonghang-li/codex-mobile --body '/review'
gh pr merge "$PR_NUMBER" --repo zonghang-li/codex-mobile --rebase --delete-branch
git fetch --prune origin
git switch main
git merge --ff-only origin/main
```

Expected: PR is merged, its remote feature branch is deleted, and local `main`
equals `origin/main`.

- [ ] **Step 5: Verify pending state before restart**

Run without printing keys, messages, or URLs:

```bash
jq '{pending_count:(.pending|length)}' /home/zonghangli/.codex-mobile-safe/ntfy-notifier.json
```

Expected: `pending_count` is `0`. If nonzero, stop deployment and report it;
do not send, edit, or delete ambiguous pending records.

- [ ] **Step 6: Reinstall and verify Tailnet-only service**

```bash
pnpm run service:install
codex-mobile-safe doctor
codex-mobile-safe status
ss -ltnp '( sport = :5900 )'
tailscale serve status
jq '{pending_count:(.pending|length)}' /home/zonghangli/.codex-mobile-safe/ntfy-notifier.json
```

Expected: service is active, doctor passes, port 5900 listens only on
`127.0.0.1`, Tailscale Serve says `tailnet only`, and pending count remains `0`.

Manual acceptance requires one top-level task longer than 10 minutes with a
subagent. A child terminal while the parent remains running sends nothing; the
single parent terminal sends one understandable final notification.
