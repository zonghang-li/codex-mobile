import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { open, type FileHandle } from 'node:fs/promises'

export type ThreadTextPageItem = {
  id: string
  type: 'agentMessage' | 'reasoning' | 'contextCompaction'
  text?: string
  summary?: string[]
  sessionOrder: number
}

export type ThreadTextPageResult = {
  threadId: string
  turnId: string
  items: ThreadTextPageItem[]
  nextOlderCursor: string | null
  hasMoreOlder: boolean
}

type ThreadTextCursor = {
  v: 1
  threadId: string
  turnId: string
  beforeOffset: number
  snapshotEndOffset: number
}

const DEFAULT_LIMIT = 300
const MAX_LIMIT = 600
const READ_CHUNK_BYTES = 64 * 1024
const TARGET_PAGE_BYTES = 256 * 1024
const MAX_PAGE_BYTES = 1024 * 1024
const MAX_RELEVANT_LINE_BYTES = 1024 * 1024
const OVERSIZED_CLASSIFIER_BYTES = 64 * 1024
const THREAD_TEXT_CURSOR_KEY = randomBytes(32)

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
  return payloadType !== 'context_compacted' && payloadType !== 'task_started'
}

function projectLine(line: Buffer, sessionOrder: number): {
  item: ThreadTextPageItem | null
  taskStartedTurnId: string | null
} {
  let row: Record<string, unknown> | null
  try {
    row = asRecord(JSON.parse(line.toString('utf8')))
  } catch {
    return { item: null, taskStartedTurnId: null }
  }
  const payload = asRecord(row?.payload)
  if (!payload) return { item: null, taskStartedTurnId: null }

  if (row?.type === 'event_msg' && payload.type === 'task_started') {
    return {
      item: null,
      taskStartedTurnId: typeof payload.turn_id === 'string' ? payload.turn_id : '',
    }
  }

  if (row?.type === 'event_msg' && payload.type === 'context_compacted') {
    return {
      item: {
        id: `rollout:contextCompaction:${sessionOrder}`,
        type: 'contextCompaction',
        sessionOrder,
      },
      taskStartedTurnId: null,
    }
  }

  if (
    row?.type !== 'response_item'
    || typeof payload.id !== 'string'
    || payload.id.length === 0
  ) {
    return { item: null, taskStartedTurnId: null }
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
    }
  }

  if (payload.type === 'reasoning') {
    const summary = (Array.isArray(payload.summary) ? payload.summary : [])
      .map(asRecord)
      .filter((part): part is Record<string, unknown> =>
        part?.type === 'summary_text' && typeof part.text === 'string',
      )
      .map((part) => part.text as string)
    return {
      item: {
        id: payload.id,
        type: 'reasoning',
        summary,
        sessionOrder,
      },
      taskStartedTurnId: null,
    }
  }

  return { item: null, taskStartedTurnId: null }
}

function buildPageResult(input: {
  threadId: string
  turnId: string
  itemsBackwards: ThreadTextPageItem[]
  hasMoreOlder: boolean
  beforeOffset: number
  snapshotEndOffset: number
}): ThreadTextPageResult {
  return {
    threadId: input.threadId,
    turnId: input.turnId,
    items: [...input.itemsBackwards].reverse(),
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
  }
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
    const { taskStartedTurnId } = projectLine(line.bytes, line.startOffset)
    if (taskStartedTurnId === null) continue
    if (taskStartedTurnId !== turnId) {
      throw new ThreadTextPageError('Requested offset is outside the active rollout turn', 409)
    }
    return
  }
  throw new ThreadTextPageError('Requested turn boundary was not found', 409)
}

export async function readThreadTextPage(input: {
  sessionPath: string
  threadId: string
  turnId: string
  cursor?: string
  limit?: number
}, options: {
  trustedActiveTurn?: boolean
  trustedSnapshotEndOffset?: number
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
    const collected: ThreadTextPageItem[] = []
    let nextBeforeOffset = beforeOffset
    let pageLimitReached = false
    let foundOlderVisible = false
    let cursorWouldExceedMax = false

    for await (const line of readLinesBackwards(file, beforeOffset)) {
      if (!line.bytes) {
        if (!oversizedLineIsDefinitelyIrrelevant(line.classificationPrefix ?? Buffer.alloc(0))) {
          throw new ThreadTextPageError('Relevant rollout record exceeds the size limit', 413)
        }
        nextBeforeOffset = line.startOffset
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
        continue
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
      if (
        collected.length >= limit
        || candidateBytes >= MAX_PAGE_BYTES
      ) {
        pageLimitReached = true
      }
    }

    const result = buildPageResult({
      threadId: input.threadId,
      turnId: input.turnId,
      itemsBackwards: collected,
      hasMoreOlder: foundOlderVisible && nextBeforeOffset > 0,
      beforeOffset: nextBeforeOffset,
      snapshotEndOffset,
    })
    if (serializedPageBytes(result) > MAX_PAGE_BYTES) {
      throw new ThreadTextPageError('Thread text page exceeds the response size limit', 413)
    }
    return result
  } finally {
    await file.close()
  }
}
