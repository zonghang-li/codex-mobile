# External Live Thread Sync Design

## Goal

When a Codex task is running in another desktop process, the selected mobile thread should refresh its visible output and show the same latest visible reasoning summary as the desktop client. Updates should normally appear within one settled polling cycle (about two seconds), pause completely while the browser is hidden, and resume immediately when the page becomes visible.

## Root cause

Codex Mobile already handles live reasoning, agent-message, command, plan, and file-change notifications emitted by its own app-server process. A desktop-owned task uses a different app-server process, so those notifications never enter the mobile process.

The external-thread path currently compensates only for lifecycle ownership: it polls `/codex-api/thread-runtime-state` and learns `running`, `idle`, or `unknown`. While the external task remains `running`, it does not refresh `thread/read`. Consequently:

- the live overlay has no activity or reasoning event and falls back to `Thinking`;
- persisted output remains at the snapshot loaded when the mobile user selected or refreshed the thread;
- a manual page refresh performs a new `thread/read`, making the missing output appear.

Read-only production evidence confirmed that `thread/read` already exposes the desktop task's current visible reasoning summaries and newly persisted agent output. The missing behavior is therefore frontend snapshot reconciliation, not unavailable backend data.

## Chosen approach

Reuse the existing bounded `thread/read` RPC response for the one selected externally owned thread. The server already trims normal RPC thread responses to the most recent ten turns and augments them with the external runtime result. One abortable request can therefore return both the authoritative external lifecycle state and the newest visible messages.

This replaces the selected-thread external runtime-only request. It does not change the separate batch poller used for non-selected sidebar indicators.

Rejected alternatives:

- Incrementally reconstructing Codex items from rollout JSONL would reduce RPC work but duplicate the Codex protocol and risk missing commands, plans, file changes, images, sub-agent activity, or future item types.
- A cross-process WebSocket/SSE relay would reduce latency but requires a new event publisher, replay cursor, reconnect protocol, and ownership handoff. Two-second selected-thread snapshots meet the current requirement with much less operational risk.

## Interfaces

### Abortable RPC read

Extend the internal RPC client and `getThreadDetail()` path with an optional `AbortSignal`. Existing callers remain source-compatible. The signal must be passed unchanged to `fetch('/codex-api/rpc', ...)`.

The external poller calls `getThreadDetail(threadId, signal)` once per cycle. It must not make a separate runtime-state request in the same cycle.

### Snapshot application

Extract the message/detail reconciliation currently embedded in `loadMessages()` into a focused internal helper shared by normal loads and external live snapshots. The helper must:

- merge the bounded latest-turn response with already loaded messages while preserving older messages missing from the bounded response;
- update existing items by stable message ID instead of appending duplicates;
- reconcile command, file-change, plan, agent-message, model, provider, turn-index, and pagination metadata through existing normalization paths;
- preserve optimistic local messages and local active-turn authority;
- retain an established external lease on `unknown`;
- never grant interrupt capability or a local active-turn lease to external work.

During a running external snapshot, the latest reasoning message belonging to the active turn drives the overlay activity label. The active reasoning item remains hidden from the ordinary transcript while that external turn is running, matching the existing local live-overlay behavior. After completion it returns to the persisted transcript normally.

### Reasoning-summary display

For the active external turn:

1. Select its newest non-empty normalized `reasoning` message.
2. If it contains multiple summary paragraphs, display the final non-empty paragraph, which represents the newest desktop activity summary.
3. Collapse whitespace and remove one matching outer `**...**` wrapper used by rollout summary text.
4. Do not inspect or expose reasoning `content`; only the already visible `summary` field normalized by `thread/read` is eligible.
5. If no usable summary exists, display `Thinking`.

Examples:

- `**Reading development-workflow.md**` becomes `Reading development-workflow.md`.
- `**Inspecting fixtures**\n\n**Planning test coverage**` displays `Planning test coverage`.

Local turns continue using their existing notification-driven live reasoning behavior.

## Polling lifecycle

- Scope: only the currently selected thread whose runtime ownership is `external`.
- Cadence: the next cycle begins 2,000 ms after the previous request settles; requests never overlap.
- Initial selection: retain the current fallback UI, then perform the first external snapshot after the existing external poll delay.
- Hidden page: cancel the timer, abort the in-flight fetch, increment the external polling generation, and schedule nothing while `document.visibilityState === 'hidden'`.
- Visible page: schedule an immediate external snapshot for the currently selected external thread, alongside the existing immediate background-indicator refresh.
- Selection or ownership change: cancel the old request. A result may apply only when its generation, selected thread ID, and external ownership still match.
- Stop: abort the request, remove visibility listeners through the existing polling lifecycle, and prevent rescheduling.

The visibility handler should coordinate both existing runtime pollers without creating duplicate listeners.

## Running, idle, and unknown results

### Running

Apply the bounded snapshot, keep ownership `external`, keep `inProgress` true, update the overlay summary, and preserve non-interruptibility.

### Idle

Apply the same response first so the final reasoning, commentary, tool result, and final answer are not lost. Then clear the external lease and in-progress state through the existing completion path, clear the live overlay, and refresh thread summaries as already required.

### Unknown or failed request

Keep the last confirmed external lease, output, and summary. Do not blank the conversation or replace a detailed summary with `Thinking`. Schedule the next cycle after settlement unless the page became hidden, selection changed, polling stopped, or ownership changed.

Aborted requests are expected lifecycle events and must not surface an error message.

## Message ordering and scrolling

Snapshot reconciliation uses the server-provided turn indexes and stable item IDs. Existing messages absent from the bounded response remain in place; changed current-turn items replace their prior versions.

New external output should follow the same auto-scroll policy as live local agent output: keep a user who is already near the bottom at the latest output, but do not force-scroll a user who intentionally moved upward.

## Performance and safety

- At most one selected external snapshot request is in flight.
- Only one selected thread is refreshed; background threads continue using the lightweight batch runtime endpoint.
- Responses remain bounded by the existing ten-turn RPC trimming.
- Polling is post-settlement, preventing catch-up bursts when a read is slow.
- Hidden pages perform no external snapshot or background-runtime requests.
- No new filesystem parser, network listener, public exposure, authentication path, notification delivery, or Tailscale configuration is introduced.

## Tests

Every production change starts with a focused failing test.

Gateway tests:

- `getThreadDetail(threadId, signal)` forwards the exact signal to the RPC fetch;
- abort rejection follows the existing normalized error behavior and does not weaken other RPC callers.

Desktop-state tests with fake timers and deferred promises:

- a running external snapshot replaces `Thinking` with the latest visible summary;
- multiple summary parts use the latest paragraph and strip only matching outer bold markers;
- no summary retains the `Thinking` fallback;
- newly persisted agent output appears without page reload and updates by stable ID without duplication;
- command, plan, and file-change snapshot items continue through existing normalization/merge paths;
- an idle response applies final output before clearing the overlay and external lease;
- one request is in flight and the next starts 2,000 ms after settlement;
- hidden visibility aborts the request and sends no new snapshot or background requests;
- visible visibility schedules an immediate fresh snapshot;
- stale results after selection, ownership, generation, or stop changes cannot mutate messages or summary;
- `unknown` and request failure retain the last confirmed output and detailed summary;
- external work remains non-interruptible and never receives a local active-turn lease;
- active external reasoning is shown in the overlay without duplicate transcript rendering, then becomes historical after completion.

Component tests verify that the overlay renders the detailed summary label and the existing mobile layout does not regress.

## Acceptance

After review, merge, installation, and service restart:

1. Start a desktop Codex task that emits multiple reasoning summaries and commentary messages.
2. Open that thread in mobile Chrome at 390×844.
3. Confirm `Thinking` changes to the desktop-visible summary within one settled polling cycle.
4. Confirm new commentary/output appears without reload and does not duplicate.
5. Put the browser in the background for more than one cycle and confirm no snapshot or batch runtime requests are sent.
6. Return to the foreground and confirm one immediate refresh catches up the summary and output.
7. Complete the desktop task and confirm the final output appears before the running overlay disappears.
8. Repeat at 768×1024 and confirm light/dark rendering remains readable.

Retain sanitized request-count, DOM-state, and screenshot evidence under `/tmp`.

## Non-goals

- Sub-second cross-process streaming.
- Showing reasoning summaries in sidebar rows.
- Exposing hidden chain-of-thought content.
- Changing local-turn live notifications, interrupt semantics, authentication, Tailscale Serve, completion notifications, or ntfy behavior.
