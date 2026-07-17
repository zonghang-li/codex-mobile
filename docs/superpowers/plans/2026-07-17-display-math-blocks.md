# Display Math Blocks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render balanced `\[...\]` LaTeX environments as safe, responsive display mathematics in normal conversation messages and plan cards.

**Architecture:** Add a pure linear scanner that separates supported display-math spans from Markdown prose without consuming code examples, then feed math spans into the existing `MessageBlock` pipeline. Load KaTeX 0.17.0 and its CSS only when a visible message contains a possible formula; a shared safe adapter, bounded cache, and reactive version make the direct-template and cached-plan rendering paths converge after the lazy import.

**Tech Stack:** Vue 3.5, TypeScript 5.7, Vitest 4.1, Vite 6, Tailwind CSS 4, KaTeX 0.17.0, pnpm 10.

## Global Constraints

- Support only balanced, unescaped `\[...\]` display environments; `$`, `$$`, `\(...\)`, and standalone `\begin` environments remain literal.
- Preserve `\[...\]` literally inside backtick/tilde fences, inline backtick code spans, escaped delimiter forms, and unmatched environments.
- KaTeX must use `displayMode: true`, `throwOnError: true`, `trust: false`, and strict handling; invalid formulas fall back to the exact escaped source.
- Messages without `\[` must not load or initialize KaTeX, and the production build must keep KaTeX in a separate lazy chunk.
- No CDN, backend request, timer, polling, notification, Tailnet, authentication, or protocol change.
- Formula blocks must stay within the conversation width, scroll horizontally inside the block when necessary, and remain legible at 375x812 and 768x1024 in light and dark themes.
- Start every production task with a focused failing test, commit each independently reviewable task, and finish with the full repository verification matrix.

---

## File Structure

- Create `src/components/content/displayMath.ts`: pure code-aware `\[...\]` span scanner; no Vue or KaTeX dependency.
- Create `src/components/content/displayMath.test.ts`: scanner boundary tests.
- Create `src/components/content/displayMathRenderer.ts`: KaTeX option contract and total render adapter.
- Create `src/components/content/displayMathRenderer.test.ts`: adapter tests with a fake renderer.
- Modify `src/components/content/messageBlockTypes.ts`: add the `mathBlock` union member.
- Modify `src/components/content/ThreadConversation.vue`: parser integration, lazy loader, bounded cache/version wiring, both render paths, and responsive styles.
- Create `src/components/content/displayMathIntegration.wiring.test.ts`: lazy import, cache invalidation, fallback, rendering, and style contract.
- Modify `src/style.css`: decisive dark-theme math presentation.
- Create `tests/chat-composer-rendering/display-math-block-rendering.md`: exact manual regression coverage.
- Modify `tests/chat-composer-rendering/index.md`: link the manual test.
- Modify `tests.md`: reconcile the stale relevant-domain count with the 36 existing rows, then increment it to 37 for the new row.
- Modify `package.json`: add exact runtime dependency `katex: "0.17.0"`.

---

### Task 1: Code-aware display-math scanner

**Files:**
- Create: `src/components/content/displayMath.ts`
- Create: `src/components/content/displayMath.test.ts`
- Modify: `src/components/content/messageBlockTypes.ts`

**Interfaces:**
- Consumes: raw Markdown text.
- Produces: `splitDisplayMathSpans(text: string): DisplayMathSpan[]`, where spans are `{ kind: 'text'; value: string }` or `{ kind: 'math'; value: string; source: string }`.
- Produces: `MessageBlock` member `{ kind: 'mathBlock'; value: string; source: string }`.

- [ ] **Step 1: Write the failing scanner tests**

Create `src/components/content/displayMath.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { splitDisplayMathSpans } from './displayMath'

describe('splitDisplayMathSpans', () => {
  it('extracts single-line and multiline display environments in order', () => {
    expect(splitDisplayMathSpans('Before \\[x^2\\] after\n\\[\n\\frac{1}{2}\n\\]')).toEqual([
      { kind: 'text', value: 'Before ' },
      { kind: 'math', value: 'x^2', source: '\\[x^2\\]' },
      { kind: 'text', value: ' after\n' },
      { kind: 'math', value: '\\frac{1}{2}', source: '\\[\n\\frac{1}{2}\n\\]' },
    ])
  })

  it('keeps multiple formulas distinct', () => {
    expect(splitDisplayMathSpans('\\[a\\]\ntext\n\\[b\\]')).toEqual([
      { kind: 'math', value: 'a', source: '\\[a\\]' },
      { kind: 'text', value: '\ntext\n' },
      { kind: 'math', value: 'b', source: '\\[b\\]' },
    ])
  })

  it('keeps escaped, inline-code, and unmatched delimiters literal', () => {
    const input = 'escaped \\\\[x\\\\] and inline `\\[y\\]` and unmatched \\[z'
    expect(splitDisplayMathSpans(input)).toEqual([{ kind: 'text', value: input }])
  })

  it('keeps backtick and tilde fence examples literal', () => {
    const input = ['```text', '\\[x\\]', '```', '~~~', '\\[y\\]', '~~~', '\\[z\\]'].join('\n')
    expect(splitDisplayMathSpans(input)).toEqual([
      { kind: 'text', value: ['```text', '\\[x\\]', '```', '~~~', '\\[y\\]', '~~~', ''].join('\n') },
      { kind: 'math', value: 'z', source: '\\[z\\]' },
    ])
  })

  it('leaves unsupported syntaxes literal', () => {
    const input = String.raw`$a$ $$b$$ \\(c\\) \\begin{equation}d\\end{equation}`
    expect(splitDisplayMathSpans(input)).toEqual([{ kind: 'text', value: input }])
  })

  it('never drops incomplete trailing source', () => {
    const input = String.raw`prefix \\[x + 1`
    expect(splitDisplayMathSpans(input).map((span) => span.kind === 'text' ? span.value : span.source).join('')).toBe(input)
  })
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

```bash
pnpm exec vitest run src/components/content/displayMath.test.ts
```

Expected: FAIL with `Cannot find module './displayMath'`.

- [ ] **Step 3: Implement the scanner**

Create `src/components/content/displayMath.ts`:

```ts
export type DisplayMathSpan =
  | { kind: 'text'; value: string }
  | { kind: 'math'; value: string; source: string }

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) slashCount += 1
  return slashCount % 2 === 1
}

function markerRunLength(text: string, index: number, marker: '`' | '~'): number {
  let cursor = index
  while (text[cursor] === marker) cursor += 1
  return cursor - index
}

export function splitDisplayMathSpans(text: string): DisplayMathSpan[] {
  if (!text.includes('\\[')) return [{ kind: 'text', value: text }]
  const spans: DisplayMathSpan[] = []
  let textStart = 0
  let cursor = 0
  let lineStart = true
  let inlineTicks = 0
  let fence: { marker: '`' | '~'; length: number } | null = null

  const emitText = (end: number): void => {
    if (end > textStart) spans.push({ kind: 'text', value: text.slice(textStart, end) })
  }

  while (cursor < text.length) {
    if (lineStart && inlineTicks === 0) {
      const line = text.slice(cursor).match(/^ {0,3}(`{3,}|~{3,})/u)
      if (line) {
        const marker = line[1][0] as '`' | '~'
        const length = line[1].length
        if (!fence) fence = { marker, length }
        else if (fence.marker === marker && length >= fence.length) fence = null
        const newline = text.indexOf('\n', cursor)
        cursor = newline === -1 ? text.length : newline + 1
        lineStart = true
        continue
      }
    }
    if (!fence && text[cursor] === '`' && !isEscaped(text, cursor)) {
      const run = markerRunLength(text, cursor, '`')
      if (inlineTicks === 0) inlineTicks = run
      else if (inlineTicks === run) inlineTicks = 0
      cursor += run
      lineStart = false
      continue
    }
    if (!fence && inlineTicks === 0 && text.startsWith('\\[', cursor) && !isEscaped(text, cursor)) {
      let close = cursor + 2
      while (close < text.length && !(text.startsWith('\\]', close) && !isEscaped(text, close))) close += 1
      if (close < text.length) {
        emitText(cursor)
        const source = text.slice(cursor, close + 2)
        spans.push({ kind: 'math', value: text.slice(cursor + 2, close).trim(), source })
        cursor = close + 2
        textStart = cursor
        lineStart = cursor === 0 || text[cursor - 1] === '\n'
        continue
      }
    }
    lineStart = text[cursor] === '\n'
    cursor += 1
  }
  emitText(text.length)
  return spans.length > 0 ? spans : [{ kind: 'text', value: text }]
}
```

Add this union member before `codeBlock` in `messageBlockTypes.ts`:

```ts
  | { kind: 'mathBlock'; value: string; source: string }
```

- [ ] **Step 4: Verify and commit**

```bash
pnpm exec vitest run src/components/content/displayMath.test.ts
pnpm exec vue-tsc --noEmit
git add src/components/content/displayMath.ts src/components/content/displayMath.test.ts src/components/content/messageBlockTypes.ts
git commit -m "feat: parse display math spans"
```

Expected: 6 tests PASS, typecheck exits 0, and one focused commit is created.

---

### Task 2: Safe KaTeX adapter and dependency

**Files:**
- Create: `src/components/content/displayMathRenderer.ts`
- Create: `src/components/content/displayMathRenderer.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: a KaTeX-compatible render function.
- Produces: `tryRenderDisplayMathToHtml(renderer, value): string | null` and `DisplayMathRenderFunction`.

- [ ] **Step 1: Install the exact runtime dependency**

```bash
pnpm add katex@0.17.0 --save-exact
```

Expected: `package.json` contains `"katex": "0.17.0"` under `dependencies`; do not stage an ignored lockfile.

- [ ] **Step 2: Write and run failing adapter tests**

Create `src/components/content/displayMathRenderer.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { tryRenderDisplayMathToHtml } from './displayMathRenderer'

describe('tryRenderDisplayMathToHtml', () => {
  it('uses locked safe display options', () => {
    const renderer = vi.fn(() => '<span class="katex">x</span>')
    expect(tryRenderDisplayMathToHtml(renderer, 'x')).toContain('katex')
    expect(renderer).toHaveBeenCalledWith('x', {
      displayMode: true,
      throwOnError: true,
      trust: false,
      strict: 'warn',
    })
  })

  it('returns null when unavailable or invalid', () => {
    expect(tryRenderDisplayMathToHtml(null, 'x')).toBeNull()
    expect(tryRenderDisplayMathToHtml(() => { throw new Error('invalid') }, '\\bad{')).toBeNull()
  })
})
```

Run `pnpm exec vitest run src/components/content/displayMathRenderer.test.ts`.

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the total adapter**

Create `src/components/content/displayMathRenderer.ts`:

```ts
export type DisplayMathRenderOptions = {
  displayMode: true
  throwOnError: true
  trust: false
  strict: 'warn'
}

export type DisplayMathRenderFunction = (value: string, options: DisplayMathRenderOptions) => string

const OPTIONS: DisplayMathRenderOptions = {
  displayMode: true,
  throwOnError: true,
  trust: false,
  strict: 'warn',
}

export function tryRenderDisplayMathToHtml(
  renderer: DisplayMathRenderFunction | null,
  value: string,
): string | null {
  if (!renderer) return null
  try {
    return renderer(value, OPTIONS)
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Verify and commit**

```bash
pnpm exec vitest run src/components/content/displayMathRenderer.test.ts
pnpm exec vue-tsc --noEmit
git add package.json src/components/content/displayMathRenderer.ts src/components/content/displayMathRenderer.test.ts
git commit -m "feat: add safe KaTeX display renderer"
```

Expected: 2 tests PASS and typecheck exits 0.

---

### Task 3: Integrate parsing, lazy loading, and both render paths

**Files:**
- Modify: `src/components/content/ThreadConversation.vue`
- Create: `src/components/content/displayMathIntegration.wiring.test.ts`

**Interfaces:**
- Consumes: Task 1 scanner/type and Task 2 renderer.
- Produces: `ensureDisplayMathLoaded(): Promise<void>`, `renderDisplayMathInnerAsHtml(block): string`, direct-template output, and cached plan-card HTML.
- Cache contract: `mathRenderVersion` participates in direct `v-memo` and plan HTML cache keys/entries.

- [ ] **Step 1: Write the failing integration test**

Create `src/components/content/displayMathIntegration.wiring.test.ts`:

```ts
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const conversationUrl = new URL('./ThreadConversation.vue', import.meta.url)

describe('ThreadConversation display math integration', () => {
  it('turns scanner math spans into message blocks', async () => {
    const source = await readFile(conversationUrl, 'utf8')
    expect(source).toContain("import { splitDisplayMathSpans } from './displayMath'")
    expect(source).toContain("span.kind === 'math'")
    expect(source).toContain("kind: 'mathBlock'")
  })

  it('lazy-loads KaTeX and invalidates direct and plan caches', async () => {
    const source = await readFile(conversationUrl, 'utf8')
    expect(source).toContain("import('katex')")
    expect(source).toContain("import('katex/dist/katex.min.css')")
    expect(source).toContain('mathRenderVersion.value += 1')
    expect(source).toMatch(/v-memo="\[[^"]*mathRenderVersion/u)
    expect(source).toMatch(/highlightCacheVersion\.value[^\n]*mathRenderVersion\.value/u)
  })

  it('renders direct and plan-card math with an escaped fallback', async () => {
    const source = await readFile(conversationUrl, 'utf8')
    expect(source).toContain("block.kind === 'mathBlock'")
    expect(source).toContain('class="message-math-block"')
    expect(source).toContain('renderDisplayMathInnerAsHtml(block)')
    expect(source).toContain('escapeHtml(block.source)')
  })

  it('loads only after relevant message text appears', async () => {
    const source = await readFile(conversationUrl, 'utf8')
    expect(source).toContain("message.text.includes('\\\\[')")
    expect(source).toContain('void ensureDisplayMathLoaded()')
  })
})
```

Run `pnpm exec vitest run src/components/content/displayMathIntegration.wiring.test.ts`.

Expected: all 4 tests FAIL.

- [ ] **Step 2: Integrate scanner spans without changing fence extraction**

Add imports:

```ts
import { splitDisplayMathSpans } from './displayMath'
import { tryRenderDisplayMathToHtml, type DisplayMathRenderFunction } from './displayMathRenderer'
```

Rename the existing `parseNonCodeMessageBlocks` body to `parseTextAndImageBlocks`. Replace it with:

```ts
function parseNonCodeMessageBlocks(text: string): MessageBlock[] {
  return splitDisplayMathSpans(text).flatMap((span): MessageBlock[] => {
    if (span.kind === 'math') return [{ kind: 'mathBlock', value: span.value, source: span.source }]
    return parseTextAndImageBlocks(span.value)
  })
}
```

Keep `parseMessageBlocks`' existing top-level fence extraction unchanged.

- [ ] **Step 3: Add the lazy loader, bounded cache, and safe inner renderer**

Beside highlight state add:

```ts
const displayMathRenderer = ref<DisplayMathRenderFunction | null>(null)
const mathRenderVersion = ref(0)
let displayMathLoader: Promise<void> | null = null
const DISPLAY_MATH_HTML_CACHE_LIMIT = 250
const displayMathHtmlCache = new Map<string, string | null>()
```

Implement:

```ts
function ensureDisplayMathLoaded(): Promise<void> {
  if (displayMathRenderer.value) return Promise.resolve()
  if (!displayMathLoader) {
    displayMathLoader = Promise.all([import('katex'), import('katex/dist/katex.min.css')])
      .then(([module]) => {
        displayMathRenderer.value = module.default.renderToString as DisplayMathRenderFunction
        displayMathHtmlCache.clear()
        markdownHtmlCache.clear()
        mathRenderVersion.value += 1
      })
      .catch(() => {
        // Keep escaped source visible. A later relevant message change retries the import.
      })
      .finally(() => { displayMathLoader = null })
  }
  return displayMathLoader
}

function renderDisplayMathInnerAsHtml(block: Extract<MessageBlock, { kind: 'mathBlock' }>): string {
  const key = `${mathRenderVersion.value}\u0000${block.value}`
  if (!displayMathHtmlCache.has(key)) {
    setBoundedCacheEntry(
      displayMathHtmlCache,
      key,
      tryRenderDisplayMathToHtml(displayMathRenderer.value, block.value),
      DISPLAY_MATH_HTML_CACHE_LIMIT,
    )
  }
  const rendered = displayMathHtmlCache.get(key) ?? null
  return rendered === null
    ? `<div class="message-math-source">${escapeHtml(block.source)}</div>`
    : `<div class="message-math-katex">${rendered}</div>`
}
```

- [ ] **Step 4: Wire both render paths and cache invalidation**

Add before the direct code-block branch:

```vue
<div
  v-else-if="block.kind === 'mathBlock'"
  class="message-math-block"
  v-html="renderDisplayMathInnerAsHtml(block)"
/>
```

Add before `codeBlock` in `renderMessageBlockAsHtml`:

```ts
if (block.kind === 'mathBlock') {
  return `<div class="message-math-block">${renderDisplayMathInnerAsHtml(block)}</div>`
}
```

Add `mathRenderVersion` to direct `v-memo`. Extend `MarkdownHtmlCacheEntry` with `mathVersion`; include `mathRenderVersion.value` in the plan cache key, hit comparison, and stored entry. `MessageBlockRenderer.vue` already delegates non-code nested blocks to `renderMessageBlockAsHtml`, so do not duplicate a second math renderer there.

Add next to the highlight watcher:

```ts
watch(
  () => props.messages
    .filter((message) => message.text.includes('\\['))
    .map((message) => `${message.id}:${message.text.length}`)
    .join('\u0000'),
  (displayMathSignature) => {
    if (!displayMathSignature || displayMathRenderer.value) return
    void ensureDisplayMathLoaded()
  },
  { immediate: true },
)
```

Clear the formula cache with the other component-owned caches. Add no retry timer or request.

- [ ] **Step 5: Verify and commit**

```bash
pnpm exec vitest run src/components/content/displayMath.test.ts src/components/content/displayMathRenderer.test.ts src/components/content/displayMathIntegration.wiring.test.ts src/components/content/outputBlockCopyIntegration.test.ts
pnpm exec vue-tsc --noEmit
git add src/components/content/ThreadConversation.vue src/components/content/displayMathIntegration.wiring.test.ts
git commit -m "feat: render lazy display math in conversations"
```

Expected: all focused tests PASS and typecheck exits 0.

---

### Task 4: Responsive themes and manual regression contract

**Files:**
- Modify: `src/components/content/ThreadConversation.vue`
- Modify: `src/style.css`
- Modify: `src/components/content/displayMathIntegration.wiring.test.ts`
- Create: `tests/chat-composer-rendering/display-math-block-rendering.md`
- Modify: `tests/chat-composer-rendering/index.md`
- Modify: `tests.md`

**Interfaces:**
- Consumes: the three math CSS classes emitted by Task 3.
- Produces: page-width containment, touch scrolling, dark styling, and repeatable manual coverage.

- [ ] **Step 1: Add a failing style contract**

Append this test:

```ts
it('contains wide formulas and has a decisive dark rule', async () => {
  const [conversation, globalStyle] = await Promise.all([
    readFile(conversationUrl, 'utf8'),
    readFile(new URL('../../style.css', import.meta.url), 'utf8'),
  ])
  expect(conversation).toMatch(/\.message-math-block\s*\{[^}]*max-width:\s*100%[^}]*overflow-x:\s*auto/su)
  expect(conversation).toContain('-webkit-overflow-scrolling: touch')
  expect(globalStyle).toMatch(/:root\.dark \.message-math-block\s*\{/u)
})
```

Run the integration test; expect this new case to FAIL.

- [ ] **Step 2: Implement responsive and dark styles**

Add to scoped component styles:

```css
.message-math-block {
  width: 100%;
  max-width: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  padding-block: 0.25rem;
  color: inherit;
  -webkit-overflow-scrolling: touch;
}

.message-math-block :deep(.katex-display) {
  margin: 0;
  width: max-content;
  min-width: 100%;
  text-align: center;
}

.message-math-source {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 0.875rem;
  line-height: 1.625;
}
```

Add `.message-math-block` to the plan-card zero-margin selector. Add to `src/style.css`:

```css
:root.dark .message-math-block {
  color: rgb(228 228 231);
}
```

- [ ] **Step 3: Add the manual test and indexes**

Create `tests/chat-composer-rendering/display-math-block-rendering.md` with:

```markdown
### Display math block rendering

#### Feature/Change Name
Balanced `\[...\]` LaTeX display environments render with lazy local KaTeX.

#### Prerequisites/Setup
1. Build the current worktree and run it at `http://127.0.0.1:4173`.
2. A `TestChat` project/thread is available.
3. DevTools Network is open with cache disabled.

#### Steps
1. Load a thread without `\[` and confirm no KaTeX asset is requested.
2. Send `\[ E = mc^2 \]` and a multiline fraction/summation; confirm formatted math and one lazy load.
3. Render the same formula in a plan explanation or plan step.
4. Send delimiter text inside inline backticks, backtick fences, and tilde fences.
5. Send escaped, unmatched, and invalid formulas; confirm exact source remains visible.
6. Inspect a wide matrix at 375x812 and 768x1024 in light and dark themes.

#### Expected Results
- Only supported balanced environments outside code render as KaTeX.
- Normal messages and plan cards agree; failure never hides source or later output.
- Wide formulas scroll inside their block without page overflow in either theme.

#### Rollback/Cleanup
- Remove the TestChat messages. Reverting the parser, renderer, styles, and dependency restores literal output.
```

Add its row to `tests/chat-composer-rendering/index.md`. The domain index has 36 existing section rows while `tests.md` still says 33; update that stale root count directly to 37 (36 existing plus this new test) without otherwise reorganizing the root index.

- [ ] **Step 4: Verify and commit**

```bash
pnpm exec vitest run src/components/content/displayMathIntegration.wiring.test.ts
pnpm run build:frontend
git add src/components/content/ThreadConversation.vue src/style.css src/components/content/displayMathIntegration.wiring.test.ts tests/chat-composer-rendering/display-math-block-rendering.md tests/chat-composer-rendering/index.md tests.md
git commit -m "test: document responsive display math rendering"
```

Expected: 5 wiring tests PASS and frontend build exits 0.

---

### Task 5: Full verification, browser evidence, and performance audit

**Files:**
- Modify only if verification reveals a defect: the smallest owning file from Tasks 1-4.
- Create ignored evidence: `output/playwright/testchat-display-math-cjs.png`, plus `display-math-{375,768}-{light,dark}.png`.

**Interfaces:**
- Consumes: all implementation/manual contracts.
- Produces: full test/build/CLI evidence, TestChat assertions, responsive screenshots, and measured lazy-chunk report.

- [ ] **Step 1: Recheck live Git state**

```bash
git status --short
git branch --show-current
git status
test ! -e "$(git rev-parse --git-common-dir)/MERGE_HEAD"
test ! -d "$(git rev-parse --git-common-dir)/rebase-merge"
test ! -d "$(git rev-parse --git-common-dir)/rebase-apply"
git diff --stat main...HEAD
git log --oneline main..HEAD
```

Expected: branch `codex/math-display-blocks`, no merge/rebase, and only in-scope commits/files.

- [ ] **Step 2: Run focused and complete verification**

```bash
pnpm exec vitest run src/components/content/displayMath.test.ts src/components/content/displayMathRenderer.test.ts src/components/content/displayMathIntegration.wiring.test.ts src/components/content/outputBlockCopyIntegration.test.ts
pnpm run test:unit
pnpm run build
node dist-cli/index.js --help
node dist-cli/safe.js doctor
```

Expected: focused tests PASS; full suite exceeds the 723-test clean baseline by the new tests; build exits 0; help exits 0; doctor passes.

- [ ] **Step 3: Run the required module-loading smoke test**

```bash
node -e "const katex=require('katex'); const html=katex.renderToString('x^2',{displayMode:true,throwOnError:true,trust:false,strict:'warn'}); if(!html.includes('katex-display')) process.exit(1); console.log('katex-cjs-smoke: ok')"
```

Expected: `katex-cjs-smoke: ok`.

- [ ] **Step 4: Measure lazy chunking and code-path cost**

```bash
find dist/assets -maxdepth 1 -type f -printf '%f %s bytes\n' | sort -k2,2n
rg -l "katex-display|KaTeX" dist/assets/*.js
rg -n "setInterval|setTimeout|fetch\(|ensureDisplayMathLoaded|DISPLAY_MATH_HTML_CACHE_LIMIT" src/components/content/ThreadConversation.vue src/components/content/displayMath.ts src/components/content/displayMathRenderer.ts
```

Expected: one separate KaTeX JS asset, no KaTeX in the initial app chunk, one in-flight loader, 250-entry cache, one load-version invalidation, and no new request/timer. Record actual JS/CSS sizes and duplicate-chunk count.

- [ ] **Step 5: Start the current worktree on disposable port 4173**

Inspect `lsof -nP -iTCP:4173 -sTCP:LISTEN`. If occupied, inspect its cwd and stop only a stale/other-worktree 4173 process. Start `pnpm run dev --host 127.0.0.1 --port 4173`. Never stop the tmux-managed 5173 server.

- [ ] **Step 6: Perform mandatory TestChat validation**

Using a CJS Playwright check, open TestChat and send one user message containing a unique marker, `\[ E = mc^2 \]`, and a known local Markdown file link. Inspect the new row:

```js
const result = await row.evaluate((element) => {
  const link = element.querySelector('a.message-file-link')
  return {
    mathOk: Boolean(element.querySelector('.message-math-block .katex-display')),
    delimitersHidden: !element.textContent.includes('\\[') && !element.textContent.includes('\\]'),
    hrefOk: Boolean(link?.getAttribute('href')?.startsWith('/codex-local-browse/')),
    titleOk: Boolean(link?.getAttribute('title')),
    textOk: Boolean(link?.textContent?.trim()),
  }
})
if (!Object.values(result).every(Boolean)) throw new Error(JSON.stringify(result))
```

Save `output/playwright/testchat-display-math-cjs.png`. Expected: all five flags are true.

- [ ] **Step 7: Capture responsive light/dark evidence**

Render a multiline fraction and wide matrix. At 375x812 and 768x1024, wait 2-3 seconds and save the four requested screenshots. Assert:

```js
const geometry = await page.locator('.message-math-block').last().evaluate((element) => ({
  blockScrollsInternally: element.scrollWidth >= element.clientWidth,
  pageHasNoHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  color: getComputedStyle(element).color,
}))
if (!geometry.blockScrollsInternally || !geometry.pageHasNoHorizontalOverflow) throw new Error(JSON.stringify(geometry))
```

Expected: internal overflow available, page overflow absent, and formulas legible in every screenshot.

- [ ] **Step 8: Fix defects test-first and rerun final verification**

For each defect, add the smallest failing focused assertion, prove failure, implement the minimal fix, rerun narrow tests plus `pnpm run build:frontend`, and commit it separately. Then run:

```bash
pnpm run test:unit
pnpm run build
node dist-cli/index.js --help
node dist-cli/safe.js doctor
git diff --check
git status --short
git diff --stat main...HEAD
git log --oneline main..HEAD
```

Expected: all checks pass and the worktree is clean. Report exact counts, KaTeX asset sizes, TestChat result object, URLs/viewports, absolute screenshot paths, and any measurement limitation.

---

## Final Review Gates

1. Requirements review first: map every recognition, fallback, lazy-load, plan-card, responsive, theme, security, and non-goal requirement in the approved design to a passing check.
2. Code-quality review second: verify linear source-preserving scanning, total error handling, one loader, bounded caches, and page-width containment.
3. Do not merge, push, restart the installed service, or modify `main` without the user's next explicit instruction.
