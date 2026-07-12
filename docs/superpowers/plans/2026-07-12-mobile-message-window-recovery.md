# Mobile Message Window Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent long mobile conversations from showing only `Load earlier messages`, and preserve manual history reading until the user explicitly jumps to latest.

**Architecture:** Put all render-window index arithmetic in a small pure helper beside `ThreadConversation.vue`. The component uses a clamped effective start for rendering and loading, disables auto-follow before expanding history, and only restores the latest bounded window through `jumpToLatest` or a thread switch.

**Tech Stack:** Vue 3 Composition API, TypeScript, Vitest, Vite, pnpm

## Global Constraints

- Keep the existing latest-message render window at exactly 50 messages.
- Keep each earlier-message expansion at exactly 30 messages.
- A non-empty message array must always render at least one message.
- Clicking `Load earlier messages` must disable auto-follow before local or persisted expansion.
- New messages must not reset a manually expanded history window.
- `Jump to latest` must restore automatic following and the latest bounded window.
- Do not add requests, watchers with unbounded work, dependencies, or browser automation.

---

### Task 1: Pure render-window bounds

**Files:**
- Create: `src/components/content/threadConversationWindow.ts`
- Create: `src/components/content/threadConversationWindow.test.ts`

**Interfaces:**
- Produces: `THREAD_RENDER_WINDOW_SIZE = 50`
- Produces: `THREAD_RENDER_LOAD_CHUNK = 30`
- Produces: `clampThreadRenderWindowStart(start: number, messageCount: number): number`
- Produces: `latestThreadRenderWindowStart(messageCount: number): number`
- Produces: `earlierThreadRenderWindowStart(start: number, messageCount: number): number`

- [ ] **Step 1: Write the failing helper tests**

```ts
import { describe, expect, it } from 'vitest'
import {
  clampThreadRenderWindowStart,
  earlierThreadRenderWindowStart,
  latestThreadRenderWindowStart,
} from './threadConversationWindow'

describe('thread conversation render window', () => {
  it('clamps a stale oversized start so a non-empty list remains visible', () => {
    expect(clampThreadRenderWindowStart(140, 94)).toBe(93)
  })

  it('uses zero for empty lists and invalid negative starts', () => {
    expect(clampThreadRenderWindowStart(20, 0)).toBe(0)
    expect(clampThreadRenderWindowStart(-4, 10)).toBe(0)
  })

  it('expands from the effective bounded start in one click', () => {
    expect(earlierThreadRenderWindowStart(140, 94)).toBe(63)
  })

  it('keeps the latest render window bounded to fifty messages', () => {
    expect(latestThreadRenderWindowStart(94)).toBe(44)
    expect(latestThreadRenderWindowStart(20)).toBe(0)
  })
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm exec vitest run src/components/content/threadConversationWindow.test.ts`

Expected: FAIL because `threadConversationWindow.ts` does not exist.

- [ ] **Step 3: Implement the minimal pure helper**

```ts
export const THREAD_RENDER_WINDOW_SIZE = 50
export const THREAD_RENDER_LOAD_CHUNK = 30

export function clampThreadRenderWindowStart(start: number, messageCount: number): number {
  const boundedCount = Math.max(0, Math.floor(messageCount))
  if (boundedCount === 0) return 0
  const normalizedStart = Number.isFinite(start) ? Math.max(0, Math.floor(start)) : 0
  return Math.min(normalizedStart, boundedCount - 1)
}

export function latestThreadRenderWindowStart(messageCount: number): number {
  return Math.max(0, Math.floor(messageCount) - THREAD_RENDER_WINDOW_SIZE)
}

export function earlierThreadRenderWindowStart(start: number, messageCount: number): number {
  const effectiveStart = clampThreadRenderWindowStart(start, messageCount)
  return Math.max(0, effectiveStart - THREAD_RENDER_LOAD_CHUNK)
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm exec vitest run src/components/content/threadConversationWindow.test.ts`

Expected: 1 file and 4 tests pass.

- [ ] **Step 5: Commit the helper and tests**

```bash
git add src/components/content/threadConversationWindow.ts src/components/content/threadConversationWindow.test.ts
git commit -m "fix: bound conversation render window"
```

---

### Task 2: Wire manual history mode into the conversation component

**Files:**
- Modify: `src/components/content/ThreadConversation.vue:1428-1440,4238-4270,4338-4355,4398-4422`
- Create: `src/components/content/threadConversationWindow.wiring.test.ts`
- Modify: `tests/chat-composer-rendering/lazy-message-rendering-windowed-conversation.md`

**Interfaces:**
- Consumes: all exports from `threadConversationWindow.ts` created in Task 1.
- Produces: a clamped `effectiveRenderWindowStart` computed value used by rendering, button visibility, and earlier-window expansion.

- [ ] **Step 1: Write the failing component wiring test**

```ts
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('ThreadConversation render-window wiring', () => {
  it('clamps visible messages and enters manual history mode before expansion', async () => {
    const source = await readFile(new URL('./ThreadConversation.vue', import.meta.url), 'utf8')
    expect(source).toContain('const effectiveRenderWindowStart = computed(() => clampThreadRenderWindowStart(')
    expect(source).toContain('props.messages.slice(effectiveRenderWindowStart.value)')
    expect(source).toMatch(/async function loadMoreAbove[\s\S]*autoFollowOutput\.value = false[\s\S]*earlierThreadRenderWindowStart/u)
  })

  it('restores the bounded latest window only when jumping to latest', async () => {
    const source = await readFile(new URL('./ThreadConversation.vue', import.meta.url), 'utf8')
    expect(source).toMatch(/function jumpToLatest[\s\S]*autoFollowOutput\.value = true[\s\S]*latestThreadRenderWindowStart/u)
  })
})
```

- [ ] **Step 2: Run the wiring test and verify RED**

Run: `pnpm exec vitest run src/components/content/threadConversationWindow.wiring.test.ts`

Expected: FAIL because the component does not yet use the helper or disable auto-follow.

- [ ] **Step 3: Replace local constants and derive a safe effective start**

Add the helper import beside the existing component imports:

```ts
import {
  clampThreadRenderWindowStart,
  earlierThreadRenderWindowStart,
  latestThreadRenderWindowStart,
} from './threadConversationWindow'
```

Replace the local render constants and computed values with:

```ts
const LOAD_MORE_SCROLL_THRESHOLD_PX = 200
const renderWindowStart = ref(0)
const isLoadingMore = ref(false)
const effectiveRenderWindowStart = computed(() => clampThreadRenderWindowStart(
  renderWindowStart.value,
  props.messages.length,
))
const visibleMessages = computed(() => props.messages.slice(effectiveRenderWindowStart.value))
const hasMoreAbove = computed(() => effectiveRenderWindowStart.value > 0 || props.hasMorePersistedAbove === true)
```

- [ ] **Step 4: Make manual load and jump-to-latest explicit state transitions**

Update `jumpToLatest`:

```ts
function jumpToLatest(): void {
  autoFollowOutput.value = true
  renderWindowStart.value = latestThreadRenderWindowStart(props.messages.length)
  enforceBottomState()
  scheduleBottomLock(4)
}
```

At the start of `loadMoreAbove`, after its guard and before `isLoadingMore.value = true`, add:

```ts
autoFollowOutput.value = false
```

Replace the local expansion branch with:

```ts
if (effectiveRenderWindowStart.value > 0) {
  renderWindowStart.value = earlierThreadRenderWindowStart(
    effectiveRenderWindowStart.value,
    props.messages.length,
  )
} else if (props.hasMorePersistedAbove === true) {
  await props.loadEarlierMessages?.(threadIdAtStart)
}
```

- [ ] **Step 5: Use helper bounds for all message/thread transitions**

In the `props.messages` watcher, use:

```ts
if (autoFollowOutput.value) {
  renderWindowStart.value = latestThreadRenderWindowStart(next.length)
} else {
  renderWindowStart.value = clampThreadRenderWindowStart(renderWindowStart.value, next.length)
}
```

In the `props.isLoading` and `props.activeThreadId` watchers, replace the latest-window arithmetic with:

```ts
renderWindowStart.value = latestThreadRenderWindowStart(props.messages.length)
```

- [ ] **Step 6: Update manual validation for live updates during history reading**

Append these actions after the existing manual-load steps:

```markdown
13. While older messages are visible, allow the active thread to receive several new messages.
14. Confirm the current reading position and expanded older-message window remain unchanged.
15. Click `Jump to latest` and confirm the conversation returns to the newest bounded window and resumes following output.
16. Force a message-list shrink or rollback and confirm at least one message remains visible whenever the list is non-empty.
```

Update the expected results to state that a non-empty conversation never renders only the load control.

- [ ] **Step 7: Run focused tests and production type/build verification**

Run:

```bash
pnpm exec vitest run src/components/content/threadConversationWindow.test.ts src/components/content/threadConversationWindow.wiring.test.ts
pnpm run build
```

Expected: 2 focused test files pass; Vue typecheck and production build succeed.

- [ ] **Step 8: Commit the component behavior**

```bash
git add src/components/content/ThreadConversation.vue \
  src/components/content/threadConversationWindow.wiring.test.ts \
  tests/chat-composer-rendering/lazy-message-rendering-windowed-conversation.md
git commit -m "fix: preserve mobile history reading window"
```

---

### Task 3: Full verification and local deployment

**Files:**
- Verify only; no source files should change.

**Interfaces:**
- Consumes: the completed render-window helper and component wiring.
- Produces: test/build/runtime evidence suitable for the PR and local service handoff.

- [ ] **Step 1: Run the complete automated suite**

Run: `pnpm run test:unit`

Expected: all test files and tests pass with zero failures.

- [ ] **Step 2: Run production build and CLI safety smoke**

Run:

```bash
pnpm run build
node dist-cli/safe.js doctor
git diff --check
```

Expected: build succeeds, doctor reports `ok`, and diff check is clean.

- [ ] **Step 3: Audit performance-sensitive behavior**

Inspect the diff and confirm:

- no new network requests or polling paths;
- no unbounded watcher or loop;
- the render window remains 50 and expansion remains 30;
- helper work is constant-time arithmetic;
- frontend build output has no material bundle increase.

- [ ] **Step 4: Install from the persistent local main clone and restart the service**

After the branch is merged to `main`, run from the persistent clone:

```bash
pnpm run service:install
codex-mobile-safe doctor
systemctl --user is-active codex-mobile-safe.service
```

Expected: doctor reports `ok` and the service reports `active` on loopback port 5900.

- [ ] **Step 5: Publish through the existing GitHub workflow**

Push `codex/fix-mobile-message-window`, create a draft PR targeting `main`, include the focused/full test evidence, and keep the worktree for review follow-up.
