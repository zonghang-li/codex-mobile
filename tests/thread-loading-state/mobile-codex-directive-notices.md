### Mobile Codex directive notices

#### Feature/Change Name

Recognized Codex directives render as localized notices and export as readable Markdown without exposing raw protocol syntax.

#### Prerequisites/Setup

- Deploy the feature build and complete the normal local installation.
- Use a fresh authenticated browser page.
- Make Chinese and English UI languages available.
- Make light and dark appearance available.

#### Production Acceptance Steps

1. Open thread `019f565b-9ea5-7a30-b51d-8d927451f1b5` after deployment at 390×844.
2. Locate the assistant message whose persisted completion ends in the production `git-push` directive.
3. Assert the preceding Chinese summary is unchanged.
4. Assert a compact localized notice displays `已推送 main` when Chinese is active.
5. Assert the page body and copied thread Markdown do not contain the recognized raw prefix `::git-push{`.
6. Verify a fenced literal example remains visible.
7. Verify an unknown standalone `::future-directive{value="kept"}` remains visible.
8. Verify ordinary assistant Markdown retains leading/trailing whitespace and four-space indented code.
9. Verify code-comment notices show `file`, `file:start`, and `file:start-end` for their respective location forms.
10. Check 375×812 and 768×1024 in light and dark appearance.

#### Expected Results

- The preceding assistant summary remains visible and unchanged.
- Chinese displays `已推送 main`; English displays `Pushed main`.
- Recognized raw directive syntax appears in neither the rendered page nor copied thread Markdown.
- Fenced literals and unknown or malformed directive-like prose remain visible.
- Assistant whitespace is unchanged unless a recognized directive line and its separator gap are removed.
- Code-comment locations include an end line when the directive supplies one.
- The notice remains compact and readable at every listed viewport in light and dark appearance.

#### Rollback/Cleanup

Revert the feature commits, rebuild/install, and restart only `codex-mobile-safe.service`.
