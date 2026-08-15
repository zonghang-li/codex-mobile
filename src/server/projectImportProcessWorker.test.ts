import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const workerId = process.env.CODEX_MOBILE_PROJECT_IMPORT_WORKER_ID ?? ''
const codexHome = process.env.CODEX_HOME ?? ''
const destinationParent = process.env.CODEX_MOBILE_PROJECT_IMPORT_PARENT ?? ''
const zipPath = process.env.CODEX_MOBILE_PROJECT_IMPORT_ZIP ?? ''

describe.skipIf(!workerId || !codexHome || !destinationParent || !zipPath)('project import process worker', () => {
  it('runs a failing import inside the cross-process mutation window', async () => {
    const bridge = await import('./codexAppServerBridge')
    const readyPath = join(codexHome, `project-import-ready-${workerId}`)
    const peerReadyPath = join(codexHome, `project-import-ready-${workerId === 'a' ? 'b' : 'a'}`)
    const activePath = join(codexHome, 'project-import-active')
    const overlapPath = join(codexHome, 'project-import-overlap')
    await writeFile(readyPath, workerId, 'utf8')
    const deadline = Date.now() + 10_000
    while (true) {
      try {
        await stat(peerReadyPath)
        break
      } catch {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for peer import worker')
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    let ownsActiveMarker = false

    await expect(bridge.importProjectZip(await readFile(zipPath), destinationParent, {
      afterGlobalStatePersist: async () => {
        try {
          await mkdir(activePath)
          ownsActiveMarker = true
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          await writeFile(overlapPath, workerId, 'utf8')
        }
        await new Promise((resolve) => setTimeout(resolve, 200))
        if (ownsActiveMarker) await rm(activePath, { recursive: true, force: true })
        throw new Error('simulated worker import failure')
      },
    })).rejects.toThrow('simulated worker import failure')
  }, 30_000)
})
