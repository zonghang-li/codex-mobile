### Sidebar thread main target selects thread

#### Feature/Change Name
Thread rows expose one explicit main navigation target, while pin/menu controls remain independent actions.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. Sidebar contains multiple threads
3. At least one thread has visible time text on the right

#### Steps
1. Hover a thread row and confirm the row highlight appears
2. Click the thread title/body inside the main thread button
3. Reopen the sidebar, then click the pin button and menu button
4. On a coarse-pointer viewport, tap the main thread button once
5. Reopen the sidebar and tap the already-visible overflow control once

#### Expected Results
- The main thread button opens the clicked thread with one navigation/request path
- Pin and menu controls do not select or resume the thread
- The coarse-pointer overflow control is reachable without a preparatory tap or long press
- The row has no competing outer click handler, so one tap never produces duplicate navigation

#### Rollback/Cleanup
- None

---
