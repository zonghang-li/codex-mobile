# Manual Test Catalog

Use this catalog for release checks that require a real Codex app-server,
browser lifecycle, microphone, file picker, or visual comparison.

## Current conversation page

- Running local turn with a five-step plan and live file changes
- Desktop-owned running turn viewed from mobile
- Completed turn with `Worked for` disclosure and visible final answer
- Subagent spawn/wait/complete without child transcript leakage
- Command approval, permission approval, and user-input request
- Active, paused, blocked, limited, and completed goal
- Queue, steer, stop, dictation, attachment, model/effort/speed menus
- 320 px, 390 px, and 430 px viewport with software keyboard

For every scenario, compare the mobile page with the same turn in Codex
desktop. Confirm content categories, activity/final-answer boundaries, labels,
icons, Step and file-change values, control ordering, disabled states, text
styles, and menu behavior. The document must not scroll horizontally; long
paths and inline code must wrap, while fenced code may scroll inside its own
block.
