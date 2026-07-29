### Mobile thread loading and delta sync

#### Feature/Change Name
Mobile sidebar and conversation loading use metadata-only sidebar pages, active-thread text pagination, lightweight running live-state, small runtime-state probes, thread-id delta notifications, and same-thread multi-window request sharing.

#### Prerequisites/Setup
1. Dev server or installed safe service running with browser devtools Network panel open.
2. A workspace with more than 20 threads, including at least one running or recently completed thread.
3. One selected thread with enough assistant output and reasoning text to require active-turn text pagination.
4. Two mobile browser windows or tabs can be opened on the same origin.
5. Light theme and dark theme both available from the appearance switcher.

#### Steps
1. Open the mobile UI on a cold load and inspect the first sidebar requests.
2. Confirm sidebar requests use `thread/list` summary data and do not include turn, item, message, conversation, or transcript payloads.
3. Confirm the first sidebar page requests only the 5 most recent threads, keeps the selected thread usable if that list is still refreshing, and loads older sidebar rows asynchronously.
4. Restart the safe service with no warm in-memory thread-list cache and confirm the first `thread/list` response can come from `session_index.jsonl` metadata while the real app-server list refreshes in the background.
5. Select a thread with long output and confirm the conversation body loads through paged current-thread text/detail requests rather than a full sidebar detail scan.
6. Confirm the initial selected-thread transcript displays only the newest 3 turns by default; older turns load only through explicit older-page pagination and this display window does not alter Codex reasoning context.
7. While the selected thread is running, let new assistant text arrive and confirm previously loaded reasoning/output remains visible while the new tail appends promptly without waiting for the generic notification debounce.
8. Inspect `/codex-api/thread-text-page` calls after the selected thread has a cached detail/live snapshot, or after a service restart where only the local rollout file is available, and confirm they use the resolved rollout path instead of issuing `thread/read` before every page.
9. Trigger or observe a notification for a different loaded thread and confirm the UI refreshes only that changed thread's visible status/metadata instead of issuing a full thread-list refresh.
10. Inspect `/codex-api/thread-runtime-states` calls and confirm each batch stays small, probes a loaded selected thread before the sidebar/background batch, includes recently running/actionable visible rows, and does not rotate through all historical loaded threads.
11. Open a blue-dot thread, return to another thread, then let sidebar metadata refresh; confirm the read row does not regain a blue dot just because its metadata timestamp changed.
12. Confirm historical turns show assistant/user body summaries but do not expose reasoning text; only the last running turn can show reasoning body text.
13. Confirm title-only reasoning statuses such as `Planning ...`, `Updating ...`, `Inspecting ...`, and `Reviewing ...` do not appear as reasoning transcript text.
14. Leave a long selected thread open while another Codex client writes new output; confirm the selected external live projection checks for changes at the fast selected interval, about 150 ms while the tab is visible, and appends each new paragraph-sized tail instead of batching several updates together.
15. Inspect a running `/codex-api/thread-live-state` response and confirm it contains only lightweight projection metadata plus an empty or compressed conversation shell, not the active turn's large `items` payload; the browser should then fetch `/codex-api/thread-text-page` for the active text delta.
16. Open two visible mobile windows on the same selected running thread and watch server/network logs while new assistant text arrives; confirm only one window performs each identical selected active-text page request and the other window receives the same delta through the cross-window sync path.
17. Hide or close the window that was issuing selected active-text requests, then let another assistant paragraph arrive; confirm a remaining visible window takes over promptly without waiting for a long timeout or replaying the whole active turn.
18. With server logs open, confirm the selected `/codex-api/thread-live-state` request reuses a recent `/codex-api/thread-runtime-states` running observation when available, can use a fresh running desktop-writer snapshot for the first projection, and treats a recently updated unmatched rollout as running even when the writer does not hold an open fd.
19. Restart the safe service while another Codex client owns the selected running thread, then leave that client quiet for several minutes without a terminal lifecycle record; confirm `/codex-api/thread-text-page` keeps returning the active page from the local rollout path instead of falling back to slow `thread/read` or `409`.
20. Confirm intermediate assistant progress/commentary rows may render as transcript body, but `Copy` and `Fork` controls appear only on a completed final assistant response; copying that response excludes prior commentary/progress text.
21. Let the selected running turn complete from another Codex client and confirm the final detail refresh happens immediately rather than waiting for the generic event-sync debounce or an external runtime poll.
22. Repeat the visible checks in dark theme.

#### Expected Results
- Cold sidebar load and background sidebar pagination remain metadata-only.
- Cold sidebar load shows the newest 5 known threads first, can use a lightweight `session_index.jsonl` fallback on service restart, and loads the rest asynchronously.
- Switching threads does not fetch every loaded thread's turn content.
- Initial selected-thread detail displays the newest 3 turns only; older turns remain available through pagination and this display limit does not affect model context.
- Active-thread output appends incrementally without clearing already displayed hydrated reasoning or assistant text.
- Selected active-thread text deltas trigger a dedicated newest-text refresh immediately; generic notification debounce remains reserved for list/runtime/background reconciliation.
- Selected external running threads use a fast lightweight live-projection check of about 150 ms while visible; the heavier active-turn text page is fetched only when the projection key changes.
- Running live-state payloads do not include the active turn's full item history; the selected text page endpoint supplies only the missing newest tail.
- Multiple visible windows on the same origin and selected thread share identical active-text page requests through `BroadcastChannel('codex-mobile-thread-sync')`; same-thread backend read cost is close to one visible window, while different selected running threads still poll independently.
- A hidden, closed, or stale leader window does not block a visible follower from taking over selected active-text sync.
- Selected external live projection is not serialized behind a sidebar runtime batch: the selected thread gets an isolated first runtime probe, and live-state can reuse a short-lived running runtime observation or a fresh writer snapshot instead of starting another slow inspect.
- Running detection does not depend solely on a long-lived writable fd; an active rollout with an unmatched `task_started` and a file update within the quiet grace window is enough to keep the selected task in the realtime path.
- Active-turn text paging reuses the cached session path from the selected thread snapshot, so paragraph-sized deltas are not serialized behind repeated `thread/read` calls.
- After a service restart, known-key live-state and active-turn text paging can rediscover the local rollout path from `CODEX_HOME/sessions` by thread id, avoiding a cold `thread/read` before realtime resumes.
- Selected current-turn completion notifications cancel pending external projection polls and refresh the final detail immediately.
- Known-thread notifications drive targeted message/runtime refreshes; full thread-list refresh happens only for unknown or structural list changes.
- Runtime-state polling stays bounded to the selected, visible/actionable, and recently running set.
- Read sidebar rows do not regain blue unread dots from metadata-only timestamp refreshes.
- A selected long thread that was previously showing a truncated terminal/live window repairs itself after the compressed projection changes; existing output stays visible and the newest tail appears.
- Historical reasoning remains hidden, running-last-turn reasoning body remains visible, and title-only reasoning statuses are filtered.
- Response actions are anchored to final assistant body text only; retained commentary/progress rows do not expose `Copy` or `Fork`.
- The behavior is readable and stable in light and dark themes.

#### Rollback/Cleanup
- Stop any manually started dev server or safe service if it is not normally running.
- Close any extra mobile test windows or tabs opened for the multi-window sync check.

---
