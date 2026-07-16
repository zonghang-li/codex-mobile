### User message edit action replaces rollback button

#### Feature/Change Name
The old rollback button is replaced with an `Edit message` action under each eligible user message, while keeping the existing behavior that appends the original text into the composer and rolls the thread back from that turn.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. An existing thread with at least one completed or interrupted user turn

#### Steps
1. Open a thread with multiple completed turns
2. Hover a completed user message
3. Confirm `Edit message` appears under that user message
4. Confirm assistant responses no longer show the old `Rollback` button
5. Click `Edit message` on an earlier user message with recognizable text
6. Observe the composer draft after the click
7. Confirm the thread rolls back from the selected turn
8. Start another turn, stop it immediately, click `Edit message`, change the draft, and submit it without waiting for the rollback indicator to disappear
9. Wait for the replacement turn to start and finish, then refresh the page

#### Expected Results
- The action under eligible user messages is labeled `Edit message`
- Assistant responses no longer render the old rollback action
- Clicking `Edit message` appends the original user text into the composer
- The existing rollback behavior still truncates the selected turn and later turns
- An immediate edited re-submit waits for rollback completion before starting the replacement turn
- The edited user message remains visible during the turn and after refresh; it does not briefly show running and then disappear

#### Rollback/Cleanup
- Re-send the edited message if you want to recreate the conversation path

---
