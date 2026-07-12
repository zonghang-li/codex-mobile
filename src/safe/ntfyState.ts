import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, rm, type FileHandle } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join, parse, resolve, sep } from 'node:path'

export type ActiveTurnRecord = { key: string; threadId: string; turnId: string; startedAt: number }
export type PendingNtfyRecord = {
  key: string
  title: 'Codex 任务完成' | 'Codex 任务失败' | 'Codex 任务已中断'
  message: string
  createdAt: number
}
export type SentTurnRecord = { key: string; sentAt: number }
export type NtfyNotifierState = {
  active: ActiveTurnRecord[]
  pending: PendingNtfyRecord[]
  sent: SentTurnRecord[]
}

type WarningCallback = (message: string) => void

type NtfyStateStoreOperations = {
  afterDirectoryOpen: () => Promise<void>
  rename: (source: string, destination: string) => Promise<void>
  write: (handle: FileHandle, contents: string) => Promise<void>
}

type DirectoryIdentity = {
  path: string
  dev: number
  ino: number
}

class UnsafeStatePathError extends Error {}

const TITLES = new Set<PendingNtfyRecord['title']>([
  'Codex 任务完成',
  'Codex 任务失败',
  'Codex 任务已中断',
])

export function createEmptyNtfyState(): NtfyNotifierState {
  return { active: [], pending: [], sent: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length
    && expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isActiveTurnRecord(value: unknown): value is ActiveTurnRecord {
  return isRecord(value)
    && hasExactKeys(value, ['key', 'threadId', 'turnId', 'startedAt'])
    && isNonEmptyString(value.key)
    && isNonEmptyString(value.threadId)
    && isNonEmptyString(value.turnId)
    && isTimestamp(value.startedAt)
}

function isPendingNtfyRecord(value: unknown): value is PendingNtfyRecord {
  return isRecord(value)
    && hasExactKeys(value, ['key', 'title', 'message', 'createdAt'])
    && isNonEmptyString(value.key)
    && typeof value.title === 'string'
    && TITLES.has(value.title as PendingNtfyRecord['title'])
    && typeof value.message === 'string'
    && isTimestamp(value.createdAt)
}

function isSentTurnRecord(value: unknown): value is SentTurnRecord {
  return isRecord(value)
    && hasExactKeys(value, ['key', 'sentAt'])
    && isNonEmptyString(value.key)
    && isTimestamp(value.sentAt)
}

function parseNtfyState(value: unknown): NtfyNotifierState | null {
  if (!isRecord(value) || !hasExactKeys(value, ['active', 'pending', 'sent'])) return null
  if (!Array.isArray(value.active) || !value.active.every(isActiveTurnRecord)) return null
  if (!Array.isArray(value.pending) || !value.pending.every(isPendingNtfyRecord)) return null
  if (!Array.isArray(value.sent) || !value.sent.every(isSentTurnRecord)) return null
  return { active: value.active, pending: value.pending, sent: value.sent }
}

function newestOldestFirst<T>(records: readonly T[], limit: number, time: (record: T) => number): T[] {
  const sorted = [...records].sort((left, right) => time(left) - time(right))
  return sorted.slice(Math.max(0, sorted.length - limit))
}

export function boundNtfyState(state: NtfyNotifierState, limit = 256): NtfyNotifierState {
  const boundedLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 256
  return {
    active: newestOldestFirst(state.active, boundedLimit, (record) => record.startedAt),
    pending: newestOldestFirst(state.pending, boundedLimit, (record) => record.createdAt),
    sent: newestOldestFirst(state.sent, boundedLimit, (record) => record.sentAt),
  }
}

async function assertSafeStatePath(path: string): Promise<void> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw new Error('Unable to inspect ntfy notifier state path')
  })
  if (!info) return
  if (info.isSymbolicLink()) throw new UnsafeStatePathError('ntfy notifier state path must not be a symlink')
  if (!info.isFile()) throw new UnsafeStatePathError('ntfy notifier state path must be a regular file')
}

function directoryChain(path: string): string[] {
  const absolute = resolve(path)
  const root = parse(absolute).root
  const components = absolute.slice(root.length).split(sep).filter(Boolean)
  const paths = [root]
  for (const component of components) paths.push(join(paths[paths.length - 1], component))
  return paths
}

async function inspectDirectoryChain(path: string, createMissing: boolean): Promise<DirectoryIdentity[]> {
  const identities: DirectoryIdentity[] = []
  for (const componentPath of directoryChain(path)) {
    let info = await lstat(componentPath).catch((error: NodeJS.ErrnoException) => {
      if (createMissing && error.code === 'ENOENT') return null
      throw error
    })
    if (!info) {
      await mkdir(componentPath, { mode: 0o700 })
      info = await lstat(componentPath)
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('unsafe directory chain')
    identities.push({ path: componentPath, dev: info.dev, ino: info.ino })
  }
  return identities
}

function matchesDirectoryChain(expected: DirectoryIdentity[], actual: DirectoryIdentity[]): boolean {
  return expected.length === actual.length && expected.every((identity, index) => {
    const candidate = actual[index]
    return candidate?.path === identity.path && candidate.dev === identity.dev && candidate.ino === identity.ino
  })
}

async function assertDirectoryChainUnchanged(expected: DirectoryIdentity[]): Promise<void> {
  try {
    const actual = await inspectDirectoryChain(expected[expected.length - 1].path, false)
    if (!matchesDirectoryChain(expected, actual)) throw new Error('directory chain changed')
  } catch {
    throw new Error('Unable to save ntfy notifier state')
  }
}

async function openVerifiedDirectory(path: string): Promise<{
  handle: FileHandle
  identities: DirectoryIdentity[]
}> {
  let handle: FileHandle | null = null
  try {
    const identities = await inspectDirectoryChain(path, true)
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    const opened = await handle.stat()
    const expected = identities[identities.length - 1]
    if (opened.dev !== expected.dev || opened.ino !== expected.ino || !opened.isDirectory()) {
      throw new Error('directory changed while opening')
    }
    await assertDirectoryChainUnchanged(identities)
    await handle.chmod(0o700)
    if (((await handle.stat()).mode & 0o777) !== 0o700) throw new Error('directory permissions are unsafe')
    return { handle, identities }
  } catch {
    await handle?.close().catch(() => undefined)
    throw new Error('Unable to prepare private ntfy notifier state directory')
  }
}

export class FileNtfyStateStore {
  private readonly operations: NtfyStateStoreOperations

  constructor(
    private readonly path: string,
    private readonly warn: WarningCallback = (message) => console.warn(message),
    operations: Partial<NtfyStateStoreOperations> = {},
  ) {
    this.operations = {
      afterDirectoryOpen: operations.afterDirectoryOpen ?? (async () => undefined),
      rename: operations.rename ?? rename,
      write: operations.write ?? ((handle, contents) => handle.writeFile(contents, 'utf8')),
    }
  }

  async load(): Promise<NtfyNotifierState> {
    let handle: FileHandle | null = null
    try {
      handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW)
      const info = await handle.stat()
      if (!info.isFile()) throw new Error('unsafe state file type')
      const uid = process.getuid?.()
      if (uid !== undefined && info.uid !== uid) throw new Error('unsafe state file owner')
      if ((info.mode & 0o077) !== 0) throw new Error('unsafe state file permissions')
      const parsed = parseNtfyState(JSON.parse(await handle.readFile('utf8')))
      if (!parsed) throw new Error('invalid state shape')
      return boundNtfyState(parsed)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return createEmptyNtfyState()
      this.warn('Unable to load ntfy notifier state; starting with empty state')
      return createEmptyNtfyState()
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  async save(state: NtfyNotifierState): Promise<void> {
    const validated = parseNtfyState(state)
    if (!validated) throw new Error('Unable to save invalid ntfy notifier state')
    const statePath = resolve(this.path)
    const directory = dirname(statePath)
    const verifiedDirectory = await openVerifiedDirectory(directory)
    const anchoredDirectory = `/proc/self/fd/${verifiedDirectory.handle.fd}`
    const destinationPath = join(anchoredDirectory, basename(statePath))
    const temporaryPath = join(
      anchoredDirectory,
      `.${basename(statePath)}.${process.pid}.${randomUUID()}.tmp`,
    )
    let temporaryHandle: FileHandle | null = null
    try {
      await this.operations.afterDirectoryOpen()
      await assertDirectoryChainUnchanged(verifiedDirectory.identities)
      await assertSafeStatePath(destinationPath)
      temporaryHandle = await open(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      )
      await temporaryHandle.chmod(0o600)
      await this.operations.write(temporaryHandle, `${JSON.stringify(boundNtfyState(validated), null, 2)}\n`)
      await temporaryHandle.sync()
      await temporaryHandle.close()
      temporaryHandle = null
      await assertDirectoryChainUnchanged(verifiedDirectory.identities)
      await assertSafeStatePath(destinationPath)
      await this.operations.rename(temporaryPath, destinationPath)
      await assertDirectoryChainUnchanged(verifiedDirectory.identities)
    } catch (error) {
      await temporaryHandle?.close().catch(() => undefined)
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      if (error instanceof UnsafeStatePathError) throw error
      throw new Error('Unable to save ntfy notifier state')
    } finally {
      await verifiedDirectory.handle.close().catch(() => undefined)
    }
  }
}
