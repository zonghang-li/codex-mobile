# Mobile Dark Mode Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing system/light/dark theme support directly accessible from the mobile browser header with a persistent one-tap light/dark override.

**Architecture:** Keep `App.vue` as the owner of the existing stored theme mode and root `dark` class, extract small pure effective/next-mode decisions for unit testing, and add a mobile-only 44×44 header button using new sun/moon icons. Default remains `system`; the first quick-toggle click stores the opposite of the current effective system theme, while Settings continues to provide the path back to `system`.

**Tech Stack:** Vue 3 Composition API, TypeScript, localStorage, `matchMedia`, Tailwind utility application, Vitest source/pure tests, Playwright responsive browser verification.

## Global Constraints

- Existing storage key remains `codex-web-local.dark-mode.v1`.
- Missing or invalid preference remains `system`.
- The quick button is CSS-visible only at widths up to and including 768 px; do not redesign the desktop header.
- The visible control has a minimum 44×44 CSS touch target and localized `aria-label`/`title`.
- The moon indicates “switch to dark”; the sun indicates “switch to light”.
- At 375 px, the button must not overlap or collapse the title, terminal button, or branch selector.
- The root `dark` class remains the single theme switch; do not create a second CSS theme system.
- Appearance Settings must still cycle `system → light → dark → system`.
- Browser verification must cover 375×812 and 768×1024 in system-light, system-dark, explicit-light, and explicit-dark states.

## File Structure

- Create `src/utils/themeMode.ts`: pure theme validation, effective-theme, and next-quick-mode functions.
- Create `src/utils/themeMode.test.ts`: unit tests for system/light/dark decisions.
- Create `src/components/icons/IconTablerMoon.vue`: mobile quick-action moon icon.
- Create `src/components/icons/IconTablerSun.vue`: mobile quick-action sun icon.
- Modify `src/App.vue`: reactive system preference, quick-toggle button, labels, and persistence.
- Modify `src/composables/useUiLanguage.ts`: Chinese labels for switching themes.
- Modify `src/style.css`: shared mobile header control and dark/focus states.
- Create `src/components/content/mobileThemeToggle.wiring.test.ts`: structural accessibility and responsive wiring checks.
- Create `tests/theme-layout-terminal/mobile-header-theme-toggle.md`: exact manual/browser acceptance.
- Modify `tests/theme-layout-terminal/index.md`: index the new acceptance case.

---

### Task 1: Extract and Test Theme Mode Decisions

**Files:**
- Create: `src/utils/themeMode.ts`
- Create: `src/utils/themeMode.test.ts`
- Modify: `src/App.vue`

**Interfaces:**
- Produces:

```ts
export type ThemeMode = 'system' | 'light' | 'dark'
export type EffectiveTheme = 'light' | 'dark'

export function readThemeMode(value: string | null): ThemeMode
export function resolveEffectiveTheme(mode: ThemeMode, systemDark: boolean): EffectiveTheme
export function nextQuickThemeMode(mode: ThemeMode, systemDark: boolean): 'light' | 'dark'
```

- [ ] **Step 1: Write failing pure tests**

```ts
describe('theme mode decisions', () => {
  it.each([
    [null, 'system'],
    ['', 'system'],
    ['invalid', 'system'],
    ['system', 'system'],
    ['light', 'light'],
    ['dark', 'dark'],
  ] as const)('reads %s as %s', (stored, expected) => {
    expect(readThemeMode(stored)).toBe(expected)
  })

  it('resolves system mode and chooses the opposite explicit quick mode', () => {
    expect(resolveEffectiveTheme('system', false)).toBe('light')
    expect(nextQuickThemeMode('system', false)).toBe('dark')
    expect(resolveEffectiveTheme('system', true)).toBe('dark')
    expect(nextQuickThemeMode('system', true)).toBe('light')
  })

  it('alternates explicit modes without consulting the system', () => {
    expect(nextQuickThemeMode('light', true)).toBe('dark')
    expect(nextQuickThemeMode('dark', false)).toBe('light')
  })
})
```

- [ ] **Step 2: Run the pure tests and observe RED**

```bash
pnpm exec vitest run src/utils/themeMode.test.ts
```

Expected: FAIL because `themeMode.ts` does not exist.

- [ ] **Step 3: Implement the pure helpers**

```ts
export type ThemeMode = 'system' | 'light' | 'dark'
export type EffectiveTheme = 'light' | 'dark'

export function readThemeMode(value: string | null): ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system'
}

export function resolveEffectiveTheme(mode: ThemeMode, systemDark: boolean): EffectiveTheme {
  if (mode === 'system') return systemDark ? 'dark' : 'light'
  return mode
}

export function nextQuickThemeMode(mode: ThemeMode, systemDark: boolean): 'light' | 'dark' {
  return resolveEffectiveTheme(mode, systemDark) === 'dark' ? 'light' : 'dark'
}
```

- [ ] **Step 4: Reuse the reader in `App.vue`**

Replace the local validation body without changing the storage key:

```ts
function loadDarkModePref(): ThemeMode {
  if (typeof window === 'undefined') return 'system'
  return readThemeMode(window.localStorage.getItem(DARK_MODE_KEY))
}
```

- [ ] **Step 5: Run theme tests and typecheck**

```bash
pnpm exec vitest run src/utils/themeMode.test.ts
pnpm exec vue-tsc --noEmit
```

Expected: tests PASS and typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/utils/themeMode.ts src/utils/themeMode.test.ts src/App.vue
git commit -m "refactor: centralize browser theme decisions"
```

---

### Task 2: Add the Accessible Mobile Header Toggle

**Files:**
- Create: `src/components/icons/IconTablerMoon.vue`
- Create: `src/components/icons/IconTablerSun.vue`
- Modify: `src/App.vue`
- Modify: `src/composables/useUiLanguage.ts`
- Modify: `src/style.css`
- Create: `src/components/content/mobileThemeToggle.wiring.test.ts`

**Interfaces:**
- Consumes: `resolveEffectiveTheme()` and `nextQuickThemeMode()`.
- Produces reactive values `systemPrefersDark`, `effectiveTheme`, `themeToggleLabel`, and action `toggleQuickTheme()`.

- [ ] **Step 1: Add a failing wiring/accessibility test**

Read `App.vue`, `style.css`, and translations and assert the exact contract:

```ts
it('wires an accessible mobile-only theme toggle', async () => {
  expect(appSource).toContain('class="mobile-theme-toggle"')
  expect(appSource).toContain(':aria-label="themeToggleLabel"')
  expect(appSource).toContain(':title="themeToggleLabel"')
  expect(appSource).toContain('@click="toggleQuickTheme"')
  expect(appSource).toContain('<IconTablerSun v-if="effectiveTheme === \'dark\'"')
  expect(appSource).toContain('<IconTablerMoon v-else')
  expect(styleSource).toMatch(/\.mobile-theme-toggle\s*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px/su)
  expect(languageSource).toContain("'Switch to dark mode': '切换到深色模式'")
  expect(languageSource).toContain("'Switch to light mode': '切换到浅色模式'")
})
```

- [ ] **Step 2: Run the wiring test and observe RED**

```bash
pnpm exec vitest run src/components/content/mobileThemeToggle.wiring.test.ts
```

Expected: FAIL because the button, icons, labels, and styles do not exist.

- [ ] **Step 3: Create sun and moon SVG components**

Use app-native one-em icons with `aria-hidden="true"`:

```vue
<!-- IconTablerSun.vue -->
<template>
  <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" aria-hidden="true">
    <g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">
      <path d="M12 3v1m0 16v1M3 12h1m16 0h1M5.64 5.64l.7.7m11.32 11.32l.7.7m0-12.72l-.7.7M6.34 17.66l-.7.7" />
      <circle cx="12" cy="12" r="4" />
    </g>
  </svg>
</template>
```

```vue
<!-- IconTablerMoon.vue -->
<template>
  <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" aria-hidden="true">
    <path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12.79A9 9 0 1 1 11.21 3A7 7 0 0 0 21 12.79" />
  </svg>
</template>
```

- [ ] **Step 4: Make the effective system theme reactive**

Initialize from the existing media query and update on changes:

```ts
const darkModeMediaQuery = typeof window !== 'undefined'
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : null
const systemPrefersDark = ref(darkModeMediaQuery?.matches ?? false)
const effectiveTheme = computed(() => resolveEffectiveTheme(darkMode.value, systemPrefersDark.value))
const themeToggleLabel = computed(() => t(
  effectiveTheme.value === 'dark' ? 'Switch to light mode' : 'Switch to dark mode',
))

function onSystemThemeChange(event: MediaQueryListEvent): void {
  systemPrefersDark.value = event.matches
  applyDarkMode()
}

function toggleQuickTheme(): void {
  darkMode.value = nextQuickThemeMode(darkMode.value, systemPrefersDark.value)
  window.localStorage.setItem(DARK_MODE_KEY, darkMode.value)
  applyDarkMode()
}
```

Register/unregister `onSystemThemeChange` rather than passing `applyDarkMode` directly. Make `applyDarkMode()` toggle the root class from `effectiveTheme.value === 'dark'`.

- [ ] **Step 5: Add the mobile-only header button**

Place it in `ContentHeader`'s leading slot after `SidebarThreadControls`:

```vue
<button
  class="mobile-theme-toggle"
  type="button"
  :aria-label="themeToggleLabel"
  :title="themeToggleLabel"
  @click="toggleQuickTheme"
>
  <IconTablerSun v-if="effectiveTheme === 'dark'" />
  <IconTablerMoon v-else />
</button>
```

Import both icons and add Chinese translations:

```ts
'Switch to dark mode': '切换到深色模式',
'Switch to light mode': '切换到浅色模式',
```

- [ ] **Step 6: Add touch, focus, and dark-theme styles**

```css
.mobile-theme-toggle {
  min-width: 44px;
  min-height: 44px;
  @apply hidden shrink-0 items-center justify-center rounded-xl border-0 bg-transparent text-zinc-600 transition hover:bg-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500;
}

.mobile-theme-toggle svg {
  @apply h-5 w-5;
}

:root.dark .mobile-theme-toggle {
  @apply text-zinc-300 hover:bg-zinc-800;
}

@media (max-width: 768px) {
  .mobile-theme-toggle {
    display: inline-flex;
  }
}
```

Keep the button in the DOM and hide it by default so the CSS breakpoint includes the required 768×1024 verification viewport. Do not change `useMobile()` or the application-wide layout breakpoint.

- [ ] **Step 7: Run focused tests and typecheck**

```bash
pnpm exec vitest run src/utils/themeMode.test.ts src/components/content/mobileThemeToggle.wiring.test.ts
pnpm exec vue-tsc --noEmit
```

Expected: all tests PASS and typecheck exits 0.

- [ ] **Step 8: Commit**

```bash
git add \
  src/components/icons/IconTablerMoon.vue \
  src/components/icons/IconTablerSun.vue \
  src/App.vue \
  src/composables/useUiLanguage.ts \
  src/style.css \
  src/components/content/mobileThemeToggle.wiring.test.ts
git commit -m "feat: add mobile dark mode shortcut"
```

---

### Task 3: Document and Browser-Verify Responsive Theme Behavior

**Files:**
- Create: `tests/theme-layout-terminal/mobile-header-theme-toggle.md`
- Modify: `tests/theme-layout-terminal/index.md`
- Generate ignored evidence: `output/playwright/mobile-theme-toggle-*.png`
- Generate ignored evidence: `output/playwright/mobile-theme-toggle-report.json`

**Interfaces:**
- Consumes: completed theme toggle.
- Produces: reproducible acceptance documentation and screenshot/assertion evidence.

- [ ] **Step 1: Write the manual acceptance document**

Include prerequisites, exact actions, expected results, and cleanup. Cover:

1. clear `codex-web-local.dark-mode.v1`;
2. emulate system light, refresh, and assert light root plus moon button;
3. click once, assert stored `dark`, dark root, sun button, and refresh persistence;
4. click again, assert stored `light` and moon button;
5. select Appearance until `System`, emulate system dark, and assert automatic update;
6. verify keyboard focus and localized labels;
7. repeat at 375×812 and 768×1024;
8. inspect header bounding boxes and all major surfaces in light/dark.

- [ ] **Step 2: Index the manual case**

Add:

```markdown
| [Mobile header theme toggle](mobile-header-theme-toggle.md) |
```

to `tests/theme-layout-terminal/index.md` without altering unrelated cases.

- [ ] **Step 3: Start or validate the branch dev server**

Inspect `127.0.0.1:4173` and its process cwd. Stop only a stale `4173` process, never the tmux-managed `5173`, then run:

```bash
pnpm run dev --host 127.0.0.1 --port 4173
```

Expected: Vite reports the current branch at `http://127.0.0.1:4173/`.

- [ ] **Step 4: Run Playwright light/dark/system assertions**

Use system Chrome when Playwright's bundled browser is unavailable. For each viewport and mode, assert:

```js
const report = {
  viewport,
  mode,
  rootDarkOk,
  iconOk,
  ariaLabelOk,
  storedModeOk,
  persistsAfterRefresh,
  touchWidthOk: box.width >= 44,
  touchHeightOk: box.height >= 44,
  headerOverlap: false,
}
```

Save 375×812 and 768×1024 screenshots for system-light, system-dark, explicit-light, and explicit-dark. Wait 2–3 seconds before final screenshots and visually inspect at least the 375 px light/dark pair.

- [ ] **Step 5: Run full frontend verification**

```bash
pnpm exec vitest run src/utils/themeMode.test.ts src/components/content/mobileThemeToggle.wiring.test.ts
pnpm run test:unit
pnpm exec vue-tsc --noEmit
pnpm run build
git diff --check
```

Expected: every command exits 0 and browser report has no failed assertion or page error.

- [ ] **Step 6: Commit documentation**

```bash
git add tests/theme-layout-terminal/mobile-header-theme-toggle.md tests/theme-layout-terminal/index.md
git commit -m "test: document mobile theme switching"
```

- [ ] **Step 7: Include theme evidence in the shared PR/deployment flow**

Attach the report paths and inline light/dark screenshots to the final handoff. The backend plan owns the shared code review, PR merge, service reinstall, and Tailnet-only runtime verification; do not create a second PR.
