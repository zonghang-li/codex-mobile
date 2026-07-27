# Codex Desktop Activity Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make mobile thread content, activity rows, completed-turn folding, and typography match the Codex desktop client closely enough that the same app-server items remain recognizable on both surfaces.

**Architecture:** Keep the app-server response as the source of truth, normalize every supported thread item into typed `UiMessage` activity metadata, derive compact desktop-style activity segments in a pure O(n) presentation layer, and render those segments without adding network requests. Preserve the current `Worked for …` completion boundary and final-answer rendering, while using conservative command classification only when restored history omits `commandActions`.

**Tech Stack:** Vue 3, TypeScript, Vitest, Tailwind CSS utilities, Vite, Playwright runtime profiler, Codex app-server v2 thread items.

## Global Constraints

- Do not change app-server polling, thread identity, completion detection, or notification semantics.
- Do not add a second history request. Presentation operates on the already loaded/pruned message set and must not hide already-loaded turns behind a local render window.
- Prefer official `commandActions` over command-string inference. Unknown or destructive-looking shell commands remain `Ran …`.
- Keep the composer input at 16px to avoid iOS focus zoom.
- Keep activity derivation pure and linear in the number of loaded messages.
- Preserve user changes already present in the working tree and commit them separately before feature work.
- Update the manual test catalog for the new visible behavior.
- Run requirements review before code-quality review at the merge gate.

---

## Task 0: Checkpoint the existing route and payload fixes

**Files:**

- Modify: `index.html`
- Modify: `src/App.vue`
- Modify: `src/components/content/ThreadConversation.vue`
- Create: `src/components/content/mobileRouteViewport.wiring.test.ts`
- Modify: `src/composables/useDesktopState.ts`
- Modify: `src/composables/useDesktopState.test.ts`
- Modify: `src/server/codexAppServerBridge.ts`
- Modify: `src/server/codexAppServerBridge.inlinePayload.test.ts`
- Modify: `src/server/externalThreadRuntimeBridge.test.ts`
- Modify: `src/style.css`

- [ ] **Step 1: Confirm only the previously verified stale-route, viewport, and payload-bounding changes are in this checkpoint**

Run:

```bash
git diff --check
git diff --stat
git status --short
```

Expected: no whitespace errors; only the listed pre-existing files are dirty.

- [ ] **Step 2: Re-run the focused regression tests**

Run:

```bash
pnpm exec vitest run \
  src/components/content/mobileRouteViewport.wiring.test.ts \
  src/composables/useDesktopState.test.ts \
  src/server/codexAppServerBridge.inlinePayload.test.ts \
  src/server/externalThreadRuntimeBridge.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit the checkpoint without including this feature plan**

Run:

```bash
git add index.html src/App.vue src/components/content/ThreadConversation.vue \
  src/components/content/mobileRouteViewport.wiring.test.ts \
  src/composables/useDesktopState.ts src/composables/useDesktopState.test.ts \
  src/server/codexAppServerBridge.ts src/server/codexAppServerBridge.inlinePayload.test.ts \
  src/server/externalThreadRuntimeBridge.test.ts src/style.css
git commit -m "fix: handle stale mobile routes and bound thread payloads"
```

Expected: one isolated checkpoint commit.

---

## Task 1: Preserve desktop activity metadata during normalization

**Files:**

- Modify: `src/types/codex.ts`
- Modify: `src/api/normalizers/v2.ts`
- Test: `src/api/normalizers/v2.test.ts`

- [ ] **Step 1: Write failing normalization tests for the missing protocol items**

Add fixtures and assertions covering:

```ts
expect(messages).toEqual(expect.arrayContaining([
  expect.objectContaining({
    messageType: 'subAgentActivity',
    activity: {
      kind: 'subAgent',
      label: 'Updated docs coverage review',
      status: 'updated',
      agentPath: '/root/updated_docs_coverage_review',
    },
  }),
  expect.objectContaining({
    messageType: 'dynamicToolCall',
    activity: expect.objectContaining({ kind: 'tool' }),
  }),
  expect.objectContaining({
    messageType: 'sleep',
    activity: expect.objectContaining({ kind: 'status' }),
  }),
  expect.objectContaining({
    messageType: 'imageGeneration',
    text: 'Generated an image',
  }),
]))
```

Also assert that `commandExecution.commandActions` is retained in typed UI data.

- [ ] **Step 2: Run the focused test and observe the expected failure**

Run:

```bash
pnpm exec vitest run src/api/normalizers/v2.test.ts
```

Expected: FAIL because the missing item types are currently dropped or collapsed.

- [ ] **Step 3: Add typed activity metadata**

In `src/types/codex.ts`, introduce:

```ts
export type UiActivityData = {
  kind: 'command' | 'fileChange' | 'tool' | 'subAgent' | 'image' | 'search' | 'status' | 'plan'
  label: string
  status?: string
  agentPath?: string
}
```

Add `activity?: UiActivityData` to `UiMessage`, and retain normalized command action categories on `CommandExecutionData`.

- [ ] **Step 4: Normalize all supported app-server activity items**

In `src/api/normalizers/v2.ts`:

- map `subAgentActivity` into a readable chip label derived from the last `agentPath` segment;
- map `started`, `interacted`, and `interrupted` to `started`, `updated`, and `interrupted`;
- preserve `dynamicToolCall` and `sleep` as readable activity rows;
- keep `imageGeneration` distinct from `imageView`;
- attach activity metadata to existing command, file-change, search, tool, image, plan, and compaction messages;
- retain the original `rawPayload` for unsupported fields without showing raw JSON in the conversation.

- [ ] **Step 5: Re-run the focused test**

Run:

```bash
pnpm exec vitest run src/api/normalizers/v2.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/types/codex.ts src/api/normalizers/v2.ts src/api/normalizers/v2.test.ts
git commit -m "feat: preserve Codex desktop activity events"
```

---

## Task 2: Classify restored commands conservatively

**Files:**

- Modify: `src/utils/commandActivity.ts`
- Create: `src/utils/commandActivity.test.ts`
- Modify: `src/api/normalizers/v2.ts`

- [ ] **Step 1: Write failing classifier tests**

Cover official actions first, then restored-history fallback:

```ts
expect(commandActivityCategories('sed -n "1,80p" src/App.vue', [])).toEqual(['read'])
expect(commandActivityCategories('rg --files src', [])).toEqual(['listFiles'])
expect(commandActivityCategories('rg -n "UiMessage" src', [])).toEqual(['search'])
expect(commandActivityCategories('pnpm test', [])).toEqual(['unknown'])
expect(commandActivityCategories('sed -n "1,80p" a && rg -n x b', [])).toEqual(['read', 'search'])
```

Assert that official `commandActions` win over fallback classification.

- [ ] **Step 2: Run the focused test and observe the expected failure**

Run:

```bash
pnpm exec vitest run src/utils/commandActivity.test.ts
```

Expected: FAIL because only one display label currently exists.

- [ ] **Step 3: Implement pure category and label helpers**

Add:

```ts
export type CommandActivityCategory = 'read' | 'listFiles' | 'search' | 'unknown'

export function commandActivityCategories(
  command: string,
  commandActions: unknown,
): CommandActivityCategory[]
```

Rules:

- explicit app-server action types always win;
- recognize read-only `cat`, `head`, `tail`, and `sed -n`;
- recognize `ls`, `find`, `fd`, and `rg --files` as listing;
- recognize `rg`, `grep`, and `git grep` as search;
- split only obvious `&&`, `;`, and pipeline segments;
- never classify mutation commands as reads solely because they contain a filename.

- [ ] **Step 4: Feed categories into normalized command metadata**

Use `commandActivityCategories` from `src/api/normalizers/v2.ts` so restored desktop sessions can produce the same summary grammar even when `commandActions` is empty.

- [ ] **Step 5: Re-run the tests**

Run:

```bash
pnpm exec vitest run src/utils/commandActivity.test.ts src/api/normalizers/v2.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/utils/commandActivity.ts src/utils/commandActivity.test.ts \
  src/api/normalizers/v2.ts src/api/normalizers/v2.test.ts
git commit -m "feat: classify restored Codex command activity"
```

---

## Task 3: Derive desktop-style activity segments

**Files:**

- Modify: `src/components/content/threadConversationActivity.ts`
- Modify: `src/components/content/threadConversationActivity.test.ts`

- [ ] **Step 1: Write failing segment and summary tests**

Use a fixture matching the reported desktop/mobile mismatch:

```ts
const segment = buildThreadActivitySegments([
  reasoning('Closing the final review'),
  fileChange('file-1'),
  command('read-1', ['read']),
  command('run-1', ['unknown']),
  subAgent('agent-1', 'Updated docs coverage review'),
])

expect(segment).toMatchObject([
  { kind: 'reasoning', label: 'Closing the final review' },
  { kind: 'summary', label: 'Edited a file, read files, ran a command' },
  { kind: 'subAgent', label: 'Updated docs coverage review' },
])
```

Also test:

- plural grammar;
- stable source order;
- boundaries at user messages and `Worked for …`;
- completed activity hidden under `Worked for …` while final assistant text remains visible;
- `subAgentActivity`, `dynamicToolCall`, `sleep`, and `imageGeneration` count as activity.

- [ ] **Step 2: Run the focused test and observe the expected failure**

Run:

```bash
pnpm exec vitest run src/components/content/threadConversationActivity.test.ts
```

Expected: FAIL because the current module only returns raw activity messages.

- [ ] **Step 3: Add pure segment types and derivation**

Implement:

```ts
export type ThreadActivitySegment =
  | { kind: 'reasoning'; id: string; label: string; sourceMessageIds: string[] }
  | { kind: 'summary'; id: string; label: string; sourceMessageIds: string[] }
  | { kind: 'subAgent'; id: string; label: string; status?: string; sourceMessageIds: string[] }
  | { kind: 'event'; id: string; label: string; sourceMessageIds: string[] }

export function buildThreadActivitySegments(
  messages: readonly UiMessage[],
): ThreadActivitySegment[]
```

Aggregate adjacent command/file activity into concise desktop grammar while preserving reasoning and explicit agent/tool events in source order.

- [ ] **Step 4: Update completed-turn folding to use the same activity definition**

Extend `TURN_ACTIVITY_MESSAGE_TYPES` and reuse the segment logic for expanded `Worked for …` details. Avoid separate running/completed interpretations.

- [ ] **Step 5: Re-run the focused tests**

Run:

```bash
pnpm exec vitest run src/components/content/threadConversationActivity.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/components/content/threadConversationActivity.ts \
  src/components/content/threadConversationActivity.test.ts
git commit -m "feat: derive desktop-style thread activity summaries"
```

---

## Task 4: Render activity rows and completed turns like the desktop client

**Files:**

- Modify: `src/components/content/ThreadConversation.vue`
- Create: `src/components/content/threadConversationDesktopParity.wiring.test.ts`

- [ ] **Step 1: Write a failing wiring test**

Assert that the component:

- renders derived activity segments instead of command-only adjacency groups;
- renders subagent chips with status text;
- uses the same segment renderer inside expanded `Worked for …`;
- leaves final `agentMessage` content outside the folded activity block;
- does not render raw `subAgentActivity` or `dynamicToolCall` payload text.

- [ ] **Step 2: Run the focused test and observe the expected failure**

Run:

```bash
pnpm exec vitest run src/components/content/threadConversationDesktopParity.wiring.test.ts
```

Expected: FAIL because the component still groups only consecutive command rows.

- [ ] **Step 3: Replace command-only grouping with segment rendering**

In `ThreadConversation.vue`:

- compute segment ownership once from the loaded `messages`;
- render desktop-style gray rows for `Read files`, `Edited files`, `Ran commands`, search, tool, image, compaction, and agent events;
- render subagent activity as compact bordered chips with readable names and status;
- preserve command click-to-expand output for source command IDs;
- keep live reasoning visible while running;
- after completion, fold all activity under `Worked for …` and show only final assistant reply by default.

- [ ] **Step 4: Re-run component and activity tests**

Run:

```bash
pnpm exec vitest run \
  src/components/content/threadConversationDesktopParity.wiring.test.ts \
  src/components/content/threadConversationActivity.test.ts \
  src/components/content/threadConversationWindow.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/components/content/ThreadConversation.vue \
  src/components/content/threadConversationDesktopParity.wiring.test.ts
git commit -m "feat: render Codex desktop activity flow on mobile"
```

---

## Task 5: Match Codex typography and mobile density

**Files:**

- Modify: `src/style.css`
- Modify: `src/components/content/ThreadConversation.vue`
- Create: `src/components/content/threadConversationTypography.wiring.test.ts`
- Create: `tests/chat-composer-rendering/codex-desktop-activity-parity-and-mobile-typography.md`
- Modify: `tests/chat-composer-rendering/index.md`

- [ ] **Step 1: Write a failing typography wiring test**

Assert:

- the app body uses the client-like system UI stack;
- assistant paragraphs and lists use 15px/24px on mobile;
- activity rows use 14px/22px;
- command rows use 13–14px monospace;
- composer textarea/input remains at least 16px;
- message and activity containers keep `min-width: 0` and cannot cause page-level horizontal scrolling.

- [ ] **Step 2: Run the focused test and observe the expected failure**

Run:

```bash
pnpm exec vitest run src/components/content/threadConversationTypography.wiring.test.ts
```

Expected: FAIL on the missing font stack and oversized 16px/32px conversation rules.

- [ ] **Step 3: Apply the client-like typography**

Use:

```css
font-family:
  system-ui,
  -apple-system,
  BlinkMacSystemFont,
  "SF Pro Text",
  "PingFang SC",
  "Segoe UI",
  sans-serif;
```

Set mobile conversation text to 15px/24px, activity text to 14px/22px, and command labels/output to 13–14px while retaining readable desktop breakpoints and the 16px composer safeguard.

- [ ] **Step 4: Document manual checks**

The manual test document must cover:

- active turn with reasoning, read/search/run/edit actions, image view, and subagent activity;
- completed turn collapsed to `Worked for …` with final answer visible;
- 375×812 and 768×1024 viewports;
- light and dark themes;
- no horizontal page drag and no iOS focus zoom.

- [ ] **Step 5: Re-run the focused test**

Run:

```bash
pnpm exec vitest run src/components/content/threadConversationTypography.wiring.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/style.css src/components/content/ThreadConversation.vue \
  src/components/content/threadConversationTypography.wiring.test.ts \
  tests/chat-composer-rendering/codex-desktop-activity-parity-and-mobile-typography.md \
  tests/chat-composer-rendering/index.md
git commit -m "style: align mobile thread typography with Codex"
```

---

## Task 6: Full verification, performance audit, and local deployment

**Files:**

- Verify: all changed implementation and test files
- Modify only if a regression is found

- [ ] **Step 1: Run focused feature tests**

Run:

```bash
pnpm exec vitest run \
  src/api/normalizers/v2.test.ts \
  src/utils/commandActivity.test.ts \
  src/components/content/threadConversationActivity.test.ts \
  src/components/content/threadConversationDesktopParity.wiring.test.ts \
  src/components/content/threadConversationTypography.wiring.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run the complete unit suite**

Run:

```bash
pnpm run test:unit
```

Expected: PASS with no unhandled errors.

- [ ] **Step 3: Run the production build and command smoke checks**

Run:

```bash
pnpm run build
node dist-cli/index.js --help
node dist-cli/safe.js doctor
```

Expected: build succeeds, help exits 0, doctor passes.

- [ ] **Step 4: Verify responsive rendering in a real browser**

Use the current Tailnet/LAN deployment and the known mismatch thread at:

- 375×812, light
- 375×812, dark
- 768×1024, light
- 768×1024, dark

Check activity order, subagent chips, completed folding, font size, line height, command expansion, and zero page-level horizontal overflow. Save screenshots under `/tmp` only.

- [ ] **Step 5: Audit request and rendering performance**

Run:

```bash
pnpm run profile:thread
```

Inspect `duplicateCounts`, warnings, total API KB, request count, and bundle output. Confirm the feature adds no network request and that activity derivation remains bounded to the already-loaded/pruned message set without reintroducing a client-side render window.

- [ ] **Step 6: Review requirements, then code quality**

Requirements review:

- every visible desktop activity type from the supplied screenshots is represented;
- running and completed states use the same source items;
- final reply stays visible after completion;
- font and density match the approved design.

Code-quality review:

- no duplicate normalizer/presentation rules;
- pure helpers are tested;
- no raw payload leaks;
- no unbounded computed loops or deep watchers.

- [ ] **Step 7: Restart and inspect the safe Tailnet service**

Run:

```bash
systemctl --user restart codex-mobile-safe-tailnet.service
systemctl --user --no-pager --full status codex-mobile-safe-tailnet.service
```

Expected: active/running from this repository's latest build.

- [ ] **Step 8: Final repository check**

Run:

```bash
git diff --check
git status --short
git log -8 --oneline
```

Expected: clean worktree and the feature split into reviewable commits.
