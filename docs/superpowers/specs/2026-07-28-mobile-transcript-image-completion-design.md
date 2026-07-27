# Mobile Transcript, Image, and Completion State Design

## Scope

This design fixes three related mobile conversation-page failures:

1. User-uploaded images render as broken thumbnails.
2. A long active turn loses most commentary and reasoning because the current
   240-item projection drops earlier visible text.
3. The composer can keep showing Stop after the matching turn has completed.

The change is limited to the current conversation page and its supporting
server APIs. It does not change model-generated image behavior, Markdown image
semantics, completed-turn reasoning visibility, or Codex session files.

## User-visible behavior

### User-uploaded images

- User-uploaded images are represented as attachment text in the user message,
  using `@<filename>` when a filename is available.
- The conversation transcript must not create an `<img>` element for a
  user-uploaded image.
- The original attachment target remains available to the turn submission
  pipeline. Removing the thumbnail must not remove the image from the request
  sent to Codex.

### Other image sources

- Model-generated images and explicit `imageView` results continue to render as
  images.
- Markdown images in assistant output continue to render as images.
- If either image class fails to load, the broken `<img>` is replaced by a
  text link to the original target. The UI must not leave a browser broken-image
  glyph.

### Active-turn transcript

- Every assistant commentary message and every visible reasoning summary from
  the active turn remains reachable in original session order.
- New snapshots append or update items by stable identity; they never replace
  earlier pages from the same turn.
- The newest page is displayed first so the conversation becomes interactive
  quickly.
- Earlier text pages load independently from raw tool payloads. Loading earlier
  pages must not require transferring the full rollout JSONL.
- Completed and historical turns retain the existing rule: reasoning is folded
  or omitted according to the completed-turn presentation, while normal user
  and assistant body text remains available.

### Completion state

- A `turn/completed` notification whose thread ID and turn ID match the current
  active lease is authoritative, including when the thread is currently marked
  as externally owned.
- The matching notification immediately clears `inProgress`, removes the
  active turn ID, clears transient command/reasoning state, and switches the
  composer from Stop to Send.
- A completion for another or stale turn must not clear the active lease.
- External runtime polling remains the fallback when no completion notification
  is observed.

## Architecture

### 1. Image presentation policy

Add one source-aware presentation decision at normalization/rendering time:

- `userMessage` image inputs retain submission metadata but expose an attachment
  label instead of transcript `images`.
- `imageView`, image generation, and Markdown-image blocks retain image URLs.

The renderer uses a shared failed-image fallback component for non-user images.
On `error`, it removes the image node from presentation and shows a link with a
stable label. This keeps working images visible while eliminating broken-image
placeholders.

### 2. Text-only active-turn paging

Add a server endpoint dedicated to visible active-turn text:

`GET /codex-api/thread-text-page?threadId=<id>&turnId=<id>&cursor=<opaque>&limit=<n>`

The endpoint reads the rollout JSONL incrementally and returns only supported
display records:

- assistant commentary/final text,
- visible reasoning summaries,
- context-compaction status,
- lightweight activity labels required to preserve ordering.

It must not include command output, function arguments/results, MCP payloads,
binary data, base64 data, or world-state snapshots.

Response shape:

```ts
type ThreadTextPage = {
  threadId: string
  turnId: string
  items: ThreadTextItem[]
  nextOlderCursor: string | null
  hasMoreOlder: boolean
}
```

Each `ThreadTextItem` contains a deterministic identity derived from the rollout
record position plus its normalized message type. The cursor is opaque to the
browser and scoped to the selected thread and turn.

The initial live-state response stays bounded. When it reports
`rawItemCompression.omittedItemCount > 0` for the active turn, the client starts
text-page hydration:

1. Fetch the newest text page.
2. Merge it with the live projection by stable ID.
3. Fetch older pages without blocking the first render.
4. Prepend older records in session order.
5. Stop at `hasMoreOlder=false`, turn completion, thread change, or document
   backgrounding.

Only the active turn receives this text hydration. Raw activity remains bounded.
Requests are abortable and deduplicated per thread/turn/cursor.

### 3. Completion reconciliation

Replace the blanket “externally owned means ignore completion” rule with
identity-based ownership:

- If a completion's turn ID equals `activeTurnIdByThreadId[threadId]`, it owns
  that active lease and may finish it.
- If it does not match, preserve the current lease and schedule reconciliation.

The existing completion disposition still decides retry/error/unread behavior.
Only the ownership check changes. The subsequent notification-driven sync
refreshes persisted messages and thread-list metadata.

## Data flow

1. A live-state response supplies the newest bounded turn projection and
   compression metadata.
2. The client renders it immediately.
3. When active-turn text was omitted, the client requests text-only pages.
4. Text pages merge with the current message list by deterministic identity and
   absolute rollout order.
5. New live-state snapshots update current items without deleting hydrated
   earlier text.
6. A matching completion notification closes the active lease immediately.
7. The completed refresh applies existing historical reasoning presentation.

## Error handling

- Missing or unreadable rollout files return a structured 404/409 response;
  the bounded live transcript remains usable.
- Invalid or cross-thread cursors return 400 and are never silently reused.
- A failed text-page request is retryable on the next foreground poll and does
  not clear already hydrated items.
- Thread switches and background visibility abort outstanding text-page reads.
- Failed generated/Markdown images display a link fallback.
- Failed user-upload image display is impossible because no user attachment
  thumbnail node is created.

## Performance constraints

- Text pages default to 300 records and have a bounded serialized byte size.
- JSONL parsing is incremental and cursor-based; the server does not parse or
  serialize the entire 101 MB rollout for every poll.
- Raw tool payloads never enter the text-page response.
- The newest live page remains the critical path. Older text hydration runs
  after the first usable render.
- Repeated live polls use projection keys and do not restart completed text
  pagination.

## Verification

Tests must prove:

1. A user message with an uploaded image renders an `@filename` attachment and
   no `<img>`.
2. `imageView`, generated images, and valid Markdown images still render.
3. Failed non-user images switch to a text link and remove the broken preview.
4. Multiple text pages reconstruct commentary/reasoning in rollout order with
   no duplicates or omissions.
5. A newer bounded live snapshot cannot delete hydrated active-turn text.
6. Historical turns do not gain reasoning visibility.
7. A matching external `turn/completed` immediately changes the composer from
   Stop to Send.
8. A stale completion leaves the current active turn running.
9. Existing unit tests, production type checking/build, service health, and a
   real long-running thread smoke test pass before deployment is reported.
