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
4. In Client B at `375x812` Light, read and scroll the conversation, then try to focus or edit the composer, add an attachment, change plan/model/reasoning/speed settings, submit with the button and configured send shortcut, activate the stop control, edit a prior user prompt (rollback), undo/redo prior file changes, answer any pending server request, and edit, steer, delete, drag, or reorder the queued row.
5. Switch Client B to Dark appearance without changing the `375x812` viewport and repeat the visual and disabled-control checks.
6. Resize Client B to `768x1024` while keeping Dark appearance, refresh the same thread, and repeat the visual and disabled-control checks; then switch to Light appearance at `768x1024` and repeat them once more.
7. Leave both clients open until the turn reaches a terminal state in Client A. Immediately after the external-runtime poll notices completion but before terminal output appears, try to submit once in Client B; then wait for the forced terminal detail refresh to finish.
8. In Client B, confirm the final output appears, the sidebar and composer leave their running state, and submit a short follow-up message.
9. While an external-runtime request for one selected thread is deliberately left pending (for example with a development request interceptor), select a second externally running thread and wait one polling interval; then stop polling or trigger a local turn on the selected thread.
10. Create one pending request scoped to an externally owned thread and one scoped to an idle thread. Change selection before responding to each request, and also exercise one explicitly global request plus an expired/unknown request ID.

#### Expected Results
- During both refreshes, the thread remains selected and its readable conversation history stays visible.
- The selected thread's sidebar row shows the running spinner while the external turn is active.
- Client B shows a stop-shaped control labelled and titled `Running in another client`; it is disabled and cannot emit an interrupt.
- Client B's composer text, attachment, configuration, model, reasoning, speed, submit, dictation, and keyboard-send paths are disabled while external ownership is active.
- Every queued edit, steer, delete, drag, drop, and reorder control is disabled in Client B, with no queue mutation.
- Prior-message rollback/edit, file-change undo/redo, plan implementation, and pending-request response controls are hidden or disabled in Client B, and their RPCs are not sent.
- Client B does not drain the persisted queued follow-up while Client A still owns the external turn, including after Client B startup/recovery; inconclusive Linux ownership checks keep the queue blocked and retry later.
- Client A retains its enabled local stop control, and an idle composer still retains normal send behavior.
- Client B retains the external read-only lease until the forced terminal detail refresh has succeeded, so the immediate completion-edge submit cannot start a duplicate turn.
- Changing selection, stopping/disconnecting, or observing a local takeover aborts the obsolete runtime request; the newly selected external thread starts its own poll after two seconds, and a late completion from the old request cannot clear or reschedule the new poll.
- Pending responses are authorized by the request ID's recorded scope rather than the selected row: external-thread requests remain blocked after selection changes, idle/local requests remain usable, explicit global requests retain their prior behavior, and unknown/expired IDs send no RPC.
- After the external turn reaches a terminal state, Client B removes the sidebar spinner, refreshes the completed conversation, replaces the disabled stop control with the normal idle send control, re-enables queue/composer interactions, and sends the follow-up normally.
- The layout remains usable in Light and Dark appearance at both `375x812` and `768x1024`, with the composer and queue actions remaining visible and correctly disabled.

#### Configured desktop command and launcher descendants

##### Setup
- Use Linux and keep `codex-mobile-safe` running through its normal Node launcher and native Codex app-server child.
- Identify a thread whose rollout is shared by the desktop app-server and `codex-mobile-safe`, and make sure it is idle before the check.

##### Steps
1. Start the desktop app-server in the production layout `codex -c features.code_mode_host=true app-server --listen unix://` and begin a long-running turn.
2. Open the same thread in `codex-mobile-safe`; confirm `/codex-api/thread-runtime-state` returns `running` and the composer shows the disabled “Running in another client” stop control.
3. Confirm the mobile Node launcher and its native Codex child can both hold the rollout without being accepted as external evidence.
4. Stop the separate desktop app-server while leaving the mobile service alive; after the terminal refresh the endpoint must become `idle` and the normal send control must return.

##### Expected Results
- Command recognition treats `/proc/<pid>/cmdline` as NUL-delimited argv: an argv token whose basename is exactly `codex` must precede a later token that is exactly `app-server`. Options between those tokens are accepted; lookalike basenames, reversed ordering, and lookalike subcommands are rejected.
- The mobile launcher PID and every native or Node descendant whose validated parent chain reaches that PID are excluded. Only a separate qualifying desktop app-server can supply external writer evidence.
- Linux process identity is bound to `/proc/<pid>/stat` starttime while the process table and descriptor evidence are collected. PID reuse or a starttime change before or during descriptor enumeration makes the scan conservatively `unknown` instead of accepting stale writer evidence.
- Existing lifecycle, same-UID, exact rollout dev/ino, writable-descriptor, positive-position, canonical-path, and regular-file requirements remain in force.

##### Automated Acceptance
1. Run `pnpm vitest run src/server/externalThreadRuntime.test.ts src/server/externalThreadRuntimeBridge.test.ts`; both focused suites must pass.
2. Run `pnpm test:unit`; the complete unit suite must pass.
3. Run `pnpm build`; Vue type checking, Vite, and tsup must complete successfully.
4. Run `node dist-cli/safe.js doctor`; it must print `codex-mobile-safe doctor: ok`.
5. Run `git diff --check main..HEAD`; it must print nothing.

#### Rollback/Cleanup
- From Client A, stop the long-running turn if it is still active; after both clients show the terminal state, delete the prepared test-only queued row if it remains, restore Client B's original viewport and appearance, close Client B, and stop its Codex Mobile/app-server instance.
