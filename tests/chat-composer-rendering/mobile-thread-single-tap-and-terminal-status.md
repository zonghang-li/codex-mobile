### Feature: Mobile thread single tap and terminal status

#### Prerequisites

- Run the integrated verification build on the current Task 7 branch at port 4173.
- Use Playwright device contexts at 375x812 and 768x1024 with touch enabled, `hasTouch: true`, and a coarse/no-hover pointer.
- Test both light and dark themes at each viewport.
- Provide three threads: an idle selectable thread, a background thread with a controllable running turn, and a second thread that can remain selected while the background turn completes successfully.
- Record the browser trace and relevant route/thread requests so duplicate navigation or fetching can be detected.

#### Steps

Repeat the following sequence for 375x812 light, 375x812 dark, 768x1024 light, and 768x1024 dark:

1. Open the mobile drawer and note the initial thread-row layout before touching a row.
2. Tap the idle thread's main button once.
3. Confirm its route becomes active and the drawer closes without a second tap.
4. Reopen the drawer and tap the visible overflow control without first tapping or long-pressing the row.
5. Confirm the thread action menu opens and that tapping the overflow control does not navigate.
6. Start the controllable background turn and keep another thread selected.
7. Reopen the drawer and confirm the running thread retains its rotating indicator; open the running thread and confirm the composer exposes the stop control rather than the send arrow.
8. Return to the other thread, let the background turn finish successfully, and reopen the drawer.
9. Confirm the completed background thread shows a blue unread dot rather than the rotating indicator.
10. Tap that thread's main button once and confirm the route changes once, the drawer closes, and the unread dot clears when the drawer is reopened.
11. Inspect the trace and request log for the sequence: each main-button tap causes one navigation and no duplicate thread request; overflow actions cause no navigation.

#### Expected Results

- Coarse-pointer rows begin in a stable layout with the overflow action already reachable; retained synthetic hover never hides a running, pending, or unread indicator.
- A single main-button tap opens the requested thread exactly once and closes the drawer.
- The overflow control opens its menu directly and does not select the thread.
- Running state shows the sidebar spinner and composer stop control until a terminal outcome.
- Successful background completion replaces the spinner with a blue unread dot; selecting the thread clears the dot.
- Layout and controls remain readable and usable at both viewports in light and dark themes.

#### Task 7 Screenshot Paths

- `output/playwright/codex-mobile-thread-ux-375x812-light-single-tap.png`
- `output/playwright/codex-mobile-thread-ux-375x812-light-overflow.png`
- `output/playwright/codex-mobile-thread-ux-375x812-light-running.png`
- `output/playwright/codex-mobile-thread-ux-375x812-light-unread.png`
- `output/playwright/codex-mobile-thread-ux-375x812-dark-single-tap.png`
- `output/playwright/codex-mobile-thread-ux-375x812-dark-overflow.png`
- `output/playwright/codex-mobile-thread-ux-375x812-dark-running.png`
- `output/playwright/codex-mobile-thread-ux-375x812-dark-unread.png`
- `output/playwright/codex-mobile-thread-ux-768x1024-light-single-tap.png`
- `output/playwright/codex-mobile-thread-ux-768x1024-light-overflow.png`
- `output/playwright/codex-mobile-thread-ux-768x1024-light-running.png`
- `output/playwright/codex-mobile-thread-ux-768x1024-light-unread.png`
- `output/playwright/codex-mobile-thread-ux-768x1024-dark-single-tap.png`
- `output/playwright/codex-mobile-thread-ux-768x1024-dark-overflow.png`
- `output/playwright/codex-mobile-thread-ux-768x1024-dark-running.png`
- `output/playwright/codex-mobile-thread-ux-768x1024-dark-unread.png`

Task 3 prepares this procedure only. Task 7 owns browser execution, trace inspection, and screenshot capture after all tasks are integrated.

#### Performance Findings

- Task 3 adds no requests, polling, watchers, timers, or dependencies. Its runtime changes are CSS capability queries and removal of duplicate outer-row selection handlers.
- Task 7 must confirm from the integrated browser trace that one tap does not create duplicate navigation or thread requests and that the drawer/status transitions add no repeated fetch loop.

#### Rollback/Cleanup

- Stop the controllable fixture turn and close any open thread action menu.
- To roll back Task 3, revert the sidebar media-query changes and restore the previous thread-row selection bindings together; rerun `mobileSidebarInteraction.test.ts` to confirm the rollback is intentional.
