# Unified Thread Runtime Reconciliation Design

Date: 2026-07-17
Status: Approved for implementation planning
Branch: `codex/fix-runtime-state-reconciliation`

## Problem

The mobile browser currently derives running state from two incomplete sources:

- browser-delivered `turn/started` and `turn/completed` notifications for turns
  owned by the mobile app-server; and
- Linux rollout-writer inspection for turns owned by another Codex process.

The external probe is intentionally unable to classify the mobile app-server's
own rollout writer as external. If the browser disconnects or misses a local
turn lifecycle notification, there is therefore no independent authority that
can repair its in-memory state.

Two user-visible failures follow:

1. A missed start leaves `inProgressById` false. A newer thread timestamp then
   activates the unread rule and the sidebar shows a blue completion-like dot
   while the task is still running.
2. A missed completion leaves a local active-turn lease in memory. Existing
   polling excludes locally owned threads, so the composer and page remain in
   the running state until a full browser refresh discards that lease.

The background runtime poller also always selects the first 50 eligible rows.
When more than 50 rows are loaded, later rows can be starved indefinitely.

## Production Evidence

Read-only inspection of the deployed service showed:

- `thread/list` reported desktop-owned running tasks as `idle` or `notLoaded`;
- `POST /codex-api/thread-runtime-states` correctly reported three current
  external tasks as `running`;
- a fresh mobile browser instance rendered all three as `working` within the
  existing two-second cadence;
- `recoverBridgeState()` only restores pending server requests and unloaded
  selected messages; it does not reconcile loaded local runtime leases; and
- the existing `syncThreadStatus()` helper is not scheduled.

This rules out a persistent external-probe failure and identifies missed local
lifecycle recovery plus candidate starvation as the remaining gaps.

## Goal

Make the visible mobile state converge automatically to the app-server's
authoritative local lifecycle state and the existing external writer state,
without requiring a page refresh and without resuming polling while the browser
is hidden.

## Non-goals

- Do not add sub-second cross-process streaming.
- Do not make external turns interruptible from mobile.
- Do not change unread timestamps, notification delivery, ntfy thresholds,
  authentication, Tailscale Serve, or public exposure.
- Do not clear a confirmed running state because of `unknown` evidence.
- Do not poll while `document.visibilityState === 'hidden'`.

## Runtime State Model

Keep the existing external runtime shapes and add one exact local-running shape
for the batch endpoint:

```ts
export type LocalAppServerRunningRuntime = {
  state: 'running'
  turnId: string
  interruptible: true
  source: 'local-app-server'
}

export type ThreadRuntimeObservation =
  | ExternalThreadRuntime
  | LocalAppServerRunningRuntime
```

`idle` and `unknown` retain their existing exact one-key shapes. Ownership is
inferred only from the exact running source; no optional fields are accepted.

State semantics are:

- local ledger running: `running/local-app-server`;
- otherwise confirmed external writer: `running/external-session-writer`;
- otherwise matching terminal lifecycle in the rollout: `idle`;
- otherwise incomplete or unsafe evidence: `unknown`.

The frontend continues to preserve every established local or external lease
on `unknown`.

## Backend Local Runtime Ledger

Add a focused `LocalThreadRuntimeLedger` owned by `AppServerProcess`. It consumes
the same app-server notifications before they are broadcast to browser clients.
Because the ledger lives beside the app-server process, browser WebSocket/SSE
disconnects cannot make it miss those events.

Rules:

- matching `turn/started` stores `(threadId, turnId)`;
- matching `turn/completed` removes only the same active turn;
- a delayed completion for an older turn cannot clear a newer turn;
- malformed or unrelated notifications do nothing;
- app-server exit and disposal clear the ledger.

The ledger stores only active turns. Completion authority continues to come
from the rollout terminal record; until that record is readable, the merged
answer is `unknown` and the frontend retains its lease.

## Unified Batch Observation

The existing single-thread endpoint remains external-only. The batch endpoint
becomes the browser reconciliation endpoint and combines both authorities.

For each request:

1. Run the existing one-scan external inspection for all requested IDs.
2. After the external scan settles, read the local ledger again.
3. Override each external result with `running/local-app-server` when the local
   ledger currently owns that thread.

Reading the local ledger after the potentially slower `/proc` scan prevents an
idle result captured before a new local start from winning the response. A
completion during the scan removes the local override and lets the rollout
result decide between authoritative `idle` and inconclusive `unknown`.

## Frontend Reconciliation

The background poller becomes a general runtime reconciler:

- include idle, local, and background-external loaded threads;
- exclude only the selected externally owned thread, whose detailed live
  snapshot poller already owns reconciliation;
- prioritize the selected non-external thread in each batch;
- rotate the remaining eligible rows through the available batch slots so
  every loaded row is eventually observed;
- retain the existing 50-ID request limit and one-request-at-a-time rule.

Result handling:

- `running/local-app-server`: establish or repair local ownership, store the
  observed active turn ID, set `inProgress`, and suppress unread;
- `running/external-session-writer`: preserve the existing external behavior;
- `idle` for an established external lease: release it and refresh summaries;
- `idle` for an established local lease: release it only if the request's local
  authority version is still current;
- `unknown`: preserve established ownership and progress, otherwise do nothing.

Every result continues to be rejected after generation, selection, local
authority, removal, stop, or visibility changes.

## Selected Local Completion Recovery

When the batch reconciler observes `idle` for the selected locally owned
thread, it must not clear the UI before terminal output is loaded.

Perform one shared, abortable `thread/read` detail request and reconcile it with
a narrowly scoped recovery option that permits an idle server detail to release
the stale local lease. The result applies only if the selected thread, detail
epoch, polling generation, and local authority version still match.

This ordering ensures the final reasoning, command, file-change, and assistant
messages are applied before the live overlay and stop state disappear. If the
detail read reports a new active local turn, keep the local lease. If it fails,
retain the current lease and retry on the next runtime cycle.

Unselected local completion may clear immediately after authoritative `idle`;
the existing forced thread-list refresh supplies its latest summary and unread
timestamp.

## Visibility and Reconnection

The existing visibility contract remains unchanged:

- hidden: cancel timers and abort in-flight runtime/detail requests;
- visible: run one immediate batch reconciliation and, when applicable, one
  immediate selected-external detail snapshot;
- network or notification reconnect: no special replay protocol is required,
  because the independent visible-page runtime reconciler repairs missed local
  lifecycle state within its normal cadence.

## Tests

Automated coverage must prove:

- the local ledger records a start and matching completion;
- an older completion cannot clear a newer local turn;
- unified observation prefers current local running over external idle,
  unknown, or running evidence;
- the gateway strictly accepts the local-running response shape and rejects
  malformed variants as `unknown`;
- a missed local start changes a blue unread row to `working`;
- a missed local completion clears a background running row and refreshes its
  unread summary;
- a selected missed completion applies final detail before releasing the local
  lease;
- detail failure and `unknown` preserve the established lease;
- a new local start invalidates a stale idle result;
- more than 50 eligible rows rotate without starving later rows;
- hidden pages issue no polls and foreground resume reconciles immediately.

## Acceptance

1. Start a task through mobile, disconnect or suppress the browser start event,
   and verify the sidebar converges from unread to working within one visible
   runtime cycle.
2. Suppress the browser completion event and verify final output appears and the
   composer returns to idle without refreshing the page.
3. Repeat with a desktop-owned task and confirm existing external working,
   output refresh, and terminal unread behavior remain unchanged.
4. Put the browser in the background and confirm no runtime/detail requests are
   sent; return to the foreground and confirm one immediate correction.

## Rollback

The change is additive at the batch-observation boundary. Rollback removes the
local ledger, restores the external-only batch parser, and restores fixed-order
candidate selection. No persisted state or migration is introduced.
