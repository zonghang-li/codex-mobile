import type { UiMessage } from '../types/codex'

const HYDRATED_TEXT_TYPES = new Set([
  'agentMessage',
  'reasoning',
  'contextCompaction',
])

function hasSessionOrder(message: UiMessage): message is UiMessage & { sessionOrder: number } {
  return typeof message.sessionOrder === 'number'
    && Number.isFinite(message.sessionOrder)
    && message.sessionOrder >= 0
}

function isHydratedTextMessage(message: UiMessage): boolean {
  return HYDRATED_TEXT_TYPES.has(message.messageType ?? '')
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

  return Array.from(byId.values())
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
    .map(({ message }) => message)
}

export function mergeHydratedTurnTextIntoTranscript(
  transcript: UiMessage[],
  hydrated: UiMessage[],
  turnId: string,
): UiMessage[] {
  const orderedHydrated = mergeThreadTextPage(
    [],
    hydrated.filter((message) => message.turnId === turnId && isHydratedTextMessage(message)),
  )
  const hydratedIds = new Set(orderedHydrated.map((message) => message.id))
  const liveOnly = mergeThreadTextPage(
    [],
    transcript.filter((message) => (
      message.turnId === turnId
      && isHydratedTextMessage(message)
      && !hydratedIds.has(message.id)
    )),
  )
  const replacement = [...orderedHydrated, ...liveOnly]
  const firstTurnIndex = transcript.findIndex((message) => message.turnId === turnId)

  if (firstTurnIndex < 0) {
    return replacement.length > 0 ? [...transcript, ...replacement] : transcript
  }

  const retained = transcript.filter((message) => (
    message.turnId !== turnId || !isHydratedTextMessage(message)
  ))
  const insertionPoint = transcript
    .slice(0, firstTurnIndex)
    .filter((message) => message.turnId !== turnId || !isHydratedTextMessage(message))
    .length

  return [
    ...retained.slice(0, insertionPoint),
    ...replacement,
    ...retained.slice(insertionPoint),
  ]
}

export function finalizeHydratedTurnText(messages: UiMessage[]): UiMessage[] {
  return messages.filter((message) => message.messageType !== 'reasoning')
}
