import type { UiMessage } from '../../types/codex'
import {
  buildSubAgentActivityGroup,
  type SubAgentActivityGroup,
  type SubAgentDisplayItem,
} from './subAgentActivity'

const TURN_ACTIVITY_MESSAGE_TYPES = new Set([
  'reasoning',
  'commandExecution',
  'mcpToolCall',
  'collabAgentToolCall',
  'webSearch',
  'imageView',
  'contextCompaction',
  'plan',
  'subAgentActivity',
  'dynamicToolCall',
  'sleep',
  'imageGeneration',
  'enteredReviewMode',
  'exitedReviewMode',
  'collaborationActivity',
])

export type ThreadActivitySegment =
  | {
      kind: 'reasoning'
      id: string
      label: string
      iconKind: ThreadActivityIconKind
      sourceMessageIds: string[]
    }
  | {
      kind: 'subAgent'
      id: string
      agents: SubAgentDisplayItem[]
      status: SubAgentActivityGroup['status']
      sourceMessageIds: string[]
    }
  | {
      kind: 'event'
      id: string
      label: string
      iconKind: ThreadActivityIconKind
      sourceMessageIds: string[]
    }

export type ThreadActivityIconKind =
  | 'book'
  | 'search'
  | 'edit'
  | 'terminal'
  | 'integration'
  | 'image'
  | 'agent'
  | 'status'

export function shouldRenderReasoningAsTranscript(
  message: Pick<UiMessage, 'messageType' | 'turnId'>,
  context: {
    activeTurnId: string
    isThreadInProgress: boolean
    readOnly: boolean
  },
): boolean {
  const activeTurnId = context.activeTurnId.trim()
  return context.isThreadInProgress
    && activeTurnId.length > 0
    && message.messageType === 'reasoning'
    && message.turnId === activeTurnId
}

type ActionSummaryState = {
  sourceMessageIds: string[]
  latestMessage: UiMessage | null
}

function emptyActionSummary(): ActionSummaryState {
  return {
    sourceMessageIds: [],
    latestMessage: null,
  }
}

function compactActivityText(value: string): string {
  return value
    .replace(/\*\*([^*]+)\*\*/gu, '$1')
    .replace(/__([^_]+)__/gu, '$1')
    .replace(/\s+/gu, ' ')
    .trim()
}

function isFallbackRanCommandLabel(command: string, label: string): boolean {
  const compactCommand = compactActivityText(command)
  return label === 'Ran a command' || (compactCommand.length > 0 && label === `Ran ${compactCommand}`)
}

function commandActivityIconKind(message: UiMessage): ThreadActivityIconKind {
  const categories = message.commandExecution?.activityCategories ?? ['unknown']
  if (categories.includes('unknown')) return 'terminal'
  if (categories.includes('search')) return 'search'
  if (categories.includes('read') || categories.includes('listFiles')) return 'book'
  return 'terminal'
}

function commandActivityLabel(message: UiMessage): string {
  const label = compactActivityText(message.commandExecution?.displayLabel ?? '')
  const command = compactActivityText(message.commandExecution?.command ?? message.text)
  const categories = message.commandExecution?.activityCategories ?? ['unknown']
  if (label && !isFallbackRanCommandLabel(command, label)) return label
  if (categories.includes('search')) return 'Searched files'
  if (categories.includes('read')) return 'Read files'
  if (categories.includes('listFiles')) return 'Listed files'
  if (label) return label
  return command ? `Ran ${command}` : 'Ran a command'
}

function actionDetailLabel(message: UiMessage): string {
  if (message.messageType === 'commandExecution') return commandActivityLabel(message)
  return activityLabel(message)
}

function actionDetailIconKind(message: UiMessage): ThreadActivityIconKind {
  if (message.messageType === 'commandExecution') return commandActivityIconKind(message)
  return activityMessageIconKind(message)
}

function activityLabel(message: UiMessage): string {
  const label = compactActivityText(message.activity?.label ?? '')
  if (label) return label
  const text = compactActivityText(message.text)
  if (text) return text
  if (message.messageType === 'imageGeneration') return 'Generated an image'
  if (message.messageType === 'imageView') return 'Viewed an image'
  if (message.messageType === 'contextCompaction') return 'Context automatically compacting'
  return 'Thinking'
}

function isSubAgentLifecycleMessage(message: UiMessage): boolean {
  return message.messageType === 'subAgentActivity' || message.messageType === 'collabAgentToolCall'
}

function isCollaborationActivity(message: UiMessage): boolean {
  return message.messageType === 'collaborationActivity'
    && message.activity?.kind === 'collaboration'
}

function collaborationLabelPart(message: UiMessage): string {
  if (message.activity?.collaborationKind === 'sendMessage') return 'sent message to chat'
  if (message.activity?.collaborationKind === 'waitThreads') return 'wait threads'
  if (message.activity?.collaborationKind === 'listAgents') return 'listed agents'
  return ''
}

function capitalizeFirst(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value
}

function activityMessageIconKind(message: UiMessage): ThreadActivityIconKind {
  const type = message.messageType ?? ''
  if (type === 'webSearch') return 'search'
  if (type === 'imageView' || type === 'imageGeneration') return 'image'
  if (type === 'mcpToolCall' || type === 'dynamicToolCall' || type === 'collaborationActivity') {
    return 'integration'
  }
  if (type === 'subAgentActivity' || type === 'collabAgentToolCall') return 'agent'
  return 'status'
}

export function buildThreadActivitySegments(
  messages: readonly UiMessage[],
  options: { parentTurnCompleted?: boolean } = {},
): ThreadActivitySegment[] {
  const segments: ThreadActivitySegment[] = []

  for (let index = 0; index < messages.length;) {
    const message = messages[index]
    if (!isThreadActivityMessage(message)) {
      index += 1
      continue
    }

    if (message.messageType === 'commandExecution') {
      segments.push({
        kind: 'event',
        id: message.id,
        label: actionDetailLabel(message),
        iconKind: actionDetailIconKind(message),
        sourceMessageIds: [message.id],
      })
      index += 1
      continue
    }

    if (isCollaborationActivity(message)) {
      const sourceMessageIds: string[] = []
      const parts: string[] = []
      const seenParts = new Set<string>()
      while (index < messages.length && isCollaborationActivity(messages[index])) {
        const collaborationMessage = messages[index]
        sourceMessageIds.push(collaborationMessage.id)
        const part = collaborationLabelPart(collaborationMessage)
        if (part && !seenParts.has(part)) {
          seenParts.add(part)
          parts.push(part)
        }
        index += 1
      }
      if (parts.length > 0) {
        segments.push({
          kind: 'event',
          id: sourceMessageIds.at(-1) ?? '',
          label: capitalizeFirst(parts.join(', ')),
          iconKind: 'integration',
          sourceMessageIds,
        })
      }
      continue
    }

    if (isSubAgentLifecycleMessage(message)) {
      const groupMessages: UiMessage[] = []
      while (index < messages.length && isSubAgentLifecycleMessage(messages[index])) {
        groupMessages.push(messages[index])
        index += 1
      }
      const group = buildSubAgentActivityGroup(groupMessages, options)
      if (group) {
        segments.push({
          kind: 'subAgent',
          id: group.sourceMessageIds.at(-1) ?? '',
          agents: group.agents,
          status: group.status,
          sourceMessageIds: group.sourceMessageIds,
        })
      }
      continue
    }

    const label = activityLabel(message)
    if (message.messageType === 'reasoning') {
      segments.push({
        kind: 'reasoning',
        id: message.id,
        label,
        iconKind: activityMessageIconKind(message),
        sourceMessageIds: [message.id],
      })
      index += 1
      continue
    }
    segments.push({
      kind: 'event',
      id: message.id,
      label,
      iconKind: activityMessageIconKind(message),
      sourceMessageIds: [message.id],
    })
    index += 1
  }

  return segments
}

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

export function getTurnActivitySegmentsForWorked(
  messages: readonly UiMessage[],
  workedIndex: number,
): ThreadActivitySegment[] {
  if (workedIndex < 0 || workedIndex >= messages.length) return []
  const worked = messages[workedIndex]
  if (worked?.messageType !== 'worked') return []

  const turnMessages: UiMessage[] = []
  for (let index = workedIndex - 1; index >= 0; index -= 1) {
    const candidate = messages[index]
    if (!candidate || isTurnBoundary(candidate)) break
    turnMessages.unshift(candidate)
  }
  return buildThreadActivitySegments(turnMessages, { parentTurnCompleted: true })
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
