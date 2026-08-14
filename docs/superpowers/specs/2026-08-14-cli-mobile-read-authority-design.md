# CLI and Mobile Read Authority Design

## Problem

Opening or refreshing an active Codex CLI thread in codex-mobile does not start
a second turn, but the browser composes the same turn from conflicting sources:

- native `thread/read` can report the CLI-owned turn as `interrupted` because the
  mobile app-server does not own the CLI process's in-memory runtime;
- rollout lifecycle inspection reports the same turn as `running`;
- `thread-live-state` can report `liveAuthority: missing` and replace the active
  turn with an empty `inProgress` projection;
- active text hydration appends only rollout-backed visible text.

After a refresh this can look like a fork even though the rollout still contains
one `task_started` event and one turn ID.

## Required Behavior

While an external CLI writer owns an active turn, codex-mobile must be a
read-only observer:

1. The rollout lifecycle and monotonic rollout cursor are authoritative for the
   active turn's identity, running state, and visible text.
2. A stale native `interrupted` status for that same turn must not become a
   competing browser projection.
3. Refreshing or selecting the thread must not call `thread/resume`,
   `turn/start`, Steer, Stop, rollback, fork, or any other writer operation.
4. Text updates must append or merge by `turnId` and `sessionOrder`; an older
   snapshot must not erase or reorder newer hydrated rows.
5. Active runtime and text polling must continue while the document is hidden.
6. Mobile writes attempted during external ownership must remain queued until
   the external turn is terminal and mobile has confirmed idle ownership.

## Server Design

The external runtime probe will distinguish a direct interactive Codex CLI
process from an app-server process. Direct CLI evidence establishes an external,
non-interruptible writer. A writable rollout descriptor held by an unrelated
app-server is not sufficient to override direct CLI ownership.

For an externally running turn without a writer live snapshot,
`thread-live-state` will produce one partial projection for the rollout active
turn. The projection status will be `inProgress`, and the response will identify
rollout text hydration as the authority rather than presenting the stale native
turn as a second terminal branch. Projection keys must include monotonic rollout
tail evidence so appended rows invalidate the prior projection.

The native `thread/read` response remains available for completed history and
metadata, but its stale terminal status cannot terminate or replace the matching
externally active turn.

## Client Design

The client will retain exactly one transcript segment for the active external
`turnId`. It will preserve completed history, merge active rollout text by
`sessionOrder`, and ignore stale same-turn terminal projections while external
runtime evidence remains running.

External ownership is read-only. Composer submissions use the durable queue;
queued Steer controls remain disabled until ownership is confirmed idle. No
optimistic sent bubble may be shown for an operation that was only queued.

## Failure Handling

- Inconclusive writer evidence remains fail-closed as `unknown`; it does not
  grant mobile writer ownership.
- Missing or temporarily unreadable rollout text preserves the last browser
  transcript and retries without clearing it.
- A terminal rollout lifecycle event ends external authority only after the
  terminal state and final text have been reconciled.

## Verification

Automated tests must cover:

- pure open/refresh issues no resume/start/control RPC;
- stale native `interrupted` plus external `running` yields one active turn;
- direct CLI writer detection is external and non-interruptible;
- unrelated app-server descriptors cannot masquerade as the CLI owner;
- text hydration appends without clearing history or duplicating the active turn;
- hidden documents continue active runtime and text polling;
- external submissions remain queued and cannot call `turn/start`.

Real acceptance uses Playwright against the deployed safe service and an active
non-protected CLI sample. The captured request list must contain no write RPC,
and rollout lifecycle metadata must show no additional task or turn after open
and refresh.
