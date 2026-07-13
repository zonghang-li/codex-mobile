# Turn Running Lease Design

## Problem

The mobile composer can return from the stop control to the send control while the selected Codex turn is still running. The affected production thread later recorded the turn as `interrupted`, confirming that the UI had shown idle before the turn reached a terminal state.

Two state transitions can currently cause this:

1. After `turn/started` establishes a local active turn, a lagging `thread/read` or cached `thread/resume` response reporting idle can overwrite the local running state.
2. A `turn/completed` event clears the thread's active turn without checking whether the completed turn ID matches the currently active turn ID. A delayed completion for an older turn can therefore end a newer turn in the UI.

## Required Behavior

Once the client observes `turn/started` for turn A, turn A is an authoritative local running lease:

- The thread remains in progress and the composer keeps its stop control until turn A terminates.
- An idle backend snapshot cannot clear the lease.
- A terminal event for a different turn cannot clear the lease.
- Only `turn/completed` for turn A can release it.
- The stop request always targets the active lease's turn ID.

When the client has no local running lease, such as after a page reload or reconnect, backend `thread/read` state is authoritative. An active backend turn establishes a lease; an idle backend result leaves the thread idle.

## Design

### Turn-aware transition helper

Add a small pure lifecycle helper that receives:

- the locally active turn ID, if any;
- the completed turn ID;
- whether the completion will immediately retry with a fallback model;
- the terminal status and selected-thread state already used for unread handling.

The helper returns whether the completion owns the active lease, whether running state should be retained, and whether unread state should be marked. A completion owns the lease only when there is no known active ID or its turn ID matches the active ID. A mismatched completion cannot clear running state, active ID, live activity, or the current pending request.

### Notification handling

`turn/started` stores the turn ID and sets the thread in progress as today.

For `turn/completed`:

1. Compare the completed turn ID with the current active lease.
2. Preserve the existing fallback-retry behavior.
3. Apply terminal cleanup only when the completion owns the lease.
4. Continue syncing the stale turn's persisted output and historical metadata, but do not let it replace the newer turn's live activity, summary, error overlay, pending request, active ID, or running state.

When the client does not know an active turn ID, the completion remains authoritative for backward compatibility and performs the existing terminal cleanup.

### Backend reconciliation

When `loadMessages` receives a backend detail response:

- An active backend turn replaces or establishes the local lease and sets running state.
- An idle response cannot clear an existing local lease established by `turn/started`.
- An idle response can set idle only when no local lease exists.
- Backend request failure is conservative: retain the local lease and retry on the next normal synchronization cycle.

This uses the existing `thread/read`/`thread/resume` path as the backend confirmation requested by the user; it does not add polling on every render or a new endpoint.

## Alternatives Rejected

### Query the backend for every idle transition

This adds avoidable traffic and still allows a lagging snapshot to overwrite a newer event.

### Delay idle transitions with a timeout

This masks rather than fixes the race and still fails when event reordering exceeds the delay.

## Testing

Add regression tests proving:

1. `turn/started(A)` followed by an idle detail response keeps A running.
2. `turn/started(A)`, `turn/started(B)`, then `turn/completed(A)` keeps B running and preserves B as the stop target.
3. `turn/completed(B)` releases B and restores idle UI.
4. A backend active turn establishes running state after reload.
5. A backend idle result with no local lease remains idle.
6. Fallback retry, unread handling, selected-thread behavior, and non-success terminal behavior remain unchanged.

Run focused lifecycle tests, the full Vitest suite, the production build, CLI doctor, and responsive browser verification of the stop/send control before deployment.

## Deployment and Rollback

Deploy through the existing local installer and user service, then restore Tailscale Serve as tailnet-only. Verify that the service remains bound to `127.0.0.1:5900` and that the stop control remains visible during an active test turn.

Rollback is a revert of the lifecycle commit followed by the same service installation and Tailscale exposure steps.
