# Display Math Block Rendering Design

## Goal

Render LaTeX display-math environments delimited by `\[` and `\]` as formatted mathematics in Codex Mobile conversations. The same formula must render in ordinary assistant messages, nested Markdown blocks, and plan cards on narrow mobile screens in both light and dark themes.

This change supports only `\[...\]` display math. It does not add inline-math or other TeX delimiter syntaxes.

## Current behavior and root cause

`ThreadConversation.vue` uses a custom Markdown parser whose `MessageBlock` union has paragraphs, headings, quotes, lists, tables, fenced code, dividers, and images, but no mathematical block. A balanced `\[...\]` environment therefore enters `parseTextBlocks` as an ordinary paragraph. Inline rendering escapes it as text, so the browser correctly but undesirably displays the delimiters and TeX source literally.

There are two output paths that must remain consistent:

- regular conversation blocks are rendered by the Vue template and `MessageBlockRenderer.vue`;
- plan explanations and plan steps are converted to cached HTML by `renderMarkdownBlocksAsHtml` and `renderMessageBlockAsHtml`.

Fixing only one path would leave formulas unformatted in the other.

## Chosen approach

Add a `mathBlock` to the existing custom block parser and render it with lazily loaded KaTeX.

KaTeX is preferred because it is small, deterministic, local-only, and suitable for display mathematics. MathJax supports a wider TeX surface but adds substantially more runtime and bundle cost than this requirement needs. A handwritten TeX subset would be smaller initially but would be fragile and would silently format common notation incorrectly.

The renderer follows the existing lazy syntax-highlighting pattern:

1. Messages without a possible `\[` marker do no math-specific loading or rendering work.
2. When visible message or plan text contains a possible display-math marker, a single shared dynamic import loads KaTeX and its stylesheet.
3. Until loading completes, the original delimited source remains visible as safe text.
4. On successful load, a reactive math-render version increments and invalidates both direct-message memoization and cached plan HTML.
5. Every `mathBlock` is then rendered with KaTeX in display mode.

No CDN, external request, backend API, timer, or polling change is introduced.

## Recognition boundary

The parser recognizes an unescaped opening delimiter `\[` and the next unescaped closing delimiter `\]` outside Markdown code. The delimiters may be on one line or separate lines. Whitespace immediately inside the delimiters is excluded from the formula value but otherwise the TeX source is preserved.

Examples that become one `mathBlock`:

```text
\[ E = mc^2 \]
```

```text
\[
\sum_{i=1}^{n} i = \frac{n(n+1)}{2}
\]
```

Surrounding prose is preserved as ordinary blocks. For example, `Before \[x^2\] after` becomes a paragraph, a display-math block, and a second paragraph in source order. This is tolerant of model output that does not place display delimiters on dedicated lines, although the rendered formula remains a block.

The scanner must not recognize delimiters in:

- backtick or tilde fenced code blocks;
- inline backtick code spans;
- escaped literal forms such as `\\[` and `\\]`;
- an opening delimiter with no matching closing delimiter.

An unmatched or otherwise incomplete environment remains ordinary literal text. Parsing never discards source text and never throws.

Only balanced `\[...\]` environments are in scope. The following stay literal:

- `$...$`;
- `$$...$$`;
- `\(...\)`;
- `\begin{equation}...\end{equation}` without the supported outer delimiters;
- delimiters nested inside an already recognized math environment.

## Data model and parsing

Extend `MessageBlock` with:

```ts
{ kind: 'mathBlock'; value: string; source: string }
```

- `value` is the TeX passed to KaTeX after trimming delimiter-adjacent whitespace.
- `source` is the exact balanced `\[...\]` text used for loading and error fallbacks.

A small stateful scanner splits non-code message chunks into prose and math spans before the existing prose/image block parsing. It tracks inline backtick spans and escaped delimiters, emits only balanced math spans, and forwards every prose span through the existing parser unchanged. Top-level fenced code continues to be separated by the existing `parseMessageBlocks` fence state machine, while nested fenced blocks remain governed by `parseTextBlocks`.

The scanner is linear in message length and does not use a greedy regular expression across the full conversation.

## Rendering and security

KaTeX renders with:

- `displayMode: true`;
- `throwOnError: true`, caught by the application;
- `trust: false`;
- strict handling that does not enable raw HTML or arbitrary trusted URLs.

KaTeX's returned markup is inserted only after successful local rendering. User/model TeX is never inserted directly with `v-html`. Before KaTeX is available, or when rendering fails, `source` is passed through the existing HTML escaping path and shown literally.

Both rendering paths call the same math-render helper:

- the regular-message template and `MessageBlockRenderer.vue` render a `.message-math-block` wrapper;
- `renderMessageBlockAsHtml` emits the same wrapper and content for plan-card HTML.

A bounded formula cache is keyed by the formula value and math-render version. KaTeX is called once for repeated identical formulas until the module version changes. The plan HTML cache key and cache entry gain the math-render version alongside the existing highlight version so a plan card cannot retain its pre-load fallback.

## Loading and failure behavior

The KaTeX loader is a single in-flight promise. Concurrent messages reuse it. Successful loading clears formula and Markdown HTML caches and increments the math-render version.

Failures are non-fatal:

- if the dynamic import fails, keep the delimited source visible and permit a later relevant render to retry;
- if one formula is invalid, catch only that render, keep its exact source visible, and continue rendering other blocks;
- never replace a failed formula with an empty block or a generic error that hides the original expression;
- never allow a load or render error to abort conversation updates.

No notification is generated for math rendering failures.

## Presentation

`.message-math-block` is a full-width block aligned with other message content. KaTeX output is centered when it fits and gains horizontal scrolling inside its own wrapper when it is wider than the viewport; it must not widen the page or the conversation column.

Color is inherited from the message text, so formulas remain legible in both themes. The KaTeX stylesheet supplies mathematical layout and font faces; local component styles supply spacing, overflow, touch scrolling, and fallback-source wrapping. Formula selection and copying remain enabled.

The fallback displays the original delimiters and source in normal message text styling, not as executable HTML or a code card.

## Performance

- Messages and plans without `\[` do not download or initialize KaTeX.
- The module and stylesheet load at most once concurrently.
- Parsing remains one linear pass over each non-code chunk.
- Formula HTML uses a bounded cache consistent with the existing message caches.
- Math-render versioning performs one reactive rerender after the module becomes available; it adds no interval, observer, or background refresh.
- Production-build output must be inspected to confirm KaTeX is emitted as a separate lazy chunk rather than added to the initial application chunk.

## Tests

Implementation begins with focused failing tests.

Parser tests cover:

- single-line and multiline `\[...\]` environments become `mathBlock` values;
- surrounding prose retains order and existing Markdown parsing;
- multiple formulas in one message remain distinct and ordered;
- escaped delimiters, inline-code delimiters, fenced-code delimiters, unmatched openers, and unsupported math syntaxes remain literal;
- images, headings, lists, and ordinary paragraphs retain their current behavior;
- parsing malformed input never throws or drops text.

Rendering tests cover:

- valid TeX produces KaTeX display markup and the shared wrapper in regular messages;
- plan explanations and steps produce the same math markup after the lazy module resolves;
- pre-load output safely displays source, then rerenders after the math version changes;
- invalid TeX and module-load failure preserve escaped source without breaking adjacent blocks;
- trusted HTML/URL commands are not enabled;
- plan cache invalidation includes the math-render version;
- repeated formulas use the bounded render cache.

Regression verification includes the complete unit suite, production build, CLI help, safe-mode doctor, and the repository's required manual test and performance audit. Manual UI verification covers representative short, multiline, invalid, and horizontally wide formulas at 375x812 and 768x1024 in light and dark themes.

## Acceptance

After implementation, installation, and service restart:

1. Open a conversation containing `\[ E = mc^2 \]` and confirm formatted display mathematics appears without literal delimiters.
2. Confirm a multiline fraction/summation renders identically in a normal assistant message and a plan card.
3. Confirm the first page load does not fetch the KaTeX chunk when the rendered conversation has no supported formula.
4. Confirm a conversation containing a supported formula loads the lazy chunk once and replaces the safe source fallback with formatted math.
5. Confirm identical delimiter text inside backtick and tilde fences and inline code stays literal.
6. Confirm an unmatched delimiter and invalid TeX remain visible and do not prevent later output from rendering.
7. Confirm a wide expression scrolls within its block without horizontal page overflow on mobile.
8. Confirm formula text and fallback source are legible in light and dark themes.

## Non-goals

- Inline math rendering.
- Supporting `$`, `$$`, `\(...\)`, or standalone `\begin` environments.
- A full Markdown parser replacement.
- Formula editing, equation numbering, labels, references, macros persisted across messages, or server-side rendering.
- Changing conversation synchronization, runtime status, notifications, Tailnet exposure, authentication, or backend protocols.
