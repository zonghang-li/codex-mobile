### Feature: External client running state after refresh

#### Prerequisites
- Use a Linux host where both Codex Mobile instances run under the same user and read the same Codex home/session data.
- Start two Codex Mobile app instances backed by different Codex app-server processes: Client A in a desktop browser and Client B in a mobile browser or mobile viewport.
- Open the same existing thread in both clients and ensure it is idle before starting.
- Prepare a prompt in Client A that runs long enough to refresh and inspect Client B before it completes.
- Configure Client A to queue messages while busy, and prepare a short test-only follow-up that will become the visible queued row before Client B takes external ownership.
- Ensure Client B can be tested at both `375x812` and `768x1024` and can switch explicitly between Light and Dark appearance.

#### Steps
1. In desktop Client A, submit the long-running prompt, confirm the turn begins streaming, submit the prepared follow-up in Queue mode, and confirm at least one queued row is visible before opening or refreshing the thread in Client B.
2. In desktop Client A, refresh the browser page while the turn is still running, reopen the thread if necessary, and inspect its sidebar row, conversation, composer, enabled local stop control, and queued row.
3. Set Client B to a `375x812` viewport and Light appearance, navigate to the same thread, and refresh while Client A's turn and queued row are still active.
4. In Client B at `375x812` Light, read and scroll the conversation, then try to focus or edit the composer, add an attachment, change plan/model/reasoning/speed settings, submit with the button and configured send shortcut, activate the stop control, and edit, steer, delete, drag, or reorder the queued row.
5. Switch Client B to Dark appearance without changing the `375x812` viewport and repeat the visual and disabled-control checks.
6. Resize Client B to `768x1024` while keeping Dark appearance, refresh the same thread, and repeat the visual and disabled-control checks; then switch to Light appearance at `768x1024` and repeat them once more.
7. Leave both clients open until the turn reaches a terminal state in Client A, then allow at least one external-runtime polling interval in Client B.
8. In Client B, confirm the final output appears, the sidebar and composer leave their running state, and submit a short follow-up message.

#### Expected Results
- During both refreshes, the thread remains selected and its readable conversation history stays visible.
- The selected thread's sidebar row shows the running spinner while the external turn is active.
- Client B shows a stop-shaped control labelled and titled `Running in another client`; it is disabled and cannot emit an interrupt.
- Client B's composer text, attachment, configuration, model, reasoning, speed, submit, dictation, and keyboard-send paths are disabled while external ownership is active.
- Every queued edit, steer, delete, drag, drop, and reorder control is disabled in Client B, with no queue mutation.
- Client A retains its enabled local stop control, and an idle composer still retains normal send behavior.
- After the external turn reaches a terminal state, Client B removes the sidebar spinner, refreshes the completed conversation, replaces the disabled stop control with the normal idle send control, re-enables queue/composer interactions, and sends the follow-up normally.
- The layout remains usable in Light and Dark appearance at both `375x812` and `768x1024`, with the composer and queue actions remaining visible and correctly disabled.

#### Rollback/Cleanup
- From Client A, stop the long-running turn if it is still active; after both clients show the terminal state, delete the prepared test-only queued row if it remains, restore Client B's original viewport and appearance, close Client B, and stop its Codex Mobile/app-server instance.
