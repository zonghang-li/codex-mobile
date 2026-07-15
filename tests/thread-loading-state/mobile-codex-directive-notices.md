### Mobile Codex directive notices

#### Feature/Change Name

Known, future, and malformed standalone Codex directives render as localized structured notices and export as readable Markdown without exposing raw protocol syntax.

#### Prerequisites/Setup

- Deploy the feature build and complete the normal local installation.
- Use a fresh authenticated browser page.
- Make Chinese and English UI languages available.
- Make light and dark appearance available.

#### Production Acceptance Steps

1. Open thread `019f565b-9ea5-7a30-b51d-8d927451f1b5` after deployment at 390×844.
2. Locate the assistant message whose persisted completion ends in the production `git-push` directive.
3. Assert the preceding Chinese summary is unchanged and a compact localized notice displays `已推送 main`.
4. Render `::future-directive{phase="done" url="https://example.com"}` as standalone assistant output.
5. Assert a neutral `Codex 指令：future-directive` card displays `phase` and `url` in source order, and neither value is an anchor or action.
6. Stream that future directive across multiple deltas and assert no raw `::future` fragment appears before the completed card.
7. Render `::future-auth{accessToken="example-secret" phase="done"}` and assert `example-secret` appears in neither the page DOM nor copied thread Markdown; the card and export contain only `••••`.
8. Complete `::git-push{cwd="/tmp/repo"}` and assert an amber `指令格式异常` card reports invalid fields without a success check or raw protocol text.
9. Mix known, future, and malformed directives and verify their cards retain source order without duplicates.
10. Put valid future and malformed examples inside both backtick and tilde fences and confirm they remain literal code.
11. Put a future directive in a user message and inline assistant prose and confirm both remain literal text.
12. Verify ordinary assistant Markdown retains leading/trailing whitespace and four-space indented code.
13. Render the exact typed pull-request form `::git-create-pr{cwd="/tmp/repo" branch="feature/one" url="https://example.com/pull/1" isDraft=false}` with the unquoted boolean and assert it produces a specialized linked PR card for `https://example.com/pull/1`, with neither raw `::` syntax nor `Directive format error` visible.
14. Render the exact typed code-comment form `::code-comment{title="Fix" body="Body" file="src/a.ts" start=4 end=7 priority=2}` with the unquoted integers and assert it produces a specialized code-comment notice at `src/a.ts:4-7`, with neither raw `::` syntax nor `Directive format error` visible.
15. Verify code-comment notices show `file`, `file:start`, and `file:start-end` for their respective location forms.
16. Copy/export the conversation and confirm typed, generic, and warning cards become readable Markdown containing no standalone raw directive syntax.
17. Repeat at 375×812 and 768×1024 in light and dark appearance; long names and values must wrap without horizontal page overflow.

#### Expected Results

- The preceding assistant summary remains visible and unchanged.
- Chinese displays `已推送 main`; English displays `Pushed main` for the known typed directive.
- Unknown valid standalone directives use neutral cards with plain-text, non-clickable attributes.
- Malformed or known-schema-invalid standalone directives use warning cards and never imply success.
- Typed, generic, and invalid raw directive syntax appears in neither the rendered page nor copied thread Markdown.
- Incomplete future directives do not flicker as raw fragments during streaming and do not create duplicate cards.
- Sensitive generic values are discarded from parsed/rendered/exported state and replaced with `••••`.
- Fenced literals, inline examples, and user-authored directive syntax remain visible.
- Assistant whitespace is unchanged unless a structured directive line and its separator gap are removed.
- The unquoted `isDraft=false` pull-request form renders as a specialized linked PR card, never raw `::` syntax or `Directive format error`.
- The unquoted `start=4 end=7 priority=2` code-comment form renders at `src/a.ts:4-7`, never raw `::` syntax or `Directive format error`.
- Code-comment locations include an end line when the directive supplies one.
- The notice remains compact and readable at every listed viewport in light and dark appearance.

#### Rollback/Cleanup

Revert the feature commits, rebuild/install, and restart only `codex-mobile-safe.service`.
