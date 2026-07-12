import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('safe CLI entry packaging', () => {
  it('builds a dedicated safe entry and exposes both local commands', async () => {
    const [safeSource, tsupSource, packageSource] = await Promise.all([
      readFile(new URL('./safe.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../tsup.config.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    ])
    const packageJson = JSON.parse(packageSource) as { bin?: Record<string, string> }
    expect(safeSource).toContain("command('start')")
    expect(safeSource).toContain(".option('--password-file <path>',")
    expect(safeSource).toContain('buildSafeSecurityPolicy')
    expect(safeSource).not.toContain('cloudflared')
    expect(tsupSource).toContain("'src/cli/safe.ts'")
    expect(packageJson.bin?.['codex-mobile']).toBe('dist-cli/index.js')
    expect(packageJson.bin?.['codex-mobile-safe']).toBe('dist-cli/safe.js')
  })
})
