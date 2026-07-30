import type { UiMessage } from '../types/codex'
import { normalizeCodexDelegationText } from '../utils/codexDelegationText'

const HYDRATED_TEXT_TYPES = new Set([
  'userMessage',
  'agentMessage',
  'reasoning',
  'contextCompaction',
])

const TITLE_ONLY_REASONING_PREFIXES = [
  'Adding',
  'Allowing',
  'Analyzing',
  'Assessing',
  'Asserting',
  'Checking',
  'Choosing',
  'Clarifying',
  'Confirming',
  'Defining',
  'Designing',
  'Diagnosing',
  'Evaluating',
  'Examining',
  'Identifying',
  'Implementing',
  'Inspecting',
  'Investigating',
  'Linking',
  'Locating',
  'Parsing',
  'Planning',
  'Preventing',
  'Preparing',
  'Proposing',
  'Reading',
  'Refining',
  'Reviewing',
  'Testing',
  'Tracing',
  'Updating',
  'Validating',
  'Verifying',
  'Weighing',
] as const

const TITLE_ONLY_REASONING_EXACT_TEXTS = new Set([
  'Existing tests',
])

const CODEX_DELEGATION_OPEN_RE = /<codex_delegation\b[^>]*>/iu

function hasSessionOrder(message: UiMessage): message is UiMessage & { sessionOrder: number } {
  return typeof message.sessionOrder === 'number'
    && Number.isFinite(message.sessionOrder)
    && message.sessionOrder >= 0
}

function isHydratedTextMessage(message: UiMessage): boolean {
  return HYDRATED_TEXT_TYPES.has(message.messageType ?? '')
}

function isReasoningMessage(message: UiMessage): boolean {
  return message.messageType === 'reasoning'
}

function isRolloutReasoningMessage(message: UiMessage): boolean {
  return isReasoningMessage(message) && message.id.startsWith('rollout:reasoning:')
}

function normalizePotentialReasoningStatusTitle(text: string): string {
  return text
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^#{1,6}\s+/u, '')
    .replace(/^\*\*([\s\S]+)\*\*$/u, '$1')
    .replace(/^__([\s\S]+)__$/u, '$1')
    .trim()
}

function hasReasoningSentencePunctuation(text: string): boolean {
  const withoutScopeSeparators = text.replace(/::/gu, '')
  const withoutTerminalEllipsis = withoutScopeSeparators.replace(/\s*(?:\.{3,}|…)\s*$/u, '')
  return /[。！？!?:；;，,]/u.test(withoutTerminalEllipsis) || /\.$/u.test(withoutTerminalEllipsis)
}

export function isTitleOnlyReasoningStatusText(value: string): boolean {
  const text = normalizePotentialReasoningStatusTitle(value)
  if (!text || text.length > 128) return false
  if (/[\p{Script=Han}]/u.test(text)) return false
  if (TITLE_ONLY_REASONING_EXACT_TEXTS.has(text)) return true
  if (
    !hasReasoningSentencePunctuation(text)
    && TITLE_ONLY_REASONING_PREFIXES.some((prefix) => text === prefix || text.startsWith(`${prefix} `))
  ) {
    return true
  }
  if (hasReasoningSentencePunctuation(text)) return false
  if (/^(?:I|I'm|I'll|I’ll|We|The|This|That|It|They|There)\b/u.test(text)) {
    return false
  }
  return /^[A-Z][\p{L}\p{N}_./'()+-]*(?:\s+[\p{L}\p{N}_./'()+-]+){1,14}$/u.test(text)
    && /\b[\p{L}\p{N}_./'()+-]*ing\b/u.test(text)
}

export function filterTitleOnlyReasoningText(value: string): string {
  return value
    .split(/\n{2,}/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !isTitleOnlyReasoningStatusText(part))
    .join('\n\n')
    .trim()
}

function isTitleOnlyReasoningMessage(message: UiMessage): boolean {
  return isReasoningMessage(message) && isTitleOnlyReasoningStatusText(message.text)
}

function isMergeableHydratedTextMessage(message: UiMessage): boolean {
  return isHydratedTextMessage(message) && !isTitleOnlyReasoningMessage(message)
}

function normalizedTextContent(message: UiMessage): string {
  return normalizeCodexDelegationText(message.text).replace(/\s+/gu, ' ').trim()
}

function hydratedTextContentKey(message: UiMessage): string | null {
  const text = normalizedTextContent(message)
  if (!text) return null
  return [
    message.turnId ?? '',
    message.role,
    message.messageType ?? '',
    text,
  ].join('\u0000')
}

function isEventUserMessage(message: UiMessage): boolean {
  return message.messageType === 'userMessage'
    && message.id.startsWith('rollout:userMessage:event:')
}

function isLateDelegatedUserMessage(message: UiMessage): boolean {
  return message.messageType === 'userMessage'
    && isEventUserMessage(message)
    && CODEX_DELEGATION_OPEN_RE.test(normalizeCodexDelegationText(message.text))
}

function likelyDuplicateUserInputs(left: UiMessage, right: UiMessage): boolean {
  if (left.messageType !== 'userMessage' || right.messageType !== 'userMessage') return false
  const leftEvent = isEventUserMessage(left)
  const rightEvent = isEventUserMessage(right)
  if (leftEvent === rightEvent) return false
  const leftText = normalizedTextContent(left)
  if (!leftText || leftText !== normalizedTextContent(right)) return false
  if (!hasSessionOrder(left) || !hasSessionOrder(right)) return true
  const maxDistance = Math.max(4 * 1024, (leftText.length * 4) + 2048)
  return Math.abs(left.sessionOrder - right.sessionOrder) <= maxDistance
}

function deduplicateEventUserMessages(
  entries: Array<{ message: UiMessage; insertionIndex: number }>,
): Array<{ message: UiMessage; insertionIndex: number }> {
  const deduped: Array<{ message: UiMessage; insertionIndex: number }> = []
  for (const entry of entries) {
    if (entry.message.messageType !== 'userMessage') {
      deduped.push(entry)
      continue
    }

    let duplicateIndex = -1
    for (let index = deduped.length - 1; index >= 0; index -= 1) {
      const existing = deduped[index]!
      if (existing.message.messageType !== 'userMessage') break
      if (likelyDuplicateUserInputs(existing.message, entry.message)) {
        duplicateIndex = index
        break
      }
    }

    if (duplicateIndex < 0) {
      deduped.push(entry)
      continue
    }

    if (isEventUserMessage(deduped[duplicateIndex]!.message) && !isEventUserMessage(entry.message)) {
      deduped[duplicateIndex] = entry
    }
  }
  return deduped
}

function isContextCompactionMessage(message: UiMessage): boolean {
  return message.messageType === 'contextCompaction'
}

function isCompletedContextCompactionMessage(message: UiMessage): boolean {
  return isContextCompactionMessage(message)
    && normalizedTextContent(message) === 'Context automatically compacted'
}

function shouldReplaceContextCompaction(previous: UiMessage, next: UiMessage): boolean {
  const previousCompleted = isCompletedContextCompactionMessage(previous)
  const nextCompleted = isCompletedContextCompactionMessage(next)
  if (previousCompleted && !nextCompleted) return false
  if (nextCompleted && !previousCompleted) return true
  return hasSessionOrder(next) || !hasSessionOrder(previous)
}

function collapseContextCompactionUpdates(messages: UiMessage[]): UiMessage[] {
  const collapsed: UiMessage[] = []
  const byTurn = new Map<string, number>()
  for (const message of messages) {
    if (!isContextCompactionMessage(message)) {
      collapsed.push(message)
      continue
    }

    const key = message.turnId ?? ''
    const existingIndex = byTurn.get(key)
    if (existingIndex === undefined) {
      byTurn.set(key, collapsed.length)
      collapsed.push(message)
      continue
    }

    const previous = collapsed[existingIndex]!
    if (shouldReplaceContextCompaction(previous, message)) {
      collapsed[existingIndex] = message
    }
  }
  return collapsed
}

export function reorderLateDelegatedUserMessagesForDisplay(messages: UiMessage[]): UiMessage[] {
  const ordered: UiMessage[] = []
  let pairedResponseBoundary = 0
  for (const message of messages) {
    if (!isLateDelegatedUserMessage(message)) {
      ordered.push(message)
      continue
    }

    const previousLength = ordered.length
    let insertionIndex = ordered.length
    while (insertionIndex > pairedResponseBoundary) {
      const previous = ordered[insertionIndex - 1]!
      if (previous.turnId !== message.turnId) break
      if (previous.messageType === 'userMessage' || previous.messageType === 'contextCompaction') break
      insertionIndex -= 1
    }
    ordered.splice(insertionIndex, 0, message)
    if (insertionIndex < previousLength) {
      pairedResponseBoundary = previousLength + 1
    }
  }
  return ordered
}

function reasoningSegments(message: UiMessage): string[] {
  return message.text
    .split(/\n{2,}/u)
    .map((part) => part
      .replace(/\*\*([^*]+)\*\*/gu, '$1')
      .replace(/__([^_]+)__/gu, '$1')
      .replace(/\s+/gu, ' ')
      .trim())
    .filter(Boolean)
}

function collapseConsecutiveReasoningUpdates(messages: UiMessage[]): UiMessage[] {
  const collapsed: UiMessage[] = []
  for (const message of messages) {
    if (!isReasoningMessage(message)) {
      collapsed.push(message)
      continue
    }

    const currentSegments = reasoningSegments(message)
    while (collapsed.length > 0) {
      const previous = collapsed.at(-1)
      if (!previous || !isReasoningMessage(previous)) break
      const previousSegments = reasoningSegments(previous)
      if (
        previousSegments.length === 0
        || !previousSegments.every((segment) => currentSegments.includes(segment))
      ) {
        break
      }
      collapsed.pop()
    }

    collapsed.push(message)
  }
  return collapsed
}

export function mergeThreadTextPage(
  existing: UiMessage[],
  incoming: UiMessage[],
): UiMessage[] {
  const byId = new Map<string, { message: UiMessage; insertionIndex: number }>()
  let insertionIndex = 0

  for (const message of [...existing, ...incoming]) {
    const current = byId.get(message.id)
    if (!current) {
      byId.set(message.id, { message, insertionIndex })
      insertionIndex += 1
      continue
    }

    if (hasSessionOrder(message) || !hasSessionOrder(current.message)) {
      current.message = message
    }
  }

  const sorted = Array.from(byId.values())
    .sort((left, right) => {
      const leftOrdered = hasSessionOrder(left.message)
      const rightOrdered = hasSessionOrder(right.message)
      if (hasSessionOrder(left.message) && hasSessionOrder(right.message)) {
        return left.message.sessionOrder - right.message.sessionOrder
          || left.insertionIndex - right.insertionIndex
      }
      if (leftOrdered) return -1
      if (rightOrdered) return 1
      return left.insertionIndex - right.insertionIndex
    })
  return collapseConsecutiveReasoningUpdates(reorderLateDelegatedUserMessagesForDisplay(
    collapseContextCompactionUpdates(deduplicateEventUserMessages(sorted).map(({ message }) => message)),
  ))
}

function activeTurnMessageSortKey(
  message: UiMessage,
  fallbackOrder: number,
  defaultGroup: number,
): [number, number, number] {
  if (message.role === 'user' && !hasSessionOrder(message)) return [0, 0, fallbackOrder]
  if (defaultGroup === 1) return [defaultGroup, fallbackOrder, fallbackOrder]
  if (hasSessionOrder(message)) return [defaultGroup, message.sessionOrder, fallbackOrder]
  return [defaultGroup, 0, fallbackOrder]
}

export function mergeHydratedTurnTextIntoTranscript(
  transcript: UiMessage[],
  hydrated: UiMessage[],
  turnId: string,
): UiMessage[] {
  const orderedHydrated = mergeThreadTextPage(
    [],
    hydrated.filter((message) => message.turnId === turnId && isMergeableHydratedTextMessage(message)),
  )
  const hydratedIds = new Set(orderedHydrated.map((message) => message.id))
  const hydratedContentKeys = new Set(
    orderedHydrated
      .map((message) => hydratedTextContentKey(message))
      .filter((key): key is string => key !== null),
  )
  const liveOnly = mergeThreadTextPage(
    [],
    transcript.filter((message) => (
      message.turnId === turnId
      && isMergeableHydratedTextMessage(message)
      && (!isRolloutReasoningMessage(message) || hasSessionOrder(message))
      && !hydratedIds.has(message.id)
      && !hydratedContentKeys.has(hydratedTextContentKey(message) ?? '')
    )),
  )
  const textReplacement = mergeThreadTextPage(orderedHydrated, liveOnly)
  const firstTurnIndex = transcript.findIndex((message) => message.turnId === turnId)

  if (firstTurnIndex < 0) {
    return textReplacement.length > 0 ? [...transcript, ...textReplacement] : transcript
  }

  const activeTurnMessages = collapseConsecutiveReasoningUpdates([
    ...transcript
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => message.turnId === turnId && !isHydratedTextMessage(message))
      .map(({ message, index }) => ({ message, index, group: 2 })),
    ...textReplacement.map((message, index) => ({
      message,
      index,
      group: 1,
    })),
  ]
    .sort((left, right) => {
      const [leftGroup, leftOrder, leftIndex] = activeTurnMessageSortKey(left.message, left.index, left.group)
      const [rightGroup, rightOrder, rightIndex] = activeTurnMessageSortKey(right.message, right.index, right.group)
      return leftGroup - rightGroup
        || leftOrder - rightOrder
        || leftIndex - rightIndex
    })
    .map(({ message }) => message))

  const retained = transcript.filter((message) => message.turnId !== turnId)
  const insertionPoint = transcript
    .slice(0, firstTurnIndex)
    .filter((message) => message.turnId !== turnId)
    .length

  return [
    ...retained.slice(0, insertionPoint),
    ...activeTurnMessages,
    ...retained.slice(insertionPoint),
  ]
}

export function finalizeHydratedTurnText(
  messages: UiMessage[],
  turnId?: string,
): UiMessage[] {
  return messages.filter((message) => (
    message.messageType !== 'reasoning'
    || (turnId !== undefined && message.turnId !== turnId)
  ))
}
