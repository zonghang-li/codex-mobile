### Feature: External client running state after refresh

#### Prerequisites
- Use a Linux host where both Codex Mobile instances run under the same user and read the same Codex home/session data.
- Start two Codex Mobile app instances backed by different Codex app-server processes: Client A in a desktop browser and Client B in a mobile browser or mobile viewport.
- Open the same existing thread in both clients and ensure it is idle before starting.
- Prepare a prompt in Client A that runs long enough to refresh and inspect Client B before it completes.

#### Steps
1. In desktop Client A, submit the long-running prompt and confirm the turn begins streaming.
2. In desktop Client A, refresh the browser page while the turn is still running, reopen the thread if necessary, and inspect its sidebar row, conversation, composer, stop control, and queued-message controls.
3. In mobile Client B, navigate to the same thread and refresh the browser page while Client A's turn is still running.
4. In mobile Client B, read and scroll the existing conversation, then try to focus or edit the composer, add an attachment, change plan/model/reasoning/speed settings, submit with the button and send shortcut, activate the stop control, and edit, steer, delete, drag, or reorder any queued message.
5. Leave both clients open until the turn reaches a terminal state in Client A, then allow at least one external-runtime polling interval in Client B.
6. In Client B, confirm the final output appears, the sidebar and composer leave their running state, and submit a short follow-up message.

#### Expected Results
- During both refreshes, the thread remains selected and its readable conversation history stays visible.
- The selected thread's sidebar row shows the running spinner while the external turn is active.
- Client B shows a stop-shaped control labelled and titled `Running in another client`; it is disabled and cannot emit an interrupt.
- Client B's composer text, attachment, configuration, model, reasoning, speed, submit, dictation, keyboard-send, and programmatic submit paths are disabled while external ownership is active.
- Every queued edit, steer, delete, drag, drop, and reorder control is disabled in Client B, with no queue mutation.
- Client A retains its enabled local stop control, and an idle composer still retains normal send behavior.
- After the external turn reaches a terminal state, Client B removes the sidebar spinner, refreshes the completed conversation, replaces the disabled stop control with the normal idle send control, re-enables queue/composer interactions, and sends the follow-up normally.
- The layout remains usable at desktop and mobile widths in both light and dark themes.

#### Rollback/Cleanup
- Wait for or stop the long-running turn from Client A, delete any test-only queued messages, close Client B, and stop the second Codex Mobile/app-server instance.
