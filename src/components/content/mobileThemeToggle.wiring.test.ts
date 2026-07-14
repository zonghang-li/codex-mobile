import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const appUrl = new URL('../../App.vue', import.meta.url)
const styleUrl = new URL('../../style.css', import.meta.url)
const languageUrl = new URL('../../composables/useUiLanguage.ts', import.meta.url)

describe('mobile theme toggle wiring', () => {
  it('wires an accessible mobile-only theme toggle', async () => {
    const [appSource, styleSource, languageSource] = await Promise.all([
      readFile(appUrl, 'utf8'),
      readFile(styleUrl, 'utf8'),
      readFile(languageUrl, 'utf8'),
    ])

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
})
