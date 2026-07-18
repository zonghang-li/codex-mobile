# Ntfy Conversation Title Design

## Goal

Make every qualifying long-task ntfy notification identify the completed top-level conversation by name while preserving the existing result classification and final-assistant summary.

The notification title formats are:

- `Codex 任务完成：<会话名称>`
- `Codex 任务失败：<会话名称>`
- `Codex 任务已中断：<会话名称>`

The notification body remains the deterministic first non-empty sentence from the final assistant response, with the existing status-specific fallback when no assistant response exists.

## Name Sources and Precedence

The existing qualifying completion path already performs one top-level `thread/read` with turns. It must continue to reuse that result and must not make an additional Codex RPC or AI request.

Before returning the notifier-only thread read, the bridge reads the existing merged title cache. That cache combines Codex session-index titles with titles persisted by Codex Mobile. The bridge attaches the cached title as a notifier-only `notificationTitle` field on a copied thread object without mutating the original RPC result.

The notifier resolves a conversation name in this order:

1. the bridge-provided `notificationTitle` cached title;
2. a non-empty `name` supplied by `thread/read`;
3. a non-empty `title` supplied by `thread/read`;
4. `未命名会话（<thread ID suffix>）`.

The notifier does not use `preview`, the first user message, the assistant summary, the working directory, or the project name as the conversation name.

The fallback suffix is the last eight Unicode code points of the trimmed thread ID, or the entire ID when it is shorter than eight code points. Since qualifying events already require a non-empty thread ID, the fallback is always non-empty.

## Normalization and Bounds

Conversation names are normalized before persistence or delivery:

- remove C0/C1 control characters;
- collapse all remaining whitespace to one ASCII space;
- trim leading and trailing whitespace;
- truncate to 80 Unicode code points;
- use the unnamed fallback when normalization produces an empty string.

The status prefix remains one of the three existing fixed Chinese result titles. The final ntfy title is the prefix, a full-width colon, and the normalized conversation label.

The body retains its existing 180-code-point bound. No prompt, first user message, ntfy URL, topic, or full thread payload is added to logs.

## Durable State Compatibility

Pending notifications must retain their complete rendered title so retries after restart produce the same user-visible notification.

`PendingNtfyRecord.title` therefore changes from a three-value TypeScript literal union to a validated string. The state loader accepts:

- the three legacy fixed titles, so already-pending notifications remain deliverable;
- a new title whose prefix is exactly one of the three fixed titles followed by `：` and a valid normalized label.

New titles must be non-empty, contain no control characters, and contain no more Unicode code points than the longest fixed status prefix plus the colon plus the 80-code-point label. The state loader continues to reject unknown prefixes, malformed record shapes, and unbounded or unsafe titles. No state migration write is required merely to load an old file.

## Components

### Notifier-only thread enrichment

`src/server/codexAppServerBridge.ts` enriches `middleware.readThreadForNotifier()` results with the merged cached title. The helper returns a copied response/thread object and fails open for title-cache read failure: the notifier can still use a `thread/read` name/title or the ID fallback. Failure to read the actual thread remains fail-closed as today because top-level verification cannot proceed.

### Notification title composition

`src/server/ntfyCompletionNotifier.ts` owns label extraction, normalization, fallback composition, and result-title composition. It uses the same verified top-level thread object already used for hierarchy classification and assistant-summary extraction.

### Durable validation

`src/safe/ntfyState.ts` validates both legacy and new rendered titles while preserving exact-key checks and bounded active, pending, and sent collections.

### Documentation

`README.md` and `docs/AGENT_GUIDE.md` document the new title format, source precedence, fallback, bounds, and the prohibition on using prompt text as a title.

## Error Handling

- Missing or malformed cached titles do not suppress a notification; the notifier falls back through the defined sources.
- A title-cache read failure does not create a warning containing conversation data.
- A failed `thread/read` still suppresses notification delivery and emits only the existing generic warning.
- Old pending records retry with their original fixed title; they are not rewritten opportunistically.
- Delivery retry, stable sequence IDs, duration threshold, top-level-only filtering, and notification deduplication are unchanged.

## Tests

Automated tests cover:

1. cached title enrichment without mutation;
2. cached title precedence over `thread/read` name/title;
3. all three result prefixes with conversation labels;
4. missing-name fallback to the last eight thread-ID code points;
5. control-character removal, whitespace collapse, empty-name fallback, and 80-code-point truncation;
6. unchanged final-assistant body summary and fallback behavior;
7. acceptance of legacy pending titles after restart;
8. acceptance of valid new rendered titles and rejection of malformed, unsafe, or overlong titles;
9. no extra Codex RPC or AI request.

The focused notifier, state, and bridge tests run first, followed by the complete unit suite and production build. Deployment acceptance confirms `codex-mobile-safe doctor`, loopback-only port 5900, the unchanged tailnet-only Tailscale Serve mapping, and one test notification whose title visibly names the conversation.

## Out of Scope

- Changing the ten-minute notification threshold.
- Including detailed task content in the ntfy title.
- Changing ntfy topic configuration, sound, vibration, priority, tags, or sequence IDs.
- Sending notifications for child/subagent turns.
- Adding a user-configurable title template.
