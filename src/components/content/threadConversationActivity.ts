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
  'subAgentActivity',
  'dynamicToolCall',
  'sleep',
  'imageGeneration',
  'enteredReviewMode',
  'exitedReviewMode',
])

export type ThreadActivitySegment =
  | {
      kind: 'reasoning'
      id: string
      label: string
      sourceMessageIds: string[]
    }
  | {
      kind: 'summary'
      id: string
      label: string
      sourceMessageIds: string[]
    }
  | {
      kind: 'subAgent'
      id: string
      label: string
      status?: string
      sourceMessageIds: string[]
    }
  | {
      kind: 'event'
      id: string
      label: string
      sourceMessageIds: string[]
    }

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
  const label = message.activity?.label?.replace(/\s+/gu, ' ').trim()
  if (label) return label
  const text = message.text.replace(/\s+/gu, ' ').trim()
  if (text) return text
  if (message.messageType === 'imageGeneration') return 'Generated an image'
  if (message.messageType === 'imageView') return 'Viewed an image'
  if (message.messageType === 'contextCompaction') return 'Context automatically compacting'
  return 'Thinking'
}

export function buildThreadActivitySegments(messages: readonly UiMessage[]): ThreadActivitySegment[] {
  const segments: ThreadActivitySegment[] = []
  let actions = emptyActionSummary()

  const flushActions = (): void => {
    if (actions.sourceMessageIds.length === 0) return
    segments.push({
      kind: 'summary',
      id: actions.sourceMessageIds.at(-1) ?? '',
      label: actionSummaryLabel(actions),
      sourceMessageIds: [...actions.sourceMessageIds],
    })
    actions = emptyActionSummary()
  }

  for (const message of messages) {
    if (!isThreadActivityMessage(message)) {
      flushActions()
      continue
    }

    if (message.messageType === 'commandExecution' || message.messageType === 'fileChange') {
      actions.sourceMessageIds.push(message.id)
      if (message.messageType === 'fileChange') {
        actions.editedFileCount += Math.max(message.fileChanges?.length ?? 0, 1)
      } else {
        appendCommandActivity(actions, message)
      }
      continue
    }

    flushActions()
    const label = activityLabel(message)
    if (message.messageType === 'reasoning') {
      segments.push({
        kind: 'reasoning',
        id: message.id,
        label,
        sourceMessageIds: [message.id],
      })
      continue
    }
    if (message.messageType === 'subAgentActivity') {
      segments.push({
        kind: 'subAgent',
        id: message.id,
        label,
        status: message.activity?.status,
        sourceMessageIds: [message.id],
      })
      continue
    }
    segments.push({
      kind: 'event',
      id: message.id,
      label,
      sourceMessageIds: [message.id],
    })
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
