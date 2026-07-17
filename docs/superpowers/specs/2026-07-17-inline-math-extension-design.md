# Inline Math Extension Design

## Goal

Extend the display-math work so Codex Mobile renders both standard LaTeX delimiter forms used in conversation text:

- `\[...\]` as a display block;
- `\(...\)` inline with surrounding prose.

After verification, the feature branch will be integrated into `main`, installed locally, and the currently served Codex Mobile instance will be restarted so a normal browser refresh receives the new bundle.

## Confirmed root cause

The deployed service currently runs `/home/zonghangli/codex-mobile` from `main` on port 5900. The completed display-math implementation exists only in the `codex/math-display-blocks` worktree, so refreshing the deployed URL cannot expose it. In addition, that implementation deliberately leaves `\(...\)` literal. Both facts explain the reported behavior without indicating a KaTeX rendering failure.

## Chosen approach

Keep the existing custom Markdown pipeline and extend its math scanner with an inline-math span. This reuses the already-tested lazy KaTeX loader, security settings, cache invalidation, and fallback behavior.

Two alternatives were rejected:

- replacing the custom parser with a remark/rehype math pipeline would be much broader and could regress directives, plan cards, images, and current Markdown behavior;
- post-processing rendered DOM text would be fragile, would duplicate work on every update, and could incorrectly rewrite code or already-rendered markup.

## Parsing and data model

The scanner recognizes the next balanced, unescaped delimiter outside fenced code and inline backtick spans. It emits:

```ts
{ kind: 'mathBlock'; value: string; source: string }
{ kind: 'inlineMath'; value: string; source: string }
```

`mathBlock` retains the existing block-splitting behavior. `inlineMath` is an inline node within paragraphs, headings, quotes, list items, table cells, and other existing rich-text containers; it does not split surrounding prose into separate blocks.

For example, `Energy is \(E=mc^2\).` remains one paragraph containing text, an inline formula, and text. A standalone `\(x\)` remains inline rather than being promoted to a display block.

The parser does not recognize delimiters inside fenced code or inline code, escaped literal openers, or unmatched pairs. It preserves malformed or incomplete source exactly and never throws or drops adjacent text. `$...$`, `$$...$$`, and standalone `\begin{...}` environments remain out of scope.

## Rendering and loading

Both forms use the same lazily imported local KaTeX package:

- display math calls KaTeX with `displayMode: true` and uses `.message-math-block`;
- inline math calls KaTeX with `displayMode: false` and uses `.message-inline-math`.

Inline formulas inherit the surrounding font color and baseline, may wrap only between adjacent text segments, and do not create horizontal page overflow. Display formulas retain their existing centered, internally scrollable presentation.

The existing security and failure rules apply unchanged: `trust: false`, rendering exceptions are caught, and the exact escaped source remains visible if KaTeX is unavailable or the formula is invalid. The same render-version invalidation updates direct messages and cached plan HTML after the lazy module loads.

## Tests

Implementation follows test-first development. Focused tests first demonstrate that the current code leaves `\(...\)` literal, then cover:

- inline formulas embedded before, between, and after prose;
- multiple inline formulas and mixed inline/display formulas in source order;
- inline formulas in nested Markdown and plan-card HTML paths;
- code spans, code fences, escaped delimiters, and unmatched delimiters staying literal;
- invalid TeX retaining its exact source without breaking adjacent content;
- `displayMode: false` for inline math and `displayMode: true` for display math;
- lazy-load and cache-version behavior shared by both forms;
- no horizontal page overflow at mobile widths in light and dark themes.

Final verification runs the focused tests, full unit suite, production build, safe CLI doctor, and browser checks against the production bundle. The deployed service is then restarted and its served assets and formula rendering are checked directly rather than inferred from the development server.

## Acceptance

1. `\[E=mc^2\]` renders as a centered display formula.
2. `Energy is \(E=mc^2\).` renders the formula inline without visible delimiters.
3. Both forms work in ordinary messages and plan-card rendering.
4. Delimiters in code, escaped delimiters, incomplete pairs, and invalid TeX remain safe visible text.
5. Math stays legible and contained on narrow mobile screens in light and dark themes.
6. The installed service serves the new build after restart, so refreshing the user's Tailnet URL shows the feature.

## Non-goals

- `$...$`, `$$...$$`, or standalone equation environments.
- Server-side math rendering or CDN dependencies.
- Replacing the Markdown parser.
- Changing synchronization, notifications, authentication, or Tailnet exposure.
