import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export async function mutateJsonStateFile<T>(
  statePath: string,
  update: (payload: Record<string, unknown>) => T | Promise<T>,
): Promise<T> {
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 })
  const lockPath = `${statePath}.lock`
  const lockOwnerPath = join(lockPath, 'owner.json')
  const lockToken = randomUUID()
  const lockDeadline = Date.now() + 35_000
  while (true) {
    if (await tryCreateOwnedLock(lockPath, lockToken)) break
    await recoverAbandonedLock(lockPath)
    if (Date.now() >= lockDeadline) throw new Error(`Timed out acquiring state lock: ${lockPath}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
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
    try {
      const owner = JSON.parse(await readFile(lockOwnerPath, 'utf8')) as { token?: unknown }
      if (owner.token === lockToken) {
        await rm(lockPath, { recursive: true, force: true })
      }
    } catch {
      // Never remove a lock whose ownership cannot be proven.
    }
  }
}

async function tryCreateOwnedLock(lockPath: string, token: string): Promise<boolean> {
  const candidatePath = `${lockPath}.candidate-${token}`
  try {
    await mkdir(candidatePath, { recursive: false, mode: 0o700 })
    await writeFile(join(candidatePath, 'owner.json'), JSON.stringify({
      pid: process.pid,
      token,
    }), { encoding: 'utf8', mode: 0o600 })
    try {
      await rename(candidatePath, lockPath)
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error
      return false
    }
  } finally {
    await rm(candidatePath, { recursive: true, force: true }).catch(() => {})
  }
}

async function recoverAbandonedLock(lockPath: string): Promise<void> {
  const recoveryPath = `${lockPath}.recovery`
  try {
    await mkdir(recoveryPath, { recursive: false, mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return
    throw error
  }

  try {
    const lockInfo = await stat(lockPath)
    if (Date.now() - lockInfo.mtimeMs <= 30_000) return
    const ownerPath = join(lockPath, 'owner.json')
    const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as {
      pid?: unknown
      token?: unknown
    }
    const ownerPid = typeof owner.pid === 'number' && Number.isSafeInteger(owner.pid)
      ? owner.pid
      : null
    if (ownerPid === null || isProcessAlive(ownerPid)) return
    const confirmed = JSON.parse(await readFile(ownerPath, 'utf8')) as {
      pid?: unknown
      token?: unknown
    }
    if (confirmed.pid === owner.pid && confirmed.token === owner.token) {
      await rm(lockPath, { recursive: true, force: true })
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  } finally {
    await rm(recoveryPath, { recursive: true, force: true })
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
