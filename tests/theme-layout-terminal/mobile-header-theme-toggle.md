### Mobile header theme toggle

#### Feature/Change Name
The mobile content header provides a quick light/dark theme toggle while Settings retains the System appearance option.

#### Prerequisites/Setup
1. Run the current branch at `http://127.0.0.1:4173/`.
2. Open browser developer tools with color-scheme emulation available.
3. Open an existing thread whose working directory is a Git worktree on the `main` branch. Confirm the thread header renders a non-empty title, the integrated-terminal button, and the branch selector before testing. The automated acceptance used a real thread in `/home/zonghangli/Desktop/prima.cpp` on `main`; use an equivalent local Git thread if that thread is unavailable.
4. Test both `375×812` and `768×1024` viewports.
5. Keep the browser console visible so page errors can be detected.

#### Steps
1. Clear the `codex-web-local.dark-mode.v1` local-storage entry.
2. Emulate a light system color scheme and refresh the page.
3. Confirm the document root is light and the header button shows a moon. Confirm both its `aria-label` and `title` are “Switch to dark mode” (or “切换到深色模式”).
4. Click the header theme button once. Confirm local storage contains `dark`, the document root has the `dark` class, and the button shows a sun. Confirm both its `aria-label` and `title` change to “Switch to light mode” (or “切换到浅色模式”).
5. Refresh and confirm the explicit dark theme, stored value, sun icon, and accessible label persist.
6. Click the header theme button again. Confirm local storage contains `light`, the document root no longer has the `dark` class, and the button shows a moon.
7. Open Settings and select Appearance repeatedly until it reads `System`. Emulate a dark system color scheme and confirm the page updates automatically to a dark root with a sun button. Switch the emulation back to light and confirm it updates to a light root with a moon button.
8. Use Tab to focus the theme button. Confirm its visible focus indicator appears and press Enter or Space to switch themes.
9. Repeat steps 1–8 at both `375×812` and `768×1024`.
10. In light and dark mode, inspect the header button, sidebar, content header, conversation surface, composer, menus, dialogs, and terminal surface for readable contrast.
11. Inspect the title, theme button, terminal button, and branch selector bounding boxes. Confirm every control has nonzero width and height, the theme button is at least `44×44` CSS pixels, no pair overlaps, and no control extends beyond the header or viewport.
12. Set the viewport to exactly `1024×768`. Confirm the quick theme button is hidden; the title, terminal button, and branch selector remain nonzero, non-overlapping, and in their existing order. Confirm no desktop-header spacing, control, or layout redesign appears.

#### Expected Results
- With no stored preference, the root follows the emulated system color scheme.
- The quick control always represents the next action: moon switches to dark and sun switches to light.
- A quick-toggle click stores an explicit `light` or `dark` preference that survives refresh.
- Selecting `System` in Settings restores live system color-scheme updates.
- Localized `aria-label` and `title` action semantics, keyboard activation, and a visible focus indicator are available.
- The control remains at least `44×44` at both mobile viewports; title, theme, terminal, and branch controls are all nonzero and do not overlap or collapse.
- Major surfaces remain readable in light and dark themes, and the desktop header is unaffected above the breakpoint.

#### Rollback/Cleanup
1. In Settings, select Appearance until it reads `System`, or remove `codex-web-local.dark-mode.v1` from local storage.
2. Restore the browser color-scheme emulation to its default.
3. Remove generated `output/playwright/mobile-theme-toggle-*` evidence if it is no longer needed.
