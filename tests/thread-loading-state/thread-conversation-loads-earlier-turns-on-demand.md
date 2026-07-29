### Thread conversation loads older persisted turns only when reported

#### Feature/Change Name
Thread conversation older-turn loading.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev --host 127.0.0.1 --port 4173`)
2. A thread source or fixture can return `hasMoreOlder: true`
3. Light theme and dark theme both available from the appearance switcher

#### Steps
1. Open a long native Codex thread with more than 15 turns.
2. Confirm initial hydration renders the newest five turns and shows `Load earlier messages`.
3. Inspect the first `/codex-api/thread-turn-page` response and record its opaque `nextCursor`.
4. Click `Load earlier messages` once and confirm the request forwards that cursor unchanged and requests no more than ten turns.
5. Confirm the older persisted batch is prepended above the previously first visible turn and the scroll position stays near the same content.
6. While older history is visible, allow one live-state poll or force-refresh the selected thread.
7. Confirm all already-loaded turns remain visible and the next older request continues from the deeper cursor instead of restarting at the first page.
8. Continue clicking `Load earlier messages` until the cursor becomes null and the control disappears.
9. Confirm the oldest messages are visible, indices remain ordered, and no duplicate rows are introduced.
10. Switch to dark theme and repeat the flow.

#### Expected Results
- Initial hydration returns the newest five full turns.
- `Load earlier messages` appears only while the backend reports older persisted turns.
- Each control activation follows the exact opaque cursor and fetches no more than ten older persisted turns.
- Live polling and forced refreshes never hide already-loaded messages or reset pagination progress.
- Repeated or cyclic cursors stop pagination without inserting a duplicate page.
- Message ordering, turn actions, and scroll restoration remain stable in light and dark themes.

#### Rollback/Cleanup
- None.

---
