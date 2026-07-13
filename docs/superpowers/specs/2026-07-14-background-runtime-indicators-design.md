# Background External Runtime Indicators

Date: 2026-07-14
Branch: `codex/fix-background-runtime-indicators`

## Problem

A Codex task started in the desktop client can be actively writing its rollout while the mobile browser is viewing another conversation. The backend's single-thread runtime endpoint correctly reports that desktop task as `running`, but the mobile sidebar still renders the blue `unread` indicator.

Production reproduction on thread `019f565b-9ea5-7a30-b51d-8d927451f1b5` showed the mismatch directly:

```text
thread/list status: idle
GET /codex-api/thread-runtime-state: running
mobile sidebar data-state: unread
```

The frontend only calls `getThreadRuntimeState()` for the selected externally owned thread. Non-selected sidebar threads use `thread/list` summaries alone, so a desktop-owned thread is never inserted into `inProgressById`; its newer `updatedAt` instead activates the normal unread rule.

## Goal

Show the existing green animated `working` indicator for every loaded sidebar thread that is confirmed to be running in another Codex process, even when it is not selected on mobile. When that external task finishes, remove the working state and let the existing unread rules decide whether to show a blue dot.

## Non-goals

- Do not make externally owned turns interruptible from mobile.
- Do not change local turn ownership, notification semantics, unread timestamps, or completion notifications.
- Do not probe archived or unloaded threads.
- Do not make `thread/list` wait for Linux process inspection.
- Do not change indicator colors, animation, or sidebar layout.

## Chosen architecture

Add a separate batch runtime-state endpoint and a bounded background frontend poller. Keep the existing selected-thread runtime poller unchanged because it also coordinates terminal message refresh and ownership transitions for the open conversation.

### Backend batch endpoint

Add:

```text
POST /codex-api/thread-runtime-states
Content-Type: application/json

{"threadIds":["thread-a","thread-b"]}
```

The endpoint accepts 1–50 unique, non-empty thread IDs and returns an exact map:

```json
{
  "states": {
    "thread-a": {
      "state": "running",
      "turnId": "turn-a",
      "interruptible": false,
      "source": "external-session-writer"
    },
    "thread-b": { "state": "idle" }
  }
}
```

Invalid JSON, an empty list, more than 50 IDs, duplicates, empty IDs, or extra request keys returns HTTP 400. The active route-security policy is checked before probing. The response contains an entry for every accepted ID; a missing/unregistered or inconclusive thread is `unknown`.

When processing a normal `thread/list` RPC response, the bridge registers each returned thread's `(id, path)` with the runtime probe but does not inspect it or delay the list response.

### One-scan probe

Extend `ExternalThreadRuntimeProbe` with `inspectMany(threadIds, excludedPid)`. It incrementally parses and revalidates each registered rollout using the existing per-thread cache. Threads with no unmatched turn become `idle`; invalid, missing, or unsafe rollout paths become `unknown`.

For all threads that still have an unmatched turn, `inspectMany()` takes one snapshot pass over `/proc` file descriptors and matches writable Codex app-server descriptors by file identity. This avoids repeating the system-wide descriptor scan once per sidebar row. A failure to inspect one rollout does not fail other entries. A descriptor-snapshot failure makes only unresolved unmatched entries `unknown`.

The existing `inspect(threadId, excludedPid)` delegates to `inspectMany([threadId], excludedPid)` so single-thread and batch semantics cannot drift.

### Frontend API

Add `getThreadRuntimeStates(threadIds, signal?)`. It POSTs the batch body and strictly parses only the three supported runtime shapes. A failed request or malformed/missing entry yields `unknown` for that ID rather than clearing state.

### Background poller

Add one non-reactive background request/timer controller beside the existing selected-thread controller in `useDesktopState()`.

Each cycle derives at most 50 candidates, in current sidebar recency order, from loaded `sourceGroups`:

- exclude the selected thread because its existing detailed poller owns it;
- exclude locally owned or locally in-progress threads;
- include all other loaded, non-archived thread IDs so a running task is shown even if its read timestamp is current.

Only one batch request may be in flight. A new cycle starts two seconds after the previous cycle settles, preventing overlap and request accumulation.

For each result:

- `running`: set ownership to `external` and `inProgress` to true. Existing `applyThreadFlags()` then suppresses unread and the sidebar renders `working`.
- `idle`: only clear threads that this background poller previously established as external. Set ownership to `idle`, set `inProgress` false, and force one thread-list refresh for the running-to-idle batch so the latest `updatedAt` drives the existing unread rule.
- `unknown`: preserve an established external lease and otherwise leave local state unchanged.

The background poller never writes an active turn ID and never enables interrupt. Selection changes do not transfer its request to the selected-thread lifecycle; the next result application rechecks that each thread is still non-selected and non-local.

### Lifecycle and visibility

`startPolling()` starts both the existing notification stream and the background runtime poller. `stopPolling()` cancels the background timer, aborts any request, increments its generation, and removes its visibility listener.

While `document.visibilityState === 'hidden'`, no new background request is sent and any in-flight request is aborted. Becoming visible schedules an immediate fresh cycle. This is independent of the selected-thread poller and does not alter mobile resume message refresh behavior.

## Error and race handling

- Batch HTTP/network errors behave as all-`unknown`; confirmed external working indicators are retained.
- Results are ignored after stop, generation change, selection change for that thread, local takeover, or removal from the loaded thread list.
- A stale `idle` result cannot clear a newer local lease.
- A selected-thread result is ignored because the existing selected runtime lifecycle has higher authority.
- An idle batch transition refreshes thread summaries once per batch, not once per thread.
- The 50-thread cap bounds request size, cache work, and DOM-state fanout.

## Tests

### Runtime probe

- multiple running/idle/unknown threads are returned in input order;
- multiple unmatched threads share one file-descriptor snapshot pass;
- one unsafe or failed rollout does not poison other results;
- `inspect()` and one-element `inspectMany()` have identical behavior.

### Bridge and API client

- batch route validates exact request shape and route policy;
- `thread/list` registers candidates without inspecting them;
- client sends one POST, parses exact runtime records, and maps malformed/missing entries to `unknown`;
- request abort is propagated.

### Desktop state

- a non-selected unread thread changes from `unread` to `working` when batch runtime is `running`;
- a running-to-idle transition clears working and returns to unread based on refreshed `updatedAt`;
- `unknown` retains an established external working state;
- a stale idle result cannot clear a local takeover or a newly selected thread;
- one request at a time, 50-ID cap, recency order, and selected/local exclusions;
- hidden visibility aborts and visible visibility resumes;
- `stopPolling()` aborts and prevents further calls.

## Acceptance

With a desktop Codex task running and the mobile browser viewing a different conversation:

1. `/codex-api/thread-runtime-state` and the batch endpoint both report the desktop thread as `running`.
2. The sidebar row uses `data-state="working"`, not `data-state="unread"`.
3. Selecting the thread still shows it as externally owned and non-interruptible.
4. After desktop completion, the working indicator disappears; if the conversation was not read on mobile, the normal blue unread indicator appears.
5. At most one background runtime batch request is in flight, and no batch requests are sent while the page is hidden.
