import { chmod, mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadNtfyPublishUrl } from './ntfyConfig'

async function temporaryPath(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'codex-safe-ntfy-config-'))
  return join(root, name)
}

describe('secure ntfy configuration', () => {
  it('returns null when the default URL file is missing', async () => {
    const missing = await temporaryPath('missing')
    await expect(loadNtfyPublishUrl({ defaultPath: missing })).resolves.toBeNull()
  })

  it('rejects a missing explicitly configured URL file', async () => {
    const missing = await temporaryPath('missing')
    await expect(loadNtfyPublishUrl({ explicitPath: missing })).rejects.toThrow('ntfy URL file')
  })

  it('reads an HTTPS ntfy.sh topic from a mode-0600 file', async () => {
    const path = await temporaryPath('url')
    await writeFile(path, 'https://ntfy.sh/random-topic\n', { mode: 0o600 })
    await expect(loadNtfyPublishUrl({ explicitPath: path })).resolves.toBe('https://ntfy.sh/random-topic')
  })

  it('rejects group or other permission bits', async () => {
    const path = await temporaryPath('url')
    await writeFile(path, 'https://ntfy.sh/topic\n', { mode: 0o600 })
    await chmod(path, 0o644)
    await expect(loadNtfyPublishUrl({ explicitPath: path })).rejects.toThrow('0600')
  })

  it('rejects directories', async () => {
    const path = await temporaryPath('directory')
    await mkdir(path)
    await expect(loadNtfyPublishUrl({ explicitPath: path })).rejects.toThrow('regular file')
  })

  it('rejects files not owned by the current user', async () => {
    const path = await temporaryPath('url')
    await writeFile(path, 'https://ntfy.sh/topic\n', { mode: 0o600 })
    await expect(loadNtfyPublishUrl({ explicitPath: path, uid: 42 })).rejects.toThrow('current user')
  })

  it.each([
    'http://ntfy.sh/topic',
    'https://example.com/topic',
    'https://user:pass@ntfy.sh/topic',
    'https://ntfy.sh/',
    'https://ntfy.sh/a/b',
    'https://ntfy.sh/topic?x=1',
    'https://ntfy.sh/topic#fragment',
  ])('rejects unsafe publish URL shape without disclosing it: %s', async (value) => {
    const path = await temporaryPath('url')
    await writeFile(path, `${value}\n`, { mode: 0o600 })

    const error = await loadNtfyPublishUrl({ explicitPath: path }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).not.toContain(value)
  })
})
