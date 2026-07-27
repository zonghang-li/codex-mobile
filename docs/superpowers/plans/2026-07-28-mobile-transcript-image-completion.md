# Mobile Transcript, Image, and Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve every visible text item from a long active turn, render user-uploaded images as attachment text while keeping other images functional, and switch the composer out of Stop immediately when the matching external turn completes.

**Architecture:** Add a bounded, cursor-based server reader that scans rollout JSONL backwards and returns only assistant text, reasoning summaries, and lightweight status rows for one turn. The gateway normalizes those rows and a focused client helper merges older pages by stable item ID without allowing bounded live snapshots to delete hydrated text. Image source policy stays in message normalization/rendering, while turn completion uses the existing active turn ID as the authoritative lease identity.

**Tech Stack:** TypeScript, Node.js file handles, Vue 3 Composition API, Vitest, pnpm, systemd user service

## Global Constraints

- User-uploaded images render as `@<filename>` text and never create transcript `<img>` elements.
- Model-generated images, `imageView` results, and Markdown images remain renderable.
- A failed non-user image becomes a text link; no broken-image glyph remains.
- Text pagination is restricted to the selected active turn and defaults to 300 records.
- A serialized text page targets 256 KiB and has a 1 MiB hard bound so one
  relevant record is not silently truncated.
- Text pages never return command output, function arguments/results, MCP payloads, binary data, base64 data, or world-state snapshots.
- Earlier pages merge by stable item ID and rollout byte order; later live snapshots cannot delete hydrated text.
- Historical reasoning remains hidden after completion.
- Only a `turn/completed` event matching both the current thread ID and active turn ID can release an externally owned active lease.
- Stale completion events retain the current running state.
- Existing password authentication, approval policy, loopback binding, Tailscale Serve mode, ntfy behavior, and session files remain unchanged.
- Preserve all pre-existing working-tree changes and review overlapping hunks before editing; never reset or discard them.

## File Structure

- `src/server/threadTextPage.ts`: cursor encoding/validation, backwards JSONL scanning, turn boundary detection, and safe text-item projection.
- `src/server/threadTextPage.test.ts`: parser, paging, size, cursor, malformed-line, and turn-boundary tests.
- `src/server/codexAppServerBridge.ts`: resolve the trusted rollout path and expose `GET /codex-api/thread-text-page`.
- `src/server/externalThreadRuntimeBridge.test.ts`: HTTP route and error-contract coverage.
- `src/types/codex.ts`: shared `UiMessage.sessionOrder` field used only for deterministic transcript ordering.
- `src/api/normalizers/v2.ts`: source-aware user attachment normalization and propagation of server session order.
- `src/api/normalizers/v2.test.ts`: user image text policy and non-user image regression coverage.
- `src/api/codexGateway.ts`: typed text-page fetch and normalization through the existing v2 normalizer.
- `src/api/codexGateway.test.ts`: URL, cursor, error, and normalized message coverage.
- `src/composables/threadTextHydration.ts`: pure page merge/finalization helpers.
- `src/composables/threadTextHydration.test.ts`: deduplication, ordering, partial-live merge, and completed reasoning filtering.
- `src/composables/useDesktopState.ts`: hydration lifecycle, cancellation, foreground behavior, and completion lease reconciliation.
- `src/composables/useDesktopState.test.ts`: active hydration and external completion integration tests.
- `src/components/content/ThreadConversation.vue`: non-user image failure fallback links.
- `src/components/content/threadConversationImages.wiring.test.ts`: renderer contract for normal, failed, generated, `imageView`, and Markdown images.

---

### Task 1: Make image presentation source-aware

**Files:**
- Modify: `src/api/normalizers/v2.ts:233-303, 590-635`
- Modify: `src/api/normalizers/v2.test.ts`
- Modify: `src/components/content/ThreadConversation.vue:68-82, 301-348, 724-748`
- Create: `src/components/content/threadConversationImages.wiring.test.ts`

**Interfaces:**
- Consumes: Codex `UserInput` blocks with `type: "image" | "localImage"` and the existing `UiMessage.images`.
- Produces: user `UiMessage.text` containing attachment tokens and no user `images`; assistant `imageView`/`imageGeneration` messages keep `images`.
- Produces: `markMessageImageFailed(messageId: string, imageUrl: string)` and `isMessageImageFailed(messageId: string, imageUrl: string): boolean` inside `ThreadConversation.vue`.

- [ ] **Step 1: Write normalization tests for uploaded-image text and retained assistant images**

Add these cases to `src/api/normalizers/v2.test.ts`:

```ts
it('renders persisted user image inputs as attachment text without transcript images', () => {
  const messages = normalizeThreadMessagesV2(threadReadResponseWithContent([{
    type: 'userMessage',
    id: 'user-image',
    content: [
      {
        type: 'image',
        url: '/codex-local-image?path=%2Ftmp%2Fuploads%2FIMG_2912.png&uploadHandle=managed-1',
      },
      { type: 'text', text: 'What is shown here?' },
    ],
  }]))

  expect(messages).toEqual([
    expect.objectContaining({
      id: 'user-image',
      role: 'user',
      text: '@IMG_2912.png\n\nWhat is shown here?',
    }),
  ])
  expect(messages[0]?.images).toBeUndefined()
})

it('keeps imageView and generated image URLs renderable', () => {
  const messages = normalizeThreadMessagesV2(threadReadResponseWithContent([
    { type: 'imageView', id: 'view-1', path: '/tmp/view.png' },
    { type: 'imageGeneration', id: 'generated-1', result: 'data:image/png;base64,AAAA' },
  ]))

  expect(messages[0]?.images).toEqual(['/codex-local-image?path=%2Ftmp%2Fview.png'])
  expect(messages[1]?.images).toEqual(['data:image/png;base64,AAAA'])
})
```

- [ ] **Step 2: Run the normalizer tests and verify RED**

Run:

```bash
pnpm exec vitest run src/api/normalizers/v2.test.ts \
  -t "persisted user image inputs|imageView and generated image"
```

Expected: the user-image test fails because the current normalizer still sets `message.images`.

- [ ] **Step 3: Replace user image URLs with attachment labels during normalization**

In `src/api/normalizers/v2.ts`, add a filename reader that understands managed local URLs and normal URL paths:

```ts
function imageAttachmentLabel(value: string): string {
  const normalized = value.trim()
  if (!normalized) return 'image'
  try {
    const parsed = new URL(normalized, 'http://codex-mobile.local')
    const localPath = parsed.pathname === '/codex-local-image'
      ? parsed.searchParams.get('path')?.trim() ?? ''
      : decodeURIComponent(parsed.pathname)
    const label = localPath.replace(/\\/gu, '/').split('/').at(-1)?.trim() ?? ''
    return label || 'image'
  } catch {
    return normalized.replace(/\\/gu, '/').split('/').at(-1)?.trim() || 'image'
  }
}
```

Change `parseUserMessageContent` so both `image` and `localImage` blocks add a filename to one `imageLabels` array, `missingImageTokens` is built from that array, and the returned `images` array is always empty. Keep submission code untouched: this function only normalizes persisted server output.

- [ ] **Step 4: Write the renderer wiring test for fallback links**

Create `src/components/content/threadConversationImages.wiring.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./ThreadConversation.vue', import.meta.url), 'utf8')

describe('ThreadConversation image presentation', () => {
  it('does not special-case assistant image sources away', () => {
    expect(source).toContain("message.messageType === 'imageGeneration'")
    expect(source).toContain("message.messageType === 'imageView'")
    expect(source).toContain('class="message-markdown-image"')
  })

  it('replaces failed non-user images with links', () => {
    expect(source).toContain('isMessageImageFailed(message.id, imageUrl)')
    expect(source).toContain('@error="markMessageImageFailed(message.id, imageUrl)"')
    expect(source).toContain('class="message-image-fallback-link"')
    expect(source).toContain('isMarkdownImageFailed(message.id, blockIndex)')
    expect(source).toContain(':href="block.url"')
  })
})
```

- [ ] **Step 5: Run the renderer test and verify RED**

Run:

```bash
pnpm exec vitest run src/components/content/threadConversationImages.wiring.test.ts
```

Expected: FAIL because ordinary message images do not yet have an error handler and Markdown failure still renders literal Markdown.

- [ ] **Step 6: Implement failed-image fallback without affecting working images**

In `ThreadConversation.vue`, maintain a reactive `Set<string>` keyed by
`${messageId}\u0000${imageUrl}`. For every assistant image list, render:

```vue
<a
  v-if="isMessageImageFailed(message.id, imageUrl)"
  class="message-image-fallback-link"
  :href="imageUrl"
  target="_blank"
  rel="noopener noreferrer"
>
  View image
</a>
<button v-else class="message-image-button" type="button" @click="openImageModal(imageUrl)">
  <img
    class="message-image-preview"
    :src="imageUrl"
    alt="Message image preview"
    loading="lazy"
    @error="markMessageImageFailed(message.id, imageUrl)"
  />
</button>
```

Replace the Markdown failure paragraph with:

```vue
<a
  v-if="isMarkdownImageFailed(message.id, blockIndex)"
  class="message-image-fallback-link"
  :href="block.url"
  target="_blank"
  rel="noopener noreferrer"
>
  {{ block.alt || 'View image' }}
</a>
```

Reset failed-image keys when the thread identity changes so a later valid URL can retry.

- [ ] **Step 7: Run focused image tests and commit**

Run:

```bash
pnpm exec vitest run \
  src/api/normalizers/v2.test.ts \
  src/components/content/threadConversationImages.wiring.test.ts \
  src/components/content/threadComposerAttachments.wiring.test.ts
```

Expected: all selected tests pass; composer uploads remain ephemeral `@filename` tokens.

Commit:

```bash
git add src/api/normalizers/v2.ts src/api/normalizers/v2.test.ts \
  src/components/content/ThreadConversation.vue \
  src/components/content/threadConversationImages.wiring.test.ts
git commit -m "fix(conversation): distinguish uploaded and rendered images"
```

---

### Task 2: Add bounded rollout text pagination

**Files:**
- Create: `src/server/threadTextPage.ts`
- Create: `src/server/threadTextPage.test.ts`
- Modify: `src/server/codexAppServerBridge.ts:9944-10031`
- Modify: `src/server/externalThreadRuntimeBridge.test.ts`

**Interfaces:**
- Produces:

```ts
export type ThreadTextPageItem = {
  id: string
  type: 'agentMessage' | 'reasoning' | 'contextCompaction'
  text?: string
  summary?: string[]
  sessionOrder: number
}

export type ThreadTextPageResult = {
  threadId: string
  turnId: string
  items: ThreadTextPageItem[]
  nextOlderCursor: string | null
  hasMoreOlder: boolean
}

export async function readThreadTextPage(input: {
  sessionPath: string
  threadId: string
  turnId: string
  cursor?: string
  limit?: number
}): Promise<ThreadTextPageResult>
```

- Consumes: only an absolute rollout path resolved by the bridge from `thread/read`; browser input never supplies a filesystem path.

- [ ] **Step 1: Write parser and pagination tests**

Create `src/server/threadTextPage.test.ts` with temporary JSONL fixtures covering:

```ts
const rows = [
  event('task_started', { turn_id: 'turn-old' }),
  assistant('old text', 'old-agent'),
  event('task_complete', { turn_id: 'turn-old' }),
  event('task_started', { turn_id: 'turn-active' }),
  reasoning('First thought', 'reason-1'),
  functionCall('exec_command', '{"cmd":"secret output must not escape"}', 'call-1'),
  assistant('First update', 'agent-1', 'commentary'),
  event('context_compacted', {}),
  reasoning('Second thought', 'reason-2'),
  assistant('Second update', 'agent-2', 'commentary'),
]
```

Assert:

```ts
const first = await readThreadTextPage({
  sessionPath,
  threadId: 'thread-1',
  turnId: 'turn-active',
  limit: 3,
})
expect(first.items.map((item) => item.type)).toEqual([
  'contextCompaction',
  'reasoning',
  'agentMessage',
])
expect(first.items[0]?.id).toMatch(/^rollout:contextCompaction:\d+$/u)
expect(first.items.slice(1).map((item) => item.id)).toEqual(['reason-2', 'agent-2'])
expect(JSON.stringify(first)).not.toContain('secret output')
expect(first.hasMoreOlder).toBe(true)

const second = await readThreadTextPage({
  sessionPath,
  threadId: 'thread-1',
  turnId: 'turn-active',
  cursor: first.nextOlderCursor!,
  limit: 3,
})
expect(second.items.map((item) => item.id)).toEqual(['reason-1', 'agent-1'])
expect(second.hasMoreOlder).toBe(false)
```

Also test malformed lines, an oversized irrelevant tool line, cursor/thread mismatch (`400`-class typed error), file truncation (`409`-class typed error), a normal response-size stop before 256 KiB, and one relevant record between 256 KiB and 1 MiB.

- [ ] **Step 2: Run the server unit test and verify RED**

Run:

```bash
pnpm exec vitest run src/server/threadTextPage.test.ts
```

Expected: FAIL because `readThreadTextPage` does not exist.

- [ ] **Step 3: Implement opaque cursor validation and backwards line scanning**

In `src/server/threadTextPage.ts`, use this cursor payload:

```ts
type ThreadTextCursor = {
  v: 1
  threadId: string
  turnId: string
  beforeOffset: number
  snapshotEndOffset: number
}
```

Encode/decode with base64url JSON, reject any version/identity/offset mismatch,
and keep these limits:

```ts
const DEFAULT_LIMIT = 300
const MAX_LIMIT = 600
const READ_CHUNK_BYTES = 64 * 1024
const TARGET_PAGE_BYTES = 256 * 1024
const MAX_PAGE_BYTES = 1024 * 1024
const MAX_RELEVANT_LINE_BYTES = 1024 * 1024
```

Read backwards from `beforeOffset`, track every line's absolute starting byte,
and stop when:

1. `limit` visible records are collected;
2. at least one record is present and adding another would exceed
   `TARGET_PAGE_BYTES`;
3. one relevant record reaches `MAX_PAGE_BYTES`; or
4. the matching `task_started` row is reached.

Skip malformed and oversized irrelevant lines. Project only:

```ts
response_item message/assistant
  -> { id: payload.id, type: 'agentMessage', text: joined output_text, sessionOrder }
response_item reasoning
  -> { id: payload.id, type: 'reasoning', summary: summary_text[], sessionOrder }
event_msg context_compacted
  -> { id: `rollout:contextCompaction:${sessionOrder}`, type: 'contextCompaction', sessionOrder }
```

Reverse collected rows before returning so every page is chronological. The
next cursor's `beforeOffset` is the earliest scanned record offset, while
`snapshotEndOffset` remains fixed across the page chain.

- [ ] **Step 4: Add HTTP route tests**

In `src/server/externalThreadRuntimeBridge.test.ts`, add a
`GET /codex-api/thread-text-page` suite that:

- stubs `thread/read` metadata with a trusted absolute rollout path;
- asserts the first and second page payloads;
- asserts missing `threadId`/`turnId` returns 400;
- asserts a cursor from a different thread returns 400;
- asserts a missing rollout returns 404;
- asserts a truncated cursor snapshot returns 409;
- asserts no raw function arguments or output appear in the JSON body.

- [ ] **Step 5: Run the route tests and verify RED**

Run:

```bash
pnpm exec vitest run src/server/externalThreadRuntimeBridge.test.ts \
  -t "thread-text-page"
```

Expected: 404 or assertion failures because the route is absent.

- [ ] **Step 6: Wire the trusted route into the server bridge**

In `codexAppServerBridge.ts`, resolve metadata exactly as the live-state route
does:

```ts
const threadRead = await appServer.rpc('thread/read', {
  threadId,
  includeTurns: false,
})
const thread = asRecord(asRecord(threadRead)?.thread)
const sessionPath = readNonEmptyString(thread?.path)
if (!sessionPath || !isAbsolute(sessionPath)) {
  setJson(res, 404, { error: 'No rollout available for thread' })
  return
}
const page = await readThreadTextPage({
  sessionPath,
  threadId,
  turnId,
  cursor: cursor || undefined,
  limit,
})
setJson(res, 200, page)
```

Map typed invalid-cursor errors to 400, snapshot conflicts to 409, missing files
to 404, and unexpected I/O failures to 500 without returning the session path.

- [ ] **Step 7: Run focused server tests and commit**

Run:

```bash
pnpm exec vitest run \
  src/server/threadTextPage.test.ts \
  src/server/externalThreadRuntimeBridge.test.ts \
  src/server/codexAppServerBridge.inlinePayload.test.ts
```

Expected: all selected tests pass and existing 240-item live projection tests remain unchanged.

Commit:

```bash
git add src/server/threadTextPage.ts src/server/threadTextPage.test.ts \
  src/server/codexAppServerBridge.ts src/server/externalThreadRuntimeBridge.test.ts
git commit -m "feat(server): page active turn text from rollout"
```

---

### Task 3: Hydrate and merge active-turn text in the client

**Files:**
- Modify: `src/types/codex.ts:323-341`
- Modify: `src/api/normalizers/v2.ts`
- Modify: `src/api/normalizers/v2.test.ts`
- Modify: `src/api/codexGateway.ts:1110-1245, 1280-1350`
- Modify: `src/api/codexGateway.test.ts`
- Create: `src/composables/threadTextHydration.ts`
- Create: `src/composables/threadTextHydration.test.ts`
- Modify: `src/composables/useDesktopState.ts`
- Modify: `src/composables/useDesktopState.test.ts`

**Interfaces:**
- Adds `sessionOrder?: number` to `UiMessage`.
- Produces:

```ts
export type ThreadTextPage = {
  threadId: string
  turnId: string
  messages: UiMessage[]
  nextOlderCursor: string | null
  hasMoreOlder: boolean
}

export async function getThreadTextPage(
  threadId: string,
  turnId: string,
  cursor?: string,
  limit?: number,
  signal?: AbortSignal,
): Promise<ThreadTextPage>
```

- Produces pure helpers:

```ts
export function mergeThreadTextPage(
  existing: UiMessage[],
  incoming: UiMessage[],
): UiMessage[]

export function mergeHydratedTurnTextIntoTranscript(
  transcript: UiMessage[],
  hydrated: UiMessage[],
  turnId: string,
): UiMessage[]

export function finalizeHydratedTurnText(messages: UiMessage[]): UiMessage[]
```

- [ ] **Step 1: Write gateway tests for URL, cursor, and normalized order**

In `src/api/codexGateway.test.ts`, import `getThreadTextPage` and assert:

```ts
await expect(getThreadTextPage(
  'thread 1',
  'turn/1',
  'opaque+/= cursor',
  300,
  controller.signal,
)).resolves.toMatchObject({
  threadId: 'thread 1',
  turnId: 'turn/1',
  nextOlderCursor: 'next-cursor',
  hasMoreOlder: true,
  messages: [
    expect.objectContaining({
      id: 'reason-1',
      messageType: 'reasoning',
      text: 'First thought',
      sessionOrder: 120,
    }),
  ],
})
```

The expected URL is:

```text
/codex-api/thread-text-page?threadId=thread+1&turnId=turn%2F1&cursor=opaque%2B%2F%3D+cursor&limit=300
```

Also assert an aborted request becomes `CodexApiError` with
`method: "thread-text-page"` and a 409 response preserves its server message.

- [ ] **Step 2: Run gateway tests and verify RED**

Run:

```bash
pnpm exec vitest run src/api/codexGateway.test.ts -t "thread text page"
```

Expected: FAIL because the gateway function and `sessionOrder` propagation are absent.

- [ ] **Step 3: Implement gateway normalization**

Add `sessionOrder?: number` to `UiMessage`. In v2 normalization, read a finite
non-negative `item.sessionOrder` and copy it to every generated `UiMessage`.

In `getThreadTextPage`, construct an in-memory `ThreadReadResponse`:

```ts
const normalized = normalizeThreadMessagesV2({
  thread: {
    id: payload.threadId,
    turns: [{
      id: payload.turnId,
      status: 'inProgress',
      items: payload.items,
    }],
  },
} as ThreadReadResponse)
```

Return only normalized messages whose `turnId` equals the requested turn.

- [ ] **Step 4: Write pure hydration merge tests**

Create `src/composables/threadTextHydration.test.ts` and prove:

1. newest page `[reason-3, agent-3]` plus older page `[reason-1, agent-1]`
   becomes `[reason-1, agent-1, reason-3, agent-3]`;
2. overlapping IDs are deduplicated and the version with `sessionOrder` wins;
3. a bounded live snapshot containing a new `agent-4` appends it without
   deleting hydrated rows;
4. hydration replaces only text rows from the matching turn and does not alter
   historical turns;
5. finalization removes `reasoning` but retains assistant commentary and final
   response rows.

Use messages with explicit `sessionOrder` values `100`, `200`, `300`, and
`400`; assert exact ID order, not only set membership.

- [ ] **Step 5: Run hydration helper tests and verify RED**

Run:

```bash
pnpm exec vitest run src/composables/threadTextHydration.test.ts
```

Expected: FAIL because the helper module is absent.

- [ ] **Step 6: Implement deterministic hydration helpers**

`mergeThreadTextPage` must deduplicate by `message.id` and sort records with
`sessionOrder` numerically; records without an order remain after ordered rows
in their existing relative order.

`mergeHydratedTurnTextIntoTranscript` must:

1. find the first transcript position belonging to `turnId`;
2. retain non-text activity rows from that turn;
3. replace matching `agentMessage`, `reasoning`, and `contextCompaction` rows
   with the hydrated set;
4. append live-only text IDs after the newest hydrated record;
5. leave all other turns byte-for-byte equivalent.

`finalizeHydratedTurnText` is:

```ts
export function finalizeHydratedTurnText(messages: UiMessage[]): UiMessage[] {
  return messages.filter((message) => message.messageType !== 'reasoning')
}
```

- [ ] **Step 7: Write useDesktopState hydration lifecycle tests**

Extend the gateway mock with `getThreadTextPage`. Add tests that:

- a partial external live detail immediately renders its bounded rows, then
  asynchronously prepends every text page;
- a second partial live poll cannot erase the hydrated rows;
- the same thread/turn/cursor is never requested twice;
- selecting another thread aborts the active request;
- `document.visibilityState === "hidden"` prevents starting the next page and
  foregrounding resumes it;
- completion finalizes hydrated text so reasoning disappears but assistant
  commentary remains.

The primary assertion for the long-turn case is:

```ts
expect(state.messages.value
  .filter((message) => message.turnId === 'turn-external')
  .map((message) => message.id))
  .toEqual(['reason-1', 'agent-1', 'reason-2', 'agent-2', 'agent-live'])
```

- [ ] **Step 8: Run state tests and verify RED**

Run:

```bash
pnpm exec vitest run src/composables/useDesktopState.test.ts \
  -t "active turn text hydration"
```

Expected: FAIL because partial projections currently only preserve items they have already seen.

- [ ] **Step 9: Implement abortable foreground hydration in useDesktopState**

Maintain one request state per selected thread:

```ts
type ActiveTextHydration = {
  turnId: string
  messages: UiMessage[]
  nextOlderCursor: string | null
  hasMoreOlder: boolean
  consumedCursors: Set<string>
  controller: AbortController | null
}
```

Start hydration only when:

```ts
detail.isLiveProjection === true
&& detail.isPartialTurnProjection === true
&& detail.inProgress === true
&& detail.activeTurnId.length > 0
```

Fetch the newest page with an absent cursor, merge it, publish immediately,
then fetch older pages in sequence. Before every next request verify:

- the selected thread and active turn still match;
- the cursor has not been consumed;
- the document is visible;
- the generation token is current.

Abort and discard late results on thread switch. Do not clear already hydrated
messages after a retryable page error. On each live reconciliation, call
`mergeHydratedTurnTextIntoTranscript` after the existing partial-projection
merge so the bounded snapshot cannot remove earlier pages.

- [ ] **Step 10: Run focused client tests and commit**

Run:

```bash
pnpm exec vitest run \
  src/api/normalizers/v2.test.ts \
  src/api/codexGateway.test.ts \
  src/composables/threadTextHydration.test.ts \
  src/composables/useDesktopState.test.ts \
  src/components/content/threadConversationActivity.test.ts
```

Expected: all selected tests pass with exact ordering and no historical reasoning regression.

Commit:

```bash
git add src/types/codex.ts src/api/normalizers/v2.ts \
  src/api/normalizers/v2.test.ts src/api/codexGateway.ts \
  src/api/codexGateway.test.ts src/composables/threadTextHydration.ts \
  src/composables/threadTextHydration.test.ts \
  src/composables/useDesktopState.ts src/composables/useDesktopState.test.ts
git commit -m "feat(conversation): hydrate complete active turn text"
```

---

### Task 4: Release matching external completion leases immediately

**Files:**
- Modify: `src/composables/useDesktopState.ts:5379-5474`
- Modify: `src/composables/useDesktopState.test.ts:4360-4400`

**Interfaces:**
- Consumes: `activeTurnIdByThreadId[threadId]`, `runtimeOwnershipByThreadId[threadId]`, and existing `resolveTurnCompletionDisposition`.
- Produces: immediate `inProgress=false`, ownership `idle`, empty active turn ID, and cleared transient activity only for an identity-matching terminal event.

- [ ] **Step 1: Replace the obsolete external-completion expectation**

Change the test currently named
`does not let a completion without a matching local lease clear external ownership`
into two tests:

```ts
it('releases an external lease when its active turn completes', async () => {
  const { state, emit } = await setupExternalRuntimeState()
  gatewayMocks.getThreadDetail.mockResolvedValue(externalDetail('turn-external'))
  await state.loadMessages('thread-1')

  emit({
    method: 'turn/completed',
    params: { threadId: 'thread-1', turn: { id: 'turn-external', status: 'completed' } },
  })

  expect(state.selectedActiveTurnId.value).toBe('')
  expect(state.selectedThreadRuntimeOwnership.value).toBe('idle')
  expect(state.selectedThread.value?.inProgress).toBe(false)
})

it('keeps an external lease when a stale turn completes', async () => {
  const { state, emit } = await setupExternalRuntimeState()
  gatewayMocks.getThreadDetail.mockResolvedValue(externalDetail('turn-current'))
  await state.loadMessages('thread-1')

  emit({
    method: 'turn/completed',
    params: { threadId: 'thread-1', turn: { id: 'turn-stale', status: 'completed' } },
  })

  expect(state.selectedActiveTurnId.value).toBe('turn-current')
  expect(state.selectedThreadRuntimeOwnership.value).toBe('external')
  expect(state.selectedThread.value?.inProgress).toBe(true)
})
```

- [ ] **Step 2: Run completion tests and verify RED**

Run:

```bash
pnpm exec vitest run src/composables/useDesktopState.test.ts \
  -t "external lease when"
```

Expected: the matching-completion case fails because all external completions are currently assigned `ownsActiveLease: false`.

- [ ] **Step 3: Make active turn identity authoritative**

Before computing `completionDisposition`, derive:

```ts
const activeLeaseTurnId = completedTurn
  ? activeTurnIdByThreadId.value[completedTurn.threadId] ?? ''
  : ''
const matchesActiveLease = Boolean(
  completedTurn
  && activeLeaseTurnId
  && activeLeaseTurnId === completedTurn.turnId,
)
```

Replace the blanket external branch with:

```ts
const completionDisposition = completedTurn
  ? isExternallyOwned(completedTurn.threadId) && !matchesActiveLease
    ? { ownsActiveLease: false, keepRunning: true, markUnread: false }
    : hasUnlatchedLocalSubmission && !matchesActiveLease
      ? { ownsActiveLease: false, keepRunning: true, markUnread: false }
      : resolveTurnCompletionDisposition(
          completedTurn.status,
          shouldRetryWithFallback,
          completedTurn.threadId === selectedThreadId.value,
          activeLeaseTurnId,
          completedTurn.turnId,
        )
  : null
```

Keep the existing owned-completion cleanup path. It already clears the active
turn ID, running flag, ownership, activity, live reasoning, and live commands,
which makes `deriveComposerControlState` switch from Stop to Send.

- [ ] **Step 4: Run lifecycle regressions and commit**

Run:

```bash
pnpm exec vitest run \
  src/composables/threadLifecycle.test.ts \
  src/composables/useDesktopState.test.ts \
  src/components/content/composerControlState.test.ts
```

Expected: matching external completion stops immediately; stale and retrying completions remain running; composer control tests pass.

Commit:

```bash
git add src/composables/useDesktopState.ts src/composables/useDesktopState.test.ts
git commit -m "fix(runtime): finish matching external turns immediately"
```

---

### Task 5: Full verification, review, and deployment

**Files:**
- Modify: none
- Test: complete repository, built CLI, installed safe service, and real long-turn endpoint

**Interfaces:**
- Consumes: Tasks 1-4 commits.
- Produces: reviewed, deployed behavior without changing authentication or network exposure.

- [ ] **Step 1: Inspect scope and whitespace**

Run:

```bash
git status --short
git diff --check
git log --oneline --decorate -8
```

Expected: no whitespace errors; all remaining dirty files are understood and belong to the pre-existing working-tree scope.

- [ ] **Step 2: Run the focused regression set**

Run:

```bash
pnpm exec vitest run \
  src/server/threadTextPage.test.ts \
  src/server/externalThreadRuntimeBridge.test.ts \
  src/server/codexAppServerBridge.inlinePayload.test.ts \
  src/api/normalizers/v2.test.ts \
  src/api/codexGateway.test.ts \
  src/composables/threadTextHydration.test.ts \
  src/composables/useDesktopState.test.ts \
  src/composables/threadLifecycle.test.ts \
  src/components/content/threadConversationImages.wiring.test.ts \
  src/components/content/threadConversationActivity.test.ts \
  src/components/content/composerControlState.test.ts
```

Expected: every selected test passes.

- [ ] **Step 3: Run complete verification**

Run:

```bash
pnpm test:unit
pnpm run build
node dist-cli/safe.js doctor
git diff --check
```

Expected:

- all Vitest tests pass;
- Vue type checking, Vite build, and CLI build exit 0;
- doctor prints `codex-mobile-safe doctor: ok`;
- diff check prints nothing.

- [ ] **Step 4: Request code review**

Use the `requesting-code-review` skill on the exact implementation range. The
review must explicitly check:

- no user-uploaded message can produce a transcript image node;
- generated, `imageView`, and Markdown images still render and fail to links;
- cursor identity and file bounds prevent cross-thread reuse;
- oversized tool payloads never enter text-page responses;
- page merging cannot overwrite earlier text or expose historical reasoning;
- only matching completion events release the active lease.

Resolve every Critical or Important finding before deployment.

- [ ] **Step 5: Install and queue the safe service restart**

Record the current PID, then install:

```bash
systemctl --user show codex-mobile-safe.service -p MainPID -p ActiveState -p SubState
pnpm run service:install
```

Expected: installation succeeds and prints that the restart was queued.

- [ ] **Step 6: Verify service and security invariants**

After the restart worker completes, run:

```bash
systemctl --user show codex-mobile-safe.service -p MainPID -p ActiveState -p SubState
ss -ltnp 'sport = :5900'
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5900/
stat -c '%U %a %s %n' /home/zonghangli/.codex/codex-mobile-safe-password
tailscale serve status
node dist-cli/safe.js doctor
```

Expected:

- the main PID changed and the unit is active/running;
- port 5900 remains bound only to `127.0.0.1`;
- HTTP returns 200 (the password-protected login page is healthy);
- password file owner/mode remain `zonghangli 600`;
- the existing Tailnet-only Serve mapping remains unchanged;
- doctor reports `ok`.

- [ ] **Step 7: Smoke-test the real long active turn without printing its text**

Authenticate using the existing password file without echoing it, read the
active turn identity from live state, request the known long thread, and report
only counts/bytes:

```bash
cookie_jar=$(mktemp)
trap 'rm -f "$cookie_jar"' EXIT
curl -fsS -c "$cookie_jar" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "password@/home/zonghangli/.codex/codex-mobile-safe-password" \
  http://127.0.0.1:5900/auth/login >/dev/null
active_turn_id=$(
  curl -fsS -b "$cookie_jar" \
    'http://127.0.0.1:5900/codex-api/thread-live-state?threadId=019fa200-e4dc-71e3-8181-fd67eab675f5' \
    | node -e '
let raw = ""
process.stdin.on("data", (chunk) => { raw += chunk })
process.stdin.on("end", () => {
  const state = JSON.parse(raw)
  const turnId = state?.externalRuntime?.turnId
  if (typeof turnId !== "string" || turnId.length === 0) process.exit(2)
  process.stdout.write(encodeURIComponent(turnId))
})
'
)
curl -fsS -b "$cookie_jar" \
  "http://127.0.0.1:5900/codex-api/thread-text-page?threadId=019fa200-e4dc-71e3-8181-fd67eab675f5&turnId=${active_turn_id}&limit=300" \
  | node -e '
let raw = ""
process.stdin.on("data", (chunk) => { raw += chunk })
process.stdin.on("end", () => {
  const page = JSON.parse(raw)
  console.log(JSON.stringify({
    itemCount: Array.isArray(page.items) ? page.items.length : -1,
    responseBytes: Buffer.byteLength(raw),
    hasMoreOlder: page.hasMoreOlder === true,
    hasCursor: typeof page.nextOlderCursor === "string",
  }))
})
'
```

Do not record message text, rollout contents, the password, or cursor values.
Expected: `itemCount` is between 1 and 300, response bytes remain bounded, and
older pages are reachable until `hasMoreOlder=false`.

- [ ] **Step 8: Perform mobile browser acceptance**

Verify:

1. uploaded user images show only `@filename`;
2. a valid generated/Markdown image renders and a deliberately unavailable
   non-user image becomes a link;
3. the long running turn shows all prior reasoning/commentary rows instead of
   only the newest one;
4. new live text appends without deleting older rows;
5. backgrounding pauses older-page hydration and foregrounding resumes it;
6. matching completion changes Stop to Send immediately without refresh;
7. a stale completion cannot stop a newer active turn.
