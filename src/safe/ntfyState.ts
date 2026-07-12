import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

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

export class FileNtfyStateStore {
  constructor(
    private readonly path: string,
    private readonly warn: WarningCallback = (message) => console.warn(message),
  ) {}

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
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    await writeFile(this.path, `${JSON.stringify(boundNtfyState(validated), null, 2)}\n`, { mode: 0o600 })
    await chmod(this.path, 0o600)
  }
}
