import { open, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, sep } from 'node:path'
import type { ExternalThreadRuntime } from '../types/threadRuntime'

export type RuntimeFileIdentity = {
  path: string
  dev: string
  ino: string
  size: number
}

export type RuntimeFdSnapshot = {
  pid: number
  ancestorPids: number[]
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
  readRange(
    path: string,
    offset: number,
    length: number,
    expectedIdentity: RuntimeFileIdentity,
  ): Promise<Buffer>
  listFdSnapshots(): AsyncIterable<RuntimeFdSnapshot>
}

type RuntimeParseCache = {
  path: string
  dev: string
  ino: string
  offset: number
  trailingBytes: Buffer
  unmatchedTurnId: string
  checkpointBytes: Buffer
}

type RegisteredThread = {
  rolloutPath: string
  cache: RuntimeParseCache | null
}

type LinuxProcessRecord = {
  pid: number
  parentPid: number
  uid: number
  cmdline: string
  startTime: string
}

const READ_CHUNK_BYTES = 64 * 1024
const CACHE_CHECKPOINT_BYTES = 256
const MAX_PROCESS_ANCESTRY_DEPTH = 128
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

function parseProcUid(status: string): number {
  const match = /^Uid:\s+(\d+)/mu.exec(status)
  if (!match) {
    throw new InconclusiveRuntimeScanError('Cannot parse process UID')
  }
  const uid = Number.parseInt(match[1], 10)
  if (!Number.isSafeInteger(uid)) {
    throw new InconclusiveRuntimeScanError('Cannot parse process UID')
  }
  return uid
}

function parseProcParentPid(status: string): number {
  const match = /^PPid:\s+(\d+)/mu.exec(status)
  if (!match) throw new InconclusiveRuntimeScanError('Cannot parse process parent PID')
  const parentPid = Number.parseInt(match[1], 10)
  if (!Number.isSafeInteger(parentPid) || parentPid < 0) {
    throw new InconclusiveRuntimeScanError('Cannot parse process parent PID')
  }
  return parentPid
}

function parseProcStartTime(stat: string, expectedPid: number): string {
  const openParen = stat.indexOf('(')
  const closeParen = stat.lastIndexOf(')')
  if (openParen <= 0 || closeParen <= openParen) {
    throw new InconclusiveRuntimeScanError('Cannot parse process identity')
  }

  const pidToken = stat.slice(0, openParen).trim()
  const pid = /^\d+$/u.test(pidToken) ? Number.parseInt(pidToken, 10) : Number.NaN
  const fieldsFromState = stat.slice(closeParen + 1).trim().split(/\s+/u)
  const startTime = fieldsFromState[19]
  if (
    !Number.isSafeInteger(pid)
    || pid !== expectedPid
    || !/^\S$/u.test(fieldsFromState[0] ?? '')
    || !/^\d+$/u.test(startTime ?? '')
  ) {
    throw new InconclusiveRuntimeScanError('Cannot parse process identity')
  }
  return BigInt(startTime).toString()
}

async function readProcStartTime(processRoot: string, pid: number): Promise<string | null> {
  const stat = await readProcText(`${processRoot}/stat`, `process ${pid} identity`)
  return stat === null ? null : parseProcStartTime(stat, pid)
}

function assertStableProcessIdentity(
  expectedStartTime: string,
  actualStartTime: string,
): void {
  if (actualStartTime !== expectedStartTime) {
    throw new InconclusiveRuntimeScanError('Process identity changed during inspection')
  }
}

async function readStableProcessRecord(
  processRoot: string,
  pid: number,
  commandUid: number | null,
): Promise<LinuxProcessRecord | null> {
  const startTime = await readProcStartTime(processRoot, pid)
  if (startTime === null) return null
  const status = await readProcText(`${processRoot}/status`, `process ${pid} status`)
  if (status === null) return null
  const uid = parseProcUid(status)
  const parentPid = parseProcParentPid(status)

  let cmdline = ''
  if (commandUid !== null && uid === commandUid) {
    const value = await readProcText(`${processRoot}/cmdline`, `process ${pid} command`)
    if (value === null) return null
    cmdline = value
  }

  const confirmedStartTime = await readProcStartTime(processRoot, pid)
  if (confirmedStartTime === null) return null
  assertStableProcessIdentity(startTime, confirmedStartTime)
  return { pid, parentPid, uid, cmdline, startTime }
}

function assertStableProcessRecord(
  expected: LinuxProcessRecord,
  actual: LinuxProcessRecord,
  includeCandidateMetadata: boolean,
): void {
  if (
    actual.pid !== expected.pid
    || actual.startTime !== expected.startTime
    || actual.parentPid !== expected.parentPid
    || (includeCandidateMetadata
      && (actual.uid !== expected.uid || actual.cmdline !== expected.cmdline))
  ) {
    throw new InconclusiveRuntimeScanError('Process metadata changed during inspection')
  }
}

async function validateProcessChain(
  candidate: LinuxProcessRecord,
  ancestorPids: readonly number[],
  processes: ReadonlyMap<number, LinuxProcessRecord>,
): Promise<boolean> {
  const records = [
    candidate,
    ...ancestorPids
      .filter((pid) => pid !== 1)
      .map((pid) => processes.get(pid)),
  ]
  if (records.some((record) => !record)) {
    throw new InconclusiveRuntimeScanError('Cannot resolve process ancestry')
  }

  for (const [index, expected] of records.entries()) {
    if (!expected) continue
    const actual = await readStableProcessRecord(
      `/proc/${expected.pid}`,
      expected.pid,
      index === 0 ? candidate.uid : null,
    )
    if (!actual) return false
    assertStableProcessRecord(expected, actual, index === 0)
  }
  return true
}

function collectAncestorPids(
  pid: number,
  processes: ReadonlyMap<number, LinuxProcessRecord>,
): number[] {
  const ancestors: number[] = []
  const seen = new Set([pid])
  let current = processes.get(pid)?.parentPid ?? 0
  for (let depth = 0; current > 0 && depth < MAX_PROCESS_ANCESTRY_DEPTH; depth += 1) {
    if (seen.has(current)) {
      throw new InconclusiveRuntimeScanError('Process ancestry contains a cycle')
    }
    ancestors.push(current)
    if (current === 1) return ancestors
    seen.add(current)
    const parent = processes.get(current)
    if (!parent) {
      throw new InconclusiveRuntimeScanError('Cannot resolve process ancestry')
    }
    current = parent.parentPid
  }
  if (current > 0) {
    throw new InconclusiveRuntimeScanError('Process ancestry exceeds the depth limit')
  }
  return ancestors
}

function parseFdInfo(fdinfo: string): { position: number; flags: number } {
  const positionMatch = /^pos:\s+(\d+)/mu.exec(fdinfo)
  const flagsMatch = /^flags:\s+([0-7]+)/mu.exec(fdinfo)
  if (!positionMatch || !flagsMatch) {
    throw new InconclusiveRuntimeScanError('Cannot parse descriptor evidence')
  }
  const position = Number.parseInt(positionMatch[1], 10)
  const flags = Number.parseInt(flagsMatch[1], 8)
  if (!Number.isSafeInteger(position) || !Number.isSafeInteger(flags)) {
    throw new InconclusiveRuntimeScanError('Cannot parse descriptor evidence')
  }
  return { position, flags }
}

async function statProcFd(path: string): Promise<{ dev: string; ino: string } | null> {
  try {
    const identity = await stat(path, { bigint: true })
    return { dev: `${identity.dev}`, ino: `${identity.ino}` }
  } catch (error) {
    if (isProcessGone(error)) return null
    return rethrowProcError(error, path)
  }
}

async function readStableFdSnapshot(
  processRoot: string,
  pid: number,
  fd: string,
): Promise<({ dev: string; ino: string } & { position: number; flags: number }) | null> {
  const fdPath = `${processRoot}/fd/${fd}`
  const identityBefore = await statProcFd(fdPath)
  if (!identityBefore) return null
  const fdinfo = await readProcText(
    `${processRoot}/fdinfo/${fd}`,
    `process ${pid} descriptor ${fd}`,
  )
  if (fdinfo === null) return null
  const descriptor = parseFdInfo(fdinfo)
  const identityAfter = await statProcFd(fdPath)
  if (!identityAfter) return null
  if (
    identityBefore.dev !== identityAfter.dev
    || identityBefore.ino !== identityAfter.ino
  ) {
    throw new InconclusiveRuntimeScanError('Descriptor identity changed during inspection')
  }
  return { ...identityAfter, ...descriptor }
}

function isCodexAppServerCommand(cmdline: string): boolean {
  const argv = cmdline.split('\0').filter((value) => value.length > 0)
  const codexIndex = argv.findIndex((value) => basename(value) === 'codex')
  return codexIndex >= 0 && argv.slice(codexIndex + 1).includes('app-server')
}

async function* listLinuxFdSnapshots(ownUid: number | null): AsyncIterable<RuntimeFdSnapshot> {
  const processEntries = await readProcDirectory('/proc', '/proc')
  if (!processEntries) {
    throw new InconclusiveRuntimeScanError('Cannot inspect /proc')
  }

  const processes = new Map<number, LinuxProcessRecord>()
  for (const entry of processEntries) {
    if (!/^\d+$/u.test(entry)) continue
    const pid = Number.parseInt(entry, 10)
    if (!Number.isSafeInteger(pid)) continue

    const process = await readStableProcessRecord(`/proc/${entry}`, pid, ownUid)
    if (process) processes.set(pid, process)
  }

  for (const process of processes.values()) {
    const { pid, uid, cmdline } = process
    if (uid !== ownUid || !isCodexAppServerCommand(cmdline)) continue
    const processRoot = `/proc/${pid}`
    const ancestorPids = collectAncestorPids(pid, processes)
    if (!(await validateProcessChain(process, ancestorPids, processes))) continue
    const fdEntries = await readProcDirectory(`${processRoot}/fd`, `process ${pid} descriptors`)
    if (fdEntries === null) continue
    const snapshots: RuntimeFdSnapshot[] = []
    for (const fd of fdEntries) {
      if (!/^\d+$/u.test(fd)) continue
      const descriptor = await readStableFdSnapshot(processRoot, pid, fd)
      if (!descriptor) continue
      snapshots.push({
        pid,
        ancestorPids,
        uid,
        cmdline,
        dev: descriptor.dev,
        ino: descriptor.ino,
        position: descriptor.position,
        flags: descriptor.flags,
      })
    }
    if (!(await validateProcessChain(process, ancestorPids, processes))) continue
    yield* snapshots
  }
}

function createDefaultSystem(): ExternalRuntimeSystem {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  return {
    platform: process.platform,
    uid,
    realpath,
    async statFile(path) {
      const identity = await stat(path, { bigint: true })
      return {
        path,
        dev: `${identity.dev}`,
        ino: `${identity.ino}`,
        size: Number(identity.size),
        regular: identity.isFile(),
      }
    },
    async readRange(path, offset, length, expectedIdentity) {
      const handle = await open(path, 'r')
      try {
        const openedIdentity = await handle.stat({ bigint: true })
        if (
          path !== expectedIdentity.path
          || `${openedIdentity.dev}` !== expectedIdentity.dev
          || `${openedIdentity.ino}` !== expectedIdentity.ino
        ) {
          throw new InconclusiveRuntimeScanError('Opened rollout identity does not match expected')
        }
        const buffer = Buffer.allocUnsafe(length)
        const { bytesRead } = await handle.read(buffer, 0, length, offset)
        return buffer.subarray(0, bytesRead)
      } finally {
        await handle.close()
      }
    },
    listFdSnapshots: () => listLinuxFdSnapshots(uid),
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
    checkpointBytes: Buffer.alloc(0),
  }
}

function copyCache(cache: RuntimeParseCache): RuntimeParseCache {
  return {
    ...cache,
    trailingBytes: Buffer.from(cache.trailingBytes),
    checkpointBytes: Buffer.from(cache.checkpointBytes),
  }
}

function appendCheckpointBytes(cache: RuntimeParseCache, chunk: Buffer): void {
  const combined = cache.checkpointBytes.length > 0
    ? Buffer.concat([cache.checkpointBytes, chunk])
    : chunk
  cache.checkpointBytes = Buffer.from(combined.subarray(
    Math.max(0, combined.length - CACHE_CHECKPOINT_BYTES),
  ))
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
    && !belongsToExcludedProcessTree(fd, excludedPid)
    && isCodexAppServerCommand(fd.cmdline)
    && fd.dev === identity.dev
    && fd.ino === identity.ino
    && isWritable
    && fd.position > 0
}

function belongsToExcludedProcessTree(
  fd: RuntimeFdSnapshot,
  excludedPid: number | null,
): boolean {
  return excludedPid !== null
    && (fd.pid === excludedPid || fd.ancestorPids.includes(excludedPid))
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
      let mustReset = !cached
        || cached.path !== identity.path
        || cached.dev !== identity.dev
        || cached.ino !== identity.ino
        || identity.size < cached.offset
      if (!mustReset && cached && cached.checkpointBytes.length > 0) {
        const checkpointOffset = cached.offset - cached.checkpointBytes.length
        const currentCheckpoint = await this.system.readRange(
          resolvedPath,
          checkpointOffset,
          cached.checkpointBytes.length,
          identity,
        )
        if (!currentCheckpoint.equals(cached.checkpointBytes)) {
          mustReset = true
        }
      }
      const nextCache = mustReset || !cached ? resetCache(identity) : copyCache(cached)

      while (nextCache.offset < identity.size) {
        const length = Math.min(READ_CHUNK_BYTES, identity.size - nextCache.offset)
        const bytes = await this.system.readRange(
          resolvedPath,
          nextCache.offset,
          length,
          identity,
        )
        const chunk = bytes.subarray(0, length)
        if (chunk.length === 0) return { state: 'unknown' }
        appendCheckpointBytes(nextCache, chunk)
        applyChunk(nextCache, chunk)
        nextCache.offset += chunk.length
      }

      const revalidatedIdentity = await this.system.statFile(resolvedPath)
      if (
        !revalidatedIdentity.regular
        || revalidatedIdentity.path !== identity.path
        || revalidatedIdentity.dev !== identity.dev
        || revalidatedIdentity.ino !== identity.ino
        || revalidatedIdentity.size < nextCache.offset
      ) {
        return { state: 'unknown' }
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
