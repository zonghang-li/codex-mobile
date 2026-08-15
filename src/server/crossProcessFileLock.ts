import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { replaceFileDurably } from '../utils/atomicJsonState.ts'

type CrossProcessDirectoryLockOptions = {
  timeoutMs: number
  staleMs: number
  retryMs?: number
  readCurrentProcessStartIdentity?: () => Promise<string | null>
}

type LockOwner = {
  token: string
  pid: number
  hostname: string
  processStartIdentity: string | null
  updatedAtMs: number
}

const LOCAL_HOSTNAME = hostname()
const OWNER_FILE_NAME = 'owner.json'

type ProcessIdentityCommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<string>

function runProcessIdentityCommand(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], {
      encoding: 'utf8',
      timeout: 2_000,
      windowsHide: true,
      maxBuffer: 4 * 1024,
    }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export async function readProcessStartIdentityForPlatform(
  pid: number,
  platform: NodeJS.Platform,
  runCommand: ProcessIdentityCommandRunner = runProcessIdentityCommand,
): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  try {
    let identity = ''
    if (platform === 'linux') {
      const statLine = await readFile(`/proc/${pid}/stat`, 'utf8')
      const commandEnd = statLine.lastIndexOf(') ')
      if (commandEnd < 0) return null
      identity = statLine.slice(commandEnd + 2).trim().split(/\s+/u)[19]?.trim() ?? ''
    } else if (platform === 'win32') {
      identity = await runCommand('powershell.exe', [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$process = Get-Process -Id ${String(pid)} -ErrorAction Stop; `
          + '[Console]::Out.Write($process.StartTime.ToUniversalTime().Ticks)',
      ])
    } else {
      identity = await runCommand('ps', ['-o', 'lstart=', '-p', String(pid)])
    }
    identity = identity.trim()
    return identity ? `${platform}:${String(pid)}:${identity}` : null
  } catch {
    return null
  }
}

function readProcessStartIdentity(pid: number): Promise<string | null> {
  return readProcessStartIdentityForPlatform(pid, process.platform)
}

let currentProcessStartIdentityPromise: Promise<string | null> | null = null

function readCurrentProcessStartIdentity(): Promise<string | null> {
  currentProcessStartIdentityPromise ??= readProcessStartIdentity(process.pid)
  return currentProcessStartIdentityPromise
}

export async function isProcessOwnerIdentityAliveForPlatform(
  pid: number,
  expectedIdentity: string | null,
  platform: NodeJS.Platform,
  processAlive: (pid: number) => boolean = isProcessAlive,
  runCommand: ProcessIdentityCommandRunner = runProcessIdentityCommand,
): Promise<boolean> {
  if (!processAlive(pid)) return false
  if (!expectedIdentity) return true
  const currentIdentity = await readProcessStartIdentityForPlatform(pid, platform, runCommand)
  return currentIdentity === null || currentIdentity === expectedIdentity
}

async function readLockOwnerFile(ownerPath: string): Promise<LockOwner | null> {
  try {
    const parsed = JSON.parse(await readFile(ownerPath, 'utf8')) as Partial<LockOwner>
    if (!(typeof parsed.token === 'string'
      && Number.isSafeInteger(parsed.pid)
      && typeof parsed.hostname === 'string'
      && typeof parsed.updatedAtMs === 'number')) return null
    return {
      ...parsed,
      processStartIdentity: typeof parsed.processStartIdentity === 'string'
        ? parsed.processStartIdentity
        : null,
    } as LockOwner
  } catch {
    return null
  }
}

async function readLockOwner(lockPath: string): Promise<LockOwner | null> {
  return readLockOwnerFile(join(lockPath, OWNER_FILE_NAME))
}

async function isLocalOwnerAlive(owner: LockOwner | null): Promise<boolean | null> {
  if (!owner || owner.hostname !== LOCAL_HOSTNAME) return null
  return isProcessOwnerIdentityAliveForPlatform(
    owner.pid,
    owner.processStartIdentity,
    process.platform,
  )
}

async function lockHeartbeatAgeMs(lockPath: string): Promise<number> {
  try {
    return Date.now() - (await stat(join(lockPath, OWNER_FILE_NAME))).mtimeMs
  } catch {
    return Date.now() - (await stat(lockPath)).mtimeMs
  }
}

function isSqliteBusyError(error: unknown): boolean {
  const record = error as { errcode?: unknown; message?: unknown }
  return record?.errcode === 5
    || (typeof record?.message === 'string' && /database is (?:busy|locked)/iu.test(record.message))
}

async function withStaleReclaimMutex<T>(lockPath: string, callback: () => Promise<T>): Promise<T> {
  const { DatabaseSync } = await import('node:sqlite')
  const database = new DatabaseSync(`${lockPath}.reclaim.sqlite`)
  database.exec('PRAGMA busy_timeout = 0;')
  const deadline = Date.now() + 2_000
  let acquired = false
  try {
    while (!acquired) {
      try {
        database.exec('BEGIN IMMEDIATE;')
        acquired = true
      } catch (error) {
        if (!isSqliteBusyError(error) || Date.now() >= deadline) throw error
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    }
    try {
      const result = await callback()
      database.exec('COMMIT;')
      acquired = false
      return result
    } catch (error) {
      database.exec('ROLLBACK;')
      acquired = false
      throw error
    }
  } finally {
    if (acquired) {
      try {
        database.exec('ROLLBACK;')
      } catch {
        // Closing the connection below also releases the transaction.
      }
    }
    database.close()
  }
}

export async function removeStaleLock(
  lockPath: string,
  staleMs: number,
  operations: { beforeReclaimClaim?: () => Promise<void> } = {},
): Promise<boolean> {
  const firstOwner = await readLockOwner(lockPath)
  if (await isLocalOwnerAlive(firstOwner) === true || await lockHeartbeatAgeMs(lockPath) <= staleMs) return false

  const confirmedOwner = await readLockOwner(lockPath)
  if ((firstOwner?.token ?? '') !== (confirmedOwner?.token ?? '')) return false
  if (await isLocalOwnerAlive(confirmedOwner) === true || await lockHeartbeatAgeMs(lockPath) <= staleMs) return false
  if (!confirmedOwner?.token) return false

  await operations.beforeReclaimClaim?.()
  return withStaleReclaimMutex(lockPath, async () => {
    const currentOwner = await readLockOwner(lockPath)
    if (currentOwner?.token !== confirmedOwner.token) return false
    if (await isLocalOwnerAlive(currentOwner) === true || await lockHeartbeatAgeMs(lockPath) <= staleMs) return false
    const quarantinePath = `${lockPath}.stale-${confirmedOwner.token}-${randomUUID()}`
    try {
      await rename(lockPath, quarantinePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
      return false
    }
    await rm(quarantinePath, { recursive: true, force: true }).catch(() => undefined)
    return true
  })
}

async function releaseOwnedLock(lockPath: string, token: string): Promise<void> {
  if ((await readLockOwner(lockPath))?.token !== token) return
  const releasePath = `${lockPath}.release-${token}`
  try {
    await rename(lockPath, releasePath)
  } catch {
    return
  }
  await rm(releasePath, { recursive: true, force: true }).catch(() => undefined)
}

export async function withCrossProcessDirectoryLock<T>(
  root: string,
  lockName: string,
  options: CrossProcessDirectoryLockOptions,
  callback: () => Promise<T>,
): Promise<T> {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const lockPath = join(root, lockName)
  const deadline = Date.now() + options.timeoutMs
  const retryMs = Math.max(1, options.retryMs ?? 10)
  const token = randomUUID()
  const candidatePath = `${lockPath}.candidate-${token}`

  while (true) {
    try {
      const owner: LockOwner = {
        token,
        pid: process.pid,
        hostname: LOCAL_HOSTNAME,
        processStartIdentity: await (
          options.readCurrentProcessStartIdentity ?? readCurrentProcessStartIdentity
        )(),
        updatedAtMs: Date.now(),
      }
      await mkdir(candidatePath, { mode: 0o700 })
      await writeFile(join(candidatePath, OWNER_FILE_NAME), JSON.stringify(owner), { mode: 0o600 })
      await rename(candidatePath, lockPath)
      break
    } catch (error) {
      await rm(candidatePath, { recursive: true, force: true }).catch(() => undefined)
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY' && code !== 'EPERM') throw error
      try {
        if (await removeStaleLock(lockPath, options.staleMs)) continue
      } catch (lockError) {
        if ((lockError as NodeJS.ErrnoException).code === 'ENOENT') continue
      }
      if (Date.now() >= deadline) throw new Error(`Timed out acquiring ${lockName}.`)
      await new Promise((resolve) => setTimeout(resolve, retryMs))
    }
  }

  const heartbeatMs = Math.max(10, Math.floor(options.staleMs / 3))
  let heartbeat = Promise.resolve()
  const heartbeatTimer = setInterval(() => {
    heartbeat = heartbeat.then(async () => {
      const owner = await readLockOwner(lockPath)
      if (owner?.token !== token) return
      await replaceFileDurably(join(lockPath, OWNER_FILE_NAME), JSON.stringify({
        ...owner,
        updatedAtMs: Date.now(),
      }))
    }).catch(() => undefined)
  }, heartbeatMs)
  heartbeatTimer.unref?.()

  try {
    return await callback()
  } finally {
    clearInterval(heartbeatTimer)
    await heartbeat
    await releaseOwnedLock(lockPath, token)
  }
}
