import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isLockDestinationConflict,
  isProcessIdentityAlive,
  isProcessOwnerAlive,
  mutateJsonStateFile,
  readProcessStartIdentity,
  recoverAbandonedLock,
} from './atomicJsonState'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('mutateJsonStateFile', () => {
  it('treats Linux directory rename conflicts as ordinary lock contention', () => {
    expect(isLockDestinationConflict(Object.assign(new Error('exists'), { code: 'EEXIST' }))).toBe(true)
    expect(isLockDestinationConflict(Object.assign(new Error('not empty'), { code: 'ENOTEMPTY' }))).toBe(true)
    expect(isLockDestinationConflict(Object.assign(new Error('denied'), { code: 'EACCES' }))).toBe(false)
  })

  it('treats an unreadable identity for a demonstrably live pid as still owned', () => {
    expect(isProcessIdentityAlive(true, '123:456', null, 'linux')).toBe(true)
  })

  it('serializes independent mutations to the same state file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-mobile-json-state-'))
    const statePath = join(root, 'state.json')
    const firstEntered = deferred()
    const releaseFirst = deferred()

    try {
      const first = mutateJsonStateFile(statePath, async (payload) => {
        firstEntered.resolve()
        await releaseFirst.promise
        payload.first = true
      })
      await firstEntered.promise
      const second = mutateJsonStateFile(statePath, (payload) => {
        payload.second = true
      })
      await new Promise((resolve) => setTimeout(resolve, 10))
      releaseFirst.resolve()
      await Promise.all([first, second])

      expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual({
        first: true,
        second: true,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not steal an old lock while its owning mutation is still alive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-mobile-json-state-live-lock-'))
    const statePath = join(root, 'state.json')
    const firstEntered = deferred()
    const releaseFirst = deferred()
    let secondEntered = false

    try {
      const first = mutateJsonStateFile(statePath, async (payload) => {
        firstEntered.resolve()
        await releaseFirst.promise
        payload.first = true
      })
      await firstEntered.promise
      const old = new Date(Date.now() - 60_000)
      await utimes(`${statePath}.lock`, old, old)

      const second = mutateJsonStateFile(statePath, (payload) => {
        secondEntered = true
        payload.second = true
      })
      await new Promise((resolve) => setTimeout(resolve, 25))

      expect(secondEntered).toBe(false)
      releaseFirst.resolve()
      await Promise.all([first, second])
      expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual({ first: true, second: true })
    } finally {
      releaseFirst.resolve()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('recovers an abandoned main lock even when its recovery gate was abandoned', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-mobile-json-state-abandoned-recovery-'))
    const lockPath = join(root, 'state.json.lock')
    const recoveryPath = `${lockPath}.recovery`
    const old = new Date(Date.now() - 60_000)

    try {
      await mkdir(lockPath)
      await writeFile(join(lockPath, 'owner.json'), JSON.stringify({
        pid: 2_147_483_647,
        token: 'dead-main',
        processStartIdentity: 'dead-main-start',
      }))
      await mkdir(recoveryPath)
      await writeFile(join(recoveryPath, 'owner.json'), JSON.stringify({
        pid: 2_147_483_647,
        token: 'dead-recovery',
        processStartIdentity: 'dead-recovery-start',
      }))
      await utimes(lockPath, old, old)
      await utimes(recoveryPath, old, old)

      await recoverAbandonedLock(lockPath)

      await expect(readFile(join(lockPath, 'owner.json'), 'utf8')).rejects.toThrow()
      await expect(readFile(join(recoveryPath, 'owner.json'), 'utf8')).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('distinguishes a reused live pid from the original process owner', async () => {
    const processStartIdentity = await readProcessStartIdentity(process.pid)
    expect(processStartIdentity).toBeTruthy()
    await expect(isProcessOwnerAlive({
      pid: process.pid,
      processStartIdentity: `${processStartIdentity}-different`,
    })).resolves.toBe(false)
    await expect(isProcessOwnerAlive({
      pid: process.pid,
      processStartIdentity,
    })).resolves.toBe(true)
  })

  it('recovers malformed state from the last durable backup before mutating', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-mobile-json-state-invalid-'))
    const statePath = join(root, 'state.json')

    try {
      await mutateJsonStateFile(statePath, (payload) => {
        payload.stable = true
      })
      await writeFile(statePath, '{broken', 'utf8')

      await expect(mutateJsonStateFile(statePath, (payload) => {
        payload.next = true
      })).resolves.toBeUndefined()
      await expect(readFile(statePath, 'utf8').then(JSON.parse)).resolves.toEqual({
        stable: true,
        next: true,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
