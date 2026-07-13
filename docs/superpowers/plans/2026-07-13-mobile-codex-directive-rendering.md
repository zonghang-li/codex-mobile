# Mobile Codex Directive Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert supported standalone Codex desktop directives in assistant messages into readable mobile status notices without exposing raw directive syntax.

**Architecture:** Parse whitelisted standalone directive lines once during app-server message normalization and store them as typed `UiCodexDirective` metadata on `UiMessage`. A focused notice component renders safe labels and links, while thread export reuses the same presentation helpers. Unknown, malformed, inline, user-authored, and fenced examples remain ordinary visible text.

**Tech Stack:** TypeScript, Vue 3, Vitest, existing Codex app-server v2 normalizer and custom Markdown renderer.

## Global Constraints

- Recognize only `git-stage`, `git-commit`, `git-create-branch`, `git-push`, `git-create-pr`, `created-thread`, and `code-comment`.
- Recognize a directive only when it occupies its own physical line outside fenced code blocks.
- Parse directives only from assistant `agentMessage` items; never interpret user content.
- Unknown or malformed directive-like lines remain visible verbatim.
- Directive attributes are inert data and never execute browser, Git, shell, thread, or review mutations.
- Only HTTPS PR links and local stable `threadId` routes may be interactive.
- Export readable outcomes and never the recognized raw `::name{...}` line.
- Do not change polling, runtime ownership, authentication, Tailscale exposure, or notification timing.
- Every production behavior change must be preceded by a focused failing test.

---

## File map

- `src/types/codex.ts`: typed `UiCodexDirective` union and optional `UiMessage.directives` field.
- `src/utils/codexDirectives.ts`: directive grammar, whitelist validation, safe presentation labels/links, and export lines.
- `src/utils/codexDirectives.test.ts`: parser, safety, labels, links, and production-form regressions.
- `src/api/normalizers/v2.ts`: parse persisted assistant text at the `agentMessage` boundary.
- `src/api/normalizers/v2.test.ts`: assistant-only normalization behavior.
- `src/composables/useDesktopState.ts`: parse cumulative realtime agent text without losing withheld directive prefixes.
- `src/composables/codexDirectiveLive.wiring.test.ts`: realtime raw-buffer and parser wiring contract.
- `src/components/content/CodexDirectiveNotices.vue`: compact status-card rendering.
- `src/components/content/ThreadConversation.vue`: render notices after assistant prose, including directive-only messages.
- `src/components/content/codexDirectiveNotices.wiring.test.ts`: component and conversation wiring contract.
- `src/composables/useUiLanguage.ts`: Chinese status translations.
- `src/App.vue`: readable directive export lines.
- `src/components/content/codexDirectiveExport.wiring.test.ts`: export wiring contract.
- `tests/thread-loading-state/mobile-codex-directive-notices.md`: production mobile acceptance and rollback procedure.

### Task 1: Parse supported directives into typed assistant metadata

**Files:**
- Modify: `src/types/codex.ts:207-232`
- Create: `src/utils/codexDirectives.ts`
- Create: `src/utils/codexDirectives.test.ts`
- Modify: `src/api/normalizers/v2.ts:402-415`
- Modify: `src/api/normalizers/v2.test.ts:28-157`
- Modify: `src/composables/useDesktopState.ts:1403,2726-2770,3660-3710,4100-4125,5845-5865`
- Create: `src/composables/codexDirectiveLive.wiring.test.ts`

**Interfaces:**
- Produces: `parseCodexDirectiveText(value: string, options?: { suppressIncompleteTrailingDirective?: boolean }): { text: string; directives: UiCodexDirective[] }`.
- Produces: `codexDirectiveLabel(directive, translate): string`, `codexDirectiveHref(directive): string | null`, and `codexDirectiveExportLines(directive, translate): string[]` for Tasks 2 and 3.
- Modifies: `UiMessage.directives?: UiCodexDirective[]`.

- [ ] **Step 1: Add the typed directive union**

Add before `UiMessage` in `src/types/codex.ts`:

```ts
export type UiCodexDirective =
  | { kind: 'git-stage'; cwd: string }
  | { kind: 'git-commit'; cwd: string }
  | { kind: 'git-create-branch'; cwd: string; branch: string }
  | { kind: 'git-push'; cwd: string; branch: string }
  | { kind: 'git-create-pr'; cwd: string; branch: string; url: string; isDraft: boolean }
  | { kind: 'created-thread'; threadId?: string; clientThreadId?: string }
  | {
      kind: 'code-comment'
      title: string
      body: string
      file: string
      start?: number
      end?: number
      priority?: number
    }
```

Add `directives?: UiCodexDirective[]` to `UiMessage`.

- [ ] **Step 2: Write parser RED tests**

Create `src/utils/codexDirectives.test.ts` with table-driven tests that assert:

```ts
expect(parseCodexDirectiveText([
  'Deployment complete.',
  '',
  '::git-push{cwd="/tmp/zonghang-codex-mobile-review" branch="main"}',
].join('\n'))).toEqual({
  text: 'Deployment complete.',
  directives: [{
    kind: 'git-push',
    cwd: '/tmp/zonghang-codex-mobile-review',
    branch: 'main',
  }],
})
```

Cover all seven names, multiple directives, directive-only text, escaped `\"` and `\\`, fenced examples, inline examples, unknown names, malformed/missing/duplicate attributes, non-HTTPS PR URLs, and prose before/after a directive. Unknown and malformed lines must stay in `text` with an empty directive array.

Add live-stream cases:

```ts
expect(parseCodexDirectiveText('Done.\n\n::git-pu', {
  suppressIncompleteTrailingDirective: true,
})).toEqual({ text: 'Done.', directives: [] })

expect(parseCodexDirectiveText('Done.\n\n::future-directive', {
  suppressIncompleteTrailingDirective: true,
}).text).toContain('::future-directive')
```

The same incomplete `::git-pu` input without the live option must remain visible.

- [ ] **Step 3: Run parser tests and verify RED**

Run:

```bash
pnpm vitest run src/utils/codexDirectives.test.ts
```

Expected: FAIL because `src/utils/codexDirectives.ts` and its exports do not exist.

- [ ] **Step 4: Implement the minimal whitelist parser**

Create `src/utils/codexDirectives.ts` with:

```ts
import type { UiCodexDirective } from '../types/codex'

export type DirectiveTranslate = (
  message: string,
  params?: Record<string, string | number>,
) => string

export type ParsedCodexDirectiveText = {
  text: string
  directives: UiCodexDirective[]
}
```

Implement a manual quoted-attribute scanner. It must skip whitespace, require `key="value"`, decode only `\"` and `\\`, reject duplicate keys and trailing garbage, and return `null` on uncertainty. Do not use `eval`, `JSON.parse` on reconstructed input, or HTML parsing.

Use these exact validation helpers:

```ts
function hasOnlyKeys(attributes: Record<string, string>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed)
  return Object.keys(attributes).every((key) => allowedSet.has(key))
}

function isHttpsUrl(value: string | undefined): value is string {
  if (!value) return false
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function readPositiveInteger(value: string | undefined): number | undefined | null {
  if (value === undefined) return undefined
  if (!/^[1-9]\d*$/u.test(value)) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isSafeInteger(parsed) ? parsed : null
}
```

Implement `toDirective(name, attributes)` with exact required fields:

```ts
switch (name) {
  case 'git-stage':
  case 'git-commit':
    return hasOnlyKeys(attributes, ['cwd']) && attributes.cwd
      ? { kind: name, cwd: attributes.cwd }
      : null
  case 'git-create-branch':
  case 'git-push':
    return hasOnlyKeys(attributes, ['cwd', 'branch']) && attributes.cwd && attributes.branch
      ? { kind: name, cwd: attributes.cwd, branch: attributes.branch }
      : null
  case 'git-create-pr': {
    if (!hasOnlyKeys(attributes, ['cwd', 'branch', 'url', 'isDraft'])) return null
    if (!attributes.cwd || !attributes.branch || !isHttpsUrl(attributes.url)) return null
    if (attributes.isDraft !== 'true' && attributes.isDraft !== 'false') return null
    return {
      kind: name,
      cwd: attributes.cwd,
      branch: attributes.branch,
      url: attributes.url,
      isDraft: attributes.isDraft === 'true',
    }
  }
  case 'created-thread':
    if (!hasOnlyKeys(attributes, ['threadId', 'clientThreadId'])) return null
    if (Boolean(attributes.threadId) === Boolean(attributes.clientThreadId)) return null
    return attributes.threadId
      ? { kind: name, threadId: attributes.threadId }
      : { kind: name, clientThreadId: attributes.clientThreadId }
  case 'code-comment': {
    if (!hasOnlyKeys(attributes, ['title', 'body', 'file', 'start', 'end', 'priority'])) return null
    if (!attributes.title || !attributes.body || !attributes.file) return null
    const start = readPositiveInteger(attributes.start)
    const end = readPositiveInteger(attributes.end)
    const priority = attributes.priority === undefined
      ? undefined
      : /^(?:0|1|2|3)$/u.test(attributes.priority)
        ? Number.parseInt(attributes.priority, 10)
        : null
    if (start === null || end === null || priority === null) return null
    if (end !== undefined && start === undefined) return null
    if (start !== undefined && end !== undefined && end < start) return null
    return { kind: name, title: attributes.title, body: attributes.body, file: attributes.file, start, end, priority }
  }
  default:
    return null
}
```

Implement line scanning with CommonMark-style backtick or tilde fence tracking. Match only trimmed standalone lines shaped like `::name{attributes}`. Remove recognized lines, preserve all others, and return `visibleLines.join('\n').trim()`.

When `suppressIncompleteTrailingDirective` is true, inspect only the final physical line outside a fence. Withhold it when its text is a prefix of one of the seven complete forms `::name{` or starts with an exact supported `::name{` whose closing `}` has not arrived. Once the typed name cannot match any whitelisted name, preserve it normally. Never suppress a final line inside a fence.

- [ ] **Step 5: Add presentation-helper RED tests**

In `src/utils/codexDirectives.test.ts`, use an identity translator with `{param}` substitution and assert:

```ts
expect(codexDirectiveLabel(
  { kind: 'git-push', cwd: '/tmp/repo', branch: 'main' },
  translate,
)).toBe('Pushed main')

expect(codexDirectiveHref({
  kind: 'created-thread',
  threadId: 'thread/one',
})).toBe('/#/thread/thread%2Fone')
```

Assert HTTPS PR links are returned, non-link directives return `null`, code-comment export includes title/body/file/line, and no export line contains `::`.

- [ ] **Step 6: Implement presentation helpers and verify GREEN**

Use these label templates:

```ts
git-stage: 'Changes staged'
git-commit: 'Commit created'
git-create-branch: 'Switched to branch {branch}'
git-push: 'Pushed {branch}'
git-create-pr: isDraft ? 'Draft pull request created' : 'Pull request created'
created-thread: threadId ? 'New task created' : 'New task queued'
code-comment: 'Code comment: {title}'
```

`codexDirectiveHref()` returns only the validated PR HTTPS URL or `/#/thread/${encodeURIComponent(threadId)}`. `codexDirectiveExportLines()` Markdown-escapes every directive-supplied value (including backslashes, backticks, emphasis markers, brackets, angle brackets, punctuation, and pipes) before returning readable lines. It includes code-comment body/file/range details without reconstructing directive syntax.

Run:

```bash
pnpm vitest run src/utils/codexDirectives.test.ts
```

Expected: all parser and helper tests pass.

- [ ] **Step 7: Add normalizer RED tests**

Extend `src/api/normalizers/v2.test.ts` with:

```ts
it('extracts persisted Codex directives from assistant messages only', () => {
  const response = threadReadResponseWithContent([
    {
      type: 'agentMessage',
      id: 'assistant-1',
      text: 'Done.\n\n::git-push{cwd="/tmp/repo" branch="main"}',
    },
    {
      type: 'userMessage',
      id: 'user-1',
      content: [{
        type: 'text',
        text: '::git-push{cwd="/tmp/repo" branch="user-content"}',
        text_elements: [],
      }],
    },
  ])

  const messages = normalizeThreadMessagesV2(response)
  expect(messages[0]).toMatchObject({
    text: 'Done.',
    directives: [{ kind: 'git-push', branch: 'main' }],
  })
  expect(messages[1]).toMatchObject({
    text: '::git-push{cwd="/tmp/repo" branch="user-content"}',
  })
  expect(messages[1].directives).toBeUndefined()
})
```

Add a directive-only assistant case and assert it remains a `UiMessage` with empty `text` plus non-empty `directives`.

- [ ] **Step 8: Run normalizer tests and verify RED**

Run:

```bash
pnpm vitest run src/api/normalizers/v2.test.ts
```

Expected: FAIL because `agentMessage` still exposes the raw line and has no directives.

- [ ] **Step 9: Integrate parsing at the agentMessage boundary**

In `toUiMessages()`:

```ts
if (item.type === 'agentMessage') {
  const parsed = parseCodexDirectiveText(typeof item.text === 'string' ? item.text : '')
  return [{
    id: item.id,
    role: 'assistant',
    text: parsed.text,
    directives: parsed.directives.length > 0 ? parsed.directives : undefined,
    messageType: item.type,
  }]
}
```

Run parser and normalizer tests together. Expected: both files pass.

- [ ] **Step 10: Write realtime wiring RED tests**

Create `src/composables/codexDirectiveLive.wiring.test.ts`. Read `useDesktopState.ts` as source and assert the live path:

```ts
expect(source).toContain('liveAgentRawTextByThreadId')
expect(source).toContain('suppressIncompleteTrailingDirective: true')
expect(source).toMatch(/liveAgentRawTextByThreadId[\s\S]*liveAgentMessageDelta\.delta/u)
expect(source).toMatch(/completedAgentMessage[\s\S]*clearLiveAgentRawText/u)
expect(source).toContain('areCodexDirectivesEqual')
```

The test must also lock cleanup at all four lifecycle boundaries: message completion, `clearLiveAgentMessagesForThread()`, inactive-thread pruning, and the global `stop()`/reset path.

Run:

```bash
pnpm vitest run src/composables/codexDirectiveLive.wiring.test.ts
```

Expected: FAIL because realtime messages still accumulate from the rendered `existing.text`, do not parse directives, and have no private raw buffer.

- [ ] **Step 11: Integrate cumulative realtime parsing without data loss**

Import `parseCodexDirectiveText` and `UiCodexDirective`. Add a private, non-reactive nested map inside `useDesktopState()`:

```ts
const liveAgentRawTextByThreadId = new Map<string, Map<string, string>>()
```

Add small helpers to read/write one `(threadId, messageId)` entry, clear one completed message, clear one thread, prune threads not in `activeThreadIds`, and clear the whole map. On `item/agentMessage/delta`:

1. Read the previous raw value from the private map, falling back to the existing visible text only when no raw entry exists.
2. Append `liveAgentMessageDelta.delta` to that raw value and immediately store the new raw value.
3. Parse the complete raw value with `{ suppressIncompleteTrailingDirective: true }`.
4. Upsert `parsed.text` and optional `parsed.directives`; never use parsed visible text as the next delta's source.

Change `readAgentMessageCompleted()` to parse the completed item's full text in normal mode and return optional directives. In the completion handler, upsert that fully parsed message and clear only its raw-buffer entry.

Call thread-buffer cleanup from `clearLiveAgentMessagesForThread()` before its current early return. Prune raw-buffer thread keys beside `liveAgentMessagesByThreadId` pruning, and clear the whole buffer beside the global live-message reset.

- [ ] **Step 12: Make message identity directive-aware**

Add:

```ts
function areCodexDirectivesEqual(
  first?: UiCodexDirective[],
  second?: UiCodexDirective[],
): boolean {
  if (!first && !second) return true
  if (!first || !second || first.length !== second.length) return false
  return first.every((directive, index) =>
    JSON.stringify(directive) === JSON.stringify(second[index]),
  )
}
```

Include `areCodexDirectivesEqual(first.directives, second.directives)` in `areMessageFieldsEqual()`. This prevents Vue from retaining a stale object when live text stays the same but a completed directive notice appears.

Adjust `removeRedundantLiveAgentMessages()` so matching persisted message IDs are removed even when the persisted assistant has empty visible text plus directives. Do not remove an unmatched directive-only live message merely because its normalized text is empty.

Run:

```bash
pnpm vitest run src/utils/codexDirectives.test.ts src/api/normalizers/v2.test.ts src/composables/codexDirectiveLive.wiring.test.ts
```

Expected: all Task 1 tests pass.

- [ ] **Step 13: Commit Task 1**

```bash
git add src/types/codex.ts src/utils/codexDirectives.ts src/utils/codexDirectives.test.ts src/api/normalizers/v2.ts src/api/normalizers/v2.test.ts src/composables/useDesktopState.ts src/composables/codexDirectiveLive.wiring.test.ts
git commit -m "feat: parse persisted Codex directives"
```

### Task 2: Render compact localized directive notices

**Files:**
- Create: `src/components/content/CodexDirectiveNotices.vue`
- Create: `src/components/content/codexDirectiveNotices.wiring.test.ts`
- Modify: `src/components/content/ThreadConversation.vue:265-365,939-970`
- Modify: `src/composables/useUiLanguage.ts:120-180`
- Modify: `src/style.css`

**Interfaces:**
- Consumes: `UiCodexDirective[]`, `codexDirectiveLabel()`, and `codexDirectiveHref()` from Task 1.
- Produces: `<CodexDirectiveNotices :directives="message.directives" />`.

- [ ] **Step 1: Write renderer wiring RED tests**

Create `src/components/content/codexDirectiveNotices.wiring.test.ts`. Read the two Vue sources and assert:

```ts
expect(noticeSource).toContain("defineProps<{ directives: UiCodexDirective[] }>()")
expect(noticeSource).toContain('codexDirectiveLabel')
expect(noticeSource).toContain('codexDirectiveHref')
expect(conversationSource).toContain('<CodexDirectiveNotices')
expect(conversationSource).toContain(':directives="message.directives"')
expect(conversationSource).toMatch(/message\.text\.length > 0 \|\| .*directives/u)
```

The last assertion locks directive-only message visibility.

- [ ] **Step 2: Run the wiring test and verify RED**

Run:

```bash
pnpm vitest run src/components/content/codexDirectiveNotices.wiring.test.ts
```

Expected: FAIL because the notice component does not exist.

- [ ] **Step 3: Implement the notice component**

Create `CodexDirectiveNotices.vue` with:

```vue
<template>
  <div class="codex-directive-list" aria-label="Codex status">
    <article
      v-for="(directive, index) in directives"
      :key="`${directive.kind}:${index}`"
      class="codex-directive-notice"
      :data-kind="directive.kind"
    >
      <span class="codex-directive-icon" aria-hidden="true">✓</span>
      <div class="codex-directive-content">
        <a
          v-if="codexDirectiveHref(directive)"
          class="codex-directive-title"
          :href="codexDirectiveHref(directive) || undefined"
          :target="directive.kind === 'git-create-pr' ? '_blank' : undefined"
          :rel="directive.kind === 'git-create-pr' ? 'noopener noreferrer' : undefined"
        >{{ codexDirectiveLabel(directive, t) }}</a>
        <span v-else class="codex-directive-title">{{ codexDirectiveLabel(directive, t) }}</span>
        <template v-if="directive.kind === 'code-comment'">
          <span class="codex-directive-meta">{{ directive.file }}<template v-if="directive.start">:{{ directive.start }}</template></span>
          <p class="codex-directive-body">{{ directive.body }}</p>
        </template>
      </div>
    </article>
  </div>
</template>
```

Use `useUiLanguage()` for `t`. Bind all values as Vue text/attributes; do not use `v-html`.

- [ ] **Step 4: Wire directive and directive-only messages**

Change the assistant message wrapper condition from `message.text.length > 0` to:

```vue
<article
  v-if="message.text.length > 0 || (message.directives?.length ?? 0) > 0"
  class="message-card"
  :data-role="message.role"
>
```

Render notices after the normal message/plan content and before message actions:

```vue
<CodexDirectiveNotices
  v-if="message.directives && message.directives.length > 0"
  :directives="message.directives"
/>
```

- [ ] **Step 5: Add translations and compact responsive styles**

Add all label templates from Task 1 to `zhCN`, including:

```ts
'Pushed {branch}': '已推送 {branch}',
'Changes staged': '已暂存更改',
'Commit created': '已创建提交',
'Switched to branch {branch}': '已切换到分支 {branch}',
'Draft pull request created': '已创建草稿拉取请求',
'Pull request created': '已创建拉取请求',
'New task created': '已创建新任务',
'New task queued': '新任务已排队',
'Code comment: {title}': '代码评论：{title}',
```

Add styles with a compact neutral background, 12–13 px metadata, wrapping long branch/file names, and no fixed width. Dark mode must use the existing CSS variables or explicit `:root.dark` overrides.

- [ ] **Step 6: Run Task 2 tests and build**

Run:

```bash
pnpm vitest run src/utils/codexDirectives.test.ts src/api/normalizers/v2.test.ts src/components/content/codexDirectiveNotices.wiring.test.ts
pnpm build
```

Expected: all focused tests pass; Vue type checking and Vite build complete.

- [ ] **Step 7: Commit Task 2**

```bash
git add src/components/content/CodexDirectiveNotices.vue src/components/content/codexDirectiveNotices.wiring.test.ts src/components/content/ThreadConversation.vue src/composables/useUiLanguage.ts src/style.css
git commit -m "feat: render Codex directive status notices"
```

### Task 3: Export readable statuses and verify the production regression

**Files:**
- Modify: `src/App.vue:4219-4274`
- Create: `src/components/content/codexDirectiveExport.wiring.test.ts`
- Create: `tests/thread-loading-state/mobile-codex-directive-notices.md`

**Interfaces:**
- Consumes: `UiMessage.directives` and `codexDirectiveExportLines()` from Task 1.
- Produces: readable Markdown export with no recognized raw protocol syntax.

- [ ] **Step 1: Write export RED test**

Create `src/components/content/codexDirectiveExport.wiring.test.ts` and assert `App.vue` imports `codexDirectiveExportLines`, iterates `message.directives ?? []`, and appends each returned line after message prose.

Also add a utility assertion in `codexDirectives.test.ts`:

```ts
for (const line of codexDirectiveExportLines(directive, translate)) {
  expect(line).not.toContain('::')
}
```

- [ ] **Step 2: Run export tests and verify RED**

Run:

```bash
pnpm vitest run src/components/content/codexDirectiveExport.wiring.test.ts src/utils/codexDirectives.test.ts
```

Expected: wiring test fails because `App.vue` does not export directive metadata.

- [ ] **Step 3: Add readable export output**

Import `codexDirectiveExportLines` in `App.vue`. In `buildThreadMarkdown()`, after normal message text:

```ts
for (const directive of message.directives ?? []) {
  lines.push(...codexDirectiveExportLines(directive, t))
  lines.push('')
}
```

Do not inspect or regex-strip raw strings in the exporter; recognized syntax has already been removed by the normalizer.

- [ ] **Step 4: Document exact production acceptance**

Create `tests/thread-loading-state/mobile-codex-directive-notices.md` with:

1. Open thread `019f565b-9ea5-7a30-b51d-8d927451f1b5` after deployment at 390×844.
2. Locate the assistant message whose persisted completion ends in the production `git-push` directive.
3. Assert the preceding Chinese summary is unchanged.
4. Assert a compact localized notice displays `已推送 main` when Chinese is active.
5. Assert the page body and copied thread Markdown do not contain the recognized raw prefix `::git-push{`.
6. Verify a fenced literal example remains visible.
7. Verify an unknown standalone `::future-directive{value="kept"}` remains visible.
8. Check 375×812 and 768×1024 in light and dark appearance.

Rollback: revert the feature commits, rebuild/install, and restart only `codex-mobile-safe.service`.

- [ ] **Step 5: Run complete verification**

Run:

```bash
pnpm test:unit
pnpm build
node dist-cli/safe.js doctor
git diff --check main..HEAD
```

Expected: all unit tests pass, build exits 0, doctor prints `codex-mobile-safe doctor: ok`, and diff check prints nothing.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/App.vue src/components/content/codexDirectiveExport.wiring.test.ts src/utils/codexDirectives.test.ts tests/thread-loading-state/mobile-codex-directive-notices.md
git commit -m "test: cover mobile Codex directive notices"
```

### Controller integration and deployment

After every task and final whole-branch review is approved:

1. Fast-forward merge `codex/fix-mobile-directive-rendering` into `main`.
2. Rerun `pnpm test:unit`, `pnpm build`, and `node dist-cli/safe.js doctor` on merged `main`.
3. Push `origin/main` without force.
4. Run `pnpm run install:local` and restart `codex-mobile-safe.service`.
5. Verify service is active, port 5900 remains loopback-only, and Tailscale Serve remains tailnet-only.
6. Use a fresh authenticated 390×844 browser page for the affected thread and assert:

```text
visible status contains: 已推送 main (or Pushed main in English)
page text does not contain: ::git-push{
preceding assistant summary remains visible
```

7. Confirm `main == origin/main` and preserve the live evidence under `/tmp` without passwords.
