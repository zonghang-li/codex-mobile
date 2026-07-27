# Native Turn Pagination Load Speed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace full-history initial and live reads with Codex app-server's native cursor-based turn pagination while preserving complete on-demand history and mobile/desktop content parity.

**Architecture:** A focused server module calls `thread/turns/list`, validates its opaque cursors, and returns chronological pages. The bridge combines a five-turn page with metadata-only `thread/read`; the gateway and state store retain the older cursor and prepend ten-turn pages without gaps. Live refresh uses the same bounded newest page and existing writer snapshot instead of reparsing the complete rollout.

**Tech Stack:** TypeScript, Node HTTP middleware, Codex app-server v2 JSON-RPC, Vue 3 composables, Vitest.

## Global Constraints

- Initial loading must not issue `thread/read` with `includeTurns: true` when native pagination is available.
- The first payload contains at most five full turns; older requests contain at most ten full turns.
- Every historical turn remains reachable in order; no client-side window may hide already-loaded messages.
- Completed historical turns omit reasoning and intermediate progress; only the latest running turn may retain them.
- Commands, file changes, collaboration activity, completion summaries, runtime state, model, effort, Goal, optimistic messages, queueing, stop controls, and scroll anchoring remain intact.
- No new dependency, authentication change, rollout rewrite, or background full-history preload.
- Older Codex installations fall back to the existing full-read behavior only on method-not-found.

---

### Task 1: Native App-Server Turn Page

**Files:**
- Create: `src/server/threadTurnPagination.ts`
- Create: `src/server/threadTurnPagination.test.ts`
- Modify: `src/server/codexAppServerBridge.ts`
- Test: `src/server/externalThreadRuntimeBridge.test.ts`

**Interfaces:**
- Consumes: `rpc('thread/turns/list', { threadId, cursor, limit, sortDirection: 'desc', itemsView: 'full' })`.
- Produces:

```ts
export type NativeThreadTurnPage = {
  turns: unknown[]
  nextCursor: string | null
  backwardsCursor: string | null
}

export async function readNativeThreadTurnPage(
  rpc: (method: string, params: unknown) => Promise<unknown>,
  input: { threadId: string; cursor?: string; limit: number },
): Promise<NativeThreadTurnPage>
```

- [ ] **Step 1: Write failing native page tests**

Add tests that call `readNativeThreadTurnPage` with a recording RPC and assert:

```ts
expect(rpc).toHaveBeenCalledWith('thread/turns/list', {
  threadId: 'thread-1',
  cursor: null,
  limit: 5,
  sortDirection: 'desc',
  itemsView: 'full',
})
expect(page.turns.map(readId)).toEqual(['turn-3', 'turn-4'])
expect(page.nextCursor).toBe('older-2')
```

Also assert invalid result objects throw and limits are clamped to `1..50`.

- [ ] **Step 2: Verify RED**

Run:

```bash
pnpm vitest run src/server/threadTurnPagination.test.ts
```

Expected: FAIL because `threadTurnPagination.ts` does not exist.

- [ ] **Step 3: Implement the native page module**

Implement the exported types and function. Validate `data` as an array, normalize
empty cursors to `null`, reverse the descending app-server page into
chronological order, and do not inspect rollout JSONL.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
pnpm vitest run src/server/threadTurnPagination.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing bridge tests**

Add bridge tests proving `/codex-api/thread-turn-page`:

```ts
expect(rpc).toHaveBeenCalledWith('thread/turns/list', expect.objectContaining({
  threadId: 'thread-1',
  cursor: null,
  limit: 5,
  itemsView: 'full',
}))
expect(rpc).not.toHaveBeenCalledWith('thread/read', expect.objectContaining({
  includeTurns: true,
}))
```

Assert returned turns are sanitized, historical reasoning is pruned, and
`nextCursor` is returned. Add a method-not-found test returning HTTP 501 with
`fallback: 'thread/read'`.

- [ ] **Step 6: Verify bridge RED**

Run:

```bash
pnpm vitest run src/server/externalThreadRuntimeBridge.test.ts -t "native turn page"
```

Expected: FAIL because the route still calls full `thread/read`.

- [ ] **Step 7: Wire the native page route**

Replace `readThreadForTurnPage` use in the route with
`readNativeThreadTurnPage(appServer.rpc.bind(appServer), ...)`. Accept opaque
`cursor`, prune reasoning on the returned page, sanitize only returned turns,
and return:

```ts
{
  result: { thread: { id: threadId, turns } },
  nextCursor,
  backwardsCursor,
  hasMoreOlder: nextCursor !== null,
}
```

Map only JSON-RPC method-not-found errors to HTTP 501. Preserve all other
errors as retryable failures.

- [ ] **Step 8: Verify bridge GREEN**

Run both focused server test files and expect PASS.

- [ ] **Step 9: Commit Task 1**

```bash
git add src/server/threadTurnPagination.ts src/server/threadTurnPagination.test.ts \
  src/server/codexAppServerBridge.ts src/server/externalThreadRuntimeBridge.test.ts
git commit -m "feat(server): add native turn pagination"
```

---

### Task 2: Paginated Initial Hydration and Older History

**Files:**
- Modify: `src/api/codexGateway.ts`
- Modify: `src/api/codexGateway.test.ts`
- Modify: `src/composables/useDesktopState.ts`
- Modify: `src/composables/useDesktopState.test.ts`

**Interfaces:**
- `ThreadTurnPage` adds:

```ts
nextCursor: string | null
turnIds: string[]
```

- `getThreadDetail()` adds optional `olderCursor: string | null`.
- `getOlderThreadMessages(threadId, cursor, limit?)` consumes the opaque cursor.
- The state store adds `olderTurnCursorByThreadId: Record<string, string | null>`.

- [ ] **Step 1: Write failing gateway tests**

Add tests asserting initial detail performs these requests in parallel:

```ts
{ method: 'thread/read', params: { threadId, includeTurns: false } }
GET /codex-api/thread-turn-page?threadId=...&limit=5
```

Assert the combined result contains metadata, five chronological turns,
`olderCursor`, and `hasMoreOlder`. Assert the older request forwards the exact
opaque cursor and a limit of ten. Assert abort signals reach both requests.

Add a 501 test proving initial hydration falls back to one full
`thread/read(includeTurns: true)` and returns all turns with no older cursor.

- [ ] **Step 2: Verify gateway RED**

Run:

```bash
pnpm vitest run src/api/codexGateway.test.ts -t "native turn page|older cursor|pagination fallback"
```

Expected: FAIL because detail still performs one full `thread/read`.

- [ ] **Step 3: Implement gateway composition**

Add a shared page fetcher that parses `nextCursor`, `turnIds`, and the page
thread. Change initial detail to `Promise.all` metadata-only read and newest
page. Merge page turns under the metadata thread before using existing
normalizers/runtime readers.

On page HTTP 501 only, call the legacy full read. Do not fall back on abort,
authentication, or ordinary server errors.

- [ ] **Step 4: Verify gateway GREEN**

Run the focused gateway command and expect PASS.

- [ ] **Step 5: Write failing state tests**

Add tests for:

1. initial detail stores the returned opaque cursor;
2. loading older messages sends that cursor exactly once;
3. a ten-turn older page is prepended without duplicates or missing middle
   turns;
4. all loaded turn indices are reindexed contiguously after prepend;
5. the cursor advances only after success;
6. optimistic user and live overlay messages survive a prepend;
7. a failed older request preserves existing messages and cursor.

- [ ] **Step 6: Verify state RED**

Run:

```bash
pnpm vitest run src/composables/useDesktopState.test.ts -t "opaque older cursor|reindexes prepended turns"
```

Expected: FAIL because state derives pagination from `beforeTurnId`.

- [ ] **Step 7: Implement cursor state and contiguous reindexing**

Store `olderCursor` during detail reconciliation. Change `loadOlderMessages`
to call the gateway with that cursor. Before merging a successful older page:

```ts
const newTurnIds = page.turnIds.filter((turnId) => !(turnId in currentLookup))
const shift = newTurnIds.length
```

Shift existing persisted/live turn indices by `shift`, assign the new page
indices `0..shift-1`, rebuild the turn lookup, then merge. Advance to
`page.nextCursor` only after the merge succeeds.

- [ ] **Step 8: Verify state GREEN**

Run the focused state and gateway test files and expect PASS.

- [ ] **Step 9: Commit Task 2**

```bash
git add src/api/codexGateway.ts src/api/codexGateway.test.ts \
  src/composables/useDesktopState.ts src/composables/useDesktopState.test.ts
git commit -m "feat(mobile): hydrate threads from paged turns"
```

---

### Task 3: Bounded Live-State Refresh

**Files:**
- Modify: `src/server/codexAppServerBridge.ts`
- Modify: `src/server/externalThreadRuntimeBridge.test.ts`
- Modify: `src/api/codexGateway.ts`
- Modify: `src/api/codexGateway.test.ts`
- Modify: `src/composables/useDesktopState.ts`
- Modify: `src/composables/useDesktopState.test.ts`

**Interfaces:**
- `/codex-api/thread-live-state` returns at most five persisted turns plus
  `olderCursor`.
- Existing `projectionKey`, `notModified`, `liveAuthority`, and `liveSnapshot`
  semantics remain unchanged.

- [ ] **Step 1: Write failing bounded live-state tests**

Use a fake RPC that rejects any full read:

```ts
if (method === 'thread/read' && params.includeTurns === true) {
  throw new Error('full history read forbidden')
}
```

Assert live-state succeeds through metadata-only `thread/read` and
`thread/turns/list(limit: 5)`, returns no more than five turns, and carries an
older cursor. Assert repeated matching projection keys return `notModified`
without a conversation body.

- [ ] **Step 2: Verify live-state RED**

Run:

```bash
pnpm vitest run src/server/externalThreadRuntimeBridge.test.ts -t "bounded native live state"
```

Expected: FAIL because live-state still performs full `thread/read` and full
session recovery.

- [ ] **Step 3: Implement bounded live state**

Obtain metadata with `thread/read(includeTurns: false)` and the newest page with
`thread/turns/list`. Merge captured local stream items only into those turns.
Do not call `readCachedSessionRecoveredItems` on this path. Preserve runtime
probe registration, model-setting tail scan, writer snapshot authority,
projection-key behavior, and fallback snapshots.

Include `olderCursor` in full responses and use it in projection-key inputs so a
changed page cannot be mistaken for `notModified`.

- [ ] **Step 4: Update gateway/state live merge**

Parse the live response cursor. During live projection reconciliation, keep
already-loaded older pages, preserve existing indices by `turnId`, and assign
indices above the current maximum only to genuinely new latest turns.

- [ ] **Step 5: Verify Task 3 GREEN**

Run:

```bash
pnpm vitest run src/server/externalThreadRuntimeBridge.test.ts \
  src/api/codexGateway.test.ts src/composables/useDesktopState.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/server/codexAppServerBridge.ts \
  src/server/externalThreadRuntimeBridge.test.ts src/api/codexGateway.ts \
  src/api/codexGateway.test.ts src/composables/useDesktopState.ts \
  src/composables/useDesktopState.test.ts
git commit -m "perf(mobile): bound live thread refresh"
```

---

### Task 4: Documentation, Regression, Performance, and Deployment

**Files:**
- Modify: `tests/thread-loading-state/thread-loads-full-history-with-pruned-reasoning.md`
- Modify: `tests/thread-loading-state/thread-conversation-loads-earlier-turns-on-demand.md`
- Create: `tests/thread-loading-state/native-turn-pagination-load-performance.md`

**Interfaces:**
- Documents the observable five-turn initial page, ten-turn older pages, exact
  cursor continuation, and bounded live refresh.

- [ ] **Step 1: Update manual contracts**

Replace the obsolete assertion that initial `thread/read` returns all turns
with:

```text
Initial hydration returns the newest five full turns.
Load earlier messages follows the opaque cursor until every earlier turn is
visible without gaps.
Only loaded messages are rendered; already-loaded messages are never hidden by
a client-side render window.
```

- [ ] **Step 2: Run full verification**

```bash
pnpm run test:unit
pnpm run build
git diff --check
```

Expected: all Vitest files pass, frontend/CLI builds exit 0, and diff check is
clean.

- [ ] **Step 3: Install and restart**

```bash
pnpm run install:local
systemctl --user restart codex-mobile-safe.service
systemctl --user --no-pager --full status codex-mobile-safe.service
```

Expected: service is active on the configured Tailnet-only endpoint.

- [ ] **Step 4: Verify production performance**

Refresh the current long task and inspect service logs. Confirm:

```text
No initial rpcMethod=thread/read request with bodyMB≈4.3 and duration≈42s.
The newest turn-page response contains at most five turns.
Live-state responses do not contain the complete conversation.
Older-page requests contain at most ten turns.
```

Record observed request durations and payload sizes in the final report.

- [ ] **Step 5: Commit Task 4**

```bash
git add tests/thread-loading-state
git commit -m "docs: cover native paged thread loading"
```

