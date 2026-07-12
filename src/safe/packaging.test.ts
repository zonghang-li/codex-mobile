import { execFile } from 'node:child_process'
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

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
    expect(localInstaller).toContain('npm uninstall --global --prefix "$prefix" codex-mobile-safe')
    expect(localInstaller).toContain('legacy_mobile_bin="$prefix/bin/codex-mobile"')
    expect(localInstaller).toContain('rm -f "$legacy_mobile_bin"')
    expect(serviceInstaller).toContain('systemd-analyze --user verify')
    expect(serviceInstaller).toContain('loginctl show-user')
    expect(serviceInstaller).toContain('systemctl --user enable codex-mobile-safe.service')
    expect(serviceInstaller).toContain('systemctl --user restart codex-mobile-safe.service')
  })

  it('honors the conventional PREFIX override for isolated installs', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'codex-mobile-prefix-test-'))
    const binDirectory = join(temporaryRoot, 'bin')
    const capturePath = join(temporaryRoot, 'npm-args.txt')
    await execFileAsync('mkdir', ['-p', binDirectory])
    await writeFile(join(binDirectory, 'pnpm'), '#!/bin/sh\nexit 0\n')
    await writeFile(
      join(binDirectory, 'npm'),
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$CAPTURE"\n',
    )
    await Promise.all([
      chmod(join(binDirectory, 'pnpm'), 0o755),
      chmod(join(binDirectory, 'npm'), 0o755),
    ])

    await execFileAsync('sh', [fileURLToPath(new URL('../../scripts/install-local.sh', import.meta.url))], {
      env: {
        ...process.env,
        PATH: `${binDirectory}:${process.env.PATH ?? ''}`,
        PREFIX: join(temporaryRoot, 'prefix'),
        CODEX_MOBILE_PREFIX: '',
        CAPTURE: capturePath,
      },
    })

    const npmArguments = (await readFile(capturePath, 'utf8')).trim().split('\n')
    expect(npmArguments.slice(0, 4)).toEqual([
      'install',
      '--global',
      '--prefix',
      join(temporaryRoot, 'prefix'),
    ])
  })
})
