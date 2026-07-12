import { chmod, mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readSecurePasswordFile } from './passwordFile'

describe('secure password file', () => {
  it('reads a current-user mode-0600 regular file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-safe-password-'))
    const path = join(root, 'password')
    await writeFile(path, 'correct horse\n', { mode: 0o600 })
    await expect(readSecurePasswordFile(path)).resolves.toBe('correct horse')
  })

  it('rejects group or other permission bits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-safe-password-'))
    const path = join(root, 'password')
    await writeFile(path, 'secret\n', { mode: 0o600 })
    await chmod(path, 0o640)
    await expect(readSecurePasswordFile(path)).rejects.toThrow('0600')
  })

  it('rejects directories, empty files, and mismatched ownership', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-safe-password-'))
    const directory = join(root, 'directory')
    const empty = join(root, 'empty')
    const owned = join(root, 'owned')
    await mkdir(directory)
    await writeFile(empty, '', { mode: 0o600 })
    await writeFile(owned, 'secret', { mode: 0o600 })
    await expect(readSecurePasswordFile(directory)).rejects.toThrow('regular file')
    await expect(readSecurePasswordFile(empty)).rejects.toThrow('empty')
    await expect(readSecurePasswordFile(owned, { uid: 999999 })).rejects.toThrow('current user')
  })
})
