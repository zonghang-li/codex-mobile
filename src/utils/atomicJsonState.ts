import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export async function mutateJsonStateFile<T>(
  statePath: string,
  update: (payload: Record<string, unknown>) => T | Promise<T>,
): Promise<T> {
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 })
  const lockPath = `${statePath}.lock`
  const lockDeadline = Date.now() + 5_000
  while (true) {
    try {
      await mkdir(lockPath, { recursive: false, mode: 0o700 })
      break
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      try {
        const lockInfo = await stat(lockPath)
        if (Date.now() - lockInfo.mtimeMs > 30_000) {
          await rm(lockPath, { recursive: true, force: true })
          continue
        }
      } catch {}
      if (Date.now() >= lockDeadline) throw new Error(`Timed out acquiring state lock: ${lockPath}`)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  try {
    let payload: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(await readFile(statePath, 'utf8')) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }

    const result = await update(payload)
    const tempPath = join(dirname(statePath), `.${basename(statePath)}.${process.pid}.${randomUUID()}.tmp`)
    try {
      await writeFile(tempPath, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 })
      await rename(tempPath, statePath)
    } finally {
      await rm(tempPath, { force: true }).catch(() => {})
    }
    return result
  } finally {
    await rm(lockPath, { recursive: true, force: true })
  }
}
