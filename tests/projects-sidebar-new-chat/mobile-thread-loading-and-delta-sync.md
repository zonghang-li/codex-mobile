### Mobile thread loading and delta sync

#### Feature/Change Name
Mobile sidebar and conversation loading use metadata-only sidebar pages, active-thread text pagination, lightweight running live-state, small runtime-state probes, thread-id delta notifications, and same-thread multi-window request sharing.

#### Prerequisites/Setup
1. Dev server or installed safe service running with browser devtools Network panel open.
2. A workspace with more than 20 threads, including at least one running or recently completed thread.
3. One selected thread with enough assistant output and reasoning text to require active-turn text pagination.
4. Two mobile browser windows or tabs can be opened on the same origin.
5. A running thread owned by a direct Codex CLI process is available for mobile read-authority checks.
6. Light theme and dark theme both available from the appearance switcher.

#### Steps
1. Open the mobile UI on a cold load and inspect the first sidebar requests.
2. Confirm sidebar requests use `thread/list` summary data and do not include turn, item, message, conversation, or transcript payloads.
3. Confirm the first sidebar page requests only the 5 most recent threads, keeps the selected thread usable if that list is still refreshing, and loads older sidebar rows asynchronously.
4. Restart the safe service with no warm in-memory thread-list cache and confirm the first `thread/list` response can come from `session_index.jsonl` metadata while the real app-server list refreshes in the background.
5. Select a thread with long output and confirm the conversation body loads through paged current-thread text/detail requests rather than a full sidebar detail scan.
6. Confirm the initial selected-thread transcript displays only the newest 3 turns by default; older turns load only through explicit older-page pagination and this display window does not alter Codex reasoning context.
7. While the selected thread is running, let another Codex client submit a new user message and produce assistant text; confirm the mobile transcript first shows that user message bubble and then appends the new assistant tail promptly without waiting for the generic notification debounce.
8. Inspect `/codex-api/thread-text-page` calls after the selected thread has a cached detail/live snapshot, or after a service restart where only the local rollout file is available, and confirm they use the resolved rollout path instead of issuing `thread/read` before every page.
9. Trigger or observe a notification for a different loaded thread and confirm the UI refreshes only that changed thread's visible status/metadata instead of issuing a full thread-list refresh.
10. Inspect `/codex-api/thread-runtime-states` calls and confirm each batch stays small, probes a loaded selected thread before the sidebar/background batch, includes recently running/actionable visible rows, and does not rotate through all historical loaded threads.
11. Manually refresh a selected running thread whose `thread/read` metadata reports an external active turn but whose newest `/codex-api/thread-turn-page` response contains only historical turns; confirm the browser immediately follows with `/codex-api/thread-text-page` for the active turn and shows the latest active tail.
12. Manually refresh a selected running thread whose newest `/codex-api/thread-turn-page` response includes the external active turn; confirm that active turn is returned as an `inProgress` partial shell with empty `items`, not a large stale item window, and the browser uses `/codex-api/thread-text-page` for the visible active text.
13. Open a blue-dot thread, return to another thread, then let sidebar metadata refresh; confirm the read row does not regain a blue dot just because its metadata timestamp changed.
14. Confirm historical turns show assistant/user body summaries but do not expose reasoning text; only the last running turn can show reasoning body text.
15. Confirm title-only reasoning statuses such as `Planning ...`, `Updating ...`, `Inspecting ...`, and `Reviewing ...` do not appear as reasoning transcript text.
16. Leave a long selected thread open while another Codex client writes new output; confirm the selected external live projection checks for changes at the fast selected interval, about 150 ms while the tab is visible, and appends each new paragraph-sized tail instead of batching several updates together.
17. Inspect a running `/codex-api/thread-live-state` response and confirm it contains only lightweight projection metadata plus an empty or compressed conversation shell, not the active turn's large `items` payload; the browser should then fetch `/codex-api/thread-text-page` for the active text delta.
18. Open two visible mobile windows on the same selected running thread and watch server/network logs while new assistant text arrives; confirm only one window performs each identical selected active-text page request and the other window receives the same delta through the cross-window sync path.
19. Hide or close the window that was issuing selected active-text requests, then let another assistant paragraph arrive; confirm a remaining visible window takes over promptly without waiting for a long timeout or replaying the whole active turn.
20. With server logs open, confirm the selected `/codex-api/thread-live-state` request reuses a recent `/codex-api/thread-runtime-states` running observation when available, can use a fresh running desktop-writer snapshot for the first projection, and treats a recently updated unmatched rollout as running even when the writer does not hold an open fd.
21. Restart the safe service while another Codex client owns the selected running thread, then leave that client quiet for several minutes without a terminal lifecycle record; confirm `/codex-api/thread-text-page` keeps returning the active page from the local rollout path instead of falling back to slow `thread/read` or `409`.
22. Confirm intermediate assistant progress/commentary rows may render as transcript body, but `Copy` and `Fork` controls plus the completion time appear only on a completed final assistant response, including responses whose persisted phase is `final_answer`; copying that response excludes prior commentary/progress text.
23. Let the selected running turn complete from another Codex client and confirm the final detail refresh happens immediately rather than waiting for the generic event-sync debounce or an external runtime poll.
24. Open a running thread owned by a direct Codex CLI process, refresh the mobile page, and confirm the transcript continues updating without issuing `thread/resume` or `turn/start`; the composer remains available for queueing while Stop cannot interrupt the CLI-owned turn.
25. Refresh a selected thread whose initial detail briefly reports local running while another Codex client is the real writer; confirm the next runtime probe hands the thread to the external realtime path and immediately appends the selected active text tail.
26. With "When busy, send as" set to Queue, submit a mobile prompt while the external turn is still running and confirm it appears in the queue without starting a competing turn.
27. With "When busy, send as" set to Steer, submit a plain-text mobile prompt during an externally owned running turn and confirm it is persisted as a text-only queued message without an optimistic sent bubble or `turn/start`. Repeat while runtime ownership changes from local to external between submit and `turn/start`; confirm the rejected local attempt is removed and exactly one queued row remains. Repeat with an attachment or skill selected and confirm managed uploads are released while the text is queued rather than racing the writer.
28. Confirm Stop cannot interrupt a direct CLI-owned turn. For a separately validated interruptible app-server-owned turn, confirm Stop uses the exact current active turn id and refreshes state without clearing visible output.
29. Confirm queued-message Steer, edit, delete, and reorder controls all remain disabled while an external writer owns the thread.
30. Queue a normal message with a managed image/file attachment behind a long-running turn, restart the safe service, and confirm the queued row and attachment remain available until that queued turn starts; advancing beyond the normal upload reaper TTL must not delete an attachment still referenced by durable queue state.
31. Stop and restart frontend polling through an account refresh/switch while a durable queued row exists; confirm the row is reloaded instead of leaving the queue panel empty.
32. During cold startup, mutate the durable queue after the first queue GET but before the notification stream reports ready; confirm the ready recovery snapshot shows the new queue state and does not resurrect an older revision.
33. Run two service processes against the same temporary CODEX_HOME, append/reorder/remove queue rows concurrently, and terminate one process after its durable append but before local scheduling; confirm no rows are lost or duplicated and the surviving process drains the committed row.
34. Submit an inverse-arrival queue row whose declared predecessor never reaches the server; confirm it waits for the bounded dependency grace period and then becomes eligible instead of remaining stuck forever.
35. Repeat the visible checks in dark theme.

#### Expected Results
- Cold sidebar load and background sidebar pagination remain metadata-only.
- Cold sidebar load shows the newest 5 known threads first, can use a lightweight `session_index.jsonl` fallback on service restart, and loads the rest asynchronously.
- Switching threads does not fetch every loaded thread's turn content.
- Initial selected-thread detail displays the newest 3 turns only; older turns remain available through pagination and this display limit does not affect model context.
- Active-thread output appends incrementally without clearing already displayed hydrated reasoning or assistant text, and a new external active turn keeps its user message bubble visible even when live-state omitted the active turn items and the latest text page is a small tail page.
- Selected active-thread text deltas trigger a dedicated newest-text refresh immediately; generic notification debounce remains reserved for list/runtime/background reconciliation.
- Selected external running threads use a fast lightweight live-projection check of about 150 ms while visible; the heavier active-turn text page is fetched only when the projection key changes.
- Running live-state payloads do not include the active turn's full item history; the selected text page endpoint supplies the turn-start user anchor plus only the missing newest tail.
- Multiple visible windows on the same origin and selected thread share identical active-text page requests through `BroadcastChannel('codex-mobile-thread-sync')`; same-thread backend read cost is close to one visible window, while different selected running threads still poll independently.
- A hidden, closed, or stale leader window does not block a visible follower from taking over selected active-text sync.
- Selected external live projection is not serialized behind a sidebar runtime batch: the selected thread gets an isolated first runtime probe, and live-state can reuse a short-lived running runtime observation or a fresh writer snapshot instead of starting another slow inspect.
- Running detection does not depend solely on a long-lived writable fd; an active rollout with an unmatched `task_started` and a file update within the quiet grace window is enough to keep the selected task in the realtime path.
- Active-turn text paging reuses the cached session path from the selected thread snapshot, so paragraph-sized deltas are not serialized behind repeated `thread/read` calls.
- After a service restart, known-key live-state and active-turn text paging can rediscover the local rollout path from `CODEX_HOME/sessions` by thread id, avoiding a cold `thread/read` before realtime resumes.
- Selected current-turn completion notifications cancel pending external projection polls and refresh the final detail immediately.
- Known-thread notifications drive targeted message/runtime refreshes; full thread-list refresh happens only for unknown or structural list changes.
- Selected direct-route or older-page threads are not dependent on the loaded sidebar page for live sync: runtime polling and runtime notifications still promote them to external ownership and active text-page hydration still appends new output.
- Manual refresh does not depend on the active turn being present in the newest history page: external runtime metadata marks the omitted active turn as partial, causing immediate active text-page hydration.
- If the active turn is present in the newest history page, that turn is still returned as an empty partial shell instead of a stale bulk item window, so visible active text always comes from the newest text-page tail.
- Runtime-state polling stays bounded to the selected, visible/actionable, and recently running set.
- Read sidebar rows do not regain blue unread dots from metadata-only timestamp refreshes.
- A selected long thread that was previously showing a truncated terminal/live window repairs itself after the compressed projection changes; existing output stays visible and the newest tail appears.
- Historical reasoning remains hidden, running-last-turn reasoning body remains visible, and title-only reasoning statuses are filtered.
- Response actions and completion time are anchored to final assistant body text only, including `final_answer` phase payloads; retained commentary/progress rows do not expose `Copy` or `Fork`.
- Refreshing a direct CLI-owned running thread keeps transcript polling active and leaves the composer available for append-only queueing, without granting Stop or cross-process turn control.
- If a refreshed selected thread inherits a stale local-running lease, runtime discovery promotes it to external ownership unless a real local mobile submission is still pending, and the active text tail resumes without a page-wide reload.
- Mobile submissions during external ownership are always append-only queued, including Steer mode and local-to-external ownership races; no external-steer marker or competing `turn/start` is issued. Unsupported attachment/skill payloads are sanitized to queued text and their managed uploads are released.
- Direct CLI ownership is non-interruptible. A validated interruptible app-server owner may still be stopped by exact active turn id, and the follow-up refresh does not clear or overwrite visible transcript history.
- Queued-message Steer and mutation controls stay disabled while an external writer owns the thread.
- Durable queue rows reload after polling/account lifecycle resets and after notification-stream startup gaps; revision checks prevent stale snapshots from replacing newer queue state.
- Queue mutations remain serialized across service/CLI processes, live owners cannot be lease-stolen during slow RPC work, and a surviving service schedules rows committed by another process.
- Managed attachments referenced by durable queue rows survive service restart and upload-reaper TTL until their queued turn actually starts or the row is removed.
- Missing client-order predecessors delay execution only for the bounded grace period, while received predecessors still preserve submission order.
- The behavior is readable and stable in light and dark themes.

#### Rollback/Cleanup
- Stop any manually started dev server or safe service if it is not normally running.
- Close any extra mobile test windows or tabs opened for the multi-window sync check.
- Delete disposable queued rows and managed uploads created for queue-lifecycle checks, and stop the extra temporary service process.

---
