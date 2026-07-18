export const NTFY_RESULT_TITLES = [
  'Codex 任务完成',
  'Codex 任务失败',
  'Codex 任务已中断',
] as const

export type NtfyResultTitle = typeof NTFY_RESULT_TITLES[number]

export const NTFY_THREAD_LABEL_MAX_LENGTH = 80

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu

function truncateCodePoints(value: string, maximum: number): string {
  return Array.from(value).slice(0, maximum).join('')
}

export function normalizeNtfyThreadLabelCandidate(value: unknown): string {
  if (typeof value !== 'string') return ''
  return truncateCodePoints(
    value.replace(CONTROL_CHARACTERS, ' ').replace(/\s+/gu, ' ').trim(),
    NTFY_THREAD_LABEL_MAX_LENGTH,
  )
}

export function resolveNtfyThreadLabel(
  candidates: readonly unknown[],
  threadId: string,
): string {
  for (const candidate of candidates) {
    const normalized = normalizeNtfyThreadLabelCandidate(candidate)
    if (normalized) return normalized
  }
  const suffix = Array.from(threadId.trim()).slice(-8).join('')
  return `未命名会话（${suffix}）`
}

export function composeNtfyNotificationTitle(
  resultTitle: NtfyResultTitle,
  label: string,
): string {
  return `${resultTitle}：${label}`
}

export function isValidNtfyNotificationTitle(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if ((NTFY_RESULT_TITLES as readonly string[]).includes(value)) return true
  for (const resultTitle of NTFY_RESULT_TITLES) {
    const prefix = `${resultTitle}：`
    if (!value.startsWith(prefix)) continue
    const label = value.slice(prefix.length)
    return label.length > 0 && normalizeNtfyThreadLabelCandidate(label) === label
  }
  return false
}
