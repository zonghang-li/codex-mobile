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

export class ThreadTextPageError extends Error {
  readonly statusCode: 400 | 409

  constructor(message: string, statusCode: 400 | 409) {
    super(message)
    this.name = 'ThreadTextPageError'
    this.statusCode = statusCode
  }
}

type BackwardsLine = {
  startOffset: number
  bytes: Buffer | null
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
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function decodeCursor(
  encoded: string,
  threadId: string,
  turnId: string,
): ThreadTextCursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) {
      throw new Error('invalid base64url')
    }
    const cursor = asRecord(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')))
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

  const prependFragment = (fragment: Buffer): void => {
    if (oversized || fragment.length === 0) return
    fragmentBytes += fragment.length
    if (fragmentBytes > MAX_RELEVANT_LINE_BYTES) {
      oversized = true
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
        yield { startOffset, bytes: null }
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
      fragmentEnd = index
    }
    prependFragment(chunk.subarray(0, fragmentEnd))
    position = chunkStart
  }

  if (oversized) {
    yield { startOffset: 0, bytes: null }
  } else if (fragmentBytes > 0) {
    yield {
      startOffset: 0,
      bytes: fragments.length === 1
        ? fragments[0]!
        : Buffer.concat(fragments, fragmentBytes),
    }
  }
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

export async function readThreadTextPage(input: {
  sessionPath: string
  threadId: string
  turnId: string
  cursor?: string
  limit?: number
}): Promise<ThreadTextPageResult> {
  const file = await open(input.sessionPath, 'r')
  try {
    const fileStats = await file.stat()
    const cursor = input.cursor
      ? decodeCursor(input.cursor, input.threadId, input.turnId)
      : null
    const snapshotEndOffset = cursor?.snapshotEndOffset ?? fileStats.size
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

    const limit = normalizeLimit(input.limit)
    const collected: ThreadTextPageItem[] = []
    let collectedBytes = 0
    let nextBeforeOffset = beforeOffset
    let reachedTurnStart = false
    let stoppedAtPageBoundary = false

    for await (const line of readLinesBackwards(file, beforeOffset)) {
      if (!line.bytes) {
        nextBeforeOffset = line.startOffset
        continue
      }
      const projected = projectLine(line.bytes, line.startOffset)
      if (projected.taskStartedTurnId === input.turnId) {
        reachedTurnStart = true
        break
      }
      if (!projected.item) {
        nextBeforeOffset = line.startOffset
        continue
      }

      const itemBytes = Buffer.byteLength(JSON.stringify(projected.item), 'utf8')
      if (
        collected.length > 0
        && collectedBytes + itemBytes > TARGET_PAGE_BYTES
      ) {
        stoppedAtPageBoundary = true
        break
      }

      collected.push(projected.item)
      collectedBytes += itemBytes
      nextBeforeOffset = line.startOffset
      if (
        collected.length >= limit
        || collectedBytes >= MAX_PAGE_BYTES
      ) {
        stoppedAtPageBoundary = true
        break
      }
    }

    const hasMoreOlder = stoppedAtPageBoundary
      && !reachedTurnStart
      && nextBeforeOffset > 0
    return {
      threadId: input.threadId,
      turnId: input.turnId,
      items: collected.reverse(),
      nextOlderCursor: hasMoreOlder
        ? encodeCursor({
            v: 1,
            threadId: input.threadId,
            turnId: input.turnId,
            beforeOffset: nextBeforeOffset,
            snapshotEndOffset,
          })
        : null,
      hasMoreOlder,
    }
  } finally {
    await file.close()
  }
}
