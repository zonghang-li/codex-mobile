import { chmod, mkdir, mkdtemp, readFile, readdir, rename, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  FileNtfyStateStore,
  boundNtfyState,
  createEmptyNtfyState,
  type NtfyNotifierState,
} from './ntfyState'

async function temporaryStatePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'codex-safe-ntfy-state-'))
  return join(root, 'private', 'ntfy-state.json')
}

function populatedState(): NtfyNotifierState {
  return {
    active: [{ key: 'thread-1:turn-1', threadId: 'thread-1', turnId: 'turn-1', startedAt: 10 }],
    pending: [{ key: 'thread-2:turn-2', title: 'Codex 任务完成', message: '已完成', createdAt: 20 }],
    sent: [{ key: 'thread-3:turn-3', sentAt: 30 }],
  }
}

describe('durable ntfy state', () => {
  it('creates the exact empty state shape', () => {
    expect(createEmptyNtfyState()).toEqual({ active: [], pending: [], sent: [] })
  })

  it('saves state with private directory and file modes', async () => {
    const path = await temporaryStatePath()
    const store = new FileNtfyStateStore(path)

    await store.save(populatedState())

    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('reconstructs a validated state from disk', async () => {
    const path = await temporaryStatePath()
    const store = new FileNtfyStateStore(path)
    await store.save(populatedState())

    await expect(store.load()).resolves.toEqual(populatedState())
  })

  it('recovers from malformed JSON with a redacted warning', async () => {
    const path = await temporaryStatePath()
    const storeForDirectory = new FileNtfyStateStore(path)
    await storeForDirectory.save(createEmptyNtfyState())
    const secret = 'https://ntfy.sh/do-not-disclose-topic'
    await writeFile(path, `{ definitely-invalid: "${secret}"`, { mode: 0o600 })
    const warn = vi.fn()
    const store = new FileNtfyStateStore(path, warn)

    await expect(store.load()).resolves.toEqual(createEmptyNtfyState())

    expect(warn).toHaveBeenCalledTimes(1)
    const warning = String(warn.mock.calls[0]?.[0])
    expect(warning).not.toContain(secret)
    expect(warning).not.toContain('do-not-disclose-topic')
  })

  it('rejects records containing URL or topic fields without disclosing their values', async () => {
    const path = await temporaryStatePath()
    const storeForDirectory = new FileNtfyStateStore(path)
    await storeForDirectory.save(createEmptyNtfyState())
    const secretUrl = 'https://ntfy.sh/secret-topic'
    const unsafe = {
      ...populatedState(),
      pending: [{ ...populatedState().pending[0], url: secretUrl, topic: 'secret-topic' }],
    }
    await writeFile(path, JSON.stringify(unsafe), { mode: 0o600 })
    const warn = vi.fn()
    const store = new FileNtfyStateStore(path, warn)

    await expect(store.load()).resolves.toEqual(createEmptyNtfyState())

    const warning = String(warn.mock.calls[0]?.[0])
    expect(warning).not.toContain(secretUrl)
    expect(warning).not.toContain('secret-topic')
  })

  it('bounds each collection to the newest records in oldest-first order', () => {
    const oversized: NtfyNotifierState = {
      active: Array.from({ length: 300 }, (_, startedAt) => ({
        key: `active-${startedAt}`,
        threadId: `thread-${startedAt}`,
        turnId: `turn-${startedAt}`,
        startedAt,
      })),
      pending: Array.from({ length: 300 }, (_, createdAt) => ({
        key: `pending-${createdAt}`,
        title: 'Codex 任务完成' as const,
        message: `message-${createdAt}`,
        createdAt,
      })),
      sent: Array.from({ length: 300 }, (_, sentAt) => ({ key: `sent-${sentAt}`, sentAt })),
    }

    const bounded = boundNtfyState(oversized, 256)

    expect(bounded.active).toHaveLength(256)
    expect(bounded.pending).toHaveLength(256)
    expect(bounded.sent).toHaveLength(256)
    expect(bounded.active[0].startedAt).toBe(44)
    expect(bounded.pending[0].createdAt).toBe(44)
    expect(bounded.sent[0].sentAt).toBe(44)
  })

  it('reapplies mode 0600 when replacing an existing state file', async () => {
    const path = await temporaryStatePath()
    const store = new FileNtfyStateStore(path)
    await store.save(createEmptyNtfyState())
    await chmod(path, 0o644)

    await store.save(populatedState())

    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(populatedState())
  })

  it('atomically replaces an existing destination inode', async () => {
    const path = await temporaryStatePath()
    const store = new FileNtfyStateStore(path)
    await store.save(createEmptyNtfyState())
    const previousInode = (await stat(path)).ino

    await store.save(populatedState())

    expect((await stat(path)).ino).not.toBe(previousInode)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(populatedState())
  })

  it('writes through a mode-0600 private temporary file', async () => {
    const path = await temporaryStatePath()
    let temporaryMode: number | undefined
    const store = new FileNtfyStateStore(path, () => {}, {
      write: async (handle, contents) => {
        temporaryMode = (await handle.stat()).mode & 0o777
        await handle.writeFile(contents, 'utf8')
      },
    })

    await store.save(populatedState())

    expect(temporaryMode).toBe(0o600)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('rejects a symlink destination and leaves its target unchanged', async () => {
    const path = await temporaryStatePath()
    const target = `${path}-target`
    const bootstrap = new FileNtfyStateStore(target)
    await bootstrap.save(createEmptyNtfyState())
    const original = await readFile(target, 'utf8')
    await symlink(target, path)

    await expect(new FileNtfyStateStore(path).save(populatedState())).rejects.toThrow('state path')

    expect(await readFile(target, 'utf8')).toBe(original)
  })

  it('rejects a symlink used as the final parent directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-safe-ntfy-parent-link-'))
    const realParent = join(root, 'real-parent')
    const linkedParent = join(root, 'linked-parent')
    await new FileNtfyStateStore(join(realParent, 'existing.json')).save(createEmptyNtfyState())
    await symlink(realParent, linkedParent)

    await expect(new FileNtfyStateStore(join(linkedParent, 'state.json')).save(populatedState()))
      .rejects.toThrow('state directory')
  })

  it('rejects a symlink in an earlier ancestor directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-safe-ntfy-ancestor-link-'))
    const realAncestor = join(root, 'real-ancestor')
    const linkedAncestor = join(root, 'linked-ancestor')
    await new FileNtfyStateStore(join(realAncestor, 'private', 'existing.json')).save(createEmptyNtfyState())
    await symlink(realAncestor, linkedAncestor)

    await expect(new FileNtfyStateStore(join(linkedAncestor, 'private', 'state.json')).save(populatedState()))
      .rejects.toThrow('state directory')
  })

  it('detects parent replacement after opening it without writing through the replacement', async () => {
    const path = await temporaryStatePath()
    const parent = dirname(path)
    const root = dirname(parent)
    const movedParent = join(root, 'moved-private')
    const replacement = join(root, 'replacement')
    await mkdir(replacement, { mode: 0o700 })
    await new FileNtfyStateStore(path).save(createEmptyNtfyState())
    const original = await readFile(path, 'utf8')
    let replaced = false
    const racingStore = new FileNtfyStateStore(path, () => {}, {
      afterDirectoryOpen: async () => {
        await rename(parent, movedParent)
        await symlink(replacement, parent)
        replaced = true
      },
    })

    await expect(racingStore.save(populatedState())).rejects.toThrow('Unable to save ntfy notifier state')

    expect(replaced).toBe(true)
    expect(await readFile(join(movedParent, 'ntfy-state.json'), 'utf8')).toBe(original)
    await expect(readFile(join(replacement, 'ntfy-state.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves the previous state and removes the private temporary file when rename fails', async () => {
    const path = await temporaryStatePath()
    const originalStore = new FileNtfyStateStore(path)
    await originalStore.save(createEmptyNtfyState())
    const original = await readFile(path, 'utf8')
    const failingStore = new FileNtfyStateStore(path, () => {}, {
      rename: async () => {
        throw new Error('injected rename failure with https://ntfy.sh/private-topic')
      },
    })

    await expect(failingStore.save(populatedState())).rejects.toThrow('Unable to save ntfy notifier state')

    expect(await readFile(path, 'utf8')).toBe(original)
    expect(await readdir(dirname(path))).toEqual(['ntfy-state.json'])
  })

  it('preserves the previous state and removes the private temporary file when writing fails', async () => {
    const path = await temporaryStatePath()
    const originalStore = new FileNtfyStateStore(path)
    await originalStore.save(createEmptyNtfyState())
    const original = await readFile(path, 'utf8')
    const failingStore = new FileNtfyStateStore(path, () => {}, {
      write: async () => {
        throw new Error('injected write failure with https://ntfy.sh/private-topic')
      },
    })

    const error = await failingStore.save(populatedState()).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('Unable to save ntfy notifier state')
    expect(await readFile(path, 'utf8')).toBe(original)
    expect(await readdir(dirname(path))).toEqual(['ntfy-state.json'])
  })

  it.each([
    { ...populatedState(), extra: 'secret' },
    { ...populatedState(), active: [{ ...populatedState().active[0], extra: 'secret' }] },
    { ...populatedState(), sent: [{ ...populatedState().sent[0], extra: 'secret' }] },
    { ...populatedState(), pending: [{ ...populatedState().pending[0], title: 'Codex unknown' }] },
    { ...populatedState(), active: [{ ...populatedState().active[0], startedAt: -1 }] },
    { ...populatedState(), pending: [{ ...populatedState().pending[0], createdAt: Number.NaN }] },
    { ...populatedState(), sent: [{ ...populatedState().sent[0], sentAt: Number.POSITIVE_INFINITY }] },
  ])('recovers from invalid persisted schema without exposing record contents', async (invalid) => {
    const path = await temporaryStatePath()
    const bootstrap = new FileNtfyStateStore(path)
    await bootstrap.save(createEmptyNtfyState())
    await writeFile(path, JSON.stringify(invalid), { mode: 0o600 })
    const warn = vi.fn()

    await expect(new FileNtfyStateStore(path, warn).load()).resolves.toEqual(createEmptyNtfyState())

    expect(warn).toHaveBeenCalledWith('Unable to load ntfy notifier state; starting with empty state')
  })

  it('bounds oversized collections reconstructed from disk', async () => {
    const path = await temporaryStatePath()
    const bootstrap = new FileNtfyStateStore(path)
    await bootstrap.save(createEmptyNtfyState())
    const oversized: NtfyNotifierState = {
      active: Array.from({ length: 300 }, (_, startedAt) => ({
        key: `active-${startedAt}`,
        threadId: `thread-${startedAt}`,
        turnId: `turn-${startedAt}`,
        startedAt,
      })),
      pending: Array.from({ length: 300 }, (_, createdAt) => ({
        key: `pending-${createdAt}`,
        title: 'Codex 任务完成',
        message: `message-${createdAt}`,
        createdAt,
      })),
      sent: Array.from({ length: 300 }, (_, sentAt) => ({ key: `sent-${sentAt}`, sentAt })),
    }
    await writeFile(path, JSON.stringify(oversized), { mode: 0o600 })

    const loaded = await new FileNtfyStateStore(path).load()

    expect(loaded.active).toHaveLength(256)
    expect(loaded.pending).toHaveLength(256)
    expect(loaded.sent).toHaveLength(256)
    expect(loaded.active[0].startedAt).toBe(44)
  })
})
