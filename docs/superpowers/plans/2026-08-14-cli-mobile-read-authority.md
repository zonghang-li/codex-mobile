# CLI and Mobile Read Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep an active Codex CLI turn as one read-only, rollout-backed mobile projection without stale interrupted state or a competing mobile writer.

**Architecture:** Canonicalize `thread/read` after external runtime inspection so the matching active turn is always one `inProgress` turn with existing items preserved. Extend Linux writer evidence to recognize direct Codex CLI commands as non-interruptible, while retaining app-server interrupt semantics. Remove the cross-process external-steer bypass so all mobile writes remain queued during external ownership.

**Tech Stack:** TypeScript, Vue 3 composables, Node.js Linux `/proc` inspection, Vitest, Playwright.

## Global Constraints

- Do not modify `/home/zonghangli/Desktop/prima.cpp` or any Prima worktree.
- Preserve archived lifecycle guards and protected archived samples.
- Use TDD: each production change follows a failing focused test.
- Pure page open and refresh must issue no writer RPC.
- Active text merges by `turnId` and `sessionOrder` and never clears history.
- External ownership is read-only; attempted writes remain durable queued work.

---

### Task 1: Canonical External Turn Projection

**Files:**
- Modify: `src/server/codexAppServerBridge.ts`
- Test: `src/server/externalThreadRuntimeBridge.test.ts`

**Interfaces:**
- Consumes: `ExternalThreadRuntime` returned by `runtimeProbe.inspect()`.
- Produces: `reconcileThreadResultWithExternalRuntime(result, runtime)` returning one matching active turn with `status: 'inProgress'`.

- [x] Add a route test where native `thread/read` returns `interrupted` with items while runtime inspection returns the same turn as external `running`; assert HTTP `thread/read` preserves items and returns that turn as `inProgress`.
- [x] Run `pnpm vitest run src/server/externalThreadRuntimeBridge.test.ts -t "canonicalizes a stale interrupted CLI turn"` and confirm RED on `status`.
- [x] Implement the smallest immutable reconciliation in `augmentThreadResultWithExternalRuntime` for an existing matching runtime turn.
- [x] Run the focused server test and the full `externalThreadRuntimeBridge.test.ts` file; confirm GREEN.

### Task 2: Direct CLI Writer Evidence

**Files:**
- Modify: `src/server/externalThreadRuntime.ts`
- Test: `src/server/externalThreadRuntime.test.ts`

**Interfaces:**
- Produces: Codex process classification from NUL-delimited command lines.
- Preserves: `ExternalThreadRuntime.source === 'external-session-writer'`.
- Guarantees: direct CLI writer evidence yields `interruptible: false`; app-server-only evidence may yield `true`.

- [x] Add failing tests for `/usr/bin/codex resume`, flag-only direct CLI writer evidence, and mixed direct-CLI/app-server descriptors on the same rollout.
- [x] Run the focused tests and confirm direct CLI evidence is currently ignored or incorrectly interruptible.
- [x] Include direct Codex commands in descriptor discovery, aggregate writer kind conservatively, and restrict process signaling to app-server writers.
- [x] Run `pnpm vitest run src/server/externalThreadRuntime.test.ts` and confirm GREEN.

### Task 3: External Ownership Is Read-Only

**Files:**
- Modify: `src/composables/useDesktopState.ts`
- Modify: `src/App.vue`
- Modify: `src/api/codexGateway.ts`
- Modify: `src/server/codexAppServerBridge.ts`
- Test: `src/composables/useDesktopState.test.ts`
- Test: `src/api/codexGateway.test.ts`
- Test: `src/server/externalThreadRuntimeBridge.test.ts`
- Test: `src/components/content/externalThreadRuntime.wiring.test.ts`

**Interfaces:**
- External composer submissions call `enqueueExternalTextOnlyThreadMessage()` only.
- Raw `turn/start` never receives an external-steer ownership bypass.

- [x] Change client tests to require externally owned Steer submissions and ownership-race retries to persist in queue without calling `startThreadTurn`.
- [x] Change server tests to require an external-steer-marked raw `turn/start` to remain blocked.
- [x] Run focused client/server tests and confirm RED.
- [x] Remove `startExternalTextSteer`, its retry branch, the gateway marker, and the server bypass; disable every queued Steer control during external ownership.
- [x] Run all focused test files and confirm GREEN.

### Task 4: Verification and Deployment

**Files:**
- Update: `tests/projects-sidebar-new-chat/mobile-thread-loading-and-delta-sync.md` when behavior wording is stale.

- [x] Run focused server, text hydration, gateway, and desktop-state tests.
- [x] Run `pnpm run test:unit`, `pnpm run build`, CLI help, and `git diff --check`.
- [ ] Perform an independent review and resolve every Critical, Important, and Nit finding.
- [ ] Run `pnpm run install:local` and `pnpm run service:restart`.
- [ ] Run `codex-mobile-safe status` and `codex-mobile-safe doctor`.
- [ ] Use Playwright to open and refresh an active non-protected CLI thread; assert zero `thread/resume`, zero `turn/start`, one active turn ID, and no additional rollout lifecycle event.
- [ ] Commit the implementation and report commit, tests, service PID, and migration requirements.
