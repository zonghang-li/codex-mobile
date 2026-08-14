import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export function isLockDestinationConflict(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EEXIST' || code === 'ENOTEMPTY'
}

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
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        // A missing state file starts from an empty object.
      } else {
        try {
          const backup = JSON.parse(await readFile(`${statePath}.bak`, 'utf8')) as unknown
          if (!backup || typeof backup !== 'object' || Array.isArray(backup)) throw error
          payload = backup as Record<string, unknown>
        } catch {
          throw error
        }
      }
    }

    const result = await update(payload)
    const serialized = JSON.stringify(payload)
    await replaceFileDurably(`${statePath}.bak`, serialized)
    await replaceFileDurably(statePath, serialized)
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

async function replaceFileDurably(path: string, contents: string): Promise<void> {
  const directory = dirname(path)
  const tempPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    const file = await open(tempPath, 'w', 0o600)
    try {
      await file.writeFile(contents, { encoding: 'utf8' })
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(tempPath, path)
    const directoryHandle = await open(directory, 'r')
    try {
      await directoryHandle.sync()
    } finally {
      await directoryHandle.close()
    }
  } finally {
    await rm(tempPath, { force: true }).catch(() => {})
  }
}

async function tryCreateOwnedLock(lockPath: string, token: string): Promise<boolean> {
  const candidatePath = `${lockPath}.candidate-${token}`
  try {
    await mkdir(candidatePath, { recursive: false, mode: 0o700 })
    await writeFile(join(candidatePath, 'owner.json'), JSON.stringify({
      pid: process.pid,
      token,
      processStartIdentity: await getCurrentProcessStartIdentity(),
    }), { encoding: 'utf8', mode: 0o600 })
    try {
      await rename(candidatePath, lockPath)
      return true
    } catch (error) {
      if (isLockDestinationConflict(error)) return false
      try {
        await stat(lockPath)
        return false
      } catch {
        throw error
      }
    }
  } finally {
    await rm(candidatePath, { recursive: true, force: true }).catch(() => {})
  }
}

export async function recoverAbandonedLock(lockPath: string): Promise<void> {
  try {
    const lockInfo = await stat(lockPath)
    if (Date.now() - lockInfo.mtimeMs <= 30_000) return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const recoveryPath = `${lockPath}.recovery`
  const recoveryToken = randomUUID()
  if (!(await tryCreateOwnedLock(recoveryPath, recoveryToken))) {
    await removeAbandonedOwnedLock(recoveryPath, 30_000)
    if (!(await tryCreateOwnedLock(recoveryPath, recoveryToken))) return
  }

  try {
    await removeAbandonedOwnedLock(lockPath, 30_000)
  } finally {
    await releaseOwnedLock(recoveryPath, recoveryToken)
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

export async function readProcessStartIdentity(pid: number): Promise<string | null> {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 0) return null
  try {
    const statLine = await readFile(`/proc/${pid}/stat`, 'utf8')
    const commandEnd = statLine.lastIndexOf(') ')
    if (commandEnd < 0) return null
    const fieldsAfterCommand = statLine.slice(commandEnd + 2).trim().split(/\s+/u)
    const startTime = fieldsAfterCommand[19]?.trim() ?? ''
    return startTime ? `${pid}:${startTime}` : null
  } catch {
    return null
  }
}

export async function isProcessOwnerAlive(owner: {
  pid: number
  processStartIdentity?: string | null
}): Promise<boolean> {
  const pidAlive = isProcessAlive(owner.pid)
  if (!pidAlive || !owner.processStartIdentity) return pidAlive
  const currentIdentity = await readProcessStartIdentity(owner.pid)
  return isProcessIdentityAlive(
    pidAlive,
    owner.processStartIdentity,
    currentIdentity,
    process.platform,
  )
}

export function isProcessIdentityAlive(
  pidAlive: boolean,
  expectedIdentity: string | null,
  currentIdentity: string | null,
  platform: NodeJS.Platform,
): boolean {
  if (!pidAlive) return false
  if (!expectedIdentity) return true
  if (currentIdentity === null) return true
  return platform !== 'linux' || currentIdentity === expectedIdentity
}

let currentProcessStartIdentityPromise: Promise<string | null> | null = null

async function getCurrentProcessStartIdentity(): Promise<string | null> {
  currentProcessStartIdentityPromise ??= readProcessStartIdentity(process.pid)
  return currentProcessStartIdentityPromise
}

async function readLockOwner(lockPath: string): Promise<{
  pid: number
  token: string
  processStartIdentity: string | null
} | null> {
  try {
    const owner = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')) as {
      pid?: unknown
      token?: unknown
      processStartIdentity?: unknown
    }
    if (
      typeof owner.pid !== 'number'
      || !Number.isSafeInteger(owner.pid)
      || owner.pid <= 0
      || typeof owner.token !== 'string'
      || !owner.token
    ) return null
    return {
      pid: owner.pid,
      token: owner.token,
      processStartIdentity: typeof owner.processStartIdentity === 'string'
        ? owner.processStartIdentity
        : null,
    }
  } catch {
    return null
  }
}

async function removeAbandonedOwnedLock(lockPath: string, staleAfterMs: number): Promise<void> {
  try {
    const lockInfo = await stat(lockPath)
    if (Date.now() - lockInfo.mtimeMs <= staleAfterMs) return
    const owner = await readLockOwner(lockPath)
    if (!owner || await isProcessOwnerAlive(owner)) return
    const confirmed = await readLockOwner(lockPath)
    if (
      confirmed?.pid === owner.pid
      && confirmed.token === owner.token
      && confirmed.processStartIdentity === owner.processStartIdentity
    ) {
      await rm(lockPath, { recursive: true, force: true })
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function releaseOwnedLock(lockPath: string, token: string): Promise<void> {
  const owner = await readLockOwner(lockPath)
  if (owner?.token === token) {
    await rm(lockPath, { recursive: true, force: true })
  }
}
