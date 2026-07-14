# Generic Codex Directive Rendering Design

## Goal

Render every standalone assistant-output line that begins with `::` as structured UI instead of leaking protocol syntax into the mobile conversation. Preserve the existing specialized presentation for known Codex directives, add a neutral generic card for future valid directives, and add a warning card for malformed or schema-invalid directives.

No unknown directive is executed. Code fences, inline examples, user messages, and ordinary prose remain literal text.

## Current behavior

Codex Mobile currently recognizes seven directive schemas:

- `git-stage`
- `git-commit`
- `git-create-branch`
- `git-push`
- `git-create-pr`
- `created-thread`
- `code-comment`

A valid recognized standalone line is removed from assistant prose and rendered by `CodexDirectiveNotices.vue`. Unknown names, known names with invalid attributes, and malformed directive-like lines remain visible as raw `::...` text. Live output suppresses only incomplete prefixes belonging to the seven known names, so future directives can also flicker as raw protocol fragments while streaming.

## Chosen approach

Use a specialized-first parser with two structured fallback types:

1. A known directive whose strict schema validates becomes its existing typed directive and retains its specialized label, link, and metadata.
2. An unknown directive with valid generic syntax becomes a neutral generic directive card showing its name and parsed attributes.
3. Any other standalone assistant line beginning with `::` becomes an invalid-directive warning card after the line is final.

The parser remains a display-only protocol interpreter. Generic and invalid directives never receive click actions, external links, task navigation, filesystem actions, or Git operations.

Rejected alternatives:

- Continually hard-coding every official directive preserves rich presentation but necessarily leaks every newly introduced directive until the mobile project is updated.
- Replacing all typed directives with one generic renderer is future-proof but discards useful validated behavior such as safe HTTPS PR links, local task links, code-comment locations, and translated status labels.

## Recognition boundary

Only assistant-output lines meeting all of these conditions enter directive parsing:

- after trimming surrounding whitespace, the line begins with `::`;
- the line is not inside a Markdown backtick or tilde fence;
- the entire directive-like construct occupies that line;
- the message originates from assistant output, using the existing normalization and live-agent paths.

The following remain ordinary visible text:

- fenced examples such as ` ```text` followed by `::git-push{...}`;
- inline prose such as `Use ::git-push{...} after review`;
- user-authored messages containing directive syntax;
- lines that contain non-whitespace prose before `::`.

A line that itself begins with `::` is always converted to either a typed, generic, or warning card once final. This includes trailing garbage, invalid names, duplicate keys, missing quotes, missing required fields, unknown fields on a known directive, and other malformed forms.

## Generic syntax

A generic valid directive uses this single-line grammar:

```text
::<name>{<attributes>}
```

- `<name>` matches lower-case kebab syntax `[a-z][a-z0-9-]*`.
- Attributes use the existing `key="value"` form separated by whitespace.
- Attribute keys match `[A-Za-z][A-Za-z0-9]*` and may not repeat.
- Attribute values support only the existing escaped quote and escaped backslash forms.
- Empty attribute sets such as `::future-event{}` are valid for unknown names.
- A structurally valid unknown directive accepts arbitrary attribute keys; known directives continue to require their exact existing schema.

Generic attribute order is preserved for deterministic rendering and export. Attribute names render as plain text. Attribute values render as plain text with normal Vue escaping; markup inside a value is never interpreted as HTML or Markdown.

## Data model

Extend `UiCodexDirective` with two variants:

```ts
type UiGenericCodexDirective = {
  kind: 'generic'
  name: string
  attributes: Array<{ key: string; value: string; sensitive: boolean }>
}

type UiInvalidCodexDirective = {
  kind: 'invalid'
  name?: string
  reason: 'invalid-name' | 'invalid-syntax' | 'invalid-schema' | 'incomplete'
}
```

The invalid variant intentionally does not retain the raw line in renderable message state. Its purpose is to prevent protocol leakage while clearly indicating that Codex emitted a directive the client could not safely interpret.

Known typed variants remain unchanged. Existing consumers continue switching on `directive.kind`; new generic and invalid cases must be handled exhaustively by label, href, export, and renderer helpers.

## Sensitive generic attributes

Because future directive schemas are unknown, generic parsing must not expose obvious credentials more prominently than necessary. Attribute keys are marked sensitive case-insensitively when their normalized name contains one of:

- `password` or `passwd`
- `token`
- `secret`
- `credential`
- `authorization`
- `apikey`

Sensitive values are replaced with `••••` before entering `UiCodexDirective`. The original value must not be retained in the parsed directive object, rendered DOM, exported Markdown, debug logs, or error messages. This does not alter the assistant prose outside standalone directives.

## Live streaming behavior

Live agent deltas may split a directive at any character. When `suppressIncompleteTrailingDirective` is enabled:

- a final standalone line beginning with `::` and lacking a structural closing brace outside quoted text is withheld from prose;
- a complete valid known or generic directive is immediately converted to a card;
- a structurally complete but invalid directive is immediately converted to a warning card;
- an incomplete line stays withheld across deltas and becomes a typed, generic, or warning directive once completed;
- when the agent message completes while the line is still incomplete, the persisted/non-live parse produces an `incomplete` warning card.

This generalizes the existing known-prefix suppression and prevents future directive names from flickering in the transcript.

The existing accumulated raw-delta state remains the source for reparsing. A later delta that repairs or completes a line replaces the prior parsed directive array rather than appending duplicates.

## Presentation

### Known valid directive

Keep the existing success card, translated label, safe validated links, code-comment location/body, and check icon.

### Unknown valid directive

Render a neutral card with:

- an information icon rather than a success check;
- title `Codex directive: <name>`;
- one compact metadata row per attribute in source order;
- redacted `••••` for sensitive values;
- wrapping and overflow behavior suitable for narrow mobile screens.

No generic value becomes an anchor, even if it resembles an HTTPS URL or local path.

### Invalid directive

Render a warning card with:

- warning icon and warning semantics;
- title `Directive format error`;
- the parsed name when safely available;
- a concise translated reason such as invalid syntax, invalid known schema, or incomplete output;
- no success styling, attributes, raw protocol line, or action.

The directive list retains source order when known, generic, and invalid cards are mixed.

## Export and copy

Copied-thread Markdown remains readable and contains no standalone protocol syntax:

- known directives use their existing human-readable export;
- generic directives export `Codex directive: <name>` followed by escaped attribute name/value rows in source order;
- invalid directives export `Directive format error`, the safe name when available, and its translated reason;
- sensitive generic values export only `••••`.

Export helpers must escape Markdown punctuation and must not construct links for generic attributes.

## Error handling

Parsing is total: any input returns visible prose plus zero or more structured directives without throwing. A malformed standalone `::` line produces an invalid card instead of aborting message normalization or live rendering.

Existing strict validators remain authoritative for known schemas. A known directive with missing, extra, duplicated, or invalid fields becomes `invalid-schema`, never a generic success card. This avoids falsely reporting a Git, PR, thread, or code-comment action as successful.

## Performance

- Continue using one line-oriented pass through each assistant message.
- Do not add network requests, watchers, timers, dependencies, or backend work.
- Parse attributes once and reuse the result for typed or generic classification.
- Keep rendering proportional to the number of standalone directive lines and their attributes.
- Preserve the current fence state machine and whitespace normalization behavior.

## Tests

Every production change begins with a focused failing test.

Parser tests cover:

- all seven known valid directives remain typed and unchanged;
- unknown valid names with zero or multiple attributes become generic directives;
- generic attribute order and quote/backslash unescaping;
- sensitive attribute values are discarded and redacted before entering parsed state;
- known names with invalid schemas become invalid warning directives;
- unknown malformed syntax, invalid names, duplicate attributes, trailing garbage, and incomplete final output become invalid directives;
- incomplete generic names and bodies remain withheld during live parsing;
- a later delta completes the same directive without duplicate text or cards;
- fenced, inline, user-authored, and prose-prefixed examples remain literal;
- visible prose and blank-line normalization remain unchanged around removed directive lines.

Presentation and export tests cover:

- known success cards retain their links and metadata;
- generic cards use neutral styling, plain-text attributes, no anchors, and redaction;
- invalid cards use warning styling and never expose raw `::` syntax;
- mixed directive types preserve source order;
- generic and invalid exports are readable Markdown without protocol syntax or live links;
- directive-only messages remain visible;
- persisted RPC normalization and live agent deltas produce identical directive objects.

Responsive verification checks 375x812 and 768x1024 in light and dark themes. Long names and values must wrap without horizontal page overflow.

## Acceptance

After review, merge, installation, and service restart:

1. Render an assistant message containing the seven known directive types and confirm their specialized cards remain unchanged.
2. Render `::future-directive{phase="done" url="https://example.com"}` and confirm a neutral card shows both attributes with no clickable link.
3. Render a future directive containing `accessToken="example-secret"` and confirm neither the DOM nor copied Markdown contains the value.
4. Stream the future directive across multiple deltas and confirm raw `::` fragments never appear.
5. Complete a malformed known directive and confirm a warning card appears without a success check or raw protocol syntax.
6. Put identical examples inside backtick and tilde fences and confirm they remain literal code.
7. Copy/export the conversation and confirm known, generic, and warning directives become readable Markdown.
8. Verify mobile light/dark layouts at 375x812 and 768x1024.

## Non-goals

- Executing unknown directives.
- Adding generic URL, file, Git, thread, or external actions.
- Guessing semantic labels for future directive names.
- Parsing directive syntax from user messages, fenced code, inline prose, or multiline constructs.
- Changing Codex app-server protocol, authentication, Tailnet exposure, polling, ntfy, or task completion behavior.
