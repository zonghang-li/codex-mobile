import type { UiMessage } from '../types/codex'

export type ExternalReasoningSnapshot = {
  turnId: string
  label: string
  hiddenMessageIds: string[]
}

export function mergeExternalReasoningSnapshots(
  previous: ExternalReasoningSnapshot | undefined,
  incoming: ExternalReasoningSnapshot,
): ExternalReasoningSnapshot {
  if (!previous || previous.turnId !== incoming.turnId) return incoming
  return {
    ...incoming,
    label: incoming.label || previous.label,
    hiddenMessageIds: [...new Set([
      ...previous.hiddenMessageIds,
      ...incoming.hiddenMessageIds,
    ])],
  }
}

function normalizeSummaryParagraph(value: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim()
  if (normalized.length > 4 && normalized.startsWith('**') && normalized.endsWith('**')) {
    return normalized.slice(2, -2).trim()
  }
  return normalized
}

export function readExternalReasoningSnapshot(
  messages: readonly UiMessage[],
  activeTurnId: string,
): ExternalReasoningSnapshot {
  if (!activeTurnId) return { turnId: '', label: '', hiddenMessageIds: [] }
  const rows = messages.filter((message) => (
    message.messageType === 'reasoning'
    && message.turnId === activeTurnId
    && message.text.trim().length > 0
  ))
  const latest = rows.at(-1)
  const paragraphs = latest?.text
    .split(/\n\s*\n/gu)
    .map(normalizeSummaryParagraph)
    .filter(Boolean) ?? []
  return {
    turnId: activeTurnId,
    label: paragraphs.at(-1) ?? '',
    hiddenMessageIds: rows.map((message) => message.id),
  }
}
