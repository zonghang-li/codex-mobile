# Top-Level ntfy Notifications Design

Date: 2026-07-15
Status: Approved for implementation planning
Branch: `codex/filter-subagent-ntfy`

## Problem

`codex-mobile-safe` currently treats every same-user Codex turn as eligible for
long-task notification. This includes review agents, spawned workers, compact
agents, and other subagent rollouts. A child turn can finish while its parent
conversation is still running, so its authoritative terminal event produces a
premature ntfy notification whose body contains an internal worker report
instead of the parent conversation's final answer.

Production state confirms that this is not network retry behavior: successful
deliveries span many distinct thread IDs, while the durable pending queue is
empty. Current Codex metadata provides an authoritative hierarchy boundary:
subagent rollouts have `parent_thread_id` and a `source.subagent` object, while
interactive top-level rollouts have no parent and use an interactive source
such as `vscode`.

## Notification Eligibility

A notification is eligible only when all of these conditions hold:

- the turn belongs to a verified top-level thread;
- the turn has an authoritative `task_complete` or `turn_aborted` event;
- its authoritative duration, or the persisted start-to-terminal duration, is
  at least `600_000` milliseconds;
- the `(threadId, turnId)` pair has not already been delivered or queued.

Top-level sources supported by this design are `cli`, `vscode`, `exec`, and
`appServer`. A thread is a child and is never eligible when either its parent
thread ID is a non-empty string or its source is a `subagent`/`subAgent`
variant. Custom, unknown, malformed, missing, or contradictory classification
data is inconclusive and must not send a notification.

Failed classification is deliberately fail-closed: a legitimate notification
may be missed when thread metadata cannot be read, but a subagent notification
must not be guessed to be top-level.

## Architecture

Use two independent gates around the existing notifier.

### Rollout source gate

`parseRolloutRecord()` will retain the session hierarchy metadata needed by
the external monitor. Its session result will include a notification scope of
`topLevel`, `child`, or `unknown`, derived only from `parent_thread_id` and the
session source.

`ExternalTurnMonitor` will store that scope on each rollout cursor. It will
emit lifecycle events only for `topLevel` cursors. Child and unknown cursors
may still be tracked for safe append scanning, but their start and terminal
records never enter notifier state.

### Unified send gate

Direct app-server notifications do not carry thread hierarchy in
`turn/started` or `turn/completed`, so `NtfyCompletionNotifier` will verify the
thread immediately before creating a pending notification. It will reuse the
existing `thread/read` result that is already fetched for the final assistant
summary.

The verifier reads both camel-case and snake-case forms of the parent field and
recognizes both v2 `subAgent` and rollout `subagent` source objects. It sends
only for a recognized top-level interactive source with no parent. Child or
inconclusive results persist removal of the completed active record and return
without creating a pending record or calling ntfy.

The unified gate applies to both direct and externally observed terminal
events. This is intentional defense in depth: source filtering limits state
growth, while send-time verification protects against incomplete or future
event producers.

## Message Content

After top-level verification, the notifier extracts the latest non-empty
`agentMessage` from the matching top-level turn, strips Markdown presentation,
normalizes whitespace, selects the first sentence, and keeps the existing
180-character limit. It never reads a child turn to construct a parent message.

If the verified top-level turn has no final assistant text, the notification
uses the existing clear status fallback (`任务已完成。`, `任务执行失败。`, or
`任务已中断。`). Titles and status classification remain unchanged.

## Existing Durable State

No destructive state migration is required. Previously persisted child active
records remain bounded by the existing 256-record limit. When a matching child
terminal arrives, the unified send gate verifies the thread, removes that
active record, and sends nothing. Records with no later terminal remain inert
and are eventually displaced by the bounded-state policy.

Existing `sent` records remain valid deduplication history. Existing `pending`
records are not reclassified because they represent notifications already
prepared by an older process; deployment must first confirm the pending queue
is empty. If it is not empty, deployment stops and reports the condition rather
than sending or deleting ambiguous records.

## Failure Handling and Safety

- A `thread/read` error, malformed response, unknown source, missing hierarchy
  evidence, or conflicting source/parent evidence suppresses the notification.
- Suppression removes only the matching completed active record. It does not
  modify unrelated active, pending, or sent records.
- Warnings remain redacted and never include thread IDs, turn IDs, rollout
  paths, prompts, responses, ntfy URLs, or notification bodies.
- No new HTTP route, inbound listener, authentication mode, public tunnel, LAN
  binding, or Tailscale exposure is added.
- The backend remains on `127.0.0.1:5900` behind Tailnet-only Tailscale Serve.

## Tests and Acceptance

Automated tests must prove:

- rollout session metadata classifies a parentless `vscode`/`cli` session as
  top-level;
- non-empty `parent_thread_id` or a subagent source classifies as child;
- malformed, custom, unknown, contradictory, or missing evidence classifies as
  unknown;
- the external monitor emits no lifecycle for child or unknown rollouts;
- a direct long-running child turn is removed from active state without thread
  summary extraction, pending creation, or ntfy delivery;
- a send-time `thread/read` error or ambiguous thread response suppresses
  delivery and removes only the matching active record;
- an old persisted child active record is silently removed when its terminal
  event arrives;
- a verified top-level turn of exactly `600_000` milliseconds sends once with
  the matching top-level final assistant summary;
- duplicate direct and external observations of that top-level turn still send
  once;
- short top-level turns remain suppressed by the existing threshold.

Before deployment, the complete unit suite, frontend and server type checks,
production build, and `codex-mobile-safe doctor` must pass. After deployment,
verify the service is active, port 5900 listens only on `127.0.0.1`, Tailscale
Serve reports `tailnet only`, and the durable ntfy pending count is zero.

Manual acceptance starts one top-level task longer than 10 minutes with one or
more subagents. Completing subagents while the parent remains active produces
no notification. The single parent terminal produces one understandable
notification based on the parent's final answer.

## Rollback

Rollback reverts the parser, monitor, notifier, tests, and Agent Guide changes
as one feature series. No schema migration or inbound exposure change is
required. Durable state remains valid because its on-disk shape is unchanged.
