# Transient External Idle Blue-Dot Fix Design

Date: 2026-07-15
Status: Approved for implementation planning
Branch: `codex/fix-transient-idle-blue-dot`

## Problem

The sidebar blue dot represents an unread completed update. A Codex Desktop or
CLI turn can still be producing output while one background runtime probe fails
to find its writable rollout descriptor. The server currently maps an
unmatched `task_started` record with no writer evidence to `idle`. The browser
then clears `inProgress`, refreshes the thread summary, and renders the changed
summary as unread. This converts an inconclusive observation into a false
completion signal.

## State Semantics

The rollout lifecycle record is authoritative for completion:

- a matching `task_complete` or `turn_aborted` means `idle`;
- an unmatched `task_started` plus stable writer evidence means `running`;
- an unmatched `task_started` without writer evidence means `unknown`, not
  `idle`;
- filesystem, process, descriptor, identity, or permission uncertainty also
  remains `unknown`.

Writer disappearance never infers completion. This matches the server-side
notification monitor and prevents a transient process/FD observation from
creating a blue unread dot.

## Browser Behavior

The existing browser behavior for `unknown` is retained:

- an established external running lease stays `inProgress` and keeps the
  spinning working indicator;
- no unread state is created and no completion summary refresh runs;
- later `running` evidence refreshes the lease normally;
- only authoritative terminal lifecycle evidence changes the thread to idle,
  after which the existing summary rules may mark an unselected thread unread.

Terminal outcome does not change the sidebar indicator contract. Successful,
failed, interrupted, and declined turns all stop the spinner when completion is
authoritative, and all may show a blue unread dot when the unselected thread has
new summary content. The runtime response therefore remains terminal-neutral:
it does not need to expose a terminal outcome that the indicator does not use.

For a cold observation with no previously established external lease,
`unknown` does not invent a running state. This fix prevents false completion;
it does not claim that missing evidence proves a new task is running.

## Components and Data Flow

1. `ExternalThreadRuntimeProbe.prepareInspection()` continues to distinguish a
   terminal rollout from an unmatched start.
2. `ExternalThreadRuntimeProbe.inspectMany()` scans same-UID writer evidence
   once for unmatched starts.
3. An unmatched start absent from that writer snapshot is returned as
   `unknown`; a confirmed terminal remains `idle`.
4. `useDesktopState.pollBackgroundRuntimeStates()` receives `unknown` and keeps
   any established external ownership and `inProgress` state unchanged.
5. A later terminal probe returns `idle`; only then does the browser clear the
   spinner and refresh unread state.

No HTTP route, response schema, authentication, listener, Tailscale exposure,
or notification behavior changes. The existing `{ state: 'unknown' }` response
shape is reused.

## Failure Handling

- A missing writer, partial `/proc` observation, or transient I/O error fails
  closed as `unknown`.
- Repeated `unknown` results do not clear an established running lease.
- The next 2-second visible-page background poll retries naturally.
- Browser background polling remains paused while the document is hidden.
- No prompt, output, rollout path, thread ID, or process detail is logged.

## Tests and Acceptance

Automated tests must prove:

- unmatched start plus writer is `running`;
- matching terminal is `idle`;
- unmatched start without writer is `unknown`;
- a background thread already known as external remains `inProgress` and not
  unread after one or repeated `unknown` results;
- writer evidence can disappear for one poll, recover, and later deliver a
  terminal without an intermediate blue dot;
- consecutive `unknown` results followed by recovered `running` evidence keep
  `inProgress` and suppress unread throughout the nonterminal sequence;
- any authoritative terminal clears `inProgress`, and successful, failed,
  interrupted, or declined completion may become unread when the thread is not
  selected and its summary has advanced.

Manual acceptance uses a Desktop/CLI task that continuously produces output:
observe the working spinner, force or simulate one missing-writer probe, verify
the spinner remains and no blue dot appears, then allow the authoritative
terminal record and verify the final unread behavior once.

## Safety and Rollback

The change is fail-closed and reuses existing `unknown` handling. It cannot
mark an uncertain task completed. Rollback is the single code/test commit that
restores the old no-writer-to-idle mapping; no state migration is required.
