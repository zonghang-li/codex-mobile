import type { UiMessage } from '../../types/codex'
import { isThreadActivityMessage } from './threadConversationActivity'

export type ConversationTurnSection = {
  turnId: string
  userMessageIds: string[]
  activityMessageIds: string[]
  finalMessageId: string | null
  completionMessageId: string | null
  completionLabel: string | null
  isCollapsed: boolean
}

export type ConversationTurnPresentationInput = {
  messages: readonly UiMessage[]
  activeTurnId: string | null
}

type MutableTurnSection = ConversationTurnSection & {
  seenMessageIds: Set<string>
}

function explicitTurnKey(message: UiMessage): string {
  const turnId = message.turnId?.trim() ?? ''
  if (turnId) return turnId
  if (typeof message.turnIndex === 'number') return `turn-index:${message.turnIndex}`
  return ''
}

function isFinalAssistantResponse(message: UiMessage): boolean {
  if (message.role !== 'assistant' || !message.text.trim()) return false
  if (isThreadActivityMessage(message)) return false
  if (message.activity?.kind === 'subAgent') return false
  const messageType = message.messageType ?? ''
  if (messageType === 'worked' || messageType === 'turnError') return false
  if (messageType.endsWith('.live')) return false
  return true
}

function createSection(turnId: string, activeTurnId: string | null): MutableTurnSection {
  return {
    turnId,
    userMessageIds: [],
    activityMessageIds: [],
    finalMessageId: null,
    completionMessageId: null,
    completionLabel: null,
    isCollapsed: turnId !== activeTurnId,
    seenMessageIds: new Set<string>(),
  }
}

export function projectConversationTurns(
  input: ConversationTurnPresentationInput,
): ConversationTurnSection[] {
  const sections: MutableTurnSection[] = []
  const sectionByTurnId = new Map<string, MutableTurnSection>()
  let implicitTurnId = ''
  let implicitTurnSequence = 0

  const getSection = (message: UiMessage): MutableTurnSection => {
    let turnId = explicitTurnKey(message)
    if (!turnId) {
      if (message.role === 'user' || !implicitTurnId) {
        implicitTurnSequence += 1
        implicitTurnId = `implicit-turn:${implicitTurnSequence}`
      }
      turnId = implicitTurnId
    } else {
      implicitTurnId = turnId
    }

    const existing = sectionByTurnId.get(turnId)
    if (existing) return existing
    const created = createSection(turnId, input.activeTurnId)
    sectionByTurnId.set(turnId, created)
    sections.push(created)
    return created
  }

  for (const message of input.messages) {
    const section = getSection(message)
    if (section.seenMessageIds.has(message.id)) continue
    section.seenMessageIds.add(message.id)

    if (message.role === 'user') {
      section.userMessageIds.push(message.id)
      continue
    }

    if (message.messageType === 'worked') {
      section.completionMessageId = message.id
      section.completionLabel = message.text.trim() || null
      section.isCollapsed = section.turnId !== input.activeTurnId
      continue
    }

    if (isThreadActivityMessage(message) || message.activity?.kind === 'subAgent') {
      section.activityMessageIds.push(message.id)
      continue
    }

    if (isFinalAssistantResponse(message)) {
      section.finalMessageId = message.id
    }
  }

  return sections.map(({ seenMessageIds: _seenMessageIds, ...section }) => section)
}
