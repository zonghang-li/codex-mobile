import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
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
    expect(safeSource).toContain(".option('--ntfy-url-file <path>',")
    expect(safeSource).toContain('loadNtfyPublishUrl({ explicitPath: options.ntfyUrlFile })')
    expect(safeSource).toContain("join(getSafeHome(), 'ntfy-notifier.json')")
    expect(safeSource).toContain('ntfyNotifications:')
    expect(safeSource).toContain('Codex sandbox mode: read-only, workspace-write, danger-full-access')
    expect(safeSource).toContain('Codex approval policy: untrusted, on-failure, on-request, never')
    expect(safeSource).toContain('parseSafeSandboxMode(options.sandboxMode)')
    expect(safeSource).toContain('parseSafeApprovalPolicy(options.approvalPolicy)')
    expect(safeSource).toContain('buildSafeSecurityPolicy')
    expect(safeSource).not.toContain('cloudflared')
    expect(safeSource).not.toContain('private-test-topic')
    expect(tsupSource).toContain("'src/cli/safe.ts'")
    expect(packageJson.bin?.['codex-mobile']).toBe('dist-cli/index.js')
    expect(packageJson.bin?.['codex-mobile-safe']).toBe('dist-cli/safe.js')
  })

  it('renders the explicit unrestricted profile in actual start help', () => {
    const root = fileURLToPath(new URL('../..', import.meta.url))
    execFileSync('pnpm', ['run', 'build:cli'], { cwd: root, stdio: 'pipe' })
    const help = execFileSync(process.execPath, [fileURLToPath(new URL('../../dist-cli/safe.js', import.meta.url)), 'start', '--help'], {
      cwd: root,
      encoding: 'utf8',
    })
    const normalizedHelp = help.replace(/\s+/gu, ' ')
    expect(normalizedHelp).toContain('read-only, workspace-write, danger-full-access')
    expect(normalizedHelp).toContain('untrusted, on-failure, on-request, never')
  })
})
