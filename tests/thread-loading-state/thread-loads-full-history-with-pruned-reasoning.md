### Feature: Thread reaches full history on demand with pruned historical reasoning

#### Prerequisites
- App is running from this repository.
- At least one thread exists with more than 10 turns/messages.
- The thread has historical completed turns that include reasoning summaries or intermediate assistant progress messages, plus a latest running turn with visible reasoning/progress.

#### Steps
1. Open a long thread that previously caused UI lag during initial load.
2. While the thread is loading, immediately click another thread in the sidebar.
3. Return to the long thread.
4. Confirm initial hydration shows the newest five full turns and `Load earlier messages`.
5. Click `Load earlier messages` until it disappears; confirm every earlier user/final-assistant turn becomes visible without gaps or duplicates.
6. Confirm completed historical turns show user content and the final assistant reply, but do not show their reasoning summaries or intermediate assistant progress messages.
7. Confirm only the latest running turn, if one exists, shows its live reasoning/progress summary.
8. Call `/codex-api/thread-turn-page?threadId=<thread-id>&limit=5`; confirm it contains no more than five turns and returns an opaque `nextCursor` while older history exists.
9. Call `/codex-api/thread-live-state?threadId=<thread-id>`; confirm it contains no more than five persisted turns plus the same older-history cursor.

#### Expected Results
- Initial thread load renders only the newest five full turns; older history remains reachable through opaque-cursor pagination.
- Every successful older request prepends at most ten turns, and already-loaded messages remain visible after live polling or a forced refresh.
- UI remains responsive during thread load because historical reasoning items are removed server-side and completed-turn intermediate assistant progress is hidden client-side.
- You can switch to another thread without the UI freezing.
- Turn-page and live-state responses omit `reasoning` items from every non-running turn; the UI displays only the final assistant message from completed historical turns.
- If no turn is running, all persisted `reasoning` items are omitted.

#### Rollback/Cleanup
- No cleanup required.
