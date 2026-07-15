import {
  classifyNtfyThreadScope,
  type NtfyThreadScope,
} from './ntfyThreadScope'

export type ParsedRolloutRecord =
  | { kind: 'session'; threadId: string; notificationScope: NtfyThreadScope }
  | { kind: 'started'; turnId: string; occurredAt: number }
  | {
      kind: 'terminal'
      turnId: string
      status: 'completed' | 'interrupted'
      occurredAt: number
      durationMs: number | null
    }

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function readTimestamp(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0) continue
    const timestamp = Date.parse(value)
    if (Number.isFinite(timestamp)) return timestamp
  }
  return null
}

function readDuration(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null
}

export function parseRolloutRecord(line: string): ParsedRolloutRecord | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }

  const root = asRecord(value)
  const payload = asRecord(root?.payload)
  if (!root || !payload) return null

  if (root.type === 'session_meta') {
    const threadId = readString(payload.id)
    return threadId
      ? {
          kind: 'session',
          threadId,
          notificationScope: classifyNtfyThreadScope(payload),
        }
      : null
  }
  if (root.type !== 'event_msg') return null

  const turnId = readString(payload.turn_id)
  if (!turnId) return null

  if (payload.type === 'task_started') {
    const occurredAt = readTimestamp(root.timestamp)
    return occurredAt === null ? null : { kind: 'started', turnId, occurredAt }
  }

  if (payload.type !== 'task_complete' && payload.type !== 'turn_aborted') return null
  const occurredAt = readTimestamp(payload.completed_at, root.timestamp)
  if (occurredAt === null) return null

  return {
    kind: 'terminal',
    turnId,
    status: payload.type === 'task_complete' ? 'completed' : 'interrupted',
    occurredAt,
    durationMs: readDuration(payload.duration_ms),
  }
}
