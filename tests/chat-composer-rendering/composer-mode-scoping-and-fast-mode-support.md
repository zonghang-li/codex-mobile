### Composer mode scoping and Fast mode support

#### Feature/Change Name
Plan mode is scoped to the current chat instead of becoming the default for every chat. Fast mode is available for supported GPT 5.4, GPT 5.5, and GPT 5.6 model IDs. Fresh Codex new chats default to `gpt-5.6-sol`, `Max` thinking, and Fast mode when that model is available.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. At least two existing threads are available
3. Model list includes `gpt-5.4` or a `gpt-5.4-*` variant, `gpt-5.5` or a `gpt-5.5-*` variant, and `gpt-5.6-sol`
4. Light theme and dark theme both available from the appearance switcher

#### Steps
1. In light theme, open thread A, open the composer add menu, and enable Plan mode.
2. Open thread B and confirm Plan mode is off by default.
3. Return to thread A and confirm Plan mode remains on for that thread.
4. Open Start new thread, enable Plan mode, send a first message, and confirm the created thread starts in Plan mode.
5. Return to Start new thread again and confirm Plan mode is off for the next new chat.
6. Open Start new thread with no saved model override and confirm the composer shows `GPT-5.6-sol`, `Max`, and Fast mode enabled by default.
7. Open the Thinking dropdown and confirm it includes `Extra high`, `Max`, and `Ultra`.
8. Select `gpt-5.4` or a `gpt-5.4-*` model and confirm the Fast mode switch is visible.
9. Select `gpt-5.5` or a `gpt-5.5-*` model and confirm the Fast mode switch is visible.
10. Select `gpt-5.6-sol` and confirm the Fast mode switch is visible.
11. Select an unsupported model family and confirm the Fast mode switch is hidden.
12. Switch to dark theme and repeat steps 1-11.

#### Expected Results
- Enabling Plan mode in one existing thread does not enable it in other existing threads.
- A new-chat Plan mode selection applies to the created chat but does not persist as the default for later new chats.
- Fresh Codex new chats prefer `gpt-5.6-sol`, `Max`, and Fast mode when `gpt-5.6-sol` is available and no saved model override exists.
- The Thinking dropdown includes `Extra high`, `Max`, and `Ultra`.
- Fast mode is visible for GPT 5.4, GPT 5.5, and GPT 5.6 model IDs, including dashed variants.
- Fast mode remains hidden for unsupported model families.
- Composer controls and menus remain readable in light and dark themes.

#### Rollback/Cleanup
- Turn Plan mode off in any test threads if desired.

---
