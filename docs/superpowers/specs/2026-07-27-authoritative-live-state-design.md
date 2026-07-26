# Authoritative Live State Design

Date: 2026-07-27
Status: Ready for user review
Branch: `main`

## Problem

Codex Mobile currently reconstructs a selected running task from the mobile
backend's own `thread/read` result, session-log recovery, and any live stream
events received by the mobile app-server process. That works for turns started
by mobile, but it is not authoritative for a task currently being written by a
different Codex desktop/app-server process.

Production evidence from the active task `019f6447-fe48-7060-9a5a-9ce860569859`
shows the mismatch:

- the desktop client displays the active footer as `Step 2 / 6`;
- `/codex-api/thread-live-state` reports `externalRuntime.state = running` and
  the same active turn id, but the returned conversation state contains a
  five-step plan and the latest turn status still appears as `interrupted`;
- the rollout JSONL is about 206 MB, and the latest persisted `update_plan`
  entries do not contain the desktop-visible six-step active footer;
- repeated live-state reads take about four seconds and return roughly 0.9 MB.

The visible problem is not only a frontend rendering bug. Mobile is consuming a
stale derived state for externally owned running tasks, while desktop renders a
writer-owned live state that is not available to the mobile backend.

## Goal

Make Mobile render running tasks from the same authoritative state as the active
writer, so task status, footer step counts, file-change totals, pending
requests, activity labels, and completion transitions converge without page
refresh and without scanning large rollout logs every polling cycle.

## Non-goals

- Do not expose hidden chain-of-thought content.
- Do not make externally owned tasks interruptible from Mobile.
- Do not change authentication, Tailscale/LAN exposure, or ntfy delivery.
- Do not require sub-second streaming for background sidebar rows.
- Do not keep polling while the browser is hidden.
- Do not use session-log heuristics as the source of truth for active external
  footer state.

## Source of Truth

For a running task, the process that owns the active turn writer is the only
authority for live presentation state.

Mobile may still use `thread/read` for persisted history, completed turns, and
initial page hydration. It must not use a historical plan or reconstructed file
summary to overwrite or fabricate the active footer of an externally owned
running turn.

## Chosen Approach

Add a writer-owned live snapshot channel and make Mobile consume that snapshot
before falling back to persisted history.

The live snapshot is a small, bounded JSON object published by the active writer
for each active turn. It represents desktop-equivalent presentation state, not
raw protocol internals. Mobile reads this snapshot when
`externalRuntime.state === 'running'`.

Rejected alternatives:

- Continue polling bounded `thread/read`: production evidence shows it can be
  stale for desktop live footer state and expensive for large sessions.
- Reconstruct more data from rollout JSONL: this duplicates Codex protocol
  semantics, remains slow for large logs, and still cannot recover data that has
  not been persisted.
- Frontend-only correction: the frontend cannot display `Step 2 / 6` when the
  backend payload only contains a five-step plan.

## Live Snapshot Contract

The writer publishes the following logical shape:

```ts
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
  timeline: ThreadLiveTimelineItem[]
  pendingRequest: ThreadLivePendingRequest | null
  sidebar: ThreadLiveSidebarState
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

export type ThreadLiveSidebarState = {
  indicator: 'none' | 'running' | 'completed' | 'attention'
}
```

The `label` field is intentionally included. Mobile can render structured
fields for layout, but the writer-provided label is the semantic fallback and
debugging reference. If desktop says `Step 2 / 6`, the snapshot must carry
`stepCurrent = 2` and `stepTotal = 6`; Mobile must not recompute that total from
loaded messages.

`revision` is monotonically increasing per thread. Consumers ignore stale
revisions.

`expiresAt` prevents a crashed writer's last snapshot from being treated as
fresh forever.

## Transport

Use an atomic sidecar file as the first implementation:

```text
~/.codex/live-state/<thread-id>.json
```

The writer writes to a temporary file in the same directory and renames it into
place. The file is tiny, does not contain secrets, and stores only already
visible presentation state.

The sidecar is deliberately local-host scoped. Tailnet/LAN clients still access
it only through the existing Codex Mobile backend. No new public listener is
introduced.

If a future Codex app-server exposes equivalent writer-owned live state through
RPC, the Mobile backend can replace the file reader with that RPC while keeping
the same frontend contract.

## Backend Data Flow

`/codex-api/thread-live-state` becomes a merger of three sources:

1. runtime ownership from the existing runtime probe;
2. writer live snapshot when the probed owner is running and the snapshot is
   fresh for the observed active turn;
3. bounded `thread/read` for persisted messages and completed/idle fallback.

Rules:

- For `running/external-session-writer` with a fresh snapshot, return the
  snapshot's footer, timeline, pending request, and sidebar state as
  authoritative fields.
- For `running/external-session-writer` without a fresh snapshot, keep the task
  visibly running but return `liveAuthority = 'missing'`; omit active footer
  fields rather than returning stale derived values.
- For locally owned mobile turns, the existing mobile app-server stream remains
  authoritative and may also publish the same snapshot shape for consistency.
- For idle/completed turns, return `thread/read` data and clear any expired live
  snapshot state.

The endpoint response adds:

```ts
type ThreadLiveStateResponse = {
  threadId: string
  isInProgress: boolean
  externalRuntime: unknown
  liveAuthority: 'writer-snapshot' | 'local-stream' | 'persisted' | 'missing'
  liveSnapshot: ThreadLiveSnapshot | null
  conversationState: { turns: unknown[] } | null
  threadTurnStartIndex: number
  hasMoreOlder: boolean
}
```

## Frontend Data Flow

The selected conversation page applies sources in this order:

1. fresh `liveSnapshot` for active running presentation;
2. local mobile stream state for mobile-owned active turns;
3. persisted normalized messages for completed/idle display.

The active footer component receives the writer footer directly. It no longer
derives active external step totals or file totals from `filteredMessages`.

If `liveAuthority === 'missing'` while runtime is running, Mobile renders the
task as running and shows a neutral sync state, but hides the footer numbers.
It must not display an old plan such as `Step 2 / 5`.

Timeline items from the snapshot are rendered as live overlays and deduplicated
against persisted messages by stable ids and revision. Persisted history remains
available for older turns and for completed-turn folding.

## Failure Handling

- Missing snapshot + running runtime: preserve running state, hide stale active
  footer, keep polling while visible.
- Expired snapshot: treat as missing unless the runtime has become idle and
  persisted `thread/read` has the terminal turn.
- Lower revision than already applied: ignore.
- Snapshot active turn id differs from runtime active turn id: ignore snapshot
  and report `liveAuthority = 'missing'`.
- Snapshot parse failure: ignore snapshot, log one concise backend diagnostic,
  and continue with missing authority.
- `thread/read` failure while snapshot is fresh: keep the live snapshot visible
  and mark history as stale rather than blanking the page.

## Performance

The active external polling path reads one tiny snapshot file plus the existing
runtime probe. It does not scan a 206 MB rollout log every cycle.

`thread/read` remains available for initial page load, older-message pagination,
and completion catch-up. It should not be required every two seconds for active
external footer state.

Frontend polling remains post-settlement, abortable, and paused when
`document.visibilityState === 'hidden'`.

## Testing

Implementation must start with failing tests.

Backend tests:

- reads a fresh writer snapshot and returns `liveAuthority =
  'writer-snapshot'`;
- ignores expired, wrong-thread, wrong-turn, malformed, and lower-revision
  snapshots;
- returns `liveAuthority = 'missing'` for a running external task without a
  fresh snapshot and does not include stale active footer values;
- keeps fresh snapshot presentation visible when `thread/read` fails;
- does not rescan session logs for each fresh snapshot poll.

Frontend tests:

- active external footer renders writer-provided `Step 2 / 6`;
- active external footer hides stale derived `Step 2 / 5` when authority is
  missing;
- lower revision snapshots do not overwrite newer footer state;
- running status remains visible while authority is missing;
- completed/idle turns continue to render persisted history and folded activity;
- hidden page aborts polling and visible page resumes with one immediate read.

Integration tests:

- start a desktop-owned task that updates its plan from five to six steps;
- confirm Mobile updates to the same step total without refresh;
- confirm Mobile never shows the older five-step footer after the six-step
  snapshot is fresh;
- confirm active snapshot polling remains fast on a large rollout log;
- complete the desktop task and confirm final persisted output replaces the
  live snapshot in the expected desktop-style folded state.

## Acceptance

On the active "跨 LAN 分布式架构" style scenario:

1. Desktop shows `Step 2 / 6`.
2. Mobile shows `Step 2 / 6` from the writer snapshot within one visible poll.
3. If the writer snapshot is unavailable, Mobile shows the task as running but
   does not show `Step 2 / 5`.
4. Refreshing Mobile does not change the semantic state.
5. The selected-thread live-state endpoint is small and no longer depends on
   repeated full-session recovery for active footer correctness.

## Rollback

The change is additive. Rollback disables live snapshot reads and returns to the
existing `thread/read`-derived live-state path. The safe fallback behavior
should remain: when an external runtime is running and no authoritative footer
exists, Mobile hides active footer numbers instead of displaying stale ones.
