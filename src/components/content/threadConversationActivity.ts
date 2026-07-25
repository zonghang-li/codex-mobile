import type { UiMessage } from '../../types/codex'

const TURN_ACTIVITY_MESSAGE_TYPES = new Set([
  'reasoning',
  'commandExecution',
  'mcpToolCall',
  'collabAgentToolCall',
  'webSearch',
  'imageView',
  'contextCompaction',
  'fileChange',
  'plan',
])

export function isThreadActivityMessage(message: Pick<UiMessage, 'messageType' | 'role'>): boolean {
  if (message.role === 'user') return false
  const type = message.messageType ?? ''
  return TURN_ACTIVITY_MESSAGE_TYPES.has(type)
}

function isTurnBoundary(message: UiMessage): boolean {
  return message.role === 'user' || message.messageType === 'worked'
}

export function getTurnActivityMessagesForWorked(messages: readonly UiMessage[], workedIndex: number): UiMessage[] {
  if (workedIndex < 0 || workedIndex >= messages.length) return []
  const worked = messages[workedIndex]
  if (worked?.messageType !== 'worked') return []

  const activity: UiMessage[] = []
  for (let index = workedIndex - 1; index >= 0; index -= 1) {
    const candidate = messages[index]
    if (!candidate || isTurnBoundary(candidate)) break
    if (isThreadActivityMessage(candidate)) {
      activity.unshift(candidate)
    }
  }
  return activity
}

export function getHiddenCompletedActivityMessageIds(messages: readonly UiMessage[]): Set<string> {
  const hidden = new Set<string>()
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.messageType !== 'worked') continue
    for (const activity of getTurnActivityMessagesForWorked(messages, index)) {
      hidden.add(activity.id)
    }
  }
  return hidden
}
