import type { UiMessage } from '../../types/codex'
import { isThreadActivityMessage } from './threadConversationActivity'

export type ConversationTurnSection = {
  turnId: string
  userMessageIds: string[]
  activityMessageIds: string[]
  finalMessageId: string | null
  completionMessageId: string | null
  completionLabel: string | null
  completionCreatedAtMs: number | null
  isCollapsed: boolean
}

export type ConversationTurnPresentationInput = {
  messages: readonly UiMessage[]
  activeTurnId: string | null
}

export type ResponseActionVisibilityInput = {
  messageTurnId: string
  activeTurnId: string
  runtimeActive: boolean
}

export type SimplifiedTranscriptVisibilityInput = {
  messages: readonly UiMessage[]
  activeTurnId: string | null
  isThreadInProgress: boolean
}

type MutableTurnSection = ConversationTurnSection & {
  seenMessageIds: Set<string>
}

const TITLE_ONLY_REASONING_PREFIXES = [
  'Adding',
  'Analyzing',
  'Assessing',
  'Asserting',
  'Allowing',
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
]

const TITLE_ONLY_REASONING_EXACT_TEXTS = new Set([
  'Existing tests',
])

export function suppressResponseActions(input: ResponseActionVisibilityInput): boolean {
  const activeTurnId = input.activeTurnId.trim()
  const messageTurnId = input.messageTurnId.trim()
  if (activeTurnId) {
    if (!messageTurnId) return input.runtimeActive
    return messageTurnId === activeTurnId
  }
  return input.runtimeActive
}

function explicitTurnKey(message: UiMessage): string {
  const turnId = message.turnId?.trim() ?? ''
  if (turnId) return turnId
  if (typeof message.turnIndex === 'number') return `turn-index:${message.turnIndex}`
  return ''
}

function isFinalPhaseMessage(message: UiMessage): boolean {
  const phase = message.phase?.trim().toLowerCase() ?? ''
  return !phase || phase === 'final' || phase === 'final_answer'
}

function isFinalAssistantResponse(message: UiMessage): boolean {
  if (message.role !== 'assistant' || !message.text.trim()) return false
  if (!isFinalPhaseMessage(message)) return false
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
    completionCreatedAtMs: null,
    isCollapsed: turnId !== activeTurnId,
    seenMessageIds: new Set<string>(),
  }
}

export function formatCompletionClockTime(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return ''
  const date = new Date(value)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day} ${hour}:${minute}`
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
      section.completionCreatedAtMs = typeof message.createdAtMs === 'number' ? message.createdAtMs : null
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

function isTitleOnlyReasoningStatusText(value: string): boolean {
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

function isTitleOnlyReasoningStatusLine(message: UiMessage): boolean {
  return isTitleOnlyReasoningStatusText(message.text)
}

export function stripTitleOnlyReasoningStatusLines(text: string): string {
  const lines = text.replace(/\r\n/gu, '\n').split('\n')
  const filtered = lines.filter((line) => !isTitleOnlyReasoningStatusText(line))
  return filtered.join('\n').replace(/\n{3,}/gu, '\n\n').trim()
}

export function hiddenSimplifiedTranscriptMessageIds(
  input: SimplifiedTranscriptVisibilityInput,
): Set<string> {
  const hidden = new Set<string>()
  const activeTurnId = input.isThreadInProgress ? input.activeTurnId?.trim() ?? '' : ''

  for (const message of input.messages) {
    if (message.role === 'user') continue

    if (
      (message.role === 'assistant' || message.role === 'system')
      && message.text.trim()
      && !stripTitleOnlyReasoningStatusLines(message.text)
    ) {
      hidden.add(message.id)
      continue
    }

    if (message.messageType === 'reasoning') {
      if (isTitleOnlyReasoningStatusLine(message)) {
        hidden.add(message.id)
        continue
      }
      if (
        input.isThreadInProgress
        && (!activeTurnId || message.turnId === activeTurnId)
      ) {
        continue
      }
      hidden.add(message.id)
      continue
    }

    if (
      message.messageType === 'worked'
      || isThreadActivityMessage(message)
      || message.activity?.kind === 'subAgent'
    ) {
      hidden.add(message.id)
    }
  }

  return hidden
}
