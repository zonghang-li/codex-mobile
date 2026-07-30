import type { UiMessage } from '../../types/codex'
import { normalizeCodexDelegationText } from '../../utils/codexDelegationText'

const CODEX_DELEGATION_OPEN_RE = /<codex_delegation\b[^>]*>/iu
const CODEX_DELEGATION_BLOCK_RE = /<codex_delegation\b[^>]*>[\s\S]*<\/codex_delegation>/iu
const CODEX_DELEGATION_INPUT_RE = /<input\b[^>]*>([\s\S]*?)<\/input>/iu
const USER_MESSAGE_COLLAPSE_LIMIT = 180

export type UserMessagePresentation = {
  text: string
  label: string | null
  isDelegation: boolean
  isCollapsible: boolean
  isCollapsed: boolean
}

function normalizeDelegationText(text: string): string {
  return text
    .replace(/\r\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

export function parseCodexDelegationInput(text: string): string | null {
  const normalizedText = normalizeCodexDelegationText(text)
  if (!CODEX_DELEGATION_OPEN_RE.test(normalizedText) && !CODEX_DELEGATION_BLOCK_RE.test(normalizedText)) return null
  const inputMatch = normalizedText.match(CODEX_DELEGATION_INPUT_RE)
  if (inputMatch?.[1]) return normalizeDelegationText(inputMatch[1])
  return normalizeDelegationText(
    normalizedText
      .replace(/<\/?codex_delegation\b[^>]*>/giu, '')
      .replace(/<source_thread_id\b[^>]*>[\s\S]*?<\/source_thread_id>/giu, '')
      .replace(/<\/?input\b[^>]*>/giu, ''),
  )
}

function collapseText(text: string): string {
  if (text.length <= USER_MESSAGE_COLLAPSE_LIMIT) return text
  return `${text.slice(0, USER_MESSAGE_COLLAPSE_LIMIT).trimEnd()}…`
}

export function deriveUserMessagePresentation(
  message: Pick<UiMessage, 'role' | 'text'>,
  options: { expanded: boolean },
): UserMessagePresentation {
  if (message.role !== 'user') {
    return {
      text: message.text,
      label: null,
      isDelegation: false,
      isCollapsible: false,
      isCollapsed: false,
    }
  }

  const delegationText = parseCodexDelegationInput(message.text)
  if (delegationText === null) {
    return {
      text: message.text,
      label: null,
      isDelegation: false,
      isCollapsible: false,
      isCollapsed: false,
    }
  }

  const isCollapsible = delegationText.length > USER_MESSAGE_COLLAPSE_LIMIT
  const isCollapsed = isCollapsible && !options.expanded
  return {
    text: isCollapsed ? collapseText(delegationText) : delegationText,
    label: 'Sent by Codex from another chat',
    isDelegation: true,
    isCollapsible,
    isCollapsed,
  }
}
