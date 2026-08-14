### Thread archive recovery and sidebar pruning

#### Feature/Change Name
Deleting a thread uses the controlled stop-and-archive route, verifies durable archive state, clears queued work, and removes successfully archived threads from the sidebar immediately.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. Codex CLI available on `PATH`
3. At least two normal threads, one archived thread, and one newly-created thread that has not yet produced a rollout
4. Light theme and dark theme both available from the appearance switcher

#### Steps
1. In light theme, create a new empty thread from the sidebar.
2. Open that thread's menu and choose `Delete thread`.
3. Confirm the thread disappears from the sidebar without a `no rollout found` error.
4. Rename another visible thread, then delete it.
5. Confirm the renamed thread disappears immediately and does not reappear after sidebar refresh/background pagination.
6. Queue a disposable message on a normal thread, delete that thread, and confirm its queued work is removed rather than drained after archive.
7. Call `thread/list` with `archived:false` through `/codex-api/rpc` and confirm the deleted thread ids are absent while an unrelated active thread remains present.
8. Call `thread/list` with `archived:true` and confirm the deleted thread ids are present.
9. Confirm raw `thread/archive`, `thread/unarchive`, `thread/goal/set`, and `thread/goal/clear` requests are rejected and that the UI uses the controlled lifecycle routes.
10. Refresh the sidebar and search for the archived thread; confirm no persisted list cache, search index, delta refresh, queue drain, or runtime recovery makes it active or visible again.
11. Run an existing heartbeat automation for the archived thread and confirm the request fails without creating a durable queue row.
12. Switch to dark theme and repeat steps 1-5.

#### Expected Results
- Empty or not-yet-materialized threads fail visibly when archive cannot be verified; the UI never reports a false successful deletion.
- Already archived threads are treated as archived instead of surfacing a stale `no rollout found` error.
- The controlled route interrupts only a validated local active turn, waits until writer evidence is idle, clears its goal and durable queue, archives it, and verifies the result before reporting success.
- State DB archive status is scoped to the exact thread id and never hides an unrelated active thread or project.
- The sidebar prunes archived ids from its accumulated paginated list before refreshing.
- Older unarchived threads may appear as the list refills, but archived threads do not remain visible.
- Behavior is consistent in light and dark themes.

#### Rollback/Cleanup
- None.
