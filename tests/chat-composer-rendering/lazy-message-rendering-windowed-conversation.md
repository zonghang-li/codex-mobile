### Feature: Full loaded history rendering

#### Prerequisites
- App is running from this repository.
- A thread exists with more than 50 messages or turns.

#### Steps — initial load

1. Open a long thread with 60+ visible messages.
2. Confirm the full already-loaded conversation is present, including middle turns.
3. Verify the chat opens scrolled to the latest message.
4. Confirm no `Load earlier messages` button appears unless the server explicitly reports older persisted history.

#### Steps — live session growth

5. Start an active Codex session or open an existing active long session.
6. Let the conversation continue producing messages while staying at the bottom.
7. Confirm new text streams into the latest message and the view remains pinned to the bottom.
8. Scroll upward into history.
9. Confirm new output does not force-scroll while you are reading history.
10. Click `Jump to latest` and confirm the view returns to the newest message and resumes following output.

#### Steps — rollback / message shrink

11. In a thread with a turn that can be rolled back, trigger a rollback.
12. Verify the conversation does not go blank and middle/older turns remain visible after the list changes.

#### Expected Results
- The frontend does not keep a local 50-message render window.
- Already-loaded messages are all renderable after hidden metadata/reasoning filtering.
- `Load earlier messages` is only for older persisted history not returned by the current server payload.
- Historical completed turns omit reasoning summaries and intermediate assistant progress; user content and the final assistant reply remain present.

#### Rollback/Cleanup
- No persistent state is changed.
