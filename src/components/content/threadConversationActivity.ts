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
  'fileChange',
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
      kind: 'summary'
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

type ActionSummaryState = {
  sourceMessageIds: string[]
  editedFileCount: number
  readCount: number
  listCount: number
  searchCount: number
  runCount: number
}

function emptyActionSummary(): ActionSummaryState {
  return {
    sourceMessageIds: [],
    editedFileCount: 0,
    readCount: 0,
    listCount: 0,
    searchCount: 0,
    runCount: 0,
  }
}

function actionSummaryLabel(state: ActionSummaryState): string {
  const parts: string[] = []
  if (state.editedFileCount > 0) {
    parts.push(state.editedFileCount === 1 ? 'edited a file' : 'edited files')
  }
  if (state.readCount > 0) {
    parts.push(state.readCount === 1 ? 'read a file' : 'read files')
  }
  if (state.listCount > 0) {
    parts.push(state.listCount === 1 ? 'listed files' : 'listed files')
  }
  if (state.searchCount > 0) {
    parts.push(state.searchCount === 1 ? 'searched files' : 'searched files')
  }
  if (state.runCount > 0) {
    parts.push(state.runCount === 1 ? 'ran a command' : 'ran commands')
  }
  const label = parts.join(', ')
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : 'Ran activity'
}

function actionSummaryIconKind(state: ActionSummaryState): ThreadActivityIconKind {
  if (state.editedFileCount > 0) return 'edit'
  if (state.readCount > 0 || state.listCount > 0 || state.searchCount > 0) return 'search'
  return 'terminal'
}

function appendCommandActivity(state: ActionSummaryState, message: UiMessage): void {
  const categories = message.commandExecution?.activityCategories ?? ['unknown']
  for (const category of new Set(categories)) {
    if (category === 'read') state.readCount += 1
    else if (category === 'listFiles') state.listCount += 1
    else if (category === 'search') state.searchCount += 1
    else state.runCount += 1
  }
}

function activityLabel(message: UiMessage): string {
  const compact = (value: string): string => value
    .replace(/\*\*([^*]+)\*\*/gu, '$1')
    .replace(/__([^_]+)__/gu, '$1')
    .replace(/\s+/gu, ' ')
    .trim()
  const label = compact(message.activity?.label ?? '')
  if (label) return label
  const text = compact(message.text)
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
  let actions = emptyActionSummary()

  const flushActions = (): void => {
    if (actions.sourceMessageIds.length === 0) return
    segments.push({
      kind: 'summary',
      id: actions.sourceMessageIds.at(-1) ?? '',
      label: actionSummaryLabel(actions),
      iconKind: actionSummaryIconKind(actions),
      sourceMessageIds: [...actions.sourceMessageIds],
    })
    actions = emptyActionSummary()
  }

  for (let index = 0; index < messages.length;) {
    const message = messages[index]
    if (!isThreadActivityMessage(message)) {
      flushActions()
      index += 1
      continue
    }

    if (message.messageType === 'commandExecution' || message.messageType === 'fileChange') {
      actions.sourceMessageIds.push(message.id)
      if (message.messageType === 'fileChange') {
        actions.editedFileCount += Math.max(message.fileChanges?.length ?? 0, 1)
      } else {
        appendCommandActivity(actions, message)
      }
      index += 1
      continue
    }

    flushActions()
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

  flushActions()
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
