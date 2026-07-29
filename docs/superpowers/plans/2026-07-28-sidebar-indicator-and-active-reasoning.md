# Sidebar Indicator and Active Reasoning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the sidebar-button notification state and the complete running-turn reasoning transcript match the mobile sidebar and Codex client behavior.

**Architecture:** Extract one pure sidebar display-state resolver and reuse it in both the thread tree and the top-level aggregate. Extend the existing text-only active-turn pagination so compressed local projections hydrate exactly like external projections, while realtime reasoning remains accumulated until turn completion.

**Tech Stack:** Vue 3, TypeScript, Vitest, Codex app-server RPC and rollout text pagination.

## Global Constraints

- `working` and `idle` threads do not activate the top sidebar dot.
- `unread`, `awaiting-response`, and `awaiting-approval` threads activate it.
- Only the last running turn exposes reasoning transcript text.
- Completed and historical reasoning stays hidden.
- Existing dirty worktree changes must be preserved.

---

### Task 1: Canonical sidebar notification state

**Files:**
- Create: `src/components/sidebar/threadSidebarState.ts`
- Create: `src/components/sidebar/threadSidebarState.test.ts`
- Modify: `src/components/sidebar/SidebarThreadTree.vue`
- Modify: `src/App.vue`

**Interfaces:**
- Produces: `getSidebarThreadState(thread): SidebarThreadState`
- Produces: `hasSidebarAttention(groups): boolean`

- [ ] **Step 1: Write the failing test**

Cover all five states and assert that only `working` and `idle` are excluded
from the aggregate attention dot.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/sidebar/threadSidebarState.test.ts`

Expected: FAIL because `threadSidebarState` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create the shared resolver, replace `SidebarThreadTree.vue`'s local
`getThreadState`, and change `App.vue` from raw `thread.unread` aggregation to:

```ts
const hasUnreadSidebarThreads = computed(() => hasSidebarAttention(projectGroups.value))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/components/sidebar/threadSidebarState.test.ts`

Expected: PASS.

### Task 2: Running-turn reasoning transcript visibility

**Files:**
- Modify: `src/components/content/threadConversationActivity.test.ts`
- Modify: `src/components/content/threadConversationActivity.ts`

**Interfaces:**
- Consumes: `shouldRenderReasoningAsTranscript(message, context)`
- Produces: running active-turn reasoning is transcript text for both local and external ownership.

- [ ] **Step 1: Write the failing test**

Add a local active-turn case with `readOnly: false` and expect `true`; keep
inactive and wrong-turn cases false.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/content/threadConversationActivity.test.ts`

Expected: FAIL because local running reasoning is currently compact activity.

- [ ] **Step 3: Write minimal implementation**

Remove the `readOnly` ownership gate while retaining active-turn and
in-progress guards.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/components/content/threadConversationActivity.test.ts`

Expected: PASS.

### Task 3: Compressed local active-turn text hydration

**Files:**
- Modify: `src/api/codexGateway.test.ts`
- Modify: `src/api/codexGateway.ts`
- Modify: `src/composables/useDesktopState.test.ts`
- Modify: `src/composables/useDesktopState.ts`

**Interfaces:**
- Produces: `getThreadDetail()` sets `isPartialTurnProjection` for compressed active local turns.
- Consumes: existing `getThreadTextPage(threadId, turnId, cursor, limit, signal)`.

- [ ] **Step 1: Write failing gateway and state tests**

Assert that a paged `thread/read` response with active-turn
`rawItemCompression.omittedItemCount > 0` is partial, and that a local running
partial projection starts hydration and retains every returned reasoning item.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/api/codexGateway.test.ts src/composables/useDesktopState.test.ts`

Expected: FAIL because local paged projections neither report partial state nor
start text hydration.

- [ ] **Step 3: Write minimal implementation**

Detect the active raw turn's compression in `getThreadDetailV2` and start
hydration whenever `isPartialTurnProjection`, `inProgress`, and `activeTurnId`
are present, regardless of live/local ownership.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/api/codexGateway.test.ts src/composables/useDesktopState.test.ts`

Expected: PASS.

### Task 4: Preserve realtime reasoning across content items

**Files:**
- Modify: `src/composables/useDesktopState.test.ts`
- Modify: `src/composables/useDesktopState.ts`

**Interfaces:**
- Consumes: normalized `item/reasoning/*` and `item/agentMessage/*` notifications.
- Produces: one accumulated live reasoning transcript for the active turn.

- [ ] **Step 1: Write the failing test**

Emit reasoning delta, agent-message delta, a second reasoning item, and another
reasoning delta. Assert that both reasoning sections remain in order.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/composables/useDesktopState.test.ts`

Expected: FAIL because agent content currently clears prior reasoning.

- [ ] **Step 3: Write minimal implementation**

Do not clear reasoning on agent-content events. Insert a paragraph boundary
when a new reasoning item starts and prior reasoning exists. Continue clearing
on turn completion and thread reset.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/composables/useDesktopState.test.ts`

Expected: PASS.

### Task 5: Full verification and deployment

**Files:**
- No source changes expected.

**Interfaces:**
- Consumes: all changes from Tasks 1-4.
- Produces: deployed `codex-mobile-safe` service serving the verified build.

- [ ] **Step 1: Run the full unit suite**

Run: `pnpm test:unit`

Expected: all tests pass.

- [ ] **Step 2: Run the production build**

Run: `pnpm build`

Expected: frontend typecheck/Vite build and CLI build pass.

- [ ] **Step 3: Restart and inspect the service**

Run: `pnpm service:restart` followed by `pnpm service:status`.

Expected: `codex-mobile-safe.service` is active on the configured safe
interface.

- [ ] **Step 4: Verify in the browser**

Confirm the top dot follows unread/pending states and a running last turn
retains all paged and realtime reasoning text without showing historical
reasoning.
