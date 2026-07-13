import { open, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import type { ExternalThreadRuntime } from '../types/threadRuntime'

export type RuntimeFileIdentity = {
  path: string
  dev: string
  ino: string
  size: number
}

export type RuntimeFdSnapshot = {
  pid: number
  uid: number
  cmdline: string
  dev: string
  ino: string
  position: number
  flags: number
}

export interface ExternalRuntimeSystem {
  readonly platform: NodeJS.Platform
  readonly uid: number | null
  realpath(path: string): Promise<string>
  statFile(path: string): Promise<RuntimeFileIdentity & { regular: boolean }>
  readRange(path: string, offset: number, length: number): Promise<Buffer>
  listFdSnapshots(): AsyncIterable<RuntimeFdSnapshot>
}

type RuntimeParseCache = {
  path: string
  dev: string
  ino: string
  offset: number
  trailingBytes: Buffer
  unmatchedTurnId: string
}

type RegisteredThread = {
  rolloutPath: string
  cache: RuntimeParseCache | null
}

const READ_CHUNK_BYTES = 64 * 1024
const PROCESS_GONE_CODES = new Set(['ENOENT', 'ESRCH'])

class InconclusiveRuntimeScanError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InconclusiveRuntimeScanError'
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function readNonEmptyString(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : ''
}

function applyLifecycleLine(currentTurnId: string, line: string): string {
  const row = asRecord(safeJsonParse(line))
  if (row?.type !== 'event_msg') return currentTurnId
  const payload = asRecord(row.payload)
  const turnId = readNonEmptyString(payload?.turn_id)
  if (payload?.type === 'task_started' && turnId) return turnId
  if (
    (payload?.type === 'task_complete' || payload?.type === 'turn_aborted')
    && turnId === currentTurnId
  ) {
    return ''
  }
  return currentTurnId
}

function errorCode(error: unknown): string {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof error.code === 'string'
    ? error.code
    : ''
}

function isProcessGone(error: unknown): boolean {
  return PROCESS_GONE_CODES.has(errorCode(error))
}

function rethrowProcError(error: unknown, context: string): never {
  if (errorCode(error) === 'EACCES') {
    throw new InconclusiveRuntimeScanError(`Cannot inspect ${context}`)
  }
  throw error
}

async function readProcText(path: string, context: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (isProcessGone(error)) return null
    return rethrowProcError(error, context)
  }
}

async function readProcDirectory(path: string, context: string): Promise<string[] | null> {
  try {
    return await readdir(path)
  } catch (error) {
    if (isProcessGone(error)) return null
    return rethrowProcError(error, context)
  }
}

function parseProcUid(status: string): number | null {
  const match = /^Uid:\s+(\d+)/mu.exec(status)
  if (!match) return null
  const uid = Number.parseInt(match[1], 10)
  return Number.isSafeInteger(uid) ? uid : null
}

function parseFdInfo(fdinfo: string): { position: number; flags: number } | null {
  const positionMatch = /^pos:\s+(\d+)/mu.exec(fdinfo)
  const flagsMatch = /^flags:\s+([0-7]+)/mu.exec(fdinfo)
  if (!positionMatch || !flagsMatch) return null
  const position = Number.parseInt(positionMatch[1], 10)
  const flags = Number.parseInt(flagsMatch[1], 8)
  if (!Number.isSafeInteger(position) || !Number.isSafeInteger(flags)) return null
  return { position, flags }
}

async function statProcFd(path: string): Promise<{ dev: string; ino: string } | null> {
  try {
    const identity = await stat(path)
    return { dev: `${identity.dev}`, ino: `${identity.ino}` }
  } catch (error) {
    if (isProcessGone(error)) return null
    return rethrowProcError(error, path)
  }
}

async function* listLinuxFdSnapshots(): AsyncIterable<RuntimeFdSnapshot> {
  const processEntries = await readProcDirectory('/proc', '/proc')
  if (!processEntries) {
    throw new InconclusiveRuntimeScanError('Cannot inspect /proc')
  }

  for (const entry of processEntries) {
    if (!/^\d+$/u.test(entry)) continue
    const pid = Number.parseInt(entry, 10)
    if (!Number.isSafeInteger(pid)) continue

    const processRoot = `/proc/${entry}`
    const status = await readProcText(`${processRoot}/status`, `process ${pid} status`)
    if (status === null) continue
    const uid = parseProcUid(status)
    if (uid === null) continue

    const cmdline = await readProcText(`${processRoot}/cmdline`, `process ${pid} command`)
    if (cmdline === null) continue

    const fdEntries = await readProcDirectory(`${processRoot}/fd`, `process ${pid} descriptors`)
    if (fdEntries === null) continue
    for (const fd of fdEntries) {
      if (!/^\d+$/u.test(fd)) continue
      const fdPath = `${processRoot}/fd/${fd}`
      const fdinfo = await readProcText(
        `${processRoot}/fdinfo/${fd}`,
        `process ${pid} descriptor ${fd}`,
      )
      if (fdinfo === null) continue
      const descriptor = parseFdInfo(fdinfo)
      if (!descriptor) continue
      const identity = await statProcFd(fdPath)
      if (!identity) continue
      yield {
        pid,
        uid,
        cmdline,
        dev: identity.dev,
        ino: identity.ino,
        position: descriptor.position,
        flags: descriptor.flags,
      }
    }
  }
}

function createDefaultSystem(): ExternalRuntimeSystem {
  return {
    platform: process.platform,
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    realpath,
    async statFile(path) {
      const identity = await stat(path)
      return {
        path,
        dev: `${identity.dev}`,
        ino: `${identity.ino}`,
        size: identity.size,
        regular: identity.isFile(),
      }
    },
    async readRange(path, offset, length) {
      const handle = await open(path, 'r')
      try {
        const buffer = Buffer.allocUnsafe(length)
        const { bytesRead } = await handle.read(buffer, 0, length, offset)
        return buffer.subarray(0, bytesRead)
      } finally {
        await handle.close()
      }
    },
    listFdSnapshots: listLinuxFdSnapshots,
  }
}

function isContainedPath(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate)
  return pathFromRoot.length > 0
    && pathFromRoot !== '..'
    && !pathFromRoot.startsWith(`..${sep}`)
    && !isAbsolute(pathFromRoot)
}

function resetCache(identity: RuntimeFileIdentity): RuntimeParseCache {
  return {
    path: identity.path,
    dev: identity.dev,
    ino: identity.ino,
    offset: 0,
    trailingBytes: Buffer.alloc(0),
    unmatchedTurnId: '',
  }
}

function copyCache(cache: RuntimeParseCache): RuntimeParseCache {
  return {
    ...cache,
    trailingBytes: Buffer.from(cache.trailingBytes),
  }
}

function applyChunk(cache: RuntimeParseCache, chunk: Buffer): void {
  const bytes = cache.trailingBytes.length > 0
    ? Buffer.concat([cache.trailingBytes, chunk])
    : chunk
  let lineStart = 0
  let newline = bytes.indexOf(0x0a, lineStart)
  while (newline !== -1) {
    cache.unmatchedTurnId = applyLifecycleLine(
      cache.unmatchedTurnId,
      bytes.subarray(lineStart, newline).toString('utf8'),
    )
    lineStart = newline + 1
    newline = bytes.indexOf(0x0a, lineStart)
  }
  cache.trailingBytes = Buffer.from(bytes.subarray(lineStart))
}

function matchesWriter(
  fd: RuntimeFdSnapshot,
  identity: RuntimeFileIdentity,
  uid: number,
  excludedPid: number | null,
): boolean {
  const accessMode = fd.flags & 0b11
  const isWritable = accessMode === 1 || accessMode === 2
  return fd.uid === uid
    && fd.pid !== excludedPid
    && /(?:^|[\s/])codex(?:\s+app-server|$)/u.test(fd.cmdline.replace(/\0/g, ' '))
    && fd.dev === identity.dev
    && fd.ino === identity.ino
    && isWritable
    && fd.position > 0
}

export class ExternalThreadRuntimeProbe {
  private readonly sessionsRoot: string
  private readonly system: ExternalRuntimeSystem
  private readonly threads = new Map<string, RegisteredThread>()

  constructor(options: { sessionsRoot: string; system?: ExternalRuntimeSystem }) {
    this.sessionsRoot = options.sessionsRoot
    this.system = options.system ?? createDefaultSystem()
  }

  registerThread(threadId: string, rolloutPath: string): void {
    const current = this.threads.get(threadId)
    if (current?.rolloutPath === rolloutPath) return
    this.threads.set(threadId, { rolloutPath, cache: null })
  }

  async inspect(threadId: string, excludedPid: number | null): Promise<ExternalThreadRuntime> {
    const thread = this.threads.get(threadId)
    if (!thread || this.system.platform !== 'linux' || this.system.uid === null) {
      return { state: 'unknown' }
    }

    try {
      const [resolvedSessionsRoot, resolvedPath] = await Promise.all([
        this.system.realpath(this.sessionsRoot),
        this.system.realpath(thread.rolloutPath),
      ])
      if (!isContainedPath(resolvedSessionsRoot, resolvedPath)) {
        return { state: 'unknown' }
      }

      const identity = await this.system.statFile(resolvedPath)
      if (
        !identity.regular
        || identity.path !== resolvedPath
        || !Number.isSafeInteger(identity.size)
        || identity.size < 0
      ) {
        return { state: 'unknown' }
      }

      const cached = thread.cache
      const mustReset = !cached
        || cached.path !== identity.path
        || cached.dev !== identity.dev
        || cached.ino !== identity.ino
        || identity.size < cached.offset
      const nextCache = mustReset ? resetCache(identity) : copyCache(cached)

      while (nextCache.offset < identity.size) {
        const length = Math.min(READ_CHUNK_BYTES, identity.size - nextCache.offset)
        const bytes = await this.system.readRange(resolvedPath, nextCache.offset, length)
        const chunk = bytes.subarray(0, length)
        if (chunk.length === 0) return { state: 'unknown' }
        applyChunk(nextCache, chunk)
        nextCache.offset += chunk.length
      }
      thread.cache = nextCache

      if (!nextCache.unmatchedTurnId) return { state: 'idle' }

      for await (const fd of this.system.listFdSnapshots()) {
        if (matchesWriter(fd, identity, this.system.uid, excludedPid)) {
          return {
            state: 'running',
            turnId: nextCache.unmatchedTurnId,
            interruptible: false,
            source: 'external-session-writer',
          }
        }
      }
      return { state: 'idle' }
    } catch {
      return { state: 'unknown' }
    }
  }

  clear(): void {
    this.threads.clear()
  }
}
