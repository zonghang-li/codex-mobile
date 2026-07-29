# Progressive Sidebar Thread Directory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the initial mobile sidebar load limited to five thread summaries, then automatically fetch every remaining directory page without loading any thread message content.

**Architecture:** The existing `thread/list` cursor remains the only background data source. `useDesktopState` schedules low-priority cursor pages while the document is visible, merges summaries into the existing project groups, pauses while hidden, and resumes on `visibilitychange`; it never calls `thread/read` for directory completion.

**Tech Stack:** Vue 3, TypeScript, Vitest, Codex app-server JSON-RPC.

## Global Constraints

- Initial directory request remains limited to 5 thread summaries.
- Background directory requests contain only `thread/list` summary data.
- Background pagination pauses when the document is hidden and resumes when visible.
- Active turns must not prevent directory completion.
- Existing uncommitted user changes must remain intact.

---

### Task 1: Progressive directory pagination

**Files:**
- Modify: `src/api/codexGateway.ts`
- Modify: `src/composables/useDesktopState.ts`
- Test: `src/composables/useDesktopState.test.ts`

**Interfaces:**
- Consumes: `getThreadGroupsPage(cursor, limit): Promise<ThreadGroupsPage>`.
- Produces: automatic summary-only pagination through the existing `scheduleRemainingThreadPages` and `loadRemainingThreadPages` functions.

- [ ] **Step 1: Replace the disabled-pagination test with a failing progressive-pagination test**

```ts
it('loads every older thread directory page in the background without reading thread content', async () => {
  vi.useFakeTimers()
  installFakeTimerWindow()
  vi.stubGlobal('document', {
    visibilityState: 'visible',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })
  gatewayMocks.getThreadGroupsPage
    .mockResolvedValueOnce({
      groups: [{ projectName: 'Project', threads: [thread('thread-1', '/tmp/project')] }],
      nextCursor: 'older-page',
    })
    .mockResolvedValueOnce({
      groups: [{ projectName: 'Project', threads: [thread('thread-2', '/tmp/project')] }],
      nextCursor: null,
    })

  const state = useDesktopState()
  await state.refreshAll({ includeSelectedThreadMessages: false })
  await vi.advanceTimersByTimeAsync(250)
  await flushMicrotasks()

  expect(state.projectGroups.value[0]?.threads.map((row) => row.id)).toEqual([
    'thread-1',
    'thread-2',
  ])
  expect(state.isThreadListFullyLoaded.value).toBe(true)
  expect(gatewayMocks.getThreadDetail).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
pnpm test:unit -- src/composables/useDesktopState.test.ts -t "loads every older thread directory page"
```

Expected: FAIL because automatic background pagination is disabled.

- [ ] **Step 3: Enable efficient summary-only pagination**

```ts
const BACKGROUND_THREAD_PAGINATION_DELAY_MS = 250
const ENABLE_AUTOMATIC_BACKGROUND_THREAD_PAGINATION = true
```

Set `BACKGROUND_THREAD_LIST_LIMIT` to `50`, remove active-turn blocking from directory pagination, skip scheduling while `document.visibilityState !== 'visible'`, and resume `scheduleRemainingThreadPages` from `onRuntimeVisibilityChange`.

- [ ] **Step 4: Add hidden-page pause/resume coverage**

Create a test that starts with `document.visibilityState = 'hidden'`, verifies no second `thread/list` request occurs, starts polling, fires the installed visibility listener after switching to `visible`, and verifies the next directory page loads. Assert again that `getThreadDetail` was never called.

- [ ] **Step 5: Run focused and full verification**

Run:

```bash
pnpm test:unit -- src/composables/useDesktopState.test.ts
pnpm run build
```

Expected: all targeted tests pass and both frontend and CLI builds complete successfully.

