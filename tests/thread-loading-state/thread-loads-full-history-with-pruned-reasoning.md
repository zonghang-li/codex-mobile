### Feature: Thread loads full history with pruned historical reasoning

#### Prerequisites
- App is running from this repository.
- At least one thread exists with more than 10 turns/messages.
- The thread has historical completed turns that include reasoning summaries or intermediate assistant progress messages, plus a latest running turn with visible reasoning/progress.

#### Steps
1. Open a long thread that previously caused UI lag during initial load.
2. While the thread is loading, immediately click another thread in the sidebar.
3. Return to the long thread.
4. Count visible history blocks and confirm the full conversation history is present, not only the newest portion.
5. Confirm completed historical turns show user content and the final assistant reply, but do not show their reasoning summaries or intermediate assistant progress messages.
6. Confirm only the latest running turn, if one exists, shows its live reasoning/progress summary.
7. Call `/codex-api/rpc` with method `thread/read` for the same thread and inspect `result.thread.turns.length`.
8. Call `/codex-api/thread-live-state?threadId=<thread-id>` for the same thread and inspect `conversationState.turns.length`.

#### Expected Results
- Initial thread load renders all turns.
- UI remains responsive during thread load because historical reasoning items are removed server-side and completed-turn intermediate assistant progress is hidden client-side.
- You can switch to another thread without the UI freezing.
- `thread/read` and `thread-live-state` responses keep all turns but omit `reasoning` items from every non-running turn; the UI then displays only the final assistant message from completed historical turns.
- If no turn is running, all persisted `reasoning` items are omitted.

#### Rollback/Cleanup
- No cleanup required.
