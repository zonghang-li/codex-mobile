# Mobile Reliability and Conversation Controls Design

## Objective

Make the mobile conversation page remain responsive and accurate while a Codex Desktop task is running, remove misleading or redundant controls, and align the remaining activity UI with Codex Desktop.

The change covers:

- full-history live synchronization with server-side historical reasoning pruning during automatic context compaction;
- read-only observation of Desktop-owned tasks without importing Desktop-only dynamic tools;
- image attachments rendered as `@filename` text rather than previews;
- a single active-turn file-change footer;
- transparent subagent status chips;
- removal of the fixed `Approve for me` composer label;
- a functional, persistent Goal control;
- removal of the standalone `You stopped` transcript line.

## Confirmed Root Causes

### Full-turn polling stalls the browser

The external-runtime poll previously requested a complete multi-turn snapshot every second. A captured production request reached 21.2 MB during automatic compaction. The mobile browser repeatedly parsed, normalized, diffed, and rendered large completed turns even though only the active turn can change.

### Read operations resume Desktop-owned tasks

The first detail load calls `thread/resume` before external ownership is authoritative. A Desktop task can carry client-only dynamic tools such as `codex_app/list_threads`; resuming that task in the mobile app-server imports the contract without importing the Desktop dispatcher. The resulting `item/tool/call` is not an approval and cannot be solved by `approval_policy=never`.

### Image upload and safe path policy disagree

The upload handler stores files under `/tmp/codex-web-uploads`, while safe-mode image reads allow only configured project roots. The upload succeeds and the preview request returns 403. Persisting preview URLs in drafts also retains data that the user does not want displayed.

### Active file changes have two render owners

`ThreadConversation` attaches a synthetic file-change summary to the assistant response, while `ConversationRunFooter` renders the same active-turn changes above the composer. Raw active file-change rows are hidden, but the synthetic anchored summary is not.

### Safe mode blocks native Goal RPCs

Codex CLI 0.144.1 reports the stable `goals` feature as enabled, and a direct initialized app-server probe returned a valid `thread/goal/get` response. The mobile UI already calls `thread/goal/get`, `thread/goal/set`, and `thread/goal/clear`, but safe mode rejects all three before they reach app-server. The composer also incorrectly ties Goal availability to idle-only model-configuration editing.

### Cosmetic mismatches

The subagent chip currently has a gray fill. The composer always renders `Approve for me` even though the safe service fixes approval policy at startup. Interrupted turns create a synthetic `You stopped` transcript boundary that Codex Desktop does not show.

## Design

### 1. Full-history external live synchronization with historical reasoning/progress pruning

- Initial thread detail contains every turn, not only a recent window.
- Server responses remove `reasoning` items from every non-running turn so historical loads keep user/assistant body content without replaying old thinking summaries.
- Completed historical turns render only their final assistant reply by default; earlier assistant progress messages from the same turn are treated as process output, not user-visible final body.
- The latest running turn keeps its reasoning items; when an external writer owns the thread, the runtime active turn ID is authoritative for that exception.
- If thread-level state says the task is still running, the last turn keeps intermediate assistant progress even when its per-turn status is stale.
- External live-state responses use the same full-history/pruned-reasoning shape plus absolute turn index, runtime ownership, active turn ID, and completion metadata.
- The client reconciles live-state into the already-loaded history with `preserveMissing: true`; older visible turns are not removed.
- Polling remains approximately one second while the page is visible so new output remains timely.
- Polling pauses while the document is hidden and resumes immediately when visible.
- A context-compaction item is treated as ordinary active-turn activity; it does not trigger an extra full-history reload.
- Completion performs one terminal reconciliation, releases the external runtime lease, and re-enables local controls without a manual refresh.

This preserves full conversation context while keeping expensive reasoning/progress presentation proportional to the active turn. Repeated live-state polls still rely on projection keys and cached not-modified responses to avoid resending unchanged history.

### 2. Read without ownership takeover

- Selecting or refreshing any existing thread uses `thread/read`, never `thread/resume`.
- Immediately before a user-originated local `turn/start`, the server checks runtime ownership again.
- `thread/resume` is allowed only when the task is idle and the user is actually starting a local turn.
- The server retains a defense-in-depth resume guard: a Desktop-owned running task converts a requested resume into a read.
- Requests scoped to an externally owned app-server are never answered from the mobile process.
- Raw `item/tool/call` requests are not rendered as approvals.
- An unsupported same-process dynamic tool is returned as an explicit failure; it is never returned as `Success (Empty)`.
- Unknown, stale, or reused request IDs produce no response.

An actively running Desktop-owned task remains non-interruptible and non-sendable from the separate mobile app-server, but the page stays responsive, streams output, permits navigation, and releases read-only state promptly at completion.

### 3. Text-only image attachment presentation

- Selecting an image creates a compact text attachment token labeled `@<filename>`.
- The composer and transcript never render an `<img>` preview for a user-uploaded image.
- Image URLs are not persisted in local draft storage.
- The attachment remains a real multimodal input: the service keeps only the temporary upload needed for the active send, hands its path to Codex, and removes it when the attachment is removed, the draft is discarded, the send fails, or the turn has accepted the input.
- Temporary uploads use a server-owned directory and opaque attachment identity. General `/tmp` access is never enabled.
- Assistant-generated images and explicit image-view activity keep their existing preview behavior; this requirement applies only to user-uploaded composer attachments.
- On refresh, a pending image attachment is not restored. The text draft remains restorable.

### 4. One file-change summary and correct response actions

- The active turn renders file-change count and line totals only in `ConversationRunFooter`, directly above the composer.
- `ThreadConversation` suppresses the synthetic anchored summary when its `turnId` equals `activeTurnId`.
- Historical completed turns retain their anchored file-change summaries.
- Fork and Copy remain directly below the final assistant response, above historical summaries and outside the bottom run footer.

### 5. Subagent status visual parity

- Subagent status remains non-interactive.
- Each agent is a compact rounded pill with a one-pixel low-contrast border and fully transparent background in both themes.
- The icon uses a stable per-agent accent from the existing green, purple, and pink palette; no filled card or gray background is used.
- The label truncates on narrow screens.
- The aggregate status such as `started working` or `finished` is plain muted text immediately to the right of the chip group.
- The implementation uses the existing icon component system and does not create CSS-drawn or emoji assets.

### 6. Remove the fixed approval label

- The composer does not render `Approve for me`.
- Approval policy remains fixed by the service startup configuration and is not made user-editable in the conversation page.
- Genuine request-for-input and supported approval surfaces remain available when the protocol sends them; removing the label does not auto-approve or fabricate tool results.

### 7. Functional Goal control

Goal uses Codex app-server's native stable goal capability.

- Supported statuses remain `active`, `paused`, `blocked`, `usageLimited`, `budgetLimited`, and `complete`.
- The safe allowlist adds exactly `thread/goal/get`, `thread/goal/set`, and `thread/goal/clear`; no wildcard or raw RPC access is enabled.
- The existing gateway and state composable continue to normalize native goal responses and notifications.
- Creating a goal requires a non-empty objective.
- Native app-server owns time accumulation, token usage, persistence, and state transitions.
- Goal metadata can be read or changed while a Desktop-owned task is running because the goal RPC does not resume, interrupt, or mutate the active turn.
- The composer Goal button is enabled whenever a thread is selected and no goal mutation is in flight; it is not tied to model configuration editability or runtime ownership.
- The bottom goal strip exposes objective, elapsed time, edit, pause/resume, complete, blocked, and clear actions using the existing compact Codex Desktop-style treatment.
- Invalid or unsupported native responses fail closed for that thread without disabling other conversations.

### 8. Remove `You stopped`

- Interrupted-turn metadata remains available for runtime state, notification suppression, and completion bookkeeping.
- The synthetic `You stopped` completion-boundary message is not added to the visible transcript.
- Stopping a turn restores the composer and changes runtime status without inserting a standalone line.
- Completed turns continue to use the existing `Worked for …` fold; failure messages remain visible when they contain an actionable error.

## Error Handling

- A failed external live poll retains the last confirmed snapshot and retries without marking the task complete.
- A failed attachment handoff keeps the `@filename` token and shows an attachment error; successful cleanup is idempotent.
- Goal mutation failures keep the prior goal and show the existing visible error channel.
- Failure to read a native goal yields no goal for that thread and does not prevent thread loading.
- A dynamic tool request that cannot be executed is explicitly failed by its owning local bridge; external requests are ignored, not answered.

## Test Strategy

All production changes follow red-green-refactor.

### Live sync and ownership

- Initial detail includes all turns with historical reasoning pruned and completed-turn assistant progress hidden from the default transcript.
- External live state includes all turns with historical reasoning pruned and the correct absolute index.
- Existing visible turns survive active-turn reconciliation.
- Context compaction does not trigger a full history request.
- Existing-thread selection performs zero `thread/resume` calls.
- An idle user send performs the required resume/start path.
- External ownership races are caught by the server guard.

### Dynamic tools

- External `item/tool/call` never reaches the pending-response UI and sends zero responses.
- Unknown or reused IDs send zero responses.
- Unsupported local dynamic tools return explicit failure, never empty success.

### Attachments

- Image selection renders `@filename` and no `<img>`.
- Image attachment data is excluded from persisted drafts.
- Removal, failed send, successful handoff, and draft discard each clean the temporary attachment.
- Non-image file chips keep their existing behavior.

### Conversation UI

- The active anchored file-change summary is suppressed while the bottom footer remains.
- Historical summaries remain.
- Fork/Copy follow the response.
- Subagent pills have transparent background and bordered compact styling in light and dark themes.
- The composer contains no `Approve for me`.
- Interrupted completion metadata produces no visible `You stopped` row.

### Goal

- Create, read, edit, pause, resume, complete, block, and clear.
- Native goal responses preserve objective, status, elapsed time, token usage, and optional budget fields.
- Safe allowlist coverage, native response schema rejection, and state restoration after service restart.
- Goal controls remain enabled for an externally owned running task.

### Verification

- Focused unit and integration tests for each subsystem.
- Full typecheck, production frontend/CLI build, and complete test suite outside the restricted port-binding sandbox.
- Mobile visual QA at 320, 390, and 430 CSS pixels in light and dark themes.
- Compare the subagent row against the supplied Codex Desktop screenshot at the same content state.
- Confirm the Tailscale service remains loopback-bound and Tailnet-only after redeployment.

## Non-goals

- The mobile process will not execute Desktop-only `codex_app` dynamic tools.
- The mobile process will not interrupt or steer a task owned by a different app-server.
- The conversation page will not expose an approval-policy selector.
- User-uploaded images will not have composer or transcript previews.
- General access to `/tmp` will not be allowed.
