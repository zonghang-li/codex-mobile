import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

async function readRepoFile(path: string): Promise<string> {
  return readFile(new URL(`../../${path}`, import.meta.url), 'utf8')
}

describe('local installation packaging', () => {
  it('defines clone-local install and service lifecycle scripts', async () => {
    const packageJson = JSON.parse(await readRepoFile('package.json')) as {
      private?: boolean
      scripts?: Record<string, string>
      bin?: Record<string, string>
      files?: string[]
    }
    expect(packageJson.private).toBe(true)
    expect(packageJson.scripts?.['install:local']).toBe('sh scripts/install-local.sh')
    expect(packageJson.scripts?.['service:install']).toBe('sh scripts/install-user-service.sh')
    expect(packageJson.scripts?.['service:restart']).toContain('systemctl --user restart')
    expect(packageJson.bin?.['codex-mobile']).toBe('dist-cli/index.js')
    expect(packageJson.bin?.['codex-mobile-safe']).toBe('dist-cli/safe.js')
    expect(packageJson.files).toContain('src/')
  })

  it('keeps plaintext passwords out of the restartable systemd unit', async () => {
    const unit = await readRepoFile('packaging/systemd/codex-mobile-safe.service.in')
    expect(unit).toContain('Restart=on-failure')
    expect(unit).toContain('--password-file %h/.codex/codex-mobile-safe-password')
    expect(unit).toContain('--no-open')
    expect(unit).not.toMatch(/--password(?:=|\s)/u)
    expect(unit).not.toContain('--lan')
    expect(unit).not.toContain('cloudflared')
    expect(unit).not.toContain('funnel')
  })

  it('installs from the current clone and verifies the user unit', async () => {
    const [localInstaller, serviceInstaller] = await Promise.all([
      readRepoFile('scripts/install-local.sh'),
      readRepoFile('scripts/install-user-service.sh'),
    ])
    expect(localInstaller).toContain('pnpm run build')
    expect(localInstaller).toContain('npm install --global --prefix')
    expect(serviceInstaller).toContain('systemd-analyze --user verify')
    expect(serviceInstaller).toContain('loginctl show-user')
  })
})
