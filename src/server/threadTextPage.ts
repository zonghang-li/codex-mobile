import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { open, type FileHandle } from 'node:fs/promises'
import { normalizeCodexDelegationText } from '../utils/codexDelegationText.js'

export type ThreadTextPageItem = {
  id: string
  type: 'agentMessage' | 'reasoning' | 'contextCompaction' | 'commandExecution' | 'userMessage'
  text?: string
  summary?: string[]
  content?: Array<{ type: 'input_text'; text: string }>
  command?: string
  cwd?: string | null
  status?: 'inProgress' | 'completed'
  aggregatedOutput?: string
  exitCode?: number | null
  sessionOrder: number
}

export type ThreadTextPageResult = {
  threadId: string
  turnId: string
  items: ThreadTextPageItem[]
  nextOlderCursor: string | null
  hasMoreOlder: boolean
  notModified?: boolean
  tailSignature?: string
}

type ThreadTextCursor = {
  v: 1
  threadId: string
  turnId: string
  beforeOffset: number
  snapshotEndOffset: number
}

const DEFAULT_LIMIT = 80
const MAX_LIMIT = 200
const READ_CHUNK_BYTES = 64 * 1024
const TARGET_PAGE_BYTES = 64 * 1024
const MAX_PAGE_BYTES = 1024 * 1024
const MAX_SCAN_BYTES = 2 * 1024 * 1024
const MAX_SCAN_LINES = 2_000
const MAX_DELTA_USER_ANCHOR_SCAN_BYTES = 512 * 1024
const MAX_DELTA_USER_ANCHOR_SCAN_LINES = 512
const MAX_RELEVANT_LINE_BYTES = 1024 * 1024
const OVERSIZED_CLASSIFIER_BYTES = 64 * 1024
const THREAD_TEXT_CURSOR_KEY = randomBytes(32)
const CONTEXT_COMPACTION_COMPLETED_TEXT = 'Context automatically compacted'
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
const CODEX_INTERNAL_GOAL_CONTEXT_OPEN_RE =
  /^(?:<|&(?:amp;)*lt;)\s*codex_internal_context\b(?=[^>\n]*(?:source\s*=\s*(?:"goal"|'goal'|goal|&quot;goal&quot;|&#34;goal&#34;|&#39;goal&#39;)))/iu

export class ThreadTextPageError extends Error {
  readonly statusCode: 400 | 409 | 413

  constructor(message: string, statusCode: 400 | 409 | 413) {
    super(message)
    this.name = 'ThreadTextPageError'
    this.statusCode = statusCode
  }
}

type BackwardsLine = {
  startOffset: number
  bytes: Buffer | null
  classificationPrefix?: Buffer
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)))
}

function normalizeAfterSessionOrder(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value)) return null
  return Math.max(0, Math.floor(value))
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
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

function isInjectedUserContextText(value: string): boolean {
  const text = value.trimStart()
  return text.startsWith('<environment_context>')
    || text.startsWith('<recommended_plugins>')
    || text.startsWith('<permissions instructions>')
    || CODEX_INTERNAL_GOAL_CONTEXT_OPEN_RE.test(text)
    || text.startsWith('# AGENTS.md instructions')
    || text.startsWith('<subagent_notification>')
}

function readUserMessageContent(payload: Record<string, unknown>): Array<{ type: 'input_text'; text: string }> {
  return (Array.isArray(payload.content) ? payload.content : [])
    .map(asRecord)
    .filter((part): part is Record<string, unknown> =>
      part?.type === 'input_text' && typeof part.text === 'string',
    )
    .map((part) => ({ type: 'input_text' as const, text: normalizeCodexDelegationText(part.text as string) }))
    .filter((part) => part.text.trim().length > 0)
}

function readEventUserMessageContent(payload: Record<string, unknown>): Array<{ type: 'input_text'; text: string }> {
  const rawText = typeof payload.message === 'string'
    ? payload.message
    : typeof payload.text === 'string'
      ? payload.text
      : ''
  const text = normalizeCodexDelegationText(rawText)
  return text.trim().length > 0 ? [{ type: 'input_text', text }] : []
}

function eventUserMessageId(payload: Record<string, unknown>, sessionOrder: number, text: string): string {
  const clientId = readString(payload.client_id)
  if (clientId) return `rollout:userMessage:event:${clientId}`
  const digest = createHash('sha256')
    .update(`${sessionOrder}\n${text}`)
    .digest('base64url')
    .slice(0, 16)
  return `rollout:userMessage:event:${digest}`
}

function contextCompactionEventId(payload: Record<string, unknown>, sessionOrder: number): string {
  const explicitId = readString(payload.id) || readString(payload.event_id)
  return explicitId
    ? `rollout:contextCompaction:${explicitId}`
    : `rollout:contextCompaction:${sessionOrder}`
}

function encodeCursor(cursor: ThreadTextCursor): string {
  const payload = Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
  const signature = createHmac('sha256', THREAD_TEXT_CURSOR_KEY)
    .update(payload)
    .digest('base64url')
  return `${payload}.${signature}`
}

function decodeCursor(
  encoded: string,
  threadId: string,
  turnId: string,
): ThreadTextCursor {
  try {
    const parts = encoded.split('.')
    if (
      parts.length !== 2
      || !parts[0]
      || !parts[1]
      || !/^[A-Za-z0-9_-]+$/u.test(parts[0])
      || !/^[A-Za-z0-9_-]+$/u.test(parts[1])
    ) {
      throw new Error('invalid base64url')
    }
    const payload = parts[0]
    const suppliedSignature = Buffer.from(parts[1], 'base64url')
    const expectedSignature = createHmac('sha256', THREAD_TEXT_CURSOR_KEY)
      .update(payload)
      .digest()
    if (
      suppliedSignature.length !== expectedSignature.length
      || !timingSafeEqual(suppliedSignature, expectedSignature)
    ) {
      throw new Error('invalid cursor signature')
    }
    const cursor = asRecord(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')))
    if (
      cursor?.v !== 1
      || cursor.threadId !== threadId
      || cursor.turnId !== turnId
      || !Number.isSafeInteger(cursor.beforeOffset)
      || !Number.isSafeInteger(cursor.snapshotEndOffset)
      || (cursor.beforeOffset as number) < 0
      || (cursor.snapshotEndOffset as number) < 0
      || (cursor.beforeOffset as number) > (cursor.snapshotEndOffset as number)
    ) {
      throw new Error('invalid cursor payload')
    }
    return cursor as ThreadTextCursor
  } catch {
    throw new ThreadTextPageError('Invalid thread text cursor', 400)
  }
}

async function cursorOffsetIsLineBoundary(
  file: FileHandle,
  beforeOffset: number,
): Promise<boolean> {
  if (beforeOffset === 0) return true
  const byte = Buffer.allocUnsafe(1)
  const { bytesRead } = await file.read(byte, 0, 1, beforeOffset - 1)
  return bytesRead === 1 && byte[0] === 0x0a
}

async function* readLinesBackwards(
  file: FileHandle,
  beforeOffset: number,
): AsyncGenerator<BackwardsLine> {
  let position = beforeOffset
  let fragments: Buffer[] = []
  let fragmentBytes = 0
  let oversized = false
  let classificationPrefix: Buffer = Buffer.alloc(0)

  const prependFragment = (fragment: Buffer): void => {
    if (fragment.length === 0) return
    if (oversized) {
      classificationPrefix = fragment.length >= OVERSIZED_CLASSIFIER_BYTES
        ? fragment.subarray(0, OVERSIZED_CLASSIFIER_BYTES)
        : Buffer.concat(
            [fragment, classificationPrefix],
            Math.min(
              OVERSIZED_CLASSIFIER_BYTES,
              fragment.length + classificationPrefix.length,
            ),
          ).subarray(0, OVERSIZED_CLASSIFIER_BYTES)
      return
    }
    fragmentBytes += fragment.length
    if (fragmentBytes > MAX_RELEVANT_LINE_BYTES) {
      oversized = true
      const prefixParts: Buffer[] = []
      let prefixBytes = 0
      for (const part of [fragment, ...fragments]) {
        if (prefixBytes >= OVERSIZED_CLASSIFIER_BYTES) break
        const remaining = OVERSIZED_CLASSIFIER_BYTES - prefixBytes
        const nextPart = part.length > remaining ? part.subarray(0, remaining) : part
        prefixParts.push(nextPart)
        prefixBytes += nextPart.length
      }
      classificationPrefix = Buffer.concat(prefixParts, prefixBytes)
      fragments = []
      return
    }
    fragments.unshift(fragment)
  }

  while (position > 0) {
    const chunkStart = Math.max(0, position - READ_CHUNK_BYTES)
    const requestedBytes = position - chunkStart
    const chunk = Buffer.allocUnsafe(requestedBytes)
    const { bytesRead } = await file.read(chunk, 0, requestedBytes, chunkStart)
    if (bytesRead !== requestedBytes) {
      throw new ThreadTextPageError('Rollout snapshot changed during pagination', 409)
    }

    let fragmentEnd = bytesRead
    for (let index = bytesRead - 1; index >= 0; index -= 1) {
      if (chunk[index] !== 0x0a) continue
      prependFragment(chunk.subarray(index + 1, fragmentEnd))
      const startOffset = chunkStart + index + 1
      if (oversized) {
        yield { startOffset, bytes: null, classificationPrefix }
      } else if (fragmentBytes > 0) {
        yield {
          startOffset,
          bytes: fragments.length === 1
            ? fragments[0]!
            : Buffer.concat(fragments, fragmentBytes),
        }
      }
      fragments = []
      fragmentBytes = 0
      oversized = false
      classificationPrefix = Buffer.alloc(0)
      fragmentEnd = index
    }
    prependFragment(chunk.subarray(0, fragmentEnd))
    position = chunkStart
  }

  if (oversized) {
    yield { startOffset: 0, bytes: null, classificationPrefix }
  } else if (fragmentBytes > 0) {
    yield {
      startOffset: 0,
      bytes: fragments.length === 1
        ? fragments[0]!
        : Buffer.concat(fragments, fragmentBytes),
    }
  }
}

function oversizedLineIsDefinitelyIrrelevant(prefix: Buffer): boolean {
  const text = prefix.toString('utf8')
  let objectDepth = 0
  let payloadDepth = -1
  let topLevelType: string | undefined
  let payloadType: string | undefined
  let payloadRole: string | undefined
  let pendingKey: { depth: number; value: string } | null = null

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === '"') {
      let end = index + 1
      let escaped = false
      while (end < text.length) {
        const next = text[end]
        if (!escaped && next === '"') break
        if (!escaped && next === '\\') {
          escaped = true
        } else {
          escaped = false
        }
        end += 1
      }
      if (end >= text.length) break
      let value = ''
      try {
        value = JSON.parse(text.slice(index, end + 1)) as string
      } catch {
        break
      }
      let nextIndex = end + 1
      while (nextIndex < text.length && /\s/u.test(text[nextIndex]!)) nextIndex += 1
      if (text[nextIndex] === ':') {
        pendingKey = { depth: objectDepth, value }
      } else if (pendingKey?.depth === objectDepth) {
        if (pendingKey.value === 'type' && objectDepth === 1) {
          topLevelType = value
        } else if (pendingKey.value === 'type' && objectDepth === payloadDepth) {
          payloadType = value
        } else if (pendingKey.value === 'role' && objectDepth === payloadDepth) {
          payloadRole = value
        }
        pendingKey = null
      }
      index = end
      continue
    }
    if (character === '{') {
      if (
        pendingKey?.depth === objectDepth
        && pendingKey.value === 'payload'
        && objectDepth === 1
      ) {
        payloadDepth = objectDepth + 1
      }
      objectDepth += 1
      pendingKey = null
      continue
    }
    if (character === '}') {
      if (objectDepth === payloadDepth) payloadDepth = -1
      objectDepth = Math.max(0, objectDepth - 1)
      pendingKey = null
      continue
    }
    if (character === ',') pendingKey = null
  }

  if (topLevelType !== 'response_item' && topLevelType !== 'event_msg') {
    return topLevelType !== undefined
  }
  if (!payloadType) return false
  if (topLevelType === 'response_item') {
    if (payloadType === 'reasoning') return false
    if (payloadType !== 'message') return true
    return payloadRole !== undefined && payloadRole !== 'assistant'
  }
  return payloadType !== 'task_started'
    && payloadType !== 'agent_reasoning'
}

function projectLine(line: Buffer, sessionOrder: number): {
  item: ThreadTextPageItem | null
  taskStartedTurnId: string | null
  terminalTurnId?: string | null
  completedCommandCallId: string | null
} {
  let row: Record<string, unknown> | null
  try {
    row = asRecord(JSON.parse(line.toString('utf8')))
  } catch {
    return { item: null, taskStartedTurnId: null, completedCommandCallId: null }
  }
  const payload = asRecord(row?.payload)
  if (!payload) return { item: null, taskStartedTurnId: null, completedCommandCallId: null }

  if (row?.type === 'event_msg' && payload.type === 'task_started') {
    return {
      item: null,
      taskStartedTurnId: typeof payload.turn_id === 'string' ? payload.turn_id : '',
      completedCommandCallId: null,
    }
  }

  if (
    row?.type === 'event_msg'
    && (payload.type === 'task_complete' || payload.type === 'turn_aborted')
  ) {
    return {
      item: null,
      taskStartedTurnId: null,
      terminalTurnId: typeof payload.turn_id === 'string' ? payload.turn_id : '',
      completedCommandCallId: null,
    }
  }

  if (row?.type === 'event_msg' && payload.type === 'context_compacted') {
    return {
      item: {
        id: contextCompactionEventId(payload, sessionOrder),
        type: 'contextCompaction',
        text: CONTEXT_COMPACTION_COMPLETED_TEXT,
        sessionOrder,
      },
      taskStartedTurnId: null,
      completedCommandCallId: null,
    }
  }

  if (row?.type === 'event_msg' && payload.type === 'agent_reasoning') {
    return {
      item: null,
      taskStartedTurnId: null,
      completedCommandCallId: null,
    }
  }

  if (row?.type === 'event_msg' && payload.type === 'user_message') {
    const content = readEventUserMessageContent(payload)
    const text = content.map((part) => part.text).join('')
    return {
      item: content.length > 0 && !isInjectedUserContextText(text)
        ? {
            id: eventUserMessageId(payload, sessionOrder, text),
            type: 'userMessage',
            text,
            content,
            sessionOrder,
          }
        : null,
      taskStartedTurnId: null,
      completedCommandCallId: null,
    }
  }

  if (row?.type === 'response_item' && payload.type === 'function_call_output') {
    return { item: null, taskStartedTurnId: null, completedCommandCallId: null }
  }

  if (row?.type === 'response_item' && payload.type === 'function_call' && payload.name === 'exec_command') {
    return { item: null, taskStartedTurnId: null, completedCommandCallId: null }
  }

  if (row?.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
    const content = readUserMessageContent(payload)
    const text = content.map((part) => part.text).join('')
    return {
      item: content.length > 0 && !isInjectedUserContextText(text)
        ? {
            id: typeof payload.id === 'string' && payload.id.length > 0
              ? payload.id
              : `rollout:userMessage:${sessionOrder}`,
            type: 'userMessage',
            text,
            content,
            sessionOrder,
          }
        : null,
      taskStartedTurnId: null,
      completedCommandCallId: null,
    }
  }

  if (
    row?.type !== 'response_item'
    || typeof payload.id !== 'string'
    || payload.id.length === 0
  ) {
    return { item: null, taskStartedTurnId: null, completedCommandCallId: null }
  }

  if (payload.type === 'message' && payload.role === 'assistant') {
    const content = Array.isArray(payload.content) ? payload.content : []
    const text = content
      .map(asRecord)
      .filter((part): part is Record<string, unknown> =>
        part?.type === 'output_text' && typeof part.text === 'string',
      )
      .map((part) => part.text as string)
      .join('')
    return {
      item: {
        id: payload.id,
        type: 'agentMessage',
        text,
        sessionOrder,
      },
      taskStartedTurnId: null,
      completedCommandCallId: null,
    }
  }

  if (payload.type === 'reasoning') {
    const summary = (Array.isArray(payload.summary) ? payload.summary : [])
      .map(asRecord)
      .filter((part): part is Record<string, unknown> =>
        part?.type === 'summary_text' && typeof part.text === 'string',
      )
      .map((part) => part.text as string)
      .filter((text) => text.trim().length > 0)
      .filter((text) => !isTitleOnlyReasoningStatusText(text))
    return {
      item: summary.length > 0
        ? {
            id: payload.id,
            type: 'reasoning',
            summary,
            sessionOrder,
          }
        : null,
      taskStartedTurnId: null,
      completedCommandCallId: null,
    }
  }

  return { item: null, taskStartedTurnId: null, completedCommandCallId: null }
}

function isEventUserMessageItem(item: ThreadTextPageItem): boolean {
  return item.type === 'userMessage' && item.id.startsWith('rollout:userMessage:event:')
}

function userMessageTextKey(item: ThreadTextPageItem): string | null {
  if (item.type !== 'userMessage') return null
  const text = (item.content ?? [])
    .map((part) => part.text)
    .join('\n')
    .trim() || item.text?.trim() || ''
  const normalized = normalizeCodexDelegationText(text)
  return normalized.length > 0 ? normalized : null
}

function isLateDelegatedUserMessageItem(item: ThreadTextPageItem): boolean {
  return item.type === 'userMessage'
    && isEventUserMessageItem(item)
    && CODEX_DELEGATION_OPEN_RE.test(userMessageTextKey(item) ?? '')
}

function likelyDuplicateUserMessages(left: ThreadTextPageItem, right: ThreadTextPageItem): boolean {
  const leftEvent = isEventUserMessageItem(left)
  const rightEvent = isEventUserMessageItem(right)
  if (leftEvent === rightEvent) return false
  const text = userMessageTextKey(left)
  if (!text || text !== userMessageTextKey(right)) return false
  const maxDistance = Math.max(4 * 1024, (text.length * 4) + 2048)
  return Math.abs(left.sessionOrder - right.sessionOrder) <= maxDistance
}

function deduplicateEventUserMessageItems(items: ThreadTextPageItem[]): ThreadTextPageItem[] {
  const deduped: ThreadTextPageItem[] = []
  for (const item of items) {
    if (item.type !== 'userMessage') {
      deduped.push(item)
      continue
    }

    let duplicateIndex = -1
    for (let index = deduped.length - 1; index >= 0; index -= 1) {
      const existing = deduped[index]!
      if (existing.type !== 'userMessage') break
      if (likelyDuplicateUserMessages(existing, item)) {
        duplicateIndex = index
        break
      }
      if (
        typeof existing.sessionOrder === 'number'
        && Math.abs(existing.sessionOrder - item.sessionOrder) > Math.max(4 * 1024, ((item.text?.length ?? 0) * 4) + 2048)
      ) {
        break
      }
    }

    if (duplicateIndex < 0) {
      deduped.push(item)
      continue
    }

    if (isEventUserMessageItem(deduped[duplicateIndex]!) && !isEventUserMessageItem(item)) {
      deduped[duplicateIndex] = item
    }
  }
  return deduped
}

function reorderLateDelegatedUserMessageItems(items: ThreadTextPageItem[]): ThreadTextPageItem[] {
  const ordered: ThreadTextPageItem[] = []
  let pairedResponseBoundary = 0
  for (const item of items) {
    if (!isLateDelegatedUserMessageItem(item)) {
      ordered.push(item)
      continue
    }

    const previousLength = ordered.length
    let insertionIndex = ordered.length
    while (insertionIndex > pairedResponseBoundary) {
      const previous = ordered[insertionIndex - 1]!
      if (previous.type === 'userMessage' || previous.type === 'contextCompaction') break
      insertionIndex -= 1
    }
    ordered.splice(insertionIndex, 0, item)
    if (insertionIndex < previousLength) {
      pairedResponseBoundary = previousLength + 1
    }
  }
  return ordered
}

function buildPageResult(input: {
  threadId: string
  turnId: string
  itemsBackwards: ThreadTextPageItem[]
  hasMoreOlder: boolean
  beforeOffset: number
  snapshotEndOffset: number
  tailSignature?: string
}): ThreadTextPageResult {
  const items = reorderLateDelegatedUserMessageItems(
    deduplicateEventUserMessageItems([...input.itemsBackwards].reverse()),
  )
  return {
    threadId: input.threadId,
    turnId: input.turnId,
    items,
    nextOlderCursor: input.hasMoreOlder
      ? encodeCursor({
          v: 1,
          threadId: input.threadId,
          turnId: input.turnId,
          beforeOffset: input.beforeOffset,
          snapshotEndOffset: input.snapshotEndOffset,
        })
      : null,
    hasMoreOlder: input.hasMoreOlder,
    ...(input.tailSignature ? { tailSignature: input.tailSignature } : {}),
  }
}

function buildTailSignature(input: {
  threadId: string
  turnId: string
  snapshotEndOffset: number
  mtimeMs: number
}): string {
  return createHash('sha256')
    .update(JSON.stringify({
      threadId: input.threadId,
      turnId: input.turnId,
      snapshotEndOffset: input.snapshotEndOffset,
      mtimeMs: Math.floor(input.mtimeMs),
    }))
    .digest('base64url')
    .slice(0, 32)
}

function serializedPageBytes(page: ThreadTextPageResult): number {
  return Buffer.byteLength(JSON.stringify(page), 'utf8')
}

async function assertOffsetBelongsToTurn(
  file: FileHandle,
  beforeOffset: number,
  turnId: string,
): Promise<void> {
  for await (const line of readLinesBackwards(file, beforeOffset)) {
    if (!line.bytes) {
      if (!oversizedLineIsDefinitelyIrrelevant(line.classificationPrefix ?? Buffer.alloc(0))) {
        throw new ThreadTextPageError('Relevant rollout record exceeds the size limit', 413)
      }
      continue
    }
    const { taskStartedTurnId, terminalTurnId } = projectLine(line.bytes, line.startOffset)
    if (terminalTurnId !== null && terminalTurnId !== undefined) {
      throw new ThreadTextPageError('Requested turn is not the active rollout turn', 409)
    }
    if (taskStartedTurnId === null) continue
    if (taskStartedTurnId !== turnId) {
      throw new ThreadTextPageError('Requested offset is outside the active rollout turn', 409)
    }
    return
  }
  throw new ThreadTextPageError('Requested turn boundary was not found', 409)
}

async function readTurnStartUserMessageAnchor(
  file: FileHandle,
  beforeOffset: number,
  turnId: string,
): Promise<ThreadTextPageItem | null> {
  let scannedBytes = 0
  let scannedLines = 0
  let lastScannedBoundary = beforeOffset
  let anchor: ThreadTextPageItem | null = null

  for await (const line of readLinesBackwards(file, beforeOffset)) {
    scannedBytes += lastScannedBoundary - line.startOffset
    scannedLines += 1
    lastScannedBoundary = line.startOffset
    const reachedScanBudget =
      scannedBytes >= MAX_SCAN_BYTES || scannedLines >= MAX_SCAN_LINES

    if (!line.bytes) {
      if (!oversizedLineIsDefinitelyIrrelevant(line.classificationPrefix ?? Buffer.alloc(0))) {
        return null
      }
      if (reachedScanBudget) return null
      continue
    }

    const projected = projectLine(line.bytes, line.startOffset)
    if (projected.taskStartedTurnId !== null) {
      if (projected.taskStartedTurnId !== turnId) {
        throw new ThreadTextPageError('Requested turn is not the active rollout turn', 409)
      }
      return anchor
    }
    if (projected.item?.type === 'userMessage') {
      anchor = projected.item
    }
    if (reachedScanBudget) return null
  }

  return null
}

function maybeAppendTurnStartAnchor(
  itemsBackwards: ThreadTextPageItem[],
  anchor: ThreadTextPageItem | null,
  pageShape: {
    threadId: string
    turnId: string
    hasMoreOlder: boolean
    beforeOffset: number
    snapshotEndOffset: number
  },
): ThreadTextPageItem[] {
  if (!anchor || itemsBackwards.some((item) => item.id === anchor.id)) {
    return itemsBackwards
  }
  const candidateItems = [...itemsBackwards, anchor]
  const candidatePage = buildPageResult({
    ...pageShape,
    itemsBackwards: candidateItems,
  })
  return serializedPageBytes(candidatePage) <= MAX_PAGE_BYTES
    ? candidateItems
    : itemsBackwards
}

export async function readThreadTextPage(input: {
  sessionPath: string
  threadId: string
  turnId: string
  cursor?: string
  limit?: number
  knownTailSignature?: string
  afterSessionOrder?: number
}, options: {
  trustedActiveTurn?: boolean
  trustedSnapshotEndOffset?: number
  includeTurnStartUserAnchor?: boolean
} = {}): Promise<ThreadTextPageResult> {
  const file = await open(input.sessionPath, 'r')
  try {
    const fileStats = await file.stat()
    const cursor = input.cursor
      ? decodeCursor(input.cursor, input.threadId, input.turnId)
      : null
    if (
      options.trustedSnapshotEndOffset !== undefined
      && (
        !Number.isSafeInteger(options.trustedSnapshotEndOffset)
        || options.trustedSnapshotEndOffset < 0
      )
    ) {
      throw new ThreadTextPageError('Invalid trusted rollout snapshot', 409)
    }
    const snapshotEndOffset = cursor?.snapshotEndOffset
      ?? options.trustedSnapshotEndOffset
      ?? fileStats.size
    const beforeOffset = cursor?.beforeOffset ?? snapshotEndOffset
    const tailSignature = !cursor
      ? buildTailSignature({
          threadId: input.threadId,
          turnId: input.turnId,
          snapshotEndOffset,
          mtimeMs: fileStats.mtimeMs,
        })
      : undefined
    const knownTailSignature = input.knownTailSignature?.trim() ?? ''
    if (
      !cursor
      && knownTailSignature
      && knownTailSignature === tailSignature
    ) {
      return {
        threadId: input.threadId,
        turnId: input.turnId,
        items: [],
        nextOlderCursor: null,
        hasMoreOlder: false,
        notModified: true,
        tailSignature,
      }
    }

    if (fileStats.size < snapshotEndOffset) {
      throw new ThreadTextPageError('Rollout snapshot was truncated', 409)
    }
    if (
      beforeOffset > snapshotEndOffset
      || (cursor && !(await cursorOffsetIsLineBoundary(file, beforeOffset)))
    ) {
      throw new ThreadTextPageError('Invalid thread text cursor', 400)
    }
    if (!cursor && options.trustedActiveTurn !== true) {
      await assertOffsetBelongsToTurn(file, beforeOffset, input.turnId)
    }

    const limit = normalizeLimit(input.limit)
    const afterSessionOrder = cursor ? null : normalizeAfterSessionOrder(input.afterSessionOrder)
    const collected: ThreadTextPageItem[] = []
    let nextBeforeOffset = beforeOffset
    let pageLimitReached = false
    let foundOlderVisible = false
    let cursorWouldExceedMax = false
    let scanBudgetReached = false
    let scannedBytes = 0
    let scannedLines = 0
    let lastScannedBoundary = beforeOffset
    let crossedAfterSessionOrder = false
    let deltaUserAnchorScanBytes = 0
    let deltaUserAnchorScanLines = 0

    for await (const line of readLinesBackwards(file, beforeOffset)) {
      const lineSpanBytes = lastScannedBoundary - line.startOffset
      scannedBytes += lineSpanBytes
      scannedLines += 1
      lastScannedBoundary = line.startOffset
      const reachedScanBudget =
        scannedBytes >= MAX_SCAN_BYTES || scannedLines >= MAX_SCAN_LINES

      if (!line.bytes) {
        if (!oversizedLineIsDefinitelyIrrelevant(line.classificationPrefix ?? Buffer.alloc(0))) {
          throw new ThreadTextPageError('Relevant rollout record exceeds the size limit', 413)
        }
        nextBeforeOffset = line.startOffset
        if (reachedScanBudget) {
          scanBudgetReached = true
          break
        }
        continue
      }
      const projected = projectLine(line.bytes, line.startOffset)
      if (projected.taskStartedTurnId !== null) {
        if (projected.taskStartedTurnId !== input.turnId) {
          throw new ThreadTextPageError('Requested turn is not the active rollout turn', 409)
        }
        break
      }
      if (!projected.item) {
        nextBeforeOffset = line.startOffset
        if (reachedScanBudget) {
          scanBudgetReached = true
          break
        }
        continue
      }
      if (afterSessionOrder !== null && projected.item.sessionOrder <= afterSessionOrder) {
        crossedAfterSessionOrder = true
        deltaUserAnchorScanBytes += lineSpanBytes
        deltaUserAnchorScanLines += 1
        if (
          projected.item.type !== 'userMessage'
          || deltaUserAnchorScanBytes > MAX_DELTA_USER_ANCHOR_SCAN_BYTES
          || deltaUserAnchorScanLines > MAX_DELTA_USER_ANCHOR_SCAN_LINES
        ) {
          nextBeforeOffset = line.startOffset
          if (reachedScanBudget) {
            scanBudgetReached = false
            break
          }
          if (
            deltaUserAnchorScanBytes > MAX_DELTA_USER_ANCHOR_SCAN_BYTES
            || deltaUserAnchorScanLines > MAX_DELTA_USER_ANCHOR_SCAN_LINES
          ) {
            break
          }
          continue
        }
      }
      if (pageLimitReached) {
        if (cursorWouldExceedMax) {
          throw new ThreadTextPageError('Thread text record leaves no room for a page cursor', 413)
        }
        foundOlderVisible = true
        break
      }

      const candidateItems = [...collected, projected.item]
      const terminalCandidatePage = buildPageResult({
        threadId: input.threadId,
        turnId: input.turnId,
        itemsBackwards: candidateItems,
        hasMoreOlder: false,
        beforeOffset: line.startOffset,
        snapshotEndOffset,
      })
      const candidatePage = buildPageResult({
        threadId: input.threadId,
        turnId: input.turnId,
        itemsBackwards: candidateItems,
        hasMoreOlder: true,
        beforeOffset: line.startOffset,
        snapshotEndOffset,
      })
      const terminalCandidateBytes = serializedPageBytes(terminalCandidatePage)
      const candidateBytes = serializedPageBytes(candidatePage)
      if (terminalCandidateBytes > MAX_PAGE_BYTES) {
        if (collected.length === 0) {
          throw new ThreadTextPageError('Thread text record exceeds the response size limit', 413)
        }
        foundOlderVisible = true
        break
      }
      if (candidateBytes > MAX_PAGE_BYTES) {
        if (collected.length > 0) {
          foundOlderVisible = true
          break
        }
        collected.push(projected.item)
        nextBeforeOffset = line.startOffset
        pageLimitReached = true
        cursorWouldExceedMax = true
        continue
      }
      if (collected.length > 0 && candidateBytes > TARGET_PAGE_BYTES) {
        foundOlderVisible = true
        break
      }

      collected.push(projected.item)
      nextBeforeOffset = line.startOffset
      if (reachedScanBudget) {
        scanBudgetReached = !crossedAfterSessionOrder
        break
      }
      if (
        collected.length >= limit
        || candidateBytes >= MAX_PAGE_BYTES
      ) {
        pageLimitReached = true
      }
    }

    const hasMoreOlder = (foundOlderVisible || scanBudgetReached) && nextBeforeOffset > 0
    const shouldReadTurnStartAnchor = options.includeTurnStartUserAnchor !== false
      && !cursor
      && afterSessionOrder === null
    const itemsBackwards = shouldReadTurnStartAnchor
      ? maybeAppendTurnStartAnchor(
          collected,
          await readTurnStartUserMessageAnchor(file, beforeOffset, input.turnId),
          {
            threadId: input.threadId,
            turnId: input.turnId,
            hasMoreOlder,
            beforeOffset: nextBeforeOffset,
            snapshotEndOffset,
          },
        )
      : collected

    if (
      !cursor
      && knownTailSignature
      && afterSessionOrder !== null
      && itemsBackwards.length === 0
      && !hasMoreOlder
    ) {
      return {
        threadId: input.threadId,
        turnId: input.turnId,
        items: [],
        nextOlderCursor: null,
        hasMoreOlder: false,
        notModified: true,
        tailSignature,
      }
    }

    let result = buildPageResult({
      threadId: input.threadId,
      turnId: input.turnId,
      itemsBackwards,
      hasMoreOlder,
      beforeOffset: nextBeforeOffset,
      snapshotEndOffset,
      tailSignature,
    })
    if (tailSignature && serializedPageBytes(result) > MAX_PAGE_BYTES) {
      result = buildPageResult({
        threadId: input.threadId,
        turnId: input.turnId,
        itemsBackwards,
        hasMoreOlder,
        beforeOffset: nextBeforeOffset,
        snapshotEndOffset,
      })
    }
    if (serializedPageBytes(result) > MAX_PAGE_BYTES) {
      throw new ThreadTextPageError('Thread text page exceeds the response size limit', 413)
    }
    return result
  } finally {
    await file.close()
  }
}
