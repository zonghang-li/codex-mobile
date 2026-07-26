import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export type ThreadLiveAuthority = 'writer-snapshot' | 'local-stream' | 'persisted' | 'missing'
export type ThreadLiveSource = 'desktop-writer' | 'mobile-writer'
export type ThreadLiveState = 'running' | 'idle' | 'completed' | 'failed' | 'interrupted'
export type ThreadLiveIndicator = 'none' | 'running' | 'completed' | 'attention'

export type ThreadLiveFooter = {
  stepCurrent: number | null
  stepTotal: number | null
  completedPercent: number | null
  fileCount: number | null
  additions: number | null
  deletions: number | null
  label: string
}

export type ThreadLiveSnapshot = {
  schemaVersion: 1
  threadId: string
  activeTurnId: string | null
  revision: number
  generatedAt: string
  expiresAt: string
  source: ThreadLiveSource
  state: ThreadLiveState
  footer: ThreadLiveFooter | null
  timeline: unknown[]
  pendingRequest: unknown | null
  sidebar: { indicator: ThreadLiveIndicator }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function readNullableNumber(value: unknown): number | null | undefined {
  if (value === null) return null
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readFooter(value: unknown): ThreadLiveFooter | null | undefined {
  if (value === null) return null
  const record = asRecord(value)
  if (!record) return undefined

  const stepCurrent = readNullableNumber(record.stepCurrent)
  const stepTotal = readNullableNumber(record.stepTotal)
  const completedPercent = readNullableNumber(record.completedPercent)
  const fileCount = readNullableNumber(record.fileCount)
  const additions = readNullableNumber(record.additions)
  const deletions = readNullableNumber(record.deletions)
  const label = readString(record.label)

  if (
    stepCurrent === undefined ||
    stepTotal === undefined ||
    completedPercent === undefined ||
    fileCount === undefined ||
    additions === undefined ||
    deletions === undefined ||
    label === null
  ) {
    return undefined
  }

  return { stepCurrent, stepTotal, completedPercent, fileCount, additions, deletions, label }
}

export function parseThreadLiveSnapshot(
  value: unknown,
  options: { threadId: string; activeTurnId: string; nowMs: number; minRevision?: number },
): ThreadLiveSnapshot | null {
  const record = asRecord(value)
  if (!record || record.schemaVersion !== 1) return null

  const threadId = readString(record.threadId)
  if (threadId !== options.threadId) return null

  const activeTurnId = record.activeTurnId === null ? null : readString(record.activeTurnId)
  if (activeTurnId !== options.activeTurnId) return null

  const revision = typeof record.revision === 'number' && Number.isSafeInteger(record.revision)
    ? record.revision
    : null
  if (revision === null || revision < (options.minRevision ?? 0)) return null

  const generatedAt = readString(record.generatedAt)
  const expiresAt = readString(record.expiresAt)
  if (!generatedAt || !expiresAt) return null

  const expiresAtMs = Date.parse(expiresAt)
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= options.nowMs) return null

  const source = record.source === 'desktop-writer' || record.source === 'mobile-writer'
    ? record.source
    : null
  const state = record.state === 'running' ||
    record.state === 'idle' ||
    record.state === 'completed' ||
    record.state === 'failed' ||
    record.state === 'interrupted'
      ? record.state
      : null
  if (!source || !state) return null

  const footer = readFooter(record.footer)
  if (footer === undefined) return null

  const sidebarRecord = asRecord(record.sidebar)
  const indicator = sidebarRecord?.indicator === 'none' ||
    sidebarRecord?.indicator === 'running' ||
    sidebarRecord?.indicator === 'completed' ||
    sidebarRecord?.indicator === 'attention'
      ? sidebarRecord.indicator
      : null
  if (!indicator) return null

  return {
    schemaVersion: 1,
    threadId,
    activeTurnId,
    revision,
    generatedAt,
    expiresAt,
    source,
    state,
    footer,
    timeline: Array.isArray(record.timeline) ? record.timeline : [],
    pendingRequest: record.pendingRequest ?? null,
    sidebar: { indicator },
  }
}

export async function readThreadLiveSnapshotFile(
  liveStateDir: string,
  threadId: string,
  options: { activeTurnId: string; nowMs: number; minRevision?: number },
): Promise<ThreadLiveSnapshot | null> {
  try {
    const raw = await readFile(join(liveStateDir, `${threadId}.json`), 'utf8')
    return parseThreadLiveSnapshot(JSON.parse(raw), {
      threadId,
      activeTurnId: options.activeTurnId,
      nowMs: options.nowMs,
      minRevision: options.minRevision,
    })
  } catch {
    return null
  }
}
