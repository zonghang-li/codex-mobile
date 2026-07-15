export type NtfyThreadScope = 'topLevel' | 'child' | 'unknown'

const TOP_LEVEL_SOURCES = new Set(['cli', 'vscode', 'exec', 'appServer'])

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function parentEvidence(value: Record<string, unknown>): 'none' | 'child' | 'invalid' {
  for (const key of ['parentThreadId', 'parent_thread_id'] as const) {
    if (!hasOwn(value, key)) continue
    const candidate = value[key]
    if (candidate === null || candidate === undefined || candidate === '') continue
    if (typeof candidate === 'string') return 'child'
    return 'invalid'
  }
  return 'none'
}

export function classifyNtfyThreadScope(value: unknown): NtfyThreadScope {
  const record = asRecord(value)
  if (!record) return 'unknown'

  const source = record.source
  const sourceRecord = asRecord(source)
  if (sourceRecord && (hasOwn(sourceRecord, 'subagent') || hasOwn(sourceRecord, 'subAgent'))) {
    return 'child'
  }

  const parent = parentEvidence(record)
  if (parent === 'child') return 'child'
  if (parent === 'invalid') return 'unknown'

  return typeof source === 'string' && TOP_LEVEL_SOURCES.has(source)
    ? 'topLevel'
    : 'unknown'
}
