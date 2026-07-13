# ntfy Long-Task Completion Notifications Design

## Goal

Send a lock-screen ntfy notification when a Codex turn runs for at least ten minutes. Successful, failed, and interrupted turns all notify. Shorter turns never notify.

The notification contains one concise sentence derived from the final assistant response, not the full conversation. Delivery must work when the mobile browser is closed or suspended because it is performed by the Linux service, not the browser.

## User-visible behavior

- Threshold: elapsed time greater than or equal to `600_000` milliseconds.
- Success title: `Codex 任务完成`.
- Failure title: `Codex 任务失败`.
- Interrupted/cancelled title: `Codex 任务已中断`.
- Body: the first non-empty sentence from the final assistant response, with whitespace collapsed and a maximum of 180 characters.
- Fallback body when no assistant response exists: a short fixed sentence matching the final status.
- The phone decides whether the notification rings, vibrates, remains silent, or is suppressed by Focus/Do Not Disturb.
- Each `threadId + turnId` pair is treated as one logical notification. Local pending/sent state suppresses ordinary duplicates, and every retry uses the same deterministic ntfy sequence ID so supported clients replace the prior notification instead of displaying an unrelated one.

## Architecture

### Explicit safe-mode configuration

`codex-mobile-safe` looks for an optional secret file at:

```text
~/.codex/codex-mobile-safe-ntfy-url
```

The file contains one publish URL of the form `https://ntfy.sh/<unguessable-topic>`. It must be a regular file owned by the current user with mode `0600` or stricter. A `--ntfy-url-file <path>` option may override the default location. If the default file is absent and no override is supplied, notifications are disabled without affecting startup.

The URL, topic, and response body must never be written to Git, the systemd unit, process arguments, managed state logs, or error logs. This first version accepts only the `https://ntfy.sh` origin, a single non-empty path segment, and no username, password, query, or fragment. Supporting arbitrary self-hosted origins is outside scope.

This is a separate explicit outbound-only safe feature. It does not enable Telegram, Composio, background skill sync, incoming webhooks, remote commands, or Tailscale authentication bypasses.

### Completion notifier

A focused server module owns:

- extracting thread IDs, turn IDs, and final status from `turn/started` and `turn/completed` notifications;
- recording wall-clock start time when `turn/started` arrives;
- calculating elapsed time on `turn/completed`;
- reading the latest assistant response only after the ten-minute threshold is met;
- producing the fixed title and one-sentence body;
- queueing and sending an ntfy POST request with an RFC 2047 ASCII-encoded title header and deterministic `X-Sequence-ID`;
- deduplicating completed turns.

The shared bridge accepts the notifier as an optional dependency and forwards app-server notifications to it. The original `codex-mobile` command does not enable it by default. The safe command enables it only when a valid secret URL file is present.

No additional AI request is made to summarize text. Summary extraction is deterministic: strip markup that would make a notification unreadable, collapse whitespace, take the first sentence when possible, and truncate safely to 180 characters.

### Durable state and retry

Notifier state is stored under the existing safe home, in a mode-`0600` JSON file. It contains only:

- active `{ threadId, turnId, startedAt }` records;
- bounded sent turn keys for deduplication;
- bounded pending notification records without conversation history.

The state never contains the ntfy URL or topic. Active timing survives service restarts. Completed pending notifications survive restart until accepted by ntfy.

Sending is asynchronous and does not block or fail the Codex turn. Each delivery uses a five-second request timeout and at most three immediate attempts. A failed record remains in the bounded durable outbox and is retried on notifier startup and the next notification event. The outbox and sent-key history are each capped at 256 records, evicting the oldest record first, so failure cannot create unbounded state or retry fanout.

For each pending key, the sender derives the same bounded ASCII sequence ID from `threadId + turnId` and includes it as `X-Sequence-ID` on every attempt and post-restart retry. ntfy documents sequence IDs as a client-side notification update mechanism: the server remains append-only, while supported clients replace an earlier notification in the same sequence. This combines local sent-state deduplication with logical client replacement; it is not a transport-level exactly-once transaction. An ambiguous timeout, or a process crash after ntfy accepts the POST but before local sent state is committed, can still publish another append-only event and may re-alert on a client depending on timing and platform behavior. See the [ntfy publish documentation](https://docs.ntfy.sh/publish/#updating-notifications).

## Event and status handling

`turn/started` starts timing only when both thread ID and turn ID are present. Duplicate start events retain the earliest timestamp.

`turn/completed` behavior:

1. Ignore duplicate sent turn keys.
2. Look up and remove the matching active record.
3. If no start record exists, do not guess duration and do not notify.
4. If elapsed time is below ten minutes, persist the removal and stop.
5. Classify `turn.status === "failed"` as failed, `"completed"` as successful, and every other terminal status as interrupted.
6. Build and durably enqueue one notification before attempting network delivery.

Malformed and unrelated notifications are ignored. State corruption is reported without secrets and recovered by starting with an empty bounded state; it must never prevent Codex UI startup.

## Tests

Automated tests cover:

- 9 minutes 59.999 seconds does not notify;
- exactly 10 minutes notifies;
- successful, failed, and interrupted titles/fallback bodies;
- RFC 2047 ASCII title headers and deterministic, distinct, bounded ASCII sequence IDs in the real default request path;
- deterministic first-sentence extraction and 180-character truncation;
- duplicate started/completed events;
- missing IDs and missing start state;
- mode/owner validation and strict ntfy URL validation;
- active timing and pending delivery surviving a reconstructed notifier;
- five-second timeout, three immediate attempts, durable retry, and bounded state;
- safe CLI/default-file wiring without exposing the URL in process arguments or systemd;
- original CLI behavior remains unchanged.

The relevant manual test verifies a synthetic threshold configuration or fake clock, one real ntfy delivery to a phone, successful lock-screen alert, no conversation-body leakage beyond the derived sentence, and no notification for a short task.

## Performance and security audit

Disabled configuration adds no notification listener or network work. Enabled configuration performs constant-time map operations for start events. Thread reading and network delivery occur only for turns that reach ten minutes. State and retry queues are strictly bounded to 256 records. No polling loop, extra browser request, frontend bundle, or render work is added.

The implementation must be checked for secret redaction, SSRF prevention, local duplicate suppression, stable ntfy sequence IDs, ambiguous-delivery behavior, unbounded retries, service restart behavior, and notification work accidentally delaying app-server event handling. Verification must not describe this append-only network workflow as atomic exactly-once delivery.
