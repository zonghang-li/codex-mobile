### Feature: Unified background runtime reconciliation

#### Prerequisites
- Run this procedure against either the candidate local checkout or the deployed Codex Mobile Safe instance on Linux.
- Run the desktop Codex client as the same host user and with the same Codex home used by the Codex Mobile Safe instance so both clients can observe the same threads and rollout files.
- Open browser DevTools for the mobile client with the Network panel recording and Preserve log disabled.
- Have at least two existing threads available: one idle disposable thread for the desktop task and a different thread to keep selected on mobile. For the rotation scenario, have at least 51 loaded thread rows.
- Before starting the desktop task, open the disposable thread on mobile and wait for its conversation to finish loading, then switch to the different thread. This records the disposable thread's mobile last-read state before the new desktop activity. After every temporary selection below, return to the different thread before the desktop task completes so the completion update is newer than that last-read state.
- Be able to switch the mobile viewport between `390x844` and `768x1024` and the app appearance between Light and Dark.
- Use a desktop task that runs for longer than one complete mobile background-runtime poll cycle.

#### Steps
1. Start a task in the desktop Codex client and record its thread ID as `<desktop-thread-id>`.
2. On mobile, open a different thread, expand the sidebar, and leave the desktop-running thread unselected.
3. While the different thread remains selected, wait for one background poll and inspect `POST /codex-api/thread-runtime-states`; confirm its request body includes `<desktop-thread-id>` and its successful response has `states["<desktop-thread-id>"].state: "running"`. Temporarily select the desktop thread, wait for its selected-thread poll, and inspect `GET /codex-api/thread-runtime-state?threadId=<desktop-thread-id>`; confirm its successful response has `state: "running"`. Return to the different thread and wait for the next background poll before continuing. These same-origin requests use the mobile app's existing authenticated session; do not copy or record cookies, passwords, or authorization values.
4. In the mobile DevTools Elements panel, inspect the desktop thread's sidebar row. Confirm it contains `.thread-status-indicator[data-state="working"]` and does not contain `.thread-status-indicator[data-state="unread"]` within one poll cycle after returning to the different thread.
5. Select the externally owned desktop thread on mobile. Confirm the composer remains non-interruptible: it cannot submit, edit, attach, change turn settings, or send an interrupt, and the disabled running control identifies the task as running in another client. Return to the different thread before the desktop task completes; this records the latest mobile last-read state before the completion update.
6. Complete the task from the desktop client while the different thread remains selected on mobile. Wait for the next background-runtime poll and its forced summary refresh. On the same desktop-thread row, confirm `.thread-status-indicator[data-state="working"]` disappears and is replaced by `.thread-status-indicator[data-state="unread"]`; this proves that row transitioned from working to unread after completion rather than relying on a different conversation that was already unread.
7. In the mobile DevTools Network panel, inspect the batch polling requests. Confirm no more than one `POST /codex-api/thread-runtime-states` request is in flight at a time and every request body contains at most 50 `threadIds`. Hide the page or switch the browser tab to the background for longer than one poll interval and confirm that no batch requests are issued while `document.hidden` is true; make the page visible again and confirm polling resumes.
8. With at least 51 thread rows loaded, record two or more consecutive batch request bodies. Confirm the selected non-external thread is included in every batch, each body has at most 50 IDs, and the union of consecutive batches eventually contains every loaded row instead of repeating only the first 50.
9. Repeat steps 1–8 at `390x844` in Light and Dark appearance, then at `768x1024` in Light and Dark appearance. Confirm the sidebar indicator and externally owned composer remain visible, legible, and usable at every combination.

#### Local notification-loss recovery

1. Keep the mobile page visible, start a turn through Codex Mobile, and use DevTools to temporarily interrupt the notification transport before the browser receives `turn/started`. Restore transport without refreshing the page. Confirm the next batch response reports `running`, `source: "local-app-server"`, the row changes to `working`, and any false unread dot disappears.
2. Start another mobile turn and allow the browser to receive `turn/started`, then interrupt notification transport before `turn/completed`. Let the turn finish and restore transport without refreshing. For an unselected row, confirm the next authoritative `idle` batch clears `working` and one forced summary refresh can mark the completed thread unread.
3. Repeat the missed-completion scenario while the thread remains selected. Confirm the browser reads terminal thread detail, displays the final assistant message, and only then changes the composer and row to idle. If the terminal detail request is deliberately failed, confirm the UI stays running until a later successful reconciliation.
4. During a selected terminal detail request, start a newer turn before the old detail returns. Confirm the stale detail cannot clear the newer turn. Return an `unknown` runtime observation and confirm it also cannot clear a local running lease.
5. Hide the page before a correction is due. Confirm no runtime or terminal-detail requests occur while hidden. Make the page visible and confirm exactly one immediate batch correction starts, followed by the normal interval after it settles.

#### Expected Results
- The batch endpoint reports `running` for the desktop-owned task while another thread is selected; after temporarily selecting the desktop thread, its single endpoint also reports `running`.
- Within one poll cycle, the unselected desktop thread is marked `working`, never `unread`, and selecting it keeps the mobile composer non-interruptible.
- After desktop completion, the same desktop-thread row transitions from `working` to `unread` after the forced summary refresh.
- Background polling has one batch request in flight at a time, sends no more than 50 thread IDs per request, and sends no requests while the page is hidden.
- Consecutive limited batches rotate across all loaded rows, while the selected non-external row remains prioritized.
- Missed local starts recover to `working`; missed local completions recover to idle without losing the final selected-thread output.
- Failed detail reads, unknown observations, and stale responses never clear a newer or unconfirmed local turn.
- Returning from a hidden page triggers one immediate correction and does not create overlapping requests.
- The behavior and layout remain correct at `390x844` and `768x1024` in both Light and Dark appearance.

#### Evidence Record
Record the deployed revision, test time, mobile URL, desktop thread ID, viewport/appearance combinations, single and batch response states, the desktop row's state before and after completion, maximum batch size, maximum concurrent batch requests, and hidden-page request count. Sanitize credentials, cookies, user content, and private thread metadata before retaining screenshots or network evidence.

```text
revision:
tested at:
mobile URL:
desktop thread ID:
viewports/appearances: 390x844 Light; 390x844 Dark; 768x1024 Light; 768x1024 Dark
single runtime state:
batch runtime state:
desktop row state while running:
composer non-interruptible:
desktop row state after completion while unread:
maximum batch threadIds:
maximum concurrent batch requests:
batch requests while hidden:
foreground immediate correction count:
51+ row union complete:
missed local start recovered:
missed background completion recovered:
selected final output present before idle:
failed/unknown/stale detail retained lease:
evidence paths:
```

#### Rollback/Cleanup
- Complete or stop the disposable desktop task, close the test clients, restore the original viewport and appearance, and remove or archive disposable test threads as appropriate.
- To roll back the deployed feature, revert the background runtime indicator feature commits, run `pnpm run install:local`, and restart only `codex-mobile-safe.service`.
- Do not change or restart Tailscale Serve; its configuration and tailnet-only exposure remain unchanged.
