import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
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
})
