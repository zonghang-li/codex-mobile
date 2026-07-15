# Typed Codex Directive Literals Design

Date: 2026-07-15
Branch: `codex/fix-typed-directive-literals`

## Problem

Codex emits typed attributes in official app directives. In particular,
`git-create-pr` emits `isDraft=true` or `isDraft=false`, and `code-comment`
emits integer `start`, `end`, and `priority` attributes without quotes.

Codex Mobile currently accepts only quoted attribute values. A valid
`git-create-pr` line is therefore removed from assistant prose but rendered as
`Directive format error` with `Invalid directive syntax` instead of the
specialized pull-request notice.

## Goal

Parse every currently documented official boolean and integer literal while
retaining strict per-directive schemas, safe links, generic-directive
redaction, and identical persisted/live behavior.

## Scope

The parser will recognize three lexical value forms:

- quoted strings with the existing quote and backslash escaping;
- the exact boolean literals `true` and `false`;
- non-negative base-10 integer literals.

Lexical recognition does not by itself make a field valid. Known directive
schemas remain authoritative:

- all paths, branches, URLs, IDs, titles, bodies, and filenames require quoted
  string values;
- `git-create-pr.isDraft` accepts an unquoted boolean and continues accepting
  the legacy quoted `"true"` or `"false"` representation;
- `code-comment.start`, `code-comment.end`, and `code-comment.priority` accept
  unquoted integers and continue accepting legacy quoted integers;
- existing range, positive-integer, priority, URL, required-field, and exact
  key-set validation remains unchanged.

Unknown generic directives keep their existing quoted-string-only grammar.
This fix does not broaden future/unknown directives or allow bare literals in
known string fields.

## Parser Design

Attribute parsing will retain both the decoded string value and its lexical
kind: `quoted`, `boolean`, or `integer`. The ordered attribute list used by
generic directives remains string-valued and redacted as before.

For a known directive, the typed attribute map is passed to the existing
directive switch. Each schema validates both the key set and the permitted
lexical kind before constructing `UiCodexDirective`. Legacy quoted boolean and
integer values are normalized only inside the two schemas that historically
accepted them.

For an unknown directive, any non-quoted attribute makes the line an invalid
syntax warning rather than a generic success card. Duplicate attributes,
unsupported escapes, missing separators, decimals, signs, arbitrary bare
words, and trailing content remain invalid.

Persisted `thread/read` normalization and live agent deltas already share
`parseCodexDirectiveText()`, so no renderer, state, or component changes are
needed.

## Error and Security Behavior

- A structurally malformed literal produces `invalid-syntax`.
- A valid literal used in the wrong known field produces `invalid-schema`.
- HTTPS-only pull-request URL validation remains unchanged.
- Unknown directives remain non-interactive and their sensitive quoted
  attributes remain redacted before parsed state is returned.
- The browser never executes a directive or performs Git operations.
- Raw protocol syntax remains absent from rendered assistant prose once a
  standalone directive line is classified.

## Tests

Parser regression tests will first demonstrate the current failures for:

- the production `git-create-pr` form with `isDraft=false`;
- `code-comment` with unquoted `start`, `end`, and `priority` integers.

Additional coverage will confirm:

- `isDraft=true` maps to a draft PR notice;
- legacy quoted boolean and integer forms remain compatible;
- booleans or integers in known string fields fail schema validation;
- unknown directives with unquoted typed values do not become generic success
  cards;
- decimal, signed, and arbitrary bare values remain invalid syntax;
- presentation still produces the safe HTTPS PR link and correct labels;
- persisted and live normalization continue to produce identical typed
  directives through the shared parser.

The focused parser, normalizer, realtime-state, directive-component, and export
tests will run before the complete unit suite, type checks, production build,
and safe doctor.

## Deployment and Acceptance

The change will be reviewed, merged through a pull request, and deployed from
synchronized `main`. After restart, the exact production PR directive form
must render as the specialized pull-request notice with its HTTPS link, not as
`Directive format error`. A code-comment using unquoted numeric fields must
retain its file location, range, and priority semantics. The service must
remain loopback-only behind Tailnet-only Tailscale Serve.

## Non-goals

- Executing directives in the browser.
- Inferring schemas for unknown directive names.
- Supporting floats, signed integers, null, arrays, objects, or unquoted
  strings.
- Changing directive cards, translations, link policy, or export formatting.
