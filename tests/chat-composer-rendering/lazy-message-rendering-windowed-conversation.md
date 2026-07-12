### Feature: Lazy message rendering (windowed conversation)

#### Prerequisites
- App is running from this repository.
- A thread exists with more than 50 messages (send many short messages, or use a long-running session).

#### Steps — initial load window

1. Open a thread with 60+ messages.
2. Observe that the conversation list does **not** show all messages immediately — only the most recent ~50 are rendered.
3. Verify the latest messages are visible and the chat is scrolled to the bottom.
4. Confirm a "Load earlier messages" button appears at the top of the visible list.

#### Steps — scroll-triggered load

5. Scroll up slowly toward the top of the conversation list.
6. When the scroll position reaches within ~200 px of the top, verify that the previous 30 messages appear automatically above the current ones.
7. Confirm the viewport does **not** jump — the messages you were reading stay in view.
8. Repeat scrolling up to verify additional chunks load on demand.
9. Once all messages are loaded, verify the "Load earlier messages" button disappears.

#### Steps — manual load button

10. Reload the page and open the same long thread.
11. Click "Load earlier messages" button without scrolling.
12. Verify 30 older messages are prepended and scroll position is preserved.
13. While older messages are visible, allow the active thread to receive several new messages.
14. Confirm the current reading position and expanded older-message window remain unchanged.
15. Click `Jump to latest` and confirm the conversation returns to the newest bounded window and resumes following output.
16. Force a message-list shrink or rollback and confirm at least one message remains visible whenever the list is non-empty.

#### Steps — live session growth

17. Start an active Codex session (or send many messages in quick succession).
18. Let the conversation exceed 50 messages while staying scrolled to the bottom.
19. Verify the rendered count stays bounded (top of the DOM list advances as new messages arrive).
20. Scroll up and confirm "Load earlier messages" works to reveal trimmed messages.

#### Steps — rollback / message shrink

21. In a thread with a turn that can be rolled back, trigger a rollback.
22. Verify the conversation does **not** go blank — messages still render after the list shrinks.
23. Confirm `renderWindowStart` recovers gracefully and earlier messages remain accessible.

#### Expected Results
- Only ≤50 messages are in the DOM on initial load.
- Scrolling to the top (or clicking the button) appends older messages without a viewport jump.
- During live output, the rendered window stays bounded; old messages are trimmed from the top while the user follows the bottom.
- After a rollback the conversation remains visible; a non-empty conversation never renders only the load control.

#### Rollback/Cleanup
- No persistent state is changed — closing or refreshing the tab resets the render window.
