# Mobile Immediate Stop and Upload Lifecycle Design

## Objective

Make a submitted mobile turn behave as an irreversible running operation:

- a sent user message cannot be edited or rolled back from the transcript;
- the composer enters the running state immediately after submit;
- Stop is visible and actionable immediately, even before Codex returns a turn ID;
- a user-uploaded image remains readable until Codex has accepted it or the final send attempt fails.

Queued messages that have not been sent remain outside this scope. Existing
external-thread ownership rules also remain unchanged: mobile cannot interrupt a
turn owned by another client.

## Confirmed Current Behavior

- `ThreadConversation` derives an editable turn ID for every persisted user
  message and emits `rollback` through the `Edit message` toolbar action.
- Existing-thread sends append an optimistic user message and set local running
  state before `turn/start`, but interrupt currently requires an active turn ID.
- New-thread sends also use a persistence gate that temporarily disables Stop.
- Managed uploads use a capability-backed lease. The composer transfers that
  lease into the pending-turn request, and terminal or failed paths release it.
  The missing-image report shows that this lifetime must be verified across every
  asynchronous boundary instead of assuming that transfer always happens before
  cleanup.

## Design

### 1. Sent messages are immutable

- Remove the `Edit message` action from user-message toolbars.
- Remove the conversation-level rollback event and handler used exclusively by
  that action.
- Do not copy a historical prompt back into the composer.
- The supported correction workflow is: stop the active task if necessary, then
  send a new message.
- Queue editing remains available because a queued row has not yet been sent to
  Codex.

### 2. Submit immediately owns the running UI

- Submission synchronously appends the optimistic user row, marks the selected
  thread as locally running, and changes the primary composer action to Stop
  before awaiting resume, thread creation, or turn creation.
- The user's optimistic row remains visible while startup is pending.
- Model output reconciliation replaces optimistic state without creating a
  duplicate user row.
- A startup failure removes the optimistic running state, restores the composer
  to idle, preserves a visible error, and releases unsent managed uploads.

### 3. Stop intent may precede the turn ID

Introduce a per-submission stop latch.

- Clicking Stop records a stop request immediately and disables repeated clicks.
- If no turn-start RPC has been issued yet, subsequent startup checkpoints skip
  starting the turn and settle the optimistic submission as interrupted.
- If `turn/start` is already in flight, the returned turn ID is captured and
  `turn/interrupt` is sent immediately before normal notification
  reconciliation.
- If a `turn/started` notification arrives before the start RPC returns, it also
  consumes the same stop latch and interrupts that turn exactly once.
- The latch is cleared on terminal completion, definitive startup failure,
  thread removal, or state reset.
- Existing external ownership checks remain authoritative; a different
  client's turn never becomes locally interruptible.

This avoids cancelling only the browser request while accidentally leaving a
server-side turn running.

### 4. Managed upload ownership is explicit

Treat each managed upload as moving through these ownership states:

1. **Composer-owned** after upload succeeds.
2. **Submission-owned** synchronously when submit accepts the draft.
3. **Pending-turn-owned** before the first asynchronous resume/start boundary.
4. **Released** only after Codex has accepted the input, the user removes the
   unsent attachment, or the final send attempt fails or is cancelled before
   acceptance.

Implementation requirements:

- Transfer the upload lease at the synchronous submit boundary, before clearing
  composer state or awaiting thread/resume/thread/start.
- Preserve the capability through unsupported-model fallback and immediate-stop
  races until it is known whether a turn accepted the attachment.
- Cleanup remains idempotent.
- Add lifecycle diagnostics only at ownership transitions and failures; do not
  log file contents or capability secrets.
- The one-hour server reaper stays as a final orphan safeguard, not the normal
  successful-send cleanup path.
- User images continue to render as `@filename` tokens without previews.

## Error Handling

- A Stop click without a turn ID is a valid pending operation, not an error.
- If interruption fails after a turn ID exists, restore the Stop action and show
  the existing turn error so the user can retry.
- If startup fails before Codex accepts the attachment, return to idle and
  delete the managed upload.
- If Codex accepted the turn, cleanup must not race ahead of input ingestion.
- Stale stop latches are scoped by thread and submission generation so they
  cannot interrupt a later turn.

## Test Strategy

All implementation follows red-green-refactor.

### Conversation actions

- No persisted user message renders `Edit message`.
- `ThreadConversation` no longer emits rollback for user rows.
- Copy and Fork behavior for completed assistant responses is unchanged.

### Immediate running and Stop

- Existing-thread submit synchronously exposes an enabled Stop action.
- New-thread submit exposes running/Stop state without waiting for the first
  model output.
- Clicking Stop before a turn ID records intent and later interrupts the exact
  returned turn ID once.
- A `turn/started` notification can satisfy the pending stop before the RPC
  resolves.
- A cancelled pre-start submission does not launch a turn.
- Startup failure returns to idle and removes the optimistic row.
- External turns remain visibly running but non-interruptible.

### Upload lifecycle

- Submit transfers upload ownership before the first awaited startup operation.
- Immediate Stop before acceptance cleans the upload.
- Immediate Stop after acceptance waits for safe terminal cleanup.
- Unsupported-model fallback retains the same upload through the retry.
- Final failure and draft discard clean exactly once.
- Successful image input remains readable while Codex consumes it.

### Verification

- Focused conversation, composer-control, desktop-state, gateway, and managed
  upload tests.
- Full unit suite and production build.
- Redeploy `codex-mobile-safe`, verify status, then manually exercise submit and
  immediate Stop on an existing thread and a new thread.

## Non-goals

- Restoring sent-message editing through a different UI.
- Interrupting Desktop-owned or otherwise externally owned turns.
- Persisting user image previews or temporary paths in local draft storage.
- Changing queue editing semantics.
