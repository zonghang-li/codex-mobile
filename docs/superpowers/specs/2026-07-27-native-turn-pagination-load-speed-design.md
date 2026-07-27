# Native Turn Pagination Load Speed Design

Date: 2026-07-27
Status: Approved
Branch: `codex/native-turn-pagination-load-speed`

## Problem

Opening a long Codex task currently blocks on `thread/read` with
`includeTurns: true`. The active rollout is about 588 MB, and one observed
request spent 42.4 seconds in the backend before returning a 4.3 MB JSON body.
The frontend then normalizes and renders every returned turn.

The existing `/codex-api/thread-turn-page` endpoint is not a true performance
boundary: it first calls full `thread/read`, then slices the in-memory result.
It reduces response size but not the expensive rollout read and enrichment.

The session-recovery cache also becomes invalid whenever an active rollout
grows. Rebuilding it reads and parses the entire rollout, so live polling can
repeatedly perform work proportional to the complete session size.

## Goals

- Render the newest conversation turns without waiting for full history.
- Keep every historical turn reachable in exact order without skipping middle
  turns.
- Preserve the current display rule: completed historical turns omit reasoning
  and intermediate progress; only the latest running turn may show live
  reasoning/progress.
- Preserve Codex desktop parity for commands, file changes, collaboration
  activity, completion summaries, runtime state, model, effort, and Goal.
- Keep active live refresh bounded by the newest turn/page rather than total
  rollout size.
- Preserve optimistic user messages, queued messages, stop controls, scroll
  anchoring, and completion transitions.

## Non-goals

- Do not reintroduce a client-side render window that hides messages already
  loaded from the server.
- Do not delete, truncate, archive, or rewrite rollout files.
- Do not change Tailnet/LAN authentication or exposure.
- Do not replace Codex app-server protocol data with heuristic reconstruction.
- Do not preload all historical full turn bodies in the background.

## Considered Approaches

### 1. Native `thread/turns/list` cursor pagination — chosen

Codex app-server 0.144.1 exposes `thread/turns/list` with an opaque cursor,
ascending/descending direction, a turn limit, and `itemsView` values
`notLoaded`, `summary`, and `full`.

This is the only approach that avoids materializing every historical item while
still using Codex's authoritative persisted turn representation.

### 2. Persist the current full `thread/read` response

A disk cache would make warm reloads faster, but cold loads would still take
tens of seconds, active sessions would invalidate the cache continuously, and
cache freshness would become another source-of-truth problem.

### 3. Parse rollout JSONL directly into pages

Reverse/incremental scanning could be faster than current full enrichment, but
it would duplicate Codex protocol semantics and risk the content mismatches
already seen between desktop and mobile. It remains a compatibility fallback,
not the primary design.

## Architecture

### Native page bridge

Replace the current page endpoint's full `thread/read` dependency with
`thread/turns/list`.

The bridge accepts:

```ts
type ThreadTurnPageRequest = {
  threadId: string
  cursor?: string
  limit: number
  sortDirection: 'asc' | 'desc'
  itemsView: 'notLoaded' | 'summary' | 'full'
}
```

The initial full page uses descending order and five turns. Older-page requests
use the returned opaque `nextCursor` and load ten turns at a time. The bridge
reverses descending pages before frontend normalization so messages remain
chronological.

The bridge filters historical reasoning and sanitizes inline payloads only for
the returned page. It must not call full `thread/read` or
`readCachedSessionRecoveredItems` on the page path.

### Initial thread detail

Initial hydration obtains metadata with `thread/read` and
`includeTurns: false`, in parallel with the newest native full-turn page.
Metadata supplies path, model/runtime fields, and ownership; the page supplies
display turns.

The response includes the native older cursor and `hasMoreOlder`. The UI
renders the newest page immediately and shows the existing earlier-message
control when the cursor is non-null.

### Stable turn ordering

The frontend stores loaded turns by `turnId` and preserves their contiguous
order from the newest page backward. Prepending an older page reindexes the
loaded contiguous window before merging live overlays. No page-local index may
collide with an already-loaded turn.

Fork and rollback calculations continue to use the loaded contiguous ordering;
because pages are never skipped, the distance from any loaded turn to the
newest turn remains exact.

### Live refresh

Selected-thread refresh requests only the newest native full page and the
existing small writer-owned live snapshot/runtime state. It merges updates by
stable turn and item identifiers without deleting older loaded pages.

Unchanged projection keys continue to return lightweight `notModified`
responses. A growing rollout must not trigger a full session-recovery rebuild
for every poll.

The existing stream overlay remains authoritative for locally started active
turn events. External running presentation continues to prefer the
writer-owned snapshot.

### Older history

Loading earlier messages sends the stored opaque native cursor. Each successful
page atomically prepends its turns, advances the cursor, and preserves the
reader's scroll anchor.

There is no five-turn history cap. Five is only the first payload size. Repeated
pagination reaches the first turn without gaps or duplication.

## Compatibility and Failure Handling

- If `thread/turns/list` returns method-not-found, fall back to the existing
  full-read path and emit one concise diagnostic; correctness is preserved on
  older Codex installations.
- If metadata succeeds but the turn page fails, keep the existing rendered
  messages and expose the normal retryable thread error.
- If an older-page request fails, do not advance its cursor or remove existing
  messages.
- If a live newest-page refresh fails while runtime is still running, preserve
  the current running state and existing messages.
- Invalid or repeated cursors fail closed and must not create a pagination loop.
- Aborted thread selection requests must not write results into a newly selected
  task.

## Testing

Use test-driven development.

1. Server tests prove the native page route calls `thread/turns/list` and never
   full `thread/read`.
2. Gateway tests prove newest and older cursors, chronological reversal,
   `hasMoreOlder`, metadata merging, and abort forwarding.
3. State tests prove no skipped middle turns, no duplicates, stable ordering,
   preservation of optimistic/live messages, and scroll-safe prepend behavior.
4. Live-state tests prove active refresh remains bounded and an unchanged
   projection does not replace historical pages.
5. Compatibility tests prove method-not-found fallback retains correctness.
6. Run the full unit suite, production build, and `git diff --check`.

## Performance Acceptance

For the current roughly 588 MB active rollout:

- The initial critical path must not issue `thread/read` with
  `includeTurns: true`.
- Initial turn payload is bounded to five full turns.
- Older history requests are bounded to ten full turns.
- Repeated selected-thread polling must not return the complete 4.3 MB
  conversation projection.
- Service logs must show that initial and live requests no longer spend time
  proportional to the complete rollout size.

