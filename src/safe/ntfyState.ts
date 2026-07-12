import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, rename, rm, type FileHandle } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

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
  rename: (source: string, destination: string) => Promise<void>
  write: (handle: FileHandle, contents: string) => Promise<void>
}

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
  if (info.isSymbolicLink()) throw new Error('ntfy notifier state path must not be a symlink')
  if (!info.isFile()) throw new Error('ntfy notifier state path must be a regular file')
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 })
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('unsafe directory')
    }
    await chmod(path, 0o700)
  } catch {
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
      rename: operations.rename ?? rename,
      write: operations.write ?? ((handle, contents) => handle.writeFile(contents, 'utf8')),
    }
  }

  async load(): Promise<NtfyNotifierState> {
    try {
      const parsed = parseNtfyState(JSON.parse(await readFile(this.path, 'utf8')))
      if (!parsed) throw new Error('invalid state shape')
      return boundNtfyState(parsed)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return createEmptyNtfyState()
      this.warn('Unable to load ntfy notifier state; starting with empty state')
      return createEmptyNtfyState()
    }
  }

  async save(state: NtfyNotifierState): Promise<void> {
    const validated = parseNtfyState(state)
    if (!validated) throw new Error('Unable to save invalid ntfy notifier state')
    await assertSafeStatePath(this.path)
    const directory = dirname(this.path)
    await ensurePrivateDirectory(directory)
    const temporaryPath = join(directory, `.${basename(this.path)}.${process.pid}.${randomUUID()}.tmp`)
    let handle: FileHandle | null = null
    try {
      handle = await open(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      )
      await handle.chmod(0o600)
      await this.operations.write(handle, `${JSON.stringify(boundNtfyState(validated), null, 2)}\n`)
      await handle.sync()
      await handle.close()
      handle = null
      await assertSafeStatePath(this.path)
      await this.operations.rename(temporaryPath, this.path)
      await chmod(this.path, 0o600)
    } catch {
      await handle?.close().catch(() => undefined)
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      throw new Error('Unable to save ntfy notifier state')
    }
  }
}
