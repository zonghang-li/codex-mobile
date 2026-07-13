### Feature: Background external runtime indicators

#### Prerequisites
- Run this procedure against either the candidate local checkout or the deployed Codex Mobile Safe instance on Linux.
- Run the desktop Codex client as the same host user and with the same Codex home used by the Codex Mobile Safe instance so both clients can observe the same threads and rollout files.
- Open browser DevTools for the mobile client with the Network panel recording and Preserve log disabled.
- Have at least three existing threads available: one disposable thread for the desktop task, a different thread to keep selected on mobile, and an unread conversation for the final summary-refresh check.
- Be able to switch the mobile viewport between `390x844` and `768x1024` and the app appearance between Light and Dark.
- Use a desktop task that runs for longer than one complete mobile background-runtime poll cycle.

#### Steps
1. Start a task in the desktop Codex client and record its thread ID as `<desktop-thread-id>`.
2. On mobile, open a different thread, expand the sidebar, and leave the desktop-running thread unselected.
3. Within one poll cycle, inspect the authenticated single request `GET /codex-api/thread-runtime-state?threadId=<desktop-thread-id>` and batch request `POST /codex-api/thread-runtime-states` with `<desktop-thread-id>` in `threadIds`. Confirm both successful response bodies report `state: "running"` for the desktop thread.
4. In the mobile DevTools Elements panel, inspect the desktop thread's sidebar row. Confirm it contains `.thread-status-indicator[data-state="working"]` and does not contain `.thread-status-indicator[data-state="unread"]` within that same poll cycle.
5. Select the externally owned desktop thread on mobile. Confirm the composer remains non-interruptible: it cannot submit, edit, attach, change turn settings, or send an interrupt, and the disabled running control identifies the task as running in another client.
6. Return to a different thread on mobile. Complete the task from the desktop client, wait for the next background-runtime poll and summary refresh, and confirm the desktop thread's `data-state="working"` indicator disappears. Confirm an unread conversation then has `.thread-status-indicator[data-state="unread"]` after the summary refresh.
7. In the mobile DevTools Network panel, inspect the batch polling requests. Confirm no more than one `POST /codex-api/thread-runtime-states` request is in flight at a time and every request body contains at most 50 `threadIds`. Hide the page or switch the browser tab to the background for longer than one poll interval and confirm that no batch requests are issued while `document.hidden` is true; make the page visible again and confirm polling resumes.
8. Repeat steps 1–7 at `390x844` in Light and Dark appearance, then at `768x1024` in Light and Dark appearance. Confirm the sidebar indicator and externally owned composer remain visible, legible, and usable at every combination.

#### Expected Results
- The single and batch runtime endpoints both report `running` for the desktop-owned task while another thread is selected on mobile.
- Within one poll cycle, the unselected desktop thread is marked `working`, never `unread`, and selecting it keeps the mobile composer non-interruptible.
- After desktop completion, the working state disappears and summary refresh can restore the normal unread indicator.
- Background polling has one batch request in flight at a time, sends no more than 50 thread IDs per request, and sends no requests while the page is hidden.
- The behavior and layout remain correct at `390x844` and `768x1024` in both Light and Dark appearance.

#### Evidence Record
Record the deployed revision, test time, mobile URL, desktop thread ID, viewport/appearance combinations, single and batch response states, sidebar state before and after completion, maximum batch size, maximum concurrent batch requests, and hidden-page request count. Sanitize credentials, cookies, user content, and private thread metadata before retaining screenshots or network evidence.

```text
revision:
tested at:
mobile URL:
desktop thread ID:
viewports/appearances: 390x844 Light; 390x844 Dark; 768x1024 Light; 768x1024 Dark
single runtime state:
batch runtime state:
sidebar state while running:
composer non-interruptible:
sidebar state after completion while unread:
maximum batch threadIds:
maximum concurrent batch requests:
batch requests while hidden:
evidence paths:
```

#### Rollback/Cleanup
- Complete or stop the disposable desktop task, close the test clients, restore the original viewport and appearance, and remove or archive disposable test threads as appropriate.
- To roll back the deployed feature, revert the background runtime indicator feature commits, run `pnpm run install:local`, and restart only `codex-mobile-safe.service`.
- Do not change or restart Tailscale Serve; its configuration and tailnet-only exposure remain unchanged.
