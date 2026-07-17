# Inline Math Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render `\(...\)` as safe inline KaTeX while retaining `\[...\]` display math, then integrate and deploy the verified build to the running Codex Mobile service.

**Architecture:** Add a pure delimiter scanner for inline math, feed its spans into the existing inline-segment parser before Markdown marker parsing, and reuse the lazy KaTeX renderer with an explicit display-mode parameter. Both Vue-template rendering and cached plan-card HTML consume the same inline math segment and fallback helper.

**Tech Stack:** Vue 3, TypeScript, Vitest, KaTeX 0.17.0, Vite, Playwright, pnpm, systemd user service.

## Global Constraints

- `\[...\]` remains display math and `\(...\)` becomes inline math.
- Never parse math delimiters inside inline code or fenced code.
- Escaped, unmatched, or invalid math remains exact safe visible source.
- `$...$`, `$$...$$`, and standalone equation environments remain literal.
- KaTeX stays local and lazy-loaded with `trust: false`, `throwOnError: true`, and `strict: 'warn'`.
- Verify ordinary messages and plan-card HTML in light and dark themes at 375x812 and 768x1024.
- Install and restart from `/home/zonghangli/codex-mobile` only after the verified branch is integrated into `main`.

---

### Task 1: Parse inline math without touching code spans

**Files:**
- Create: `src/components/content/inlineMath.ts`
- Create: `src/components/content/inlineMath.test.ts`

**Interfaces:**
- Produces: `InlineMathSpan` and `splitInlineMathSpans(text: string): InlineMathSpan[]`.
- Consumes: raw inline-container text before the existing link and Markdown marker parser.

- [ ] **Step 1: Write the failing scanner tests**

```ts
import { describe, expect, it } from 'vitest'
import { splitInlineMathSpans } from './inlineMath'

describe('splitInlineMathSpans', () => {
  it('extracts inline formulas while preserving source order', () => {
    expect(splitInlineMathSpans('Energy \\(E=mc^2\\), then \\(x^2\\).')).toEqual([
      { kind: 'text', value: 'Energy ' },
      { kind: 'math', value: 'E=mc^2', source: '\\(E=mc^2\\)' },
      { kind: 'text', value: ', then ' },
      { kind: 'math', value: 'x^2', source: '\\(x^2\\)' },
      { kind: 'text', value: '.' },
    ])
  })

  it('keeps code, escaped, and unmatched delimiters literal', () => {
    const input = 'code `\\(x\\)` escaped \\\\(y\\\\) unmatched \\(z'
    expect(splitInlineMathSpans(input)).toEqual([{ kind: 'text', value: input }])
  })

  it('preserves mixed display delimiters as text for the block scanner', () => {
    const input = '\\[a\\] and \\(b\\)'
    expect(splitInlineMathSpans(input)).toEqual([
      { kind: 'text', value: '\\[a\\] and ' },
      { kind: 'math', value: 'b', source: '\\(b\\)' },
    ])
  })
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm exec vitest run src/components/content/inlineMath.test.ts`

Expected: FAIL because `./inlineMath` does not exist.

- [ ] **Step 3: Implement the minimal stateful scanner**

```ts
export type InlineMathSpan =
  | { kind: 'text'; value: string }
  | { kind: 'math'; value: string; source: string }

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) slashCount += 1
  return slashCount % 2 === 1
}

function markerRunLength(text: string, index: number): number {
  let cursor = index
  while (text[cursor] === '`') cursor += 1
  return cursor - index
}

export function splitInlineMathSpans(text: string): InlineMathSpan[] {
  if (!text.includes('\\(')) return [{ kind: 'text', value: text }]
  const spans: InlineMathSpan[] = []
  let cursor = 0
  let textStart = 0
  let inlineTicks = 0

  const emitText = (end: number): void => {
    if (end > textStart) spans.push({ kind: 'text', value: text.slice(textStart, end) })
  }

  while (cursor < text.length) {
    if (text[cursor] === '`' && !isEscaped(text, cursor)) {
      const run = markerRunLength(text, cursor)
      if (inlineTicks === 0) inlineTicks = run
      else if (inlineTicks === run) inlineTicks = 0
      cursor += run
      continue
    }

    if (inlineTicks === 0 && text.startsWith('\\(', cursor) && !isEscaped(text, cursor)) {
      let close = cursor + 2
      while (close < text.length && !(text.startsWith('\\)', close) && !isEscaped(text, close))) {
        close += 1
      }
      if (close < text.length) {
        emitText(cursor)
        const source = text.slice(cursor, close + 2)
        spans.push({ kind: 'math', value: text.slice(cursor + 2, close).trim(), source })
        cursor = close + 2
        textStart = cursor
        continue
      }
    }

    cursor += 1
  }

  emitText(text.length)
  return spans.length > 0 ? spans : [{ kind: 'text', value: text }]
}
```

- [ ] **Step 4: Run scanner tests and existing display scanner tests**

Run: `pnpm exec vitest run src/components/content/inlineMath.test.ts src/components/content/displayMath.test.ts`

Expected: both test files PASS.

- [ ] **Step 5: Commit the scanner**

```bash
git add src/components/content/inlineMath.ts src/components/content/inlineMath.test.ts
git commit -m "feat: parse inline math spans"
```

---

### Task 2: Render inline and display KaTeX through one safe adapter

**Files:**
- Modify: `src/components/content/displayMathRenderer.ts`
- Modify: `src/components/content/displayMathRenderer.test.ts`

**Interfaces:**
- Produces: `tryRenderMathToHtml(renderer, value, displayMode): string | null` plus the compatibility wrapper `tryRenderDisplayMathToHtml`.
- Consumes: the existing KaTeX `renderToString` function loaded by `ThreadConversation.vue`.

- [ ] **Step 1: Add a failing inline-mode test**

```ts
it('uses inline mode without relaxing safe options', () => {
  const renderer = vi.fn(() => '<span class="katex">x</span>')
  expect(tryRenderMathToHtml(renderer, 'x', false)).toContain('katex')
  expect(renderer).toHaveBeenCalledWith('x', {
    displayMode: false,
    throwOnError: true,
    trust: false,
    strict: 'warn',
  })
})
```

- [ ] **Step 2: Run the renderer test and verify RED**

Run: `pnpm exec vitest run src/components/content/displayMathRenderer.test.ts`

Expected: FAIL because `tryRenderMathToHtml` is not exported.

- [ ] **Step 3: Generalize only the displayMode field**

```ts
export type DisplayMathRenderOptions = {
  displayMode: boolean
  throwOnError: true
  trust: false
  strict: 'warn'
}

export type DisplayMathRenderFunction = (
  value: string,
  options: DisplayMathRenderOptions,
) => string

export function tryRenderMathToHtml(
  renderer: DisplayMathRenderFunction | null,
  value: string,
  displayMode: boolean,
): string | null {
  if (!renderer) return null
  try {
    return renderer(value, { displayMode, throwOnError: true, trust: false, strict: 'warn' })
  } catch {
    return null
  }
}

export function tryRenderDisplayMathToHtml(renderer: DisplayMathRenderFunction | null, value: string): string | null {
  return tryRenderMathToHtml(renderer, value, true)
}
```

- [ ] **Step 4: Run the renderer tests**

Run: `pnpm exec vitest run src/components/content/displayMathRenderer.test.ts`

Expected: PASS for display mode, inline mode, unavailable renderer, and invalid TeX.

- [ ] **Step 5: Commit the adapter**

```bash
git add src/components/content/displayMathRenderer.ts src/components/content/displayMathRenderer.test.ts
git commit -m "feat: support safe inline KaTeX rendering"
```

---

### Task 3: Wire inline math into every conversation render path

**Files:**
- Modify: `src/components/content/ThreadConversation.vue`
- Modify: `src/components/content/displayMathIntegration.wiring.test.ts`
- Modify: `src/style.css`

**Interfaces:**
- Consumes: `splitInlineMathSpans`, `tryRenderMathToHtml`, and the existing lazy KaTeX module.
- Produces: `InlineSegment` math entries rendered consistently by direct Vue templates and `renderInlineSegmentsAsHtml`.

- [ ] **Step 1: Add failing integration assertions**

```ts
expect(source).toContain("import { splitInlineMathSpans } from './inlineMath'")
expect(source).toContain("kind: 'math'")
expect(source).toContain("segment.kind === 'math'")
expect(source).toContain('class="message-inline-math"')
expect(source).toContain("message.text.includes('\\\\(')")
expect(globalStyle).toMatch(/\.message-inline-math\s*\{/u)
```

- [ ] **Step 2: Run the wiring test and verify RED**

Run: `pnpm exec vitest run src/components/content/displayMathIntegration.wiring.test.ts`

Expected: FAIL on the missing inline imports, segment branch, loader trigger, and CSS.

- [ ] **Step 3: Extend inline parsing before Markdown markers**

Add this segment variant:

```ts
| { kind: 'math'; value: string; source: string }
```

Rename the current `parseInlineSegmentsUncached` body to `parseNonMathInlineSegments`, then make the cache entry function split first:

```ts
function parseInlineSegmentsUncached(text: string): InlineSegment[] {
  return splitInlineMathSpans(text).flatMap((span): InlineSegment[] => (
    span.kind === 'math'
      ? [{ kind: 'math', value: span.value, source: span.source }]
      : parseNonMathInlineSegments(span.value)
  ))
}
```

This ordering prevents TeX `*`, `_`, URLs, and backslashes from being consumed by the existing Markdown/link parser. The scanner itself protects backtick code.

- [ ] **Step 4: Add a shared inline rendering helper and mode-aware cache key**

```ts
function renderInlineMathAsHtml(segment: Extract<InlineSegment, { kind: 'math' }>): string {
  const cacheKey = `${mathRenderVersion.value}\u0000inline\u0000${segment.value}`
  if (!displayMathHtmlCache.has(cacheKey)) {
    setBoundedCacheEntry(
      displayMathHtmlCache,
      cacheKey,
      tryRenderMathToHtml(displayMathRenderer.value, segment.value, false),
      DISPLAY_MATH_HTML_CACHE_LIMIT,
    )
  }
  const rendered = displayMathHtmlCache.get(cacheKey) ?? null
  return rendered === null
    ? `<span class="message-math-source">${escapeHtml(segment.source)}</span>`
    : `<span class="message-math-katex">${rendered}</span>`
}
```

Also add `\u0000display\u0000` to display keys so inline and display results cannot collide.

- [ ] **Step 5: Render math in direct templates and cached HTML**

Before every final inline-code fallback in the paragraph, heading, quote, task-list, list-item, and table-cell templates, add:

```vue
<span
  v-else-if="segment.kind === 'math'"
  class="message-inline-math"
  v-html="renderInlineMathAsHtml(segment)"
/>
```

In `renderInlineSegmentsAsHtml`, add:

```ts
if (segment.kind === 'math') {
  return `<span class="message-inline-math">${renderInlineMathAsHtml(segment)}</span>`
}
```

- [ ] **Step 6: Trigger the existing lazy loader for either delimiter**

Change the math signature filter to:

```ts
.filter((message) => message.text.includes('\\[') || message.text.includes('\\('))
```

Do not add another loader, timer, watcher, or network request.

- [ ] **Step 7: Add contained inline presentation**

```css
.message-inline-math {
  display: inline-block;
  max-width: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  vertical-align: -0.15em;
  color: inherit;
  -webkit-overflow-scrolling: touch;
}

.message-inline-math .katex {
  color: inherit;
}

.message-inline-math .message-math-source {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

:root.dark .message-inline-math {
  color: rgb(228 228 231);
}
```

- [ ] **Step 8: Run focused integration and scanner tests**

Run: `pnpm exec vitest run src/components/content/inlineMath.test.ts src/components/content/displayMathRenderer.test.ts src/components/content/displayMathIntegration.wiring.test.ts`

Expected: all focused tests PASS.

- [ ] **Step 9: Commit the integration**

```bash
git add src/components/content/ThreadConversation.vue src/components/content/displayMathIntegration.wiring.test.ts src/style.css
git commit -m "feat: render inline math in conversations"
```

---

### Task 4: Document and verify the complete rendering behavior

**Files:**
- Modify: `tests/chat-composer-rendering/display-math-block-rendering.md`
- Create: `output/playwright/inline-math-browser-report.json` (ignored verification artifact)
- Create: `output/playwright/inline-math-375-light.png` (ignored verification artifact)
- Create: `output/playwright/inline-math-375-dark.png` (ignored verification artifact)
- Create: `output/playwright/inline-math-768-light.png` (ignored verification artifact)
- Create: `output/playwright/inline-math-768-dark.png` (ignored verification artifact)

**Interfaces:**
- Consumes: the complete formula parser/render path.
- Produces: repeatable manual steps and browser evidence for responsive behavior and lazy loading.

- [ ] **Step 1: Add the inline formula manual case**

Document prerequisites, exact input `Energy is \(E=mc^2\), while \[x^2\] is displayed.`, expected inline/display layout, code-literal cases, invalid-source fallback, both themes, and cleanup.

- [ ] **Step 2: Run the complete unit suite**

Run: `pnpm run test:unit`

Expected: all Vitest files and tests PASS with no failures.

- [ ] **Step 3: Build and run required runtime checks**

```bash
pnpm run build
node -e "const katex=require('katex'); const html=katex.renderToString('E=mc^2',{displayMode:false,throwOnError:true,trust:false,strict:'warn'}); if(!html.includes('katex')) process.exit(1); console.log('KaTeX CJS inline smoke: ok')"
./dist-cli/index.js --help >/dev/null
./dist-cli/safe.js doctor
```

Expected: build succeeds; CJS smoke prints `KaTeX CJS inline smoke: ok`; help exits 0; doctor prints `codex-mobile-safe doctor: ok`.

- [ ] **Step 4: Verify browser rendering and performance**

Confirm port 4173 belongs to this worktree, use its existing server, then run Playwright against TestChat with a unique marker and both formula forms. Assert:

```js
const result = await page.evaluate(() => ({
  inlineMath: Boolean(document.querySelector('.message-inline-math .katex')),
  displayMath: Boolean(document.querySelector('.message-math-block .katex-display')),
  literalInlineDelimiters: document.body.innerText.includes('\\(E=mc^2\\)'),
  pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
}))
```

Expected for all four viewport/theme combinations: `inlineMath: true`, `displayMath: true`, `literalInlineDelimiters: false`, `pageOverflow: false`. Record KaTeX JS/CSS/font request counts and verify a no-math TestChat visit fetches zero KaTeX assets while a math visit loads each lazy asset only once.

- [ ] **Step 5: Commit manual documentation**

```bash
git add tests/chat-composer-rendering/display-math-block-rendering.md
git commit -m "test: cover inline math rendering"
```

---

### Task 5: Review, integrate, install, and verify the served build

**Files:**
- No source files expected.
- Main checkout: `/home/zonghangli/codex-mobile`.

**Interfaces:**
- Consumes: the clean verified `codex/math-display-blocks` branch.
- Produces: a merged `origin/main`, synchronized local `main`, installed commands, and restarted `codex-mobile-safe.service` serving the new frontend.

- [ ] **Step 1: Run requirements review, then code-quality review**

Compare `git diff --stat main...HEAD`, `git diff main...HEAD`, the two approved design specs, and the verification evidence. Fix and retest any confirmed requirement or quality issue before proceeding.

- [ ] **Step 2: Re-check all required live Git state**

```bash
git status --short
git branch --show-current
git -C /home/zonghangli/codex-mobile status --short
test ! -e "$(git rev-parse --git-dir)/MERGE_HEAD"
test ! -d "$(git rev-parse --git-dir)/rebase-merge"
test ! -d "$(git rev-parse --git-dir)/rebase-apply"
git fetch origin
gh pr view --json number,state,mergeStateStatus,isDraft,headRefName,baseRefName,url || true
git diff --stat main...HEAD
git log --oneline main..HEAD
```

Expected: both worktrees are clean, no merge/rebase is active, and the branch delta contains only the approved math work.

- [ ] **Step 3: Rebase, push, and merge through GitHub**

```bash
git rebase main
git push -u origin codex/math-display-blocks
gh pr create --base main --head codex/math-display-blocks --title "Render LaTeX formulas in conversations" --body $'## Summary\n- render `\\[...\\]` display formulas and `\\(...\\)` inline formulas with lazy local KaTeX\n- preserve code, malformed input, and safe literal fallbacks\n- document responsive light/dark browser verification\n\n## Verification\n- `pnpm run test:unit`\n- `pnpm run build`\n- `codex-mobile-safe doctor`\n- Playwright at 375x812 and 768x1024 in light/dark themes'
gh pr merge --merge --delete-branch
```

If a PR already exists, update it instead of creating another. Inspect and resolve any conflict intentionally; never use blanket ours/theirs resolution.

- [ ] **Step 4: Synchronize local main and verify containment**

```bash
git -C /home/zonghangli/codex-mobile pull --ff-only origin main
git -C /home/zonghangli/codex-mobile status --short --branch
git -C /home/zonghangli/codex-mobile log --oneline origin/main -10
git -C /home/zonghangli/codex-mobile branch --contains cda2fe5
```

Expected: local `main` equals `origin/main` and contains the formula branch commits.

- [ ] **Step 5: Install and restart from main**

Run from `/home/zonghangli/codex-mobile`:

```bash
pnpm run service:install
```

Expected: build/install completes, the unit verifies, and `codex-mobile-safe.service` restarts active using `/home/zonghangli/codex-mobile` with its existing password file.

- [ ] **Step 6: Verify the actual served service**

```bash
systemctl --user --no-pager --full status codex-mobile-safe.service
codex-mobile-safe status
codex-mobile-safe doctor
curl -fsS http://127.0.0.1:5900/ >/dev/null
```

Then run the same TestChat formula assertions against `http://127.0.0.1:5900`, not port 4173. Expected: service active, doctor OK, HTML request succeeds, and both inline and display KaTeX render after a browser refresh.
