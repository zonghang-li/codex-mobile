# Generic Codex Directive Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render every standalone assistant `::` line as a typed, generic, or warning card without executing unknown directives or leaking protocol fragments during streaming.

**Architecture:** Extend the existing line-oriented directive parser with ordered generic attributes and an invalid fallback while preserving strict known schemas and Markdown fence handling. Reuse the existing message normalization, live-delta reconciliation, directive notice component, and export loop so persisted and streaming output share one representation.

**Tech Stack:** TypeScript, Vue 3, Tailwind utility CSS, Vitest, pnpm.

## Global Constraints

- Parse only standalone assistant-output lines beginning with `::`; fenced code, inline prose, and user messages remain literal.
- Known directives keep strict schemas and specialized cards; a known invalid schema never becomes a generic success card.
- Unknown generic and invalid directives have no actions or links and are never executed.
- Sensitive generic values are replaced with `••••` before entering parsed directive state.
- Live incomplete final directive lines remain withheld until completed or finalized as a warning.
- Add no network requests, backend work, watchers, timers, dependencies, authentication changes, exposure changes, polling changes, or ntfy changes.

---

### Task 1: Parse typed, generic, and invalid directive lines

**Files:**
- Modify: `src/types/codex.ts:207-223`
- Modify: `src/utils/codexDirectives.ts:8-300`
- Modify: `src/utils/codexDirectives.test.ts:13-224`

**Interfaces:**
- Consumes: existing `parseCodexDirectiveText(value, options)` and strict `toDirective(name, attributes)` behavior.
- Produces: `UiCodexDirective` variants `{ kind: 'generic', name, attributes }` and `{ kind: 'invalid', name?, reason }`; all standalone `::` lines are removed from prose and returned as structured directives.

- [ ] **Step 1: Write failing parser tests for unknown valid directives and redaction**

Add tests to `src/utils/codexDirectives.test.ts`:

```ts
it('parses an unknown valid directive into ordered generic attributes', () => {
  expect(parseCodexDirectiveText(
    '::future-directive{phase="done" url="https://example.com"}',
  )).toEqual({
    text: '',
    directives: [{
      kind: 'generic',
      name: 'future-directive',
      attributes: [
        { key: 'phase', value: 'done', sensitive: false },
        { key: 'url', value: 'https://example.com', sensitive: false },
      ],
    }],
  })
})

it('redacts sensitive generic values before returning parsed state', () => {
  const parsed = parseCodexDirectiveText(
    '::future-auth{accessToken="do-not-retain" password="also-secret" phase="done"}',
  )

  expect(parsed.directives).toEqual([{
    kind: 'generic',
    name: 'future-auth',
    attributes: [
      { key: 'accessToken', value: '••••', sensitive: true },
      { key: 'password', value: '••••', sensitive: true },
      { key: 'phase', value: 'done', sensitive: false },
    ],
  }])
  expect(JSON.stringify(parsed)).not.toContain('do-not-retain')
  expect(JSON.stringify(parsed)).not.toContain('also-secret')
})
```

- [ ] **Step 2: Run the generic tests and verify RED**

Run:

```bash
pnpm exec vitest run src/utils/codexDirectives.test.ts -t 'unknown valid directive|redacts sensitive generic values'
```

Expected: FAIL because unknown names currently remain in `text` and produce no directives.

- [ ] **Step 3: Add generic and invalid directive types**

Extend `UiCodexDirective` in `src/types/codex.ts`:

```ts
export type UiGenericCodexDirectiveAttribute = {
  key: string
  value: string
  sensitive: boolean
}

export type UiCodexDirective =
  | { kind: 'generic'; name: string; attributes: UiGenericCodexDirectiveAttribute[] }
  | {
      kind: 'invalid'
      name?: string
      reason: 'invalid-name' | 'invalid-syntax' | 'invalid-schema' | 'incomplete'
    }
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

- [ ] **Step 4: Preserve attribute order and build redacted generic directives**

Replace the attribute parser return value with an internal structure used by both strict and generic classification:

```ts
type ParsedDirectiveAttributes = {
  values: Record<string, string>
  ordered: Array<{ key: string; value: string }>
}

const SENSITIVE_ATTRIBUTE_PARTS = [
  'password',
  'passwd',
  'token',
  'secret',
  'credential',
  'authorization',
  'apikey',
] as const

function isSensitiveAttribute(key: string): boolean {
  const normalized = key.toLowerCase()
  return SENSITIVE_ATTRIBUTE_PARTS.some((part) => normalized.includes(part))
}

function toGenericDirective(
  name: string,
  ordered: ParsedDirectiveAttributes['ordered'],
): UiCodexDirective {
  return {
    kind: 'generic',
    name,
    attributes: ordered.map(({ key, value }) => {
      const sensitive = isSensitiveAttribute(key)
      return { key, value: sensitive ? '••••' : value, sensitive }
    }),
  }
}
```

`readAttributes()` must reject duplicate keys as before while pushing each decoded key/value pair into `ordered`. Pass `parsed.values` to the existing strict `toDirective()`.

- [ ] **Step 5: Classify every standalone directive-like line**

Replace the known-only `readDirective()` with a total standalone classifier:

```ts
function readSafeDirectiveName(value: string): string | undefined {
  return /^::([a-z][a-z0-9-]*)/u.exec(value)?.[1]
}

function readDirective(line: string): UiCodexDirective | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('::')) return null

  const name = readSafeDirectiveName(trimmed)
  if (!name) return { kind: 'invalid', reason: 'invalid-name' }
  if (!hasStructuralClosingBrace(trimmed.slice(2))) {
    return { kind: 'invalid', name, reason: 'incomplete' }
  }

  const match = /^::([a-z][a-z0-9-]*)\{(.*)\}$/u.exec(trimmed)
  if (!match) return { kind: 'invalid', name, reason: 'invalid-syntax' }
  const parsed = readAttributes(match[2])
  if (!parsed) return { kind: 'invalid', name, reason: 'invalid-syntax' }

  if (!SUPPORTED_DIRECTIVE_NAMES.includes(name as typeof SUPPORTED_DIRECTIVE_NAMES[number])) {
    return toGenericDirective(name, parsed.ordered)
  }
  return toDirective(name, parsed.values)
    ?? { kind: 'invalid', name, reason: 'invalid-schema' }
}
```

Keep the existing fence state machine. Every non-null result is added to `directives` and its entire source line is removed from prose.

- [ ] **Step 6: Generalize live incomplete suppression**

Replace `isIncompleteSupportedDirective()` with:

```ts
function isIncompleteTrailingDirective(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('::') && !hasStructuralClosingBrace(trimmed.slice(2))
}
```

Use it only for the final line while `suppressIncompleteTrailingDirective === true`. In non-live parsing, the same line becomes an `incomplete` warning directive.

- [ ] **Step 7: Add invalid, fence, inline, and whitespace tests**

Replace the prior expectation that unknown and malformed directives remain raw. Assert these standalone cases become structured warnings:

```ts
it.each([
  ['known schema', '::git-push{cwd="/tmp/repo"}', 'git-push', 'invalid-schema'],
  ['duplicate attribute', '::future{x="1" x="2"}', 'future', 'invalid-syntax'],
  ['trailing garbage', '::future{x="1"} nope', 'future', 'invalid-syntax'],
  ['invalid name', '::Future{x="1"}', undefined, 'invalid-name'],
  ['incomplete final output', '::future{x="1"', 'future', 'incomplete'],
])('renders an invalid %s as a warning directive', (_label, source, name, reason) => {
  expect(parseCodexDirectiveText(source)).toEqual({
    text: '',
    directives: [{ kind: 'invalid', name, reason }],
  })
})
```

Keep and extend fence/inline tests so the same unknown and malformed forms remain byte-for-byte literal inside code fences or prose. Add a mixed typed/generic/invalid case and assert source order.

- [ ] **Step 8: Run parser tests and commit**

Run:

```bash
pnpm exec vitest run src/utils/codexDirectives.test.ts
```

Expected: all parser and presentation-helper tests that do not yet require new label cases pass; TypeScript exhaustiveness failures are addressed in Task 3.

Commit:

```bash
git add src/types/codex.ts src/utils/codexDirectives.ts src/utils/codexDirectives.test.ts
git commit -m "feat: parse generic and invalid Codex directives"
```

---

### Task 2: Preserve generic directives across persisted and live messages

**Files:**
- Modify: `src/api/normalizers/v2.test.ts`
- Modify: `src/composables/useDesktopState.test.ts`
- Verify: `src/api/normalizers/v2.ts`
- Verify: `src/composables/useDesktopState.ts`

**Interfaces:**
- Consumes: `parseCodexDirectiveText()` variants from Task 1.
- Produces: identical generic/invalid directive objects from persisted `thread/read` normalization and live `item/agentMessage/delta` accumulation, with no raw-fragment flicker or duplicates.

- [ ] **Step 1: Write a failing persisted-normalization test**

Add to `src/api/normalizers/v2.test.ts`:

```ts
it('normalizes future and invalid standalone directives only from assistant messages', () => {
  const response = threadReadResponseWithContent([
    {
      type: 'agentMessage',
      id: 'assistant-future',
      text: 'Done.\n::future-directive{phase="done"}\n::git-push{cwd="/tmp/repo"}',
    },
    {
      type: 'userMessage',
      id: 'user-future',
      content: [{
        type: 'text',
        text: '::future-directive{phase="user"}',
        text_elements: [],
      }],
    },
  ])

  const messages = normalizeThreadMessagesV2(response)
  expect(messages[0]).toMatchObject({
    text: 'Done.',
    directives: [
      {
        kind: 'generic',
        name: 'future-directive',
        attributes: [{ key: 'phase', value: 'done', sensitive: false }],
      },
      { kind: 'invalid', name: 'git-push', reason: 'invalid-schema' },
    ],
  })
  expect(messages[1]).toMatchObject({
    text: '::future-directive{phase="user"}',
  })
  expect(messages[1].directives).toBeUndefined()
})
```

- [ ] **Step 2: Run the persisted test and verify its expected state**

Run:

```bash
pnpm exec vitest run src/api/normalizers/v2.test.ts -t 'future and invalid standalone directives'
```

Expected after Task 1 parser work: PASS without production changes, proving existing assistant-only normalization wiring is reusable. If it fails, change only the existing assistant parsing call in `v2.ts`; do not parse user items.

- [ ] **Step 3: Write live split-delta and completion-warning tests**

Add to `describe('Codex directive notification state')`:

```ts
it('withholds and then renders a split future directive without raw fragments', async () => {
  const { state, emit } = await setupCodexDirectiveNotificationState()
  emit({
    method: 'item/agentMessage/delta',
    params: { threadId: 'thread-1', itemId: 'agent-1', delta: 'Done.\n::future-dire' },
  })
  expect(state.messages.value.at(-1)).toMatchObject({ text: 'Done.' })
  expect(state.messages.value.at(-1)?.directives).toBeUndefined()

  emit({
    method: 'item/agentMessage/delta',
    params: {
      threadId: 'thread-1',
      itemId: 'agent-1',
      delta: 'ctive{phase="done"}',
    },
  })
  expect(state.messages.value.at(-1)).toMatchObject({
    text: 'Done.',
    directives: [{
      kind: 'generic',
      name: 'future-directive',
      attributes: [{ key: 'phase', value: 'done', sensitive: false }],
    }],
  })
})
```

Add a second test that streams `::future{x="1"` and then sends `item/completed` with that same incomplete text. Assert live text hides it and completed state contains exactly one `{ kind: 'invalid', name: 'future', reason: 'incomplete' }` card.

- [ ] **Step 4: Run live and persisted integration suites**

Run:

```bash
pnpm exec vitest run src/api/normalizers/v2.test.ts src/composables/useDesktopState.test.ts -t 'directive|future'
```

Expected: all selected tests pass, raw future prefixes never appear in live message text, and no directive duplicates are appended.

- [ ] **Step 5: Commit normalization and live regression tests**

```bash
git add src/api/normalizers/v2.test.ts src/composables/useDesktopState.test.ts src/api/normalizers/v2.ts src/composables/useDesktopState.ts
git commit -m "test: cover generic directives in persisted and live output"
```

Stage `v2.ts` or `useDesktopState.ts` only if the failing integration test required a minimal production wiring fix.

---

### Task 3: Render and export generic and invalid cards

**Files:**
- Modify: `src/utils/codexDirectives.ts:300-430`
- Modify: `src/utils/codexDirectives.test.ts:226-430`
- Modify: `src/components/content/CodexDirectiveNotices.vue`
- Modify: `src/components/content/codexDirectiveNotices.wiring.test.ts`
- Modify: `src/composables/useUiLanguage.ts:130-160`
- Modify: `src/style.css:660-720,1942-1946`

**Interfaces:**
- Consumes: typed, generic, and invalid `UiCodexDirective` objects.
- Produces: exhaustive `codexDirectiveLabel()`, `codexDirectiveInvalidReason()`, `codexDirectiveHref()`, and `codexDirectiveExportLines()` behavior plus neutral/warning card markup and responsive styles.

- [ ] **Step 1: Write failing presentation-helper tests**

Add tests to `src/utils/codexDirectives.test.ts`:

```ts
it('labels generic and invalid directives without granting links', () => {
  const generic = {
    kind: 'generic' as const,
    name: 'future-directive',
    attributes: [{ key: 'phase', value: 'done', sensitive: false }],
  }
  const invalid = {
    kind: 'invalid' as const,
    name: 'git-push',
    reason: 'invalid-schema' as const,
  }

  expect(codexDirectiveLabel(generic, translate)).toBe('Codex directive: future-directive')
  expect(codexDirectiveHref(generic)).toBeNull()
  expect(codexDirectiveLabel(invalid, translate)).toBe('Directive format error')
  expect(codexDirectiveInvalidReason(invalid, translate)).toBe('Invalid directive fields')
  expect(codexDirectiveHref(invalid)).toBeNull()
})

it('exports generic and invalid directives as readable Markdown', () => {
  expect(codexDirectiveExportLines({
    kind: 'generic',
    name: 'future-directive',
    attributes: [
      { key: 'phase', value: 'done', sensitive: false },
      { key: 'accessToken', value: '••••', sensitive: true },
    ],
  }, translate)).toEqual([
    '- Codex directive: future\-directive',
    '  - phase: done',
    '  - accessToken: ••••',
  ])

  const invalidLines = codexDirectiveExportLines({
    kind: 'invalid',
    name: 'git-push',
    reason: 'invalid-schema',
  }, translate)
  expect(invalidLines.join('\n')).toContain('Directive format error')
  expect(invalidLines.join('\n')).not.toContain('::')
})
```

Import `codexDirectiveInvalidReason` in the test.

- [ ] **Step 2: Run presentation tests and verify RED**

Run:

```bash
pnpm exec vitest run src/utils/codexDirectives.test.ts -t 'labels generic|exports generic'
```

Expected: FAIL because label, reason, and export helpers do not handle the new variants.

- [ ] **Step 3: Implement exhaustive labels, reasons, hrefs, and exports**

Add cases to the helper switches:

```ts
export function codexDirectiveInvalidReason(
  directive: Extract<UiCodexDirective, { kind: 'invalid' }>,
  translate: DirectiveTranslate,
): string {
  switch (directive.reason) {
    case 'invalid-name': return translate('Invalid directive name')
    case 'invalid-syntax': return translate('Invalid directive syntax')
    case 'invalid-schema': return translate('Invalid directive fields')
    case 'incomplete': return translate('Incomplete directive output')
  }
}
```

`codexDirectiveLabel()` returns `Codex directive: {name}` for generic and `Directive format error` for invalid. `codexDirectiveHref()` returns `null` for both. Generic export escapes the name, keys, and values and emits no Markdown link syntax. Invalid export includes the title, optional safe name, and translated reason but no raw source.

- [ ] **Step 4: Add translations**

Add English keys to the Chinese translation map in `src/composables/useUiLanguage.ts`:

```ts
'Codex directive: {name}': 'Codex 指令：{name}',
'Directive format error': '指令格式异常',
'Directive name': '指令名称',
'Invalid directive name': '指令名称无效',
'Invalid directive syntax': '指令语法无效',
'Invalid directive fields': '指令字段无效',
'Incomplete directive output': '指令输出不完整',
```

- [ ] **Step 5: Write failing notice-component wiring assertions**

Extend `codexDirectiveNotices.wiring.test.ts` to require:

```ts
expect(noticeSource).toContain("directive.kind === 'generic'")
expect(noticeSource).toContain("directive.kind === 'invalid'")
expect(noticeSource).toContain('codexDirectiveInvalidReason')
expect(noticeSource).toContain('directive.attributes')
expect(noticeSource).toContain('codex-directive-attributes')
```

Run:

```bash
pnpm exec vitest run src/components/content/codexDirectiveNotices.wiring.test.ts
```

Expected: FAIL because the component has only known success and code-comment markup.

- [ ] **Step 6: Render neutral and warning variants**

Update `CodexDirectiveNotices.vue` so each article has variant classes and icons:

```vue
<article
  class="codex-directive-notice"
  :class="{
    'codex-directive-notice-generic': directive.kind === 'generic',
    'codex-directive-notice-invalid': directive.kind === 'invalid',
  }"
  :data-kind="directive.kind"
  :role="directive.kind === 'invalid' ? 'status' : undefined"
>
  <span class="codex-directive-icon" aria-hidden="true">
    {{ directive.kind === 'invalid' ? '!' : directive.kind === 'generic' ? 'i' : '✓' }}
  </span>
  <!-- existing safe title/link handling -->
  <dl v-if="directive.kind === 'generic'" class="codex-directive-attributes">
    <div v-for="attribute in directive.attributes" :key="attribute.key">
      <dt>{{ attribute.key }}</dt>
      <dd>{{ attribute.value }}</dd>
    </div>
  </dl>
  <template v-else-if="directive.kind === 'invalid'">
    <span v-if="directive.name" class="codex-directive-meta">{{ directive.name }}</span>
    <p class="codex-directive-body">{{ codexDirectiveInvalidReason(directive, t) }}</p>
  </template>
</article>
```

Vue interpolation must remain the only rendering mechanism for unknown names and attributes. Do not add `v-html`, anchors, router links, or click handlers for generic/invalid variants.

- [ ] **Step 7: Add light, dark, and mobile styles**

Add neutral blue/sky styling for `.codex-directive-notice-generic` and amber styling for `.codex-directive-notice-invalid`. Add a compact definition-list grid:

```css
.codex-directive-attributes {
  @apply mt-1 grid min-w-0 gap-x-2 gap-y-0.5 text-[12px] leading-4;
  grid-template-columns: minmax(0, max-content) minmax(0, 1fr);
}

.codex-directive-attributes div {
  display: contents;
}

.codex-directive-attributes dt {
  @apply min-w-0 font-medium text-slate-500;
  overflow-wrap: anywhere;
}

.codex-directive-attributes dd {
  @apply m-0 min-w-0 text-slate-700;
  overflow-wrap: anywhere;
}
```

Add explicit dark-theme text, border, surface, and icon colors in `src/style.css`. At `max-width: 768px`, keep the grid within the existing compact notice padding and allow both columns to wrap without horizontal page overflow.

- [ ] **Step 8: Run helper/component tests and commit**

Run:

```bash
pnpm exec vitest run src/utils/codexDirectives.test.ts src/components/content/codexDirectiveNotices.wiring.test.ts src/components/content/codexDirectiveExport.wiring.test.ts
```

Expected: all tests pass and TypeScript helper switches are exhaustive.

Commit:

```bash
git add src/utils/codexDirectives.ts src/utils/codexDirectives.test.ts src/components/content/CodexDirectiveNotices.vue src/components/content/codexDirectiveNotices.wiring.test.ts src/composables/useUiLanguage.ts src/style.css
git commit -m "feat: render generic and invalid directive cards"
```

---

### Task 4: Document, verify, review, integrate, and deploy

**Files:**
- Modify: `tests/thread-loading-state/mobile-codex-directive-notices.md`
- Modify: `tests/thread-loading-state/index.md`
- Evidence: sanitized files under `/tmp`

**Interfaces:**
- Consumes: parser, live/persisted integration, presentation, and export work from Tasks 1-3.
- Produces: repeatable manual acceptance coverage, performance evidence, merged GitHub main, installed service, and Tailnet-only deployment.

- [ ] **Step 1: Update manual acceptance coverage**

Change the existing manual document so unknown valid directives are expected as neutral cards and malformed directives as warning cards. Add exact checks for split-delta suppression, sensitive-value absence from DOM/export, no generic links, mixed source order, 375x812 and 768x1024 light/dark layouts, and fenced literals remaining raw. Add the document to `tests/thread-loading-state/index.md` if it is not already listed.

- [ ] **Step 2: Run focused and full verification**

Run:

```bash
pnpm exec vitest run src/utils/codexDirectives.test.ts src/api/normalizers/v2.test.ts src/composables/useDesktopState.test.ts src/components/content/codexDirectiveNotices.wiring.test.ts src/components/content/codexDirectiveExport.wiring.test.ts
pnpm run test:unit
pnpm run build
node dist-cli/index.js --help
node dist-cli/safe.js doctor
```

Expected: zero test failures, successful frontend/CLI build, compatibility help exit zero, and safe doctor `ok`.

- [ ] **Step 3: Perform the required performance and security audit**

Record under `/tmp`:

```text
message parser passes: 1
new network requests: 0
new timers/watchers: 0
unknown directive anchors/actions: 0
raw future directive fragments during split live delta: 0
sensitive generic values in parsed state, DOM contract, and export: 0
batch/polling/auth/Tailscale/ntfy changes: 0
```

Confirm the parser remains line-oriented and rendering remains proportional to directive and attribute counts.

- [ ] **Step 4: Commit docs, review the diff, and request code review**

```bash
git add tests/thread-loading-state/mobile-codex-directive-notices.md tests/thread-loading-state/index.md
git commit -m "test: document generic directive rendering"
git diff --check main...HEAD
git diff --stat main...HEAD
git log --oneline main..HEAD
```

Use the repository code-review workflow. Fix Critical and Important findings before integration and rerun affected tests.

- [ ] **Step 5: Integrate through GitHub**

Fetch `origin`, confirm `main` has not advanced or rebase deliberately, push `codex/render-all-directives`, create a ready PR against `zonghang-li/codex-mobile:main`, request `/review`, merge only after the branch is clean and required checks pass, then fast-forward local `main` to `origin/main`.

- [ ] **Step 6: Install and verify the safe service**

From synchronized `main`:

```bash
pnpm run service:install
codex-mobile --help
codex-mobile-safe doctor
codex-mobile-safe status
codex-mobile-safe urls
ss -ltnp '( sport = :5900 )'
tailscale serve status
journalctl --user -u codex-mobile-safe -n 30 --no-pager
```

Expected: service active on `127.0.0.1:5900`, password protection retained, Tailscale Serve reports `tailnet only`, and the restart journal has no startup errors or secret output.
