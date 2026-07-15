import { createHash } from 'node:crypto'
import {
  createExternalRuntimeSystem,
  discoverExternalRolloutWriterSnapshot,
  type ExternalRolloutWriter,
  type ExternalRuntimeSystem,
  type RuntimeFileIdentity,
} from './externalThreadRuntime'
import type { NtfyThreadScope } from './ntfyThreadScope'
import { parseRolloutRecord, type ParsedRolloutRecord } from './rolloutLifecycle'

export const EXTERNAL_TURN_SCAN_INTERVAL_MS = 15_000
export const EXTERNAL_TURN_INACTIVE_EXPIRY_MS = 24 * 60 * 60 * 1_000
const READ_CHUNK_BYTES = 64 * 1024
const MAX_TRAILING_BYTES = 256 * 1024
const DEFAULT_CURSOR_LIMIT = 256
const CHECKPOINT_BYTES = 256
const RECENT_TURN_LIMIT = 256
const MAX_TERMINAL_TOMBSTONES = DEFAULT_CURSOR_LIMIT * RECENT_TURN_LIMIT

export type ObservedTurnLifecycle = {
  method: 'turn/started' | 'turn/completed'
  threadId: string
  turnId: string
  status: 'inProgress' | 'completed' | 'interrupted'
  occurredAt: number
  durationMs?: number
}

export type ExternalTurnMonitor = {
  start(): Promise<void>
  dispose(): Promise<void>
}

export type ExternalTurnMonitorOptions = {
  sessionsRoot: string
  excludedPid?: number | null
  getExcludedPid?: () => number | null
  system?: ExternalRuntimeSystem
  scanIntervalMs?: number
  cursorLimit?: number
  inactiveExpiryMs?: number
  now?: () => number
  onLifecycle: (event: ObservedTurnLifecycle) => void | Promise<void>
  warn?: (message: string) => void
  setTimer?: (callback: () => Promise<void>, delayMs: number) => unknown
  clearTimer?: (handle: unknown) => void
}

type RolloutCursor = {
  key: string
  path: string
  dev: string
  ino: string
  offset: number
  trailing: Buffer
  checkpoint: Buffer
  threadId: string
  notificationScope: NtfyThreadScope
  activeTurn: { turnId: string; startedAt: number } | null
  pendingInitialLifecycle: Exclude<ParsedRolloutRecord, { kind: 'session' }> | null
  lastObservedAt: number
  lastFileActivityAt: number
  lastWriterSeenAt: number
}

type RolloutSession = { threadId: string; notificationScope: NtfyThreadScope }

type InitialTail = {
  latestLifecycle: Exclude<ParsedRolloutRecord, { kind: 'session' }> | null
  trailing: Buffer
}

class OversizedTrailingLineError extends Error {}

function identityFor(cursor: RolloutCursor, size: number): RuntimeFileIdentity {
  return { path: cursor.path, dev: cursor.dev, ino: cursor.ino, size }
}

function hasStableIdentity(
  identity: RuntimeFileIdentity & { regular: boolean },
  expected: Pick<RuntimeFileIdentity, 'path' | 'dev' | 'ino'>,
): boolean {
  return identity.regular
    && identity.path === expected.path
    && identity.dev === expected.dev
    && identity.ino === expected.ino
    && Number.isSafeInteger(identity.size)
    && identity.size >= 0
}

export function createExternalTurnMonitor(
  options: ExternalTurnMonitorOptions,
): ExternalTurnMonitor {
  const system = options.system ?? createExternalRuntimeSystem()
  const scanIntervalMs = options.scanIntervalMs ?? EXTERNAL_TURN_SCAN_INTERVAL_MS
  const requestedCursorLimit = options.cursorLimit ?? DEFAULT_CURSOR_LIMIT
  const cursorLimit = Number.isFinite(requestedCursorLimit)
    ? Math.min(DEFAULT_CURSOR_LIMIT, Math.max(1, Math.floor(requestedCursorLimit)))
    : DEFAULT_CURSOR_LIMIT
  const now = options.now ?? Date.now
  const inactiveExpiryMs = options.inactiveExpiryMs ?? EXTERNAL_TURN_INACTIVE_EXPIRY_MS
  const warn = options.warn ?? console.warn
  const setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(() => {
    void callback()
  }, delayMs))
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout))
  const cursors = new Map<string, RolloutCursor>()
  const terminalTombstones = new Set<string>()
  const warned = new Set<string>()

  let monitorStartedAt = 0
  let started = false
  let disposed = false
  let timer: unknown = null
  let activeWork: Promise<void> | null = null

  function warnOnce(message: string): void {
    if (warned.has(message)) return
    warned.add(message)
    warn(message)
  }

  function excludedPid(): number | null {
    return options.getExcludedPid?.() ?? options.excludedPid ?? null
  }

  async function emit(event: ObservedTurnLifecycle): Promise<void> {
    await options.onLifecycle(event)
  }

  function terminalTombstone(cursor: RolloutCursor, turnId: string): string {
    return createHash('sha256')
      .update(cursor.key)
      .update('\0')
      .update(turnId)
      .digest('hex')
  }

  function hasTerminalTombstone(cursor: RolloutCursor, turnId: string): boolean {
    return terminalTombstones.has(terminalTombstone(cursor, turnId))
  }

  function rememberTerminal(cursor: RolloutCursor, turnId: string): void {
    const tombstone = terminalTombstone(cursor, turnId)
    if (terminalTombstones.has(tombstone)) return
    terminalTombstones.add(tombstone)
    while (terminalTombstones.size > MAX_TERMINAL_TOMBSTONES) {
      const oldest = terminalTombstones.values().next().value
      if (oldest) terminalTombstones.delete(oldest)
    }
  }

  async function applyRecord(cursor: RolloutCursor, record: ParsedRolloutRecord): Promise<void> {
    if (record.kind === 'session') {
      if (!cursor.threadId) cursor.threadId = record.threadId
      return
    }
    if (cursor.notificationScope !== 'topLevel') return
    if (!cursor.threadId) return

    if (record.kind === 'started') {
      if (
        cursor.activeTurn?.turnId === record.turnId
        || hasTerminalTombstone(cursor, record.turnId)
      ) return
      await emit({
        method: 'turn/started',
        threadId: cursor.threadId,
        turnId: record.turnId,
        status: 'inProgress',
        occurredAt: record.occurredAt,
      })
      cursor.activeTurn = { turnId: record.turnId, startedAt: record.occurredAt }
      cursor.lastObservedAt = now()
      return
    }

    if (hasTerminalTombstone(cursor, record.turnId)) return

    if (cursor.activeTurn?.turnId === record.turnId) {
      await emit({
        method: 'turn/completed',
        threadId: cursor.threadId,
        turnId: record.turnId,
        status: record.status,
        occurredAt: record.occurredAt,
        ...(record.durationMs === null ? {} : { durationMs: record.durationMs }),
      })
      cursor.activeTurn = null
      rememberTerminal(cursor, record.turnId)
      cursor.lastObservedAt = now()
      return
    }

    const durationMs = record.durationMs
    const reconstructedStart = durationMs === null
      ? null
      : record.occurredAt - durationMs
    if (
      durationMs !== null
      && reconstructedStart !== null
      && record.occurredAt >= monitorStartedAt
      && reconstructedStart <= monitorStartedAt
    ) {
      await emit({
        method: 'turn/started',
        threadId: cursor.threadId,
        turnId: record.turnId,
        status: 'inProgress',
        occurredAt: reconstructedStart,
      })
      cursor.activeTurn = { turnId: record.turnId, startedAt: reconstructedStart }
      cursor.lastObservedAt = now()
      await emit({
        method: 'turn/completed',
        threadId: cursor.threadId,
        turnId: record.turnId,
        status: record.status,
        occurredAt: record.occurredAt,
        durationMs,
      })
      cursor.activeTurn = null
      rememberTerminal(cursor, record.turnId)
      cursor.lastObservedAt = now()
      return
    }
    rememberTerminal(cursor, record.turnId)
  }

  async function applyCompleteLine(cursor: RolloutCursor, bytes: Buffer): Promise<void> {
    const record = parseRolloutRecord(bytes.toString('utf8'))
    if (record) await applyRecord(cursor, record)
  }

  async function applyChunk(cursor: RolloutCursor, chunk: Buffer): Promise<boolean> {
    const bytes = cursor.trailing.length > 0
      ? Buffer.concat([cursor.trailing, chunk])
      : chunk
    let lineStart = 0
    let newline = bytes.indexOf(0x0a)
    while (newline !== -1) {
      await applyCompleteLine(cursor, bytes.subarray(lineStart, newline))
      lineStart = newline + 1
      newline = bytes.indexOf(0x0a, lineStart)
    }
    cursor.trailing = Buffer.from(bytes.subarray(lineStart))
    if (cursor.trailing.length <= MAX_TRAILING_BYTES) return true
    warnOnce('Unable to parse external turn lifecycle')
    return false
  }

  async function readSessionMetadata(identity: RuntimeFileIdentity): Promise<RolloutSession | null> {
    let offset = 0
    let trailing = Buffer.alloc(0)
    const limit = Math.min(identity.size, MAX_TRAILING_BYTES)
    while (offset < limit) {
      const length = Math.min(READ_CHUNK_BYTES, limit - offset)
      const chunk = await system.readRange(identity.path, offset, length, identity)
      if (chunk.length === 0) return null
      offset += chunk.length
      const bytes = trailing.length > 0 ? Buffer.concat([trailing, chunk]) : chunk
      let lineStart = 0
      let newline = bytes.indexOf(0x0a)
      while (newline !== -1) {
        const record = parseRolloutRecord(bytes.subarray(lineStart, newline).toString('utf8'))
        if (record?.kind === 'session') {
          return {
            threadId: record.threadId,
            notificationScope: record.notificationScope,
          }
        }
        lineStart = newline + 1
        newline = bytes.indexOf(0x0a, lineStart)
      }
      trailing = Buffer.from(bytes.subarray(lineStart))
      if (trailing.length > MAX_TRAILING_BYTES) return null
    }
    if (offset === identity.size && trailing.length > 0) {
      const record = parseRolloutRecord(trailing.toString('utf8'))
      if (record?.kind === 'session') {
        return {
          threadId: record.threadId,
          notificationScope: record.notificationScope,
        }
      }
    }
    return null
  }

  async function readInitialTail(identity: RuntimeFileIdentity): Promise<InitialTail> {
    let end = identity.size
    let crossing: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let trailing: Buffer<ArrayBufferLike> | null = null

    while (end > 0) {
      const start = Math.max(0, end - READ_CHUNK_BYTES)
      const chunk = await system.readRange(identity.path, start, end - start, identity)
      if (chunk.length !== end - start) throw new Error('Unable to read external rollout')
      let bytes: Buffer

      if (trailing === null) {
        const lastNewline = chunk.lastIndexOf(0x0a)
        if (lastNewline === -1) {
          crossing = crossing.length > 0 ? Buffer.concat([chunk, crossing]) : Buffer.from(chunk)
          if (crossing.length > MAX_TRAILING_BYTES) throw new OversizedTrailingLineError()
          end = start
          continue
        }
        trailing = Buffer.concat([chunk.subarray(lastNewline + 1), crossing])
        if (trailing.length > MAX_TRAILING_BYTES) throw new OversizedTrailingLineError()
        bytes = chunk.subarray(0, lastNewline + 1)
      } else {
        bytes = crossing.length > 0 ? Buffer.concat([chunk, crossing]) : chunk
      }

      const firstNewline = bytes.indexOf(0x0a)
      if (firstNewline === -1) {
        crossing = bytes
        if (crossing.length > MAX_TRAILING_BYTES) throw new OversizedTrailingLineError()
        end = start
        continue
      }

      const firstCompleteOffset = start === 0 ? 0 : firstNewline + 1
      let lineEnd = bytes.length - 1
      while (lineEnd >= firstCompleteOffset) {
        const previousNewline = bytes.lastIndexOf(0x0a, lineEnd - 1)
        const lineStart = Math.max(firstCompleteOffset, previousNewline + 1)
        const record = parseRolloutRecord(bytes.subarray(lineStart, lineEnd).toString('utf8'))
        if (record?.kind === 'started' || record?.kind === 'terminal') {
          return { latestLifecycle: record, trailing }
        }
        if (previousNewline < firstCompleteOffset) break
        lineEnd = previousNewline
      }

      crossing = Buffer.from(bytes.subarray(0, firstNewline + 1))
      if (crossing.length > MAX_TRAILING_BYTES) throw new OversizedTrailingLineError()
      end = start
    }

    return { latestLifecycle: null, trailing: trailing ?? crossing }
  }

  async function register(writer: ExternalRolloutWriter): Promise<void> {
    const identity = await system.statFile(writer.path)
    if (!hasStableIdentity(identity, writer)) return
    const stableIdentity: RuntimeFileIdentity = {
      path: identity.path,
      dev: identity.dev,
      ino: identity.ino,
      size: identity.size,
    }
    const session = await readSessionMetadata(stableIdentity)
    if (!session) return

    let tail: InitialTail
    try {
      tail = await readInitialTail(stableIdentity)
    } catch (error) {
      if (error instanceof OversizedTrailingLineError) {
        warnOnce('Unable to parse external turn lifecycle')
        return
      }
      throw error
    }
    const revalidated = await system.statFile(writer.path)
    if (!hasStableIdentity(revalidated, stableIdentity) || revalidated.size < stableIdentity.size) return
    const checkpoint = await readCheckpoint(stableIdentity, stableIdentity.size)

    const registeredAt = now()
    const cursor: RolloutCursor = {
      key: `${writer.dev}:${writer.ino}`,
      path: writer.path,
      dev: writer.dev,
      ino: writer.ino,
      offset: stableIdentity.size,
      trailing: tail.trailing,
      checkpoint,
      threadId: session.threadId,
      notificationScope: session.notificationScope,
      activeTurn: null,
      pendingInitialLifecycle: tail.latestLifecycle,
      lastObservedAt: registeredAt,
      lastFileActivityAt: registeredAt,
      lastWriterSeenAt: registeredAt,
    }
    cursors.set(cursor.key, cursor)
    await applyPendingInitialLifecycle(cursor)
    if (revalidated.size > cursor.offset && !await readForward(cursor, revalidated.size)) {
      cursors.delete(cursor.key)
    }
  }

  async function applyPendingInitialLifecycle(cursor: RolloutCursor): Promise<void> {
    const pending = cursor.pendingInitialLifecycle
    if (!pending) return
    await applyRecord(cursor, pending)
    cursor.pendingInitialLifecycle = null
  }

  async function readCheckpoint(
    identity: RuntimeFileIdentity,
    offset: number,
  ): Promise<Buffer> {
    const length = Math.min(CHECKPOINT_BYTES, offset)
    if (length === 0) return Buffer.alloc(0)
    const checkpoint = await system.readRange(
      identity.path,
      offset - length,
      length,
      identity,
    )
    if (checkpoint.length !== length) throw new Error('Unable to read external rollout')
    return Buffer.from(checkpoint)
  }

  async function hasMatchingCheckpoint(
    cursor: RolloutCursor,
    identity: RuntimeFileIdentity,
  ): Promise<boolean> {
    if (cursor.checkpoint.length === 0) return true
    const checkpoint = await system.readRange(
      cursor.path,
      cursor.offset - cursor.checkpoint.length,
      cursor.checkpoint.length,
      identity,
    )
    return checkpoint.equals(cursor.checkpoint)
  }

  function appendCheckpoint(cursor: RolloutCursor, chunk: Buffer): void {
    const bytes = cursor.checkpoint.length > 0
      ? Buffer.concat([cursor.checkpoint, chunk])
      : chunk
    cursor.checkpoint = Buffer.from(bytes.subarray(Math.max(0, bytes.length - CHECKPOINT_BYTES)))
  }

  async function readForward(cursor: RolloutCursor, size: number): Promise<boolean> {
    const identity = identityFor(cursor, size)
    while (cursor.offset < size) {
      const length = Math.min(READ_CHUNK_BYTES, size - cursor.offset)
      const chunk = await system.readRange(cursor.path, cursor.offset, length, identity)
      if (chunk.length === 0) return false
      if (!await applyChunk(cursor, chunk)) return false
      appendCheckpoint(cursor, chunk)
      cursor.offset += chunk.length
    }
    const revalidated = await system.statFile(cursor.path)
    return hasStableIdentity(revalidated, cursor) && revalidated.size >= cursor.offset
  }

  function makeRoomForCursor(): boolean {
    if (cursors.size < cursorLimit) return true
    const inactive = [...cursors.values()]
      .filter((cursor) => !cursor.activeTurn && !cursor.pendingInitialLifecycle)
      .sort((left, right) => left.lastObservedAt - right.lastObservedAt)[0]
    if (!inactive) return false
    cursors.delete(inactive.key)
    return true
  }

  async function scan(): Promise<void> {
    const inconclusiveCursorKeys = new Set<string>()
    for (const cursor of [...cursors.values()]) {
      try {
        const identity = await system.statFile(cursor.path)
        if (
          !hasStableIdentity(identity, cursor)
          || identity.size < cursor.offset
        ) {
          cursors.delete(cursor.key)
          continue
        }
        const stableIdentity = identityFor(cursor, identity.size)
        if (!await hasMatchingCheckpoint(cursor, stableIdentity)) {
          cursors.delete(cursor.key)
          continue
        }
        await applyPendingInitialLifecycle(cursor)
        if (identity.size > cursor.offset) {
          if (!await readForward(cursor, identity.size)) {
            cursors.delete(cursor.key)
          } else {
            cursor.lastFileActivityAt = now()
          }
        }
      } catch {
        inconclusiveCursorKeys.add(cursor.key)
        warnOnce('Unable to inspect tracked external turn lifecycle')
      }
    }

    const discovery = await discoverExternalRolloutWriterSnapshot(
      options.sessionsRoot,
      excludedPid(),
      system,
    )
    const { writers } = discovery
    const writerKeys = new Set(writers.map((writer) => `${writer.dev}:${writer.ino}`))
    const observedAt = now()
    for (const cursor of [...cursors.values()]) {
      if (inconclusiveCursorKeys.has(cursor.key)) continue
      if (writerKeys.has(cursor.key)) {
        cursor.lastWriterSeenAt = observedAt
        continue
      }
      const inactiveSince = Math.max(cursor.lastFileActivityAt, cursor.lastWriterSeenAt)
      if (
        discovery.complete
        && observedAt - inactiveSince >= inactiveExpiryMs
      ) cursors.delete(cursor.key)
    }

    for (const writer of writers) {
      const key = `${writer.dev}:${writer.ino}`
      if (cursors.has(key) || !makeRoomForCursor()) continue
      try {
        await register(writer)
      } catch {
        warnOnce('Unable to register external turn lifecycle')
      }
    }
  }

  async function runAndSchedule(): Promise<void> {
    if (disposed) return
    await scan().catch(() => warnOnce('Unable to inspect external Codex turns'))
    if (!disposed) {
      timer = setTimer(runScheduled, scanIntervalMs)
    }
  }

  async function runScheduled(): Promise<void> {
    if (disposed) return
    timer = null
    const work = runAndSchedule()
    activeWork = work
    try {
      await work
    } finally {
      if (activeWork === work) activeWork = null
    }
  }

  return {
    async start(): Promise<void> {
      if (started || disposed) return
      started = true
      monitorStartedAt = now()
      await runScheduled()
    },
    async dispose(): Promise<void> {
      disposed = true
      if (timer !== null) {
        clearTimer(timer)
        timer = null
      }
      await activeWork
      cursors.clear()
      terminalTombstones.clear()
    },
  }
}
