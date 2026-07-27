# Live State Not Modified Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce mobile live refresh latency by avoiding repeated 20MB+ `/codex-api/thread-live-state` responses when the selected external task projection has not changed.

**Architecture:** The server will attach a stable `projectionKey` to full live-state projections and accept `knownProjectionKey` on subsequent requests. When the current projection key matches, the server returns a lightweight `notModified` response carrying only runtime/live-authority fields. The frontend gateway will pass the previous key and represent not-modified responses without messages; the desktop state store will update runtime/footer state while preserving existing persisted messages.

**Tech Stack:** TypeScript, Node HTTP middleware, Vue composable state, Vitest.

## Global Constraints

- Preserve current correctness: external desktop-owned running tasks must not derive active footer numbers from stale messages.
- Preserve local/non-external task behavior.
- Do not add dependencies.
- Use TDD: write failing tests before implementation.

---

### Task 1: Server Not-Modified Response

**Files:**
- Modify: `src/server/codexAppServerBridge.ts`
- Test: `src/server/externalThreadRuntimeBridge.test.ts`

**Interfaces:**
- Consumes: `GET /codex-api/thread-live-state?threadId=<id>&knownProjectionKey=<key>`
- Produces: full responses with `projectionKey: string`; lightweight responses with `{ notModified: true, projectionKey, isInProgress, externalRuntime, liveAuthority, liveSnapshot }`.

- [ ] **Step 1: Write failing tests**
  - A full live-state response includes `projectionKey`.
  - A second request with matching `knownProjectionKey` returns `notModified: true` and omits `conversationState`.
  - A request with stale `knownProjectionKey` still returns a full projection.

- [ ] **Step 2: Run tests to verify RED**
  - Run `pnpm vitest run src/server/externalThreadRuntimeBridge.test.ts -t "projection key|not modified"`.
  - Expected: fail because `projectionKey` / `notModified` do not exist.

- [ ] **Step 3: Implement server projection key**
  - Compute the key from thread id, turn count, session size, external runtime state/turn id, live authority, and live snapshot revision.
  - Return not-modified only after runtime and live snapshot freshness are recomputed.

- [ ] **Step 4: Run tests to verify GREEN**
  - Run the same focused test command.
  - Expected: pass.

### Task 2: Gateway and State Preservation

**Files:**
- Modify: `src/api/codexGateway.ts`
- Modify: `src/composables/useDesktopState.ts`
- Test: `src/api/codexGateway.test.ts`
- Test: `src/composables/useDesktopState.test.ts`

**Interfaces:**
- Consumes: `getExternalThreadLiveSnapshot(threadId, signal, knownProjectionKey?)`.
- Produces: detail snapshots with optional `projectionKey` and `notModified`.

- [ ] **Step 1: Write failing tests**
  - Gateway sends `knownProjectionKey` when provided and normalizes `notModified` responses without messages.
  - State store passes the last key on external polling and preserves persisted messages on not-modified responses.

- [ ] **Step 2: Run tests to verify RED**
  - Run focused Vitest tests for gateway and state store.
  - Expected: fail because the parameter and not-modified handling do not exist.

- [ ] **Step 3: Implement gateway/state changes**
  - Store `projectionKeyByThreadId`.
  - Pass key to external polling.
  - For `notModified`, update runtime/live authority/snapshot but skip message replacement.

- [ ] **Step 4: Run tests to verify GREEN**
  - Run focused tests.
  - Expected: pass.

### Task 3: Verification, Deployment, PR

**Files:**
- No planned code changes.

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: deployed `codex-mobile-safe` with lightweight no-change live polling.

- [ ] **Step 1: Run regression**
  - `pnpm run test:unit`
  - `pnpm run build`
  - `git diff --check`

- [ ] **Step 2: Install and restart**
  - `pnpm run install:local`
  - `systemctl --user restart codex-mobile-safe.service`
  - `systemctl --user --no-pager --full status codex-mobile-safe.service`

- [ ] **Step 3: Verify live endpoint behavior**
  - First request returns full JSON with `projectionKey`.
  - Second request with `knownProjectionKey` returns `notModified: true` and a much smaller body.

- [ ] **Step 4: Commit, push, PR, merge**
  - Commit implementation.
  - Push branch.
  - Create PR.
  - Merge after checks/review.
  - Sync local `main` to `origin/main`.
