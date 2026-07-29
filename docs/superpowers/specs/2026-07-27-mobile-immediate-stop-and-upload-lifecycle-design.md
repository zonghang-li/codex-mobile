# Mobile Immediate Stop and Upload Lifecycle Design

## Objective

Make a submitted mobile turn behave as an irreversible running operation:

- a sent user message cannot be edited or rolled back from the transcript;
- a submitted user row remains visible continuously until its persisted echo
  replaces it;
- the composer enters the running state immediately after submit;
- Stop is visible and actionable immediately, even before Codex returns a turn ID;
- while a turn is running, new composer content changes the primary action from
  Stop to Send and always adds that message to the queue;
- terminal state immediately restores the idle Send action when no queued turn
  has started;
- a user-uploaded image remains readable until Codex has accepted it or the final send attempt fails.

Editing or reordering queued messages that have not yet been sent remains
unchanged. Existing external-thread ownership rules also remain unchanged:
mobile cannot interrupt a turn owned by another client.

## Confirmed Current Behavior

- `ThreadConversation` derives an editable turn ID for every persisted user
  message and emits `rollback` through the `Edit message` toolbar action.
- Existing-thread sends append an optimistic user message and set local running
  state before `turn/start`, but interrupt currently requires an active turn ID.
- New-thread sends also use a persistence gate that temporarily disables Stop.
- Optimistic messages currently live inside the persisted-message array. Detail
  and live-projection reconciliation can therefore replace the whole render
  source before the server has returned the user row.
- Composer control derivation always prefers Stop for a running turn, even when
  the draft contains a new message.
- A completion whose turn ID differs from the cached active turn ID is treated
  as stale and keeps the thread running without immediately confirming whether
  the backend is actually idle.
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

- Submission synchronously appends a record to a dedicated optimistic-submission
  layer, marks the selected thread as locally running, and changes the primary
  composer action to Stop before awaiting resume, thread creation, or turn
  creation.
- The optimistic layer is rendered after persisted conversation messages and is
  not an input to detail-snapshot replacement.
- Each optimistic row has a submission generation and normalized content
  fingerprint covering text, images, files, and skills.
- Detail/live reconciliation removes an optimistic row only after an equivalent
  persisted user row is present. The persisted row replaces it in the same
  render pass so there is no blank frame or duplicate.
- Agent output, activity events, polling, and route-driven detail loads cannot
  remove an unacknowledged optimistic row.
- A startup failure removes the optimistic running state, restores the composer
  to idle, preserves a visible error, and releases unsent managed uploads.

### 3. Running drafts submit to the queue

- When a local turn is running and the composer has no sendable content, the
  primary action is Stop.
- As soon as text or an attachment becomes sendable, the same primary-action
  position changes to Send.
- Submitting while the turn is running always uses queue semantics, regardless
  of the stored Steer/Queue preference.
- The sent draft clears immediately and appears in the existing queued-message
  UI.
- After the draft clears, the primary action returns to Stop while the active
  turn continues.
- External-thread ownership remains read-only: entering text, queueing, and
  stopping stay disabled.

### 4. Stop intent may precede the turn ID

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

### 5. Terminal state converges immediately

- A terminal event for the active local turn clears running state
  synchronously, unless a fallback retry or a newer queued turn is already
  starting.
- A terminal event with a different cached turn ID is not allowed to leave the
  UI permanently running. It triggers one authoritative runtime/detail
  reconciliation.
- If the backend reports idle, clear the stale active turn ID, local ownership,
  activity, interrupt latch, and running state immediately.
- If the backend reports a newer local turn, adopt its ID and remain running.
- Polling and thread-list snapshots may confirm terminal state but are not
  required before the button changes for a matching terminal event.
- Completion reconciliation is generation-scoped so an older request cannot
  clear a newer running turn.

### 6. Managed upload ownership is explicit

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
- A failed queue submission restores the draft or leaves an actionable queued
  error; it does not silently discard the user's new message.
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

### Optimistic message continuity

- Existing-thread and new-thread submissions render immediately.
- A detail snapshot without the submitted user row does not remove the
  optimistic row.
- A live projection without the submitted user row does not remove it.
- An equivalent persisted user row atomically replaces the optimistic row.
- Polling between submit and the first agent output produces neither a blank
  frame nor a duplicate row.

### Immediate running, queueing, and Stop

- Existing-thread submit synchronously exposes an enabled Stop action.
- New-thread submit exposes running/Stop state without waiting for the first
  model output.
- A running composer with text or attachments exposes Send instead of Stop.
- Running-turn Send always appends to the queue, even if the legacy preference
  is `steer`.
- Clearing or submitting the draft restores Stop while the original turn runs.
- Clicking Stop before a turn ID records intent and later interrupts the exact
  returned turn ID once.
- A `turn/started` notification can satisfy the pending stop before the RPC
  resolves.
- A cancelled pre-start submission does not launch a turn.
- Startup failure returns to idle and removes the optimistic row.
- External turns remain visibly running but non-interruptible.
- Matching completion immediately changes Stop to Send.
- Mismatched completion reconciles against backend idle/newer-turn state and
  cannot leave a stale Stop button.

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
