# Mobile Reliability and Conversation Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `subagent-driven-development` to execute this plan task by task with requirements and code-quality review checkpoints.

**Goal:** Make the mobile conversation page reliable under external desktop activity and compaction, remove misleading protocol/UI artifacts, and align the active conversation controls with Codex desktop behavior.

**Architecture:** Treat an existing task as a read-only projection until the user explicitly sends a new turn. Keep the full turn history available, but prune historical `reasoning` items server-side and display only each completed turn's final assistant reply so only the latest running turn carries live reasoning/progress. Keep uploaded images ephemeral and represented by text tokens. Preserve native Codex goal RPCs and completion state while removing UI-only artifacts.

**Tech Stack:** Vue 3, TypeScript, Vite, Vitest, Codex app-server JSON-RPC, Express-compatible server bridge, Playwright/Chromium for final visual QA.

## Global Constraints

- Work only in `/tmp/codex-mobile-reliability-ui` on branch `codex/mobile-reliability-ui`.
- Preserve the user's dirty main checkout.
- Use test-first changes: add one focused failing assertion, run it, implement the smallest fix, rerun it.
- Existing task selection and refresh must never call `thread/resume`.
- Initial task detail and live snapshots contain all turns, with `reasoning` items removed from every non-running turn and intermediate assistant progress hidden for completed turns.
- Never surface `item/tool/call` as an approval choice. Never fabricate success for a tool call.
- Uploaded image bytes may exist only as short-lived server-owned input until handoff; drafts/history show only `@filename`.
- General `/tmp` image serving remains denied.
- The active file-change footer is unique and stays at the transcript bottom, below Fork/Copy and above Goal/the composer.
- Subagent status chips remain non-interactive, transparent, and visually quiet.
- `Approve for me` remains a fixed backend policy and is not rendered in the composer.
- Goal operations use native `thread/goal/*` RPCs and remain available while an external writer owns the turn.
- Interrupted turns retain state metadata but do not render a “You stopped” transcript row.

### Task 1: Make existing task loading read-only and handle dynamic tool calls safely

**Files:**

- Modify: `src/composables/useDesktopState.test.ts`
- Modify: `src/composables/useDesktopState.ts`
- Modify: `src/server/externalThreadRuntimeBridge.test.ts`
- Modify: `src/server/codexAppServerBridge.ts`
- Modify: `src/components/content/ThreadPendingRequestPanel.vue`

**Red:**

1. Add a state test proving that selecting or refreshing an existing task calls `thread/read`, not `thread/resume`.
2. Add a bridge test proving that resume degrades to read when another process owns the task.
3. Add request tests proving `item/tool/call` is excluded from pending approvals and receives an explicit unsupported-tool error only when the request belongs to the current app-server process.
4. Run:

   `pnpm vitest run src/composables/useDesktopState.test.ts src/server/externalThreadRuntimeBridge.test.ts`

**Green:**

1. Remove resume-on-load behavior from `loadMessages`.
2. Keep resume/start exclusively in the explicit send path.
3. Add the external-writer guard before any server-side resume.
4. Classify dynamic tool calls separately from approval/user-input requests.
5. Remove the generic “Fail Tool Call / Success (Empty)” presentation.

**Verify:**

`pnpm vitest run src/composables/useDesktopState.test.ts src/server/externalThreadRuntimeBridge.test.ts`

### Task 2: Load full history while pruning historical reasoning/progress

**Files:**

- Modify: `src/server/codexAppServerBridge.liveSnapshot.test.ts`
- Modify: `src/server/codexAppServerBridge.ts`
- Modify: `src/api/codexGateway.test.ts`
- Modify: `src/api/codexGateway.ts`
- Modify: `src/composables/useDesktopState.test.ts`
- Modify: `src/composables/useDesktopState.ts`

**Red:**

1. Add server tests requiring initial detail to retain all turns while pruning `reasoning` from non-running turns.
2. Add live-snapshot tests requiring the same full-history/pruned-reasoning shape and preserving `threadTurnStartIndex`.
3. Add client tests proving live projection preserves older visible turns while updating the active turn.
4. Add normalizer tests proving completed historical turns hide intermediate assistant progress while preserving the latest running turn's progress.
5. Add a visibility test proving polling pauses while the document is hidden and resumes immediately when visible.

**Green:**

1. Remove the initial response turn limit.
2. Create live responses from the full sanitized turn list after pruning historical reasoning.
3. Preserve the absolute turn offset through gateway normalization.
4. Normalize completed turns to render only the final assistant reply by default.
5. Merge live snapshots without clearing earlier loaded history.
6. Avoid rescheduling redundant polling while a poll is already pending.

**Verify:**

`pnpm vitest run src/server/codexAppServerBridge.liveSnapshot.test.ts src/api/codexGateway.test.ts src/api/normalizers/v2.test.ts src/composables/useDesktopState.test.ts`

### Task 3: Replace uploaded-image previews with ephemeral text attachments

**Files:**

- Modify: `src/components/content/ThreadComposer.vue`
- Modify: `src/components/content/composerControlState.test.ts`
- Modify: `src/api/codexGateway.test.ts`
- Modify: `src/api/codexGateway.ts`
- Modify: `src/server/codexAppServerBridge.security.test.ts`
- Modify: `src/server/codexAppServerBridge.ts`
- Add: `src/components/content/threadComposerAttachments.wiring.test.ts`

**Red:**

1. Add component assertions that uploaded images render as `@filename` text and never as `<img>`.
2. Add draft assertions that temporary upload paths/URLs are not persisted.
3. Add gateway/server tests for deleting only a managed upload handle.
4. Add security tests rejecting arbitrary paths, traversal, and symlink escape.
5. Add send-order tests proving cleanup happens after accepted handoff, and also on removal/failure.

**Green:**

1. Keep only a managed upload identity, display name, and temporary send path in memory.
2. Render the attachment as a removable text token.
3. Exclude attachment paths from local draft persistence.
4. Add a narrowly scoped cleanup endpoint rooted in the server-owned upload directory.
5. Cleanup after removal, discard, failed send, or successful turn handoff.
6. Leave assistant-generated image rendering unchanged.

**Verify:**

`pnpm vitest run src/components/content/threadComposerAttachments.wiring.test.ts src/api/codexGateway.test.ts src/server/codexAppServerBridge.security.test.ts`

### Task 4: Keep one file-change footer and align conversation action placement

**Files:**

- Modify: `src/components/content/conversationRunFooter.wiring.test.ts`
- Modify: `src/components/content/ThreadConversation.vue`

**Red:**

1. Add a wiring assertion that the active turn never renders an anchored in-stream file-change summary.
2. Preserve a historical-turn assertion so older summaries still render in their original context.
3. Assert Fork/Copy stays attached to the final response and the active footer follows it before Goal/the composer boundary.

**Green:**

1. Suppress anchored file changes when their `turnId` matches `activeTurnId`.
2. Preserve historical anchored summaries.
3. Keep Fork/Copy directly below the final response, followed by the active run footer at the conversation bottom.

**Verify:**

`pnpm vitest run src/components/content/conversationRunFooter.wiring.test.ts`

### Task 5: Match Codex subagent chips and simplify the composer

**Files:**

- Modify: `src/components/content/subAgentActivity.test.ts`
- Modify: `src/components/content/subAgentActivity.ts`
- Modify: `src/components/content/ThreadConversation.vue`
- Modify: `src/components/content/composerControlState.test.ts`
- Modify: `src/components/content/composerControlState.ts`
- Modify: `src/components/content/ThreadComposer.vue`

**Red:**

1. Add tests for deterministic green/purple/pink agent tones.
2. Assert agent chips are non-buttons with transparent fill and a thin neutral border.
3. Assert the composer no longer renders `Approve for me`.

**Green:**

1. Derive a stable tone from agent identity while keeping existing icon components.
2. Use a transparent background in both themes and a subtle border.
3. Remove the fixed permission label from composer state, markup, and layout.

**Verify:**

`pnpm vitest run src/components/content/subAgentActivity.test.ts src/components/content/composerControlState.test.ts`

### Task 6: Enable native Goal controls throughout the task lifecycle

**Files:**

- Modify: `src/safe/featureGate.test.ts`
- Modify: `src/safe/featureGate.ts`
- Modify: `src/server/securityPolicy.test.ts`
- Modify: `src/components/content/composerControlState.test.ts`
- Modify: `src/components/content/composerControlState.ts`
- Modify: `src/components/content/conversationRunFooter.wiring.test.ts`
- Modify: `src/components/content/ConversationRunFooter.vue`
- Modify: `src/composables/useDesktopState.test.ts`
- Modify: `src/composables/useDesktopState.ts`
- Modify: `src/App.vue`

**Red:**

1. Add allowlist tests for exactly `thread/goal/get`, `thread/goal/set`, and `thread/goal/clear`.
2. Add state tests proving Goal can be opened and edited while an external writer owns the running turn.
3. Add footer tests for create, edit, pause, resume, complete, blocked, and clear actions.
4. Assert Goal mutations do not resume the task or change turn ownership.

**Green:**

1. Add the three native Goal RPCs to the safe allowlist.
2. Decouple Goal availability from turn editability and external ownership.
3. Add complete and blocked actions alongside existing edit/pause/resume/clear controls.
4. Preserve server-owned elapsed time, token budget, and status.

**Verify:**

`pnpm vitest run src/safe/featureGate.test.ts src/server/securityPolicy.test.ts src/components/content/composerControlState.test.ts src/components/content/conversationRunFooter.wiring.test.ts src/composables/useDesktopState.test.ts`

### Task 7: Remove the visible interrupted-turn summary

**Files:**

- Modify: `src/composables/useDesktopState.test.ts`
- Modify: `src/composables/useDesktopState.ts`

**Red:**

1. Update interrupted-turn tests to require completion metadata with status `interrupted`.
2. Assert no visible `turn-summary:*` message contains `You stopped`.
3. Preserve the completed-turn `Worked for …` summary assertion.

**Green:**

1. Skip transcript summary insertion for interrupted turns.
2. Retain interrupted completion state and composer restoration.
3. Leave actionable errors and completed duration summaries unchanged.

**Verify:**

`pnpm vitest run src/composables/useDesktopState.test.ts`

### Task 8: Integrate, visually compare, and deploy

**Files:**

- Add: `design-qa.md`
- Update documentation only if runtime behavior changed beyond the existing design/spec.

**Verification sequence:**

1. Run all focused tests from Tasks 1–7.
2. Run `pnpm test` outside the restricted network sandbox so listener-based tests can bind normally.
3. Run `pnpm build`.
4. Start the built app in the isolated validation environment.
5. Capture the mobile conversation at the same viewport as the supplied Codex references.
6. Compare subagent chips, file footer, Fork/Copy placement, composer controls, Goal states, and attachment tokens.
7. Record findings and fixes in `design-qa.md`; resolve all P0/P1/P2 findings.
8. Commit the implementation intentionally.
9. Merge the branch into local `main`, push `origin/main`, and fast-forward/synchronize the local main checkout without overwriting its pre-existing dirty changes.
10. Rebuild/restart `codex-mobile-safe` in the current access mode and verify health, Tailnet/LAN exposure, live updates, compaction behavior, and native Goal RPCs.
