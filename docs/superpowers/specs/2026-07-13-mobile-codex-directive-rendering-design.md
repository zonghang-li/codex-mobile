# Mobile Codex Directive Rendering

Date: 2026-07-13
Branch: `codex/fix-mobile-directive-rendering`

## Problem

Codex desktop app directives are persisted inside the final assistant message, for example:

```text
::git-push{cwd="/tmp/zonghang-codex-mobile-review" branch="main"}
```

The desktop app consumes these lines as out-of-band UI instructions. Codex Mobile currently maps `agentMessage.text` directly to `UiMessage.text`, so the mobile Markdown renderer displays the directive syntax verbatim.

Production evidence from thread `019f565b-9ea5-7a30-b51d-8d927451f1b5` shows the directive in `task_complete.last_agent_message`. The mobile codebase has no directive parser in its app-server normalizer or renderer.

## Goal

Render every currently supported Codex app directive as a compact, readable status notice while keeping ordinary assistant prose unchanged.

## Non-goals

- Do not execute directives in the browser.
- Do not duplicate desktop-side mutations such as pushing Git branches or creating threads.
- Do not hide unknown directive-like text.
- Do not interpret directives inside fenced code blocks or inline prose examples.
- Do not change message polling, runtime ownership, authentication, or Tailscale exposure.

## Supported directives

The initial whitelist is:

- `git-stage`
- `git-commit`
- `git-create-branch`
- `git-push`
- `git-create-pr`
- `created-thread`
- `code-comment`

Only a syntactically valid directive occupying its own physical line and outside a fenced code block is recognized. Unknown names, malformed attributes, inline occurrences, and fenced examples remain visible as ordinary text.

## Parsing and data model

Add a small shared parser that accepts assistant text and an optional live-stream mode, then returns:

```ts
type ParsedCodexDirectiveText = {
  text: string
  directives: UiCodexDirective[]
}
```

`UiCodexDirective` is a discriminated union for the supported directive names. Attributes are parsed from quoted `key="value"` pairs with escaped quotes and backslashes decoded. Each directive retains only the fields required for display; it never becomes an executable command.

The parser scans line by line while tracking fenced code blocks. Recognized standalone lines are removed from the visible prose and converted to structured directives. Surrounding blank lines are normalized so removing a directive does not leave a large empty gap.

In live-stream mode, an incomplete trailing line that is still a prefix of a whitelisted directive is temporarily withheld instead of flashing raw protocol syntax. Once the name is known to be unsupported, the line is visible again. The live notification path retains the unmodified cumulative agent text in a private, non-rendered buffer so parsing a delta never loses withheld characters. Completed and refreshed messages use the same parser without incomplete-line suppression.

`UiMessage` gains an optional `directives` array. `normalizeThreadMessagesV2()` parses only `agentMessage` text and attaches the result. The realtime `item/agentMessage/delta` and `item/completed` path applies the same parser to its private cumulative buffer. User messages are never interpreted as directives.

## Presentation

`ThreadConversation.vue` renders directive notices after the assistant prose in their original order. A notice uses a compact status-card style consistent with existing message metadata; only explicitly safe task and PR targets are interactive.

Display mapping:

| Directive | Visible status |
| --- | --- |
| `git-stage` | Changes staged |
| `git-commit` | Commit created |
| `git-create-branch` | Switched to branch `<branch>` |
| `git-push` | Pushed `<branch>` |
| `git-create-pr` | Pull request created / Draft pull request created |
| `created-thread` | New task created |
| `code-comment` | Code comment with title, body, file, and line metadata |

The UI language helper supplies Chinese translations for these labels. Branch names, titles, filenames, and URLs are rendered as text or safe links rather than injected HTML.

When `git-create-pr` includes an HTTPS URL, the status notice links to it. When `created-thread` includes a stable `threadId`, the notice links to the local thread route. A `clientThreadId` without a stable server thread remains a non-clickable queued-task notice.

## Copy and export

Thread export excludes the raw directive syntax. It appends readable status lines derived from the structured directives, so copied transcripts preserve useful outcomes without exposing internal protocol text.

Unknown or malformed directive-like lines remain part of `UiMessage.text` and therefore remain copyable.

## Error handling and safety

- Parsing is fail-open for content visibility: if a line cannot be parsed with certainty, leave it untouched.
- Recognition is whitelist-only.
- Attribute values are data, never HTML or shell input.
- Links are restricted to the same safe URL rules used elsewhere: HTTPS for PR links and local hash routes for known thread IDs.
- Duplicate directives remain duplicate notices because each represents a persisted desktop event.

## Tests

Unit tests must cover:

- every supported directive and its visible fields;
- multiple directives appended to one assistant message;
- incomplete whitelisted trailing directives being withheld only in live mode, then resolving into a notice;
- unsupported trailing directive names becoming visible during live streaming;
- directive-only assistant messages;
- prose before and after a directive;
- fenced and inline examples remaining visible;
- unknown and malformed directives remaining visible;
- escaped quoted attributes;
- `normalizeThreadMessagesV2()` attaching directives only to assistant messages;
- realtime agent-message wiring retaining raw cumulative deltas while rendering parsed text/directives;
- renderer wiring for status notices and safe links;
- thread export producing readable status lines without raw `::name{...}` syntax.

The regression fixture must include the exact production form:

```text
::git-push{cwd="/tmp/zonghang-codex-mobile-review" branch="main"}
```

## Acceptance

After deployment, reopening the affected thread on a mobile viewport must show `Pushed main` (or its active-language translation), must not contain `::git-push{`, and must preserve the preceding assistant summary unchanged.
