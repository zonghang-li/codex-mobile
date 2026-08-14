import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mutateJsonStateFile } from './atomicJsonState'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('mutateJsonStateFile', () => {
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

  it('does not replace malformed existing state with an empty snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-mobile-json-state-invalid-'))
    const statePath = join(root, 'state.json')
    await writeFile(statePath, '{broken', 'utf8')

    try {
      await expect(mutateJsonStateFile(statePath, (payload) => {
        payload.next = true
      })).rejects.toBeInstanceOf(SyntaxError)
      await expect(readFile(statePath, 'utf8')).resolves.toBe('{broken')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
