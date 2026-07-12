# Mobile output block copy controls

## Purpose

Verify that each stable textual output block has an isolated copy action while images, purely visual diffs, and the existing whole-response toolbar remain unchanged.

## Viewports and themes

- Mobile: 375x812, light and dark.
- Tablet: 768x1024, light and dark.
- Desktop: one fine-pointer viewport, light and dark.

Task 7 owns browser execution and screenshots. Save evidence under `output/playwright/codex-mobile-output-copy-*`.

## Setup

Open a thread containing an assistant paragraph, heading, blockquote, ordered list with a non-1 start, unordered list, checked and unchecked task items, table, fenced code, expanded command output, reasoning, plan explanation with multiple steps, turn error, live reasoning, live error, an image, and a visual file diff.

For fallback coverage, deny or remove `navigator.clipboard.writeText` while keeping `document.execCommand('copy')` available. For failure coverage, make both clipboard paths fail.

## Actions and exact clipboard expectations

1. Copy each paragraph, heading, and blockquote. Expect its original block text, never rendered HTML.
2. Copy unordered and ordered lists. Expect `- ` markers and the original ordered start/incremented numbers, with item paragraphs separated by blank lines and each nested list depth indented by two additional spaces; for example `- parent\n\n  3. child\n\n    - grandchild`.
3. Copy a task list. Expect checked and unchecked lines exactly as `- [x] done` and `- [ ] next`.
4. Copy a table. Expect header and body cells separated by tabs and rows separated by newlines, for example `Name\tValue\nalpha\t1`.
5. Copy fenced code. Expect only the original source, with no backtick fence and no language label.
6. Expand and copy command output. Expect `aggregatedOutput` exactly, including its whitespace and newlines. An empty output displaying `(no output)` has no per-block copy button.
7. Copy persisted completed reasoning and live reasoning. Expect only the user-visible reasoning summary text exactly. Reload the completed thread and confirm the persisted summary remains visible/copyable; raw reasoning content must never appear.
8. Copy a plan explanation, then each plan step. Expect explanation text separately and each step's text without `✓`, `•`, `○`, or other status UI.
9. Copy turn and live errors. Expect the original error text.
10. Confirm each successful action visibly changes to `Copied`, its accessible label also reports `Copied`, and it resets after about 1.5 seconds.
11. Confirm a failed Clipboard API attempt succeeds through the selection fallback. Then fail both paths and confirm `Copy failed` is announced from an `aria-live="polite"` status without altering the source text.
12. Tap copy inside expanded command, plan, error, and linked-text areas. Confirm it does not collapse/expand commands, open files or images, navigate, or trigger any parent action.
13. Confirm images, Markdown image blocks, and the visual diff viewer have no generic per-block copy control. Confirm the existing whole-response copy action is unchanged.

## Responsive expectations

- At 375x812 and 768x1024, every per-block copy button is always visible and has a computed hit area of at least 32x32 pixels.
- On a fine-pointer desktop, controls may be visually hidden at rest, become visible on block hover, remain keyboard-focusable, and become visible on `:focus-visible`.
- Repeat the coverage in light and dark themes; controls and feedback remain legible without covering the source text needed for verification.

## Rollback

Remove `CopyableOutputBlock.vue`, `messageBlockTypes.ts`, `outputBlockCopy.ts`, their focused tests, and the wrappers/imports added to `ThreadConversation.vue`. Restore the four block types locally in `ThreadConversation.vue`. Do not change the existing whole-response copy toolbar or clipboard utility.
