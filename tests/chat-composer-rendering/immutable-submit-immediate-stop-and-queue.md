### Immutable submit, immediate Stop, and running-turn queue

#### Prerequisites

- Run the current mobile server and open a writable local thread.
- Keep browser developer tools available to simulate a delayed or failed
  `turn/start` response.

#### Steps

1. Send a message and confirm its user row appears immediately.
2. While `turn/start` is still pending, confirm the composer changes to Stop and
   click it.
3. Confirm the eventual turn ID is interrupted exactly once and the composer
   returns to Send after terminal confirmation.
4. Start another long turn. With an empty draft, confirm the primary action is
   Stop.
5. Type a follow-up while that turn is running. Confirm the primary action
   changes to Send, submit it, and confirm it appears in the queue.
6. Confirm the cleared composer returns to Stop while the original turn remains
   active.
7. Finish the active and queued turns, then confirm the final control is Send
   without refreshing.
8. Confirm sent user rows have no `Edit message` action; queued unsent rows
   retain their existing edit and reorder actions.
9. Repeat the immediate-Stop check from the new-chat screen while
   `thread/start` is delayed.

#### Expected Results

- A submitted user row never flashes away during polling or the first model
  output.
- Stop is available before a turn ID is known and targets only the submitted
  local turn.
- A running draft always queues instead of steering.
- Matching terminal events update Stop to Send immediately.
- A mismatched terminal event is reconciled with backend runtime state and
  cannot leave a stale Stop button.
- Sent messages are immutable; only unsent queue entries remain editable.

#### Rollback/Cleanup

- Let queued test turns drain or delete unsent queue entries.
- Remove disposable test threads.
