# Mobile output block copy controls

## Purpose

Verify that Markdown fenced code blocks have an isolated copy action while ordinary prose and every other output type remain unchanged.

## Viewports and themes

- Mobile: 375x812, light and dark.
- Tablet: 768x1024, light and dark.
- Desktop: one fine-pointer viewport, light and dark.

Task 7 owns browser execution and screenshots. Save evidence under `output/playwright/codex-mobile-output-copy-*`.

## Setup

Open a thread containing ordinary assistant prose plus `text`, `shell`, language-less, and another language-tagged fenced code block. Also include a list, plan, reasoning, error, expanded command output, image, and visual file diff as negative controls.

For fallback coverage, deny or remove `navigator.clipboard.writeText` while keeping `document.execCommand('copy')` available. For failure coverage, make both clipboard paths fail.

## Actions and exact clipboard expectations

1. Confirm ordinary paragraphs, headings, blockquotes, lists, tables, plans, reasoning, errors, command output, images, and visual diffs have no per-block copy icon.
2. Confirm every fenced code block has exactly one copy icon, including fences tagged `text` and `shell` and a fence without a language tag.
3. Copy each fenced block. Expect only its original contents, preserving whitespace and newlines, with no backtick fence or language label.
4. Confirm each successful action visibly changes to `Copied`, its accessible label also reports `Copied`, and it resets after about 1.5 seconds.
5. Confirm a failed Clipboard API attempt succeeds through the selection fallback. Then fail both paths and confirm `Copy failed` is announced from an `aria-live="polite"` status without altering the source text.
6. Tap copy and confirm it does not navigate or trigger a parent block action.
7. Confirm the existing whole-response copy action is unchanged.

## Responsive expectations

- At 375x812 and 768x1024, every per-block copy button is always visible and has a computed hit area of at least 32x32 pixels.
- On a fine-pointer desktop, controls may be visually hidden at rest, become visible on block hover, remain keyboard-focusable, and become visible on `:focus-visible`.
- Repeat the coverage in light and dark themes; controls and feedback remain legible without covering the source text needed for verification.

## Rollback

Remove `CopyableOutputBlock.vue`, `outputBlockCopyController.ts`, their focused tests, and the fenced-code wrapper/import added to `ThreadConversation.vue`. Do not change the existing whole-response copy toolbar or clipboard utility.
