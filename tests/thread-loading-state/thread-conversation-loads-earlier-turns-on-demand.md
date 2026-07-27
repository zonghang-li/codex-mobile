### Thread conversation loads older persisted turns only when reported

#### Feature/Change Name
Thread conversation older-turn loading.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev --host 127.0.0.1 --port 4173`)
2. A thread source or fixture can return `hasMoreOlder: true`
3. Light theme and dark theme both available from the appearance switcher

#### Steps
1. Open a normal long thread whose `thread/read` response includes all turns.
2. Confirm the middle turns are visible and the conversation does not show `Load earlier messages`.
3. Open a fixture or legacy/paginated thread source that reports `hasMoreOlder: true`.
4. Confirm the newest returned messages render first and the conversation shows `Load earlier messages` at the top.
5. Click `Load earlier messages` once.
6. Confirm an older persisted batch is prepended above the previously first visible turn and the scroll position stays near the same content.
7. Continue clicking `Load earlier messages` until the control disappears.
8. Confirm the oldest messages in the thread are visible and no duplicate message rows are introduced.
9. Switch to dark theme and repeat steps 1-8 on the same thread or another long thread.

#### Expected Results
- Current full-history thread loads render all already-loaded turns without a local frontend window.
- `Load earlier messages` appears only while the backend reports older persisted turns.
- The control fetches older persisted turns from the local bridge instead of revealing messages already present in memory.
- Message ordering, turn actions, and scroll restoration remain stable in light and dark themes.

#### Rollback/Cleanup
- None.

---
