# Selected Idle External Turn Discovery Design

## Goal

When the mobile browser is already displaying an idle Codex task and the desktop client later starts a new turn in that same task, mobile must discover the transition automatically. The newly entered user message, live reasoning summary, and agent output should appear without a page reload.

Discovery should normally happen within the existing two-second runtime polling cadence. Once the task is known to be desktop-owned, the existing selected external-thread detail poller remains responsible for live output reconciliation.

## Root cause

Codex Mobile receives live notifications only from its own app-server process. A turn started by the desktop client belongs to another process, so mobile must discover it by polling shared task state.

The current polling paths leave a selected-idle blind spot:

- the selected external detail poller runs only after the selected task already has `external` runtime ownership;
- the lightweight background runtime batch explicitly excludes the selected task;
- an idle selected task therefore has no request that can observe a later `idle -> running` transition initiated by desktop;
- manual page refresh works because it performs a fresh `thread/read` and reconstructs the current runtime and messages.

The previously implemented external live synchronization is correct after external ownership is established. This design adds the missing discovery transition before that path starts.

## Chosen approach

While the document is visible, include the selected task in the existing lightweight batch runtime request when all of the following are true:

- the selected task is known to the mobile task list;
- it is not locally owned or protected by a local active-turn lease;
- it is not already externally owned;
- it is currently idle or its runtime state is unknown.

If the batch reports that task as `running`, atomically establish external ownership, set its in-progress state, and schedule an immediate marked external `thread/read`. That detail request uses the existing external snapshot path to reconcile the new user input, reasoning summary, and output.

The selected task is excluded from the batch while it is locally owned or already externally owned. This prevents the lightweight discovery request from competing with local notifications or duplicating the external detail poller.

Rejected alternatives:

- A separate selected-idle timer would duplicate cadence, visibility, abort, and stale-result state already owned by the batch poller.
- Continuously calling full `thread/read` for an idle selected task would transfer and normalize substantially more data even when nothing changes.
- A cross-process event relay would reduce latency but requires a publisher, replay and reconnect semantics, and ownership handoff. The existing two-second batch is sufficient for this transition.

## State transition

The intended path is:

```text
selected idle/unknown
  -> lightweight runtime batch reports running
  -> verify selection, generation, visibility, and non-local authority
  -> set ownership external and inProgress true
  -> schedule immediate external detail snapshot
  -> reconcile new input, reasoning summary, and output
  -> continue existing post-settlement external detail polling
```

An `idle` or `unknown` batch result leaves the selected task in discovery mode and retries on the normal batch cadence. A failed request preserves the last known state and retries normally.

## Authority and stale-result fences

A batch result may transition the selected task to external ownership only if, when the result is applied:

- polling is still active and the document is visible;
- the batch generation still matches;
- the same task is still selected;
- no local turn or local ownership was established after the request began;
- the task has not already transitioned to external ownership through another valid path.

Selection changes, polling stop, visibility changes, and local takeover invalidate or neutralize stale results through the existing generation and authority mechanisms. A stale `running` response must never overwrite local state or start an obsolete detail request.

The transition grants no interrupt capability and no local active-turn lease. Desktop-owned work remains read-only from mobile except for the existing supported task actions.

## Polling lifecycle

- Visible idle/unknown selected task: participate in the next existing background runtime batch.
- First foreground start or return from hidden: run the existing immediate batch probe, including the eligible selected task.
- Selected external task: use only the existing selected detail poller; exclude it from the lightweight batch.
- Selected local task: trust local notifications and local authority; exclude it from the lightweight batch.
- Hidden page: abort in-flight runtime/detail requests, stop timers, and issue no discovery requests.
- Selection change: the newly selected eligible idle task joins the next immediate or scheduled batch; results for the previous selection cannot trigger detail polling.
- Stop: invalidate generations and schedule nothing further.

The implementation reuses one batch request and one visibility listener. It introduces no second timer or overlapping detail request.

## Immediate detail handoff

When an eligible selected task is newly reported `running`, the implementation must schedule the existing marked external detail snapshot immediately rather than waiting another two seconds. The handoff must:

- preserve the at-most-one external detail request invariant;
- use the existing selection, ownership, and generation fences;
- reconcile the current bounded `thread/read` response through the existing snapshot helper;
- display the desktop-visible reasoning summary and newly persisted messages;
- continue subsequent external reads two seconds after the previous request settles.

Repeated batch results must not create duplicate detail requests. Once external ownership is established, the task no longer qualifies for batch discovery.

## Tests

Every production change starts with a focused failing test using fake timers and deferred promises.

Desktop-state tests must verify:

- an idle selected non-local task is included in the lightweight runtime batch;
- a `running` result for the still-selected task establishes external ownership and triggers one immediate marked detail read;
- the immediate detail result adds the desktop user input, reasoning summary, and agent output without reload or duplication;
- an `idle` or `unknown` result does not trigger a detail read and remains eligible for a later batch;
- a selected locally owned task is excluded from batch discovery;
- a selected externally owned task is excluded from the batch while its detail poller is active;
- a stale `running` response after selection change, local takeover, generation invalidation, visibility change, or stop cannot mutate ownership or messages;
- a failed batch request preserves current state and retries on the normal cadence;
- hidden visibility sends no runtime or detail requests, and returning visible triggers one immediate eligible discovery probe;
- repeated `running` observations cannot create overlapping or duplicate detail reads;
- after handoff, detail reads retain the existing post-settlement cadence and completion behavior.

Existing external snapshot, local-turn authority, sidebar indicator, notification, and visibility tests remain green.

## Acceptance

After review, merge, installation, and service restart:

1. Open an idle task in mobile Chrome and leave it selected.
2. Start a new turn in that same task from the Codex desktop client, including a new user input.
3. Without refreshing mobile, confirm it changes to running within one normal discovery cycle.
4. Confirm the new user input, detailed reasoning summary, and agent output appear through the immediate detail handoff.
5. Confirm requests do not overlap and only the selected external detail path continues after discovery.
6. Put mobile Chrome in the background, start or advance a desktop turn, and confirm the page sends no requests while hidden.
7. Return to the foreground and confirm one immediate probe discovers or catches up the turn.
8. Complete the desktop turn and confirm final output appears before the mobile running state clears.

Retain sanitized request timing and DOM-state evidence under `/tmp`.

## Non-goals

- Sub-second cross-process streaming.
- Polling full task details while the selected task remains idle.
- Changing local-turn notification or interrupt semantics.
- Changing sidebar unread-dot behavior beyond the state transition naturally produced by correct runtime ownership.
- Changing authentication, Tailscale Serve, ntfy, browser completion notifications, or public exposure.
