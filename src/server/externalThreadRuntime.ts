import { open, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, sep } from 'node:path'
import type { ExternalThreadRuntime } from '../types/threadRuntime'

export type RuntimeFileIdentity = {
  path: string
  dev: string
  ino: string
  size: number
  mtimeMs?: number
}

export type RuntimeFdSnapshot = {
  path: string
  pid: number
  startTime?: string
  ancestorPids: number[]
  uid: number
  cmdline: string
  dev: string
  ino: string
  position: number
  flags: number
}

export type ExternalRolloutWriter = {
  path: string
  dev: string
  ino: string
  size: number
  pid: number
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
  listFdSnapshots(): AsyncGenerator<RuntimeFdSnapshot, boolean | void, void>
  signalProcess(pid: number, signal: NodeJS.Signals, expectedStartTime?: string): Promise<void>
}

type RuntimeParseCache = {
  path: string
  dev: string
  ino: string
  offset: number
  trailingBytes: Buffer
  unmatchedTurnId: string
  runtimeCwd: string
  durableRuntimeCwd: string
  checkpointBytes: Buffer
}

type RegisteredThread = {
  rolloutPath: string
  cache: RuntimeParseCache | null
}

type PreparedRuntimeInspection =
  | { state: 'idle'; cwd?: string }
  | { state: 'unknown' }
  | {
      state: 'unmatched'
      turnId: string
      cwd: string
      identity: RuntimeFileIdentity
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
export const EXTERNAL_RUNTIME_MAX_NUMERIC_PROCESSES = 16_384
export const EXTERNAL_RUNTIME_MAX_DESCRIPTORS_PER_APP_SERVER = 4_096
export const EXTERNAL_RUNTIME_MAX_FD_SNAPSHOTS = 8_192
export const EXTERNAL_RUNTIME_SCAN_WALL_BUDGET_MS = 5_000
export const EXTERNAL_RUNTIME_MAX_ROLLOUT_WRITERS = 256
export const EXTERNAL_RUNTIME_RECENT_ACTIVE_ROLLOUT_MS = 15 * 60 * 1000

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

function readTurnIdFromRecord(row: Record<string, unknown>): string {
  const payload = asRecord(row.payload)
  const directTurnId = readNonEmptyString(payload?.turn_id)
  if (directTurnId) return directTurnId
  return readNonEmptyString(asRecord(payload?.internal_chat_message_metadata_passthrough)?.turn_id)
}

function readExecCommandWorkdir(row: Record<string, unknown>, currentTurnId: string): string {
  if (row.type !== 'response_item') return ''
  const payload = asRecord(row.payload)
  if (payload?.type !== 'function_call' || payload.name !== 'exec_command') return ''
  const turnId = readTurnIdFromRecord(row)
  if (currentTurnId && turnId && turnId !== currentTurnId) return ''
  const args = asRecord(safeJsonParse(readNonEmptyString(payload.arguments)))
  const workdir = readNonEmptyString(args?.workdir).trim()
  return isAbsolute(workdir) ? workdir : ''
}

function readApplyPatchTargetDirectory(input: string): string {
  let fallbackDirectory = ''
  let worktreeDirectory = ''
  for (const rawLine of input.split(/\r?\n/u)) {
    const line = rawLine.trim()
    const match = /^\*\*\* (?:Add File|Delete File|Update File|Move to): (.+)$/u.exec(line)
    const path = match?.[1]?.trim() ?? ''
    if (!isAbsolute(path)) continue
    const directory = dirname(path)
    fallbackDirectory = directory
    if (directory.includes(`${sep}.worktrees${sep}`)) {
      worktreeDirectory = directory
    }
  }
  return worktreeDirectory || fallbackDirectory
}

function isWorktreeRuntimeCwd(cwd: string): boolean {
  return cwd.includes(`${sep}.worktrees${sep}`)
}

function containsPath(parent: string, child: string): boolean {
  if (!parent || !child) return false
  const pathFromParent = relative(parent, child)
  return pathFromParent === ''
    || (
      pathFromParent.length > 0
      && pathFromParent !== '..'
      && !pathFromParent.startsWith(`..${sep}`)
      && !isAbsolute(pathFromParent)
    )
}

function preferRuntimeCwd(candidate: string, current: string): string {
  if (!candidate) return current
  if (!current) return candidate

  const candidateIsWorktree = isWorktreeRuntimeCwd(candidate)
  const currentIsWorktree = isWorktreeRuntimeCwd(current)
  if (candidateIsWorktree && !currentIsWorktree) return candidate
  if (!candidateIsWorktree && currentIsWorktree && containsPath(candidate, current)) {
    return current
  }
  return candidate
}

function readToolTargetCwd(row: Record<string, unknown>, currentTurnId: string): string {
  if (row.type !== 'response_item') return ''
  const payload = asRecord(row.payload)
  if (!payload) return ''
  const payloadType = readNonEmptyString(payload.type)
  if (payloadType !== 'custom_tool_call' && payloadType !== 'function_call') return ''
  if (payload.name !== 'apply_patch') return ''
  const turnId = readTurnIdFromRecord(row)
  if (currentTurnId && turnId && turnId !== currentTurnId) return ''
  const directInput = readNonEmptyString(payload.input)
  const argumentInput = readNonEmptyString(asRecord(safeJsonParse(readNonEmptyString(payload.arguments)))?.input)
  const targetDirectory = readApplyPatchTargetDirectory(directInput || argumentInput)
  return isAbsolute(targetDirectory) ? targetDirectory : ''
}

function readTurnContextCwd(row: Record<string, unknown>, currentTurnId: string): string {
  if (row.type !== 'turn_context') return ''
  const payload = asRecord(row.payload)
  const turnId = readNonEmptyString(payload?.turn_id)
  if (currentTurnId && turnId !== currentTurnId) return ''
  const cwd = readNonEmptyString(payload?.cwd).trim()
  return isAbsolute(cwd) ? cwd : ''
}

function applyLifecycleLine(
  current: { turnId: string; cwd: string; durableCwd: string },
  line: string,
): { turnId: string; cwd: string; durableCwd: string } {
  const row = asRecord(safeJsonParse(line))
  if (!row) return current

  const execWorkdir = readExecCommandWorkdir(row, current.turnId)
  if (execWorkdir) return { ...current, cwd: execWorkdir }

  const toolTargetCwd = readToolTargetCwd(row, current.turnId)
  if (toolTargetCwd) {
    const durableCwd = preferRuntimeCwd(toolTargetCwd, current.durableCwd)
    return { ...current, cwd: preferRuntimeCwd(toolTargetCwd, current.cwd), durableCwd }
  }

  const contextCwd = readTurnContextCwd(row, current.turnId)
  if (contextCwd && !current.cwd) return { ...current, cwd: contextCwd }

  if (row.type !== 'event_msg') return current
  const payload = asRecord(row.payload)
  const turnId = readNonEmptyString(payload?.turn_id)
  if (payload?.type === 'task_started' && turnId) {
    return { turnId, cwd: '', durableCwd: current.durableCwd }
  }
  if (
    (payload?.type === 'task_complete' || payload?.type === 'turn_aborted')
    && turnId === current.turnId
  ) {
    return { turnId: '', cwd: '', durableCwd: current.durableCwd }
  }
  return current
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

async function realpathProcFd(path: string): Promise<string | null> {
  try {
    return await realpath(path)
  } catch (error) {
    if (isProcessGone(error)) return null
    return rethrowProcError(error, path)
  }
}

async function readStableFdSnapshot(
  processRoot: string,
  pid: number,
  fd: string,
): Promise<(
  { path: string; dev: string; ino: string }
  & { position: number; flags: number }
) | null> {
  const fdPath = `${processRoot}/fd/${fd}`
  const identityBefore = await statProcFd(fdPath)
  if (!identityBefore) return null
  const fdinfoBefore = await readProcText(
    `${processRoot}/fdinfo/${fd}`,
    `process ${pid} descriptor ${fd}`,
  )
  if (fdinfoBefore === null) return null
  const descriptorBefore = parseFdInfo(fdinfoBefore)
  const identityBetween = await statProcFd(fdPath)
  if (!identityBetween) return null
  const path = await realpathProcFd(fdPath)
  if (path === null) return null
  const fdinfoAfter = await readProcText(
    `${processRoot}/fdinfo/${fd}`,
    `process ${pid} descriptor ${fd}`,
  )
  if (fdinfoAfter === null) return null
  const descriptorAfter = parseFdInfo(fdinfoAfter)
  const identityAfter = await statProcFd(fdPath)
  if (!identityAfter) return null
  if (
    identityBefore.dev !== identityBetween.dev
    || identityBefore.ino !== identityBetween.ino
    || identityBetween.dev !== identityAfter.dev
    || identityBetween.ino !== identityAfter.ino
  ) {
    throw new InconclusiveRuntimeScanError('Descriptor identity changed during inspection')
  }
  if (descriptorBefore.flags !== descriptorAfter.flags) {
    throw new InconclusiveRuntimeScanError('Descriptor flags changed during inspection')
  }
  return { path, ...identityAfter, ...descriptorAfter }
}

function readCodexCommandArgs(cmdline: string): string[] | null {
  const argv = cmdline.split('\0').filter((value) => value.length > 0)
  const codexIndex = argv.findIndex((value) => basename(value) === 'codex')
  if (codexIndex < 0) return null
  if (codexIndex > 0 && !(codexIndex === 1 && basename(argv[0] ?? '').startsWith('node'))) return null
  return argv.slice(codexIndex + 1)
}

function isCodexAppServerCommand(cmdline: string): boolean {
  return readCodexSubcommand(readCodexCommandArgs(cmdline)) === 'app-server'
}

function isDirectCodexCliCommand(cmdline: string): boolean {
  const args = readCodexCommandArgs(cmdline)
  return args !== null && readCodexSubcommand(args) !== 'app-server'
}

const CODEX_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  '-c', '--config', '-m', '--model', '-p', '--profile', '-s', '--sandbox',
  '-C', '--cd', '--add-dir', '--color', '--output-schema', '-i', '--image',
])

function readCodexSubcommand(args: string[] | null): string | null {
  if (!args) return null
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? ''
    if (argument === '--') return null
    if (!argument.startsWith('-')) return argument
    const optionName = argument.includes('=') ? argument.slice(0, argument.indexOf('=')) : argument
    if (CODEX_GLOBAL_OPTIONS_WITH_VALUE.has(optionName) && !argument.includes('=')) index += 1
  }
  return null
}

function isCodexRolloutWriterCommand(cmdline: string): boolean {
  return isCodexAppServerCommand(cmdline) || isDirectCodexCliCommand(cmdline)
}

async function* listLinuxFdSnapshots(
  ownUid: number | null,
  now: () => number,
): AsyncGenerator<RuntimeFdSnapshot, boolean, void> {
  const scanStartedAt = now()
  const hasTimeRemaining = (): boolean => {
    const elapsed = now() - scanStartedAt
    return elapsed >= 0 && elapsed < EXTERNAL_RUNTIME_SCAN_WALL_BUDGET_MS
  }
  if (!hasTimeRemaining()) return false
  const processEntries = await readProcDirectory('/proc', '/proc')
  if (!processEntries) {
    throw new InconclusiveRuntimeScanError('Cannot inspect /proc')
  }

  const processes = new Map<number, LinuxProcessRecord>()
  let numericProcessCount = 0
  let complete = true
  for (const entry of processEntries) {
    if (!/^\d+$/u.test(entry)) continue
    if (numericProcessCount >= EXTERNAL_RUNTIME_MAX_NUMERIC_PROCESSES) {
      complete = false
      break
    }
    numericProcessCount += 1
    if (!hasTimeRemaining()) return false
    const pid = Number.parseInt(entry, 10)
    if (!Number.isSafeInteger(pid)) continue

    const process = await readStableProcessRecord(`/proc/${entry}`, pid, ownUid)
    if (!hasTimeRemaining()) return false
    if (process) processes.set(pid, process)
  }

  let yieldedSnapshots = 0
  for (const process of processes.values()) {
    if (yieldedSnapshots >= EXTERNAL_RUNTIME_MAX_FD_SNAPSHOTS || !hasTimeRemaining()) return false
    const { pid, uid, cmdline } = process
    if (uid !== ownUid || !isCodexRolloutWriterCommand(cmdline)) continue
    const processRoot = `/proc/${pid}`
    const ancestorPids = collectAncestorPids(pid, processes)
    if (!(await validateProcessChain(process, ancestorPids, processes))) continue
    if (!hasTimeRemaining()) return false
    const fdEntries = await readProcDirectory(`${processRoot}/fd`, `process ${pid} descriptors`)
    if (fdEntries === null) continue
    const snapshots: RuntimeFdSnapshot[] = []
    let numericDescriptorCount = 0
    for (const fd of fdEntries) {
      if (!/^\d+$/u.test(fd)) continue
      if (numericDescriptorCount >= EXTERNAL_RUNTIME_MAX_DESCRIPTORS_PER_APP_SERVER) {
        complete = false
        break
      }
      numericDescriptorCount += 1
      if (!hasTimeRemaining()) return false
      const descriptor = await readStableFdSnapshot(processRoot, pid, fd)
      if (!hasTimeRemaining()) return false
      if (!descriptor) continue
      snapshots.push({
        path: descriptor.path,
        pid,
        startTime: process.startTime,
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
    if (!hasTimeRemaining()) return false
    for (const snapshot of snapshots) {
      if (yieldedSnapshots >= EXTERNAL_RUNTIME_MAX_FD_SNAPSHOTS || !hasTimeRemaining()) return false
      yieldedSnapshots += 1
      yield snapshot
    }
  }
  return complete
}

export function createExternalRuntimeSystem(
  options: { now?: () => number } = {},
): ExternalRuntimeSystem {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  const now = options.now ?? Date.now
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
        mtimeMs: typeof identity.mtimeMs === 'bigint'
          ? Number(identity.mtimeMs)
          : typeof identity.mtimeMs === 'number'
            ? identity.mtimeMs
            : undefined,
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
    listFdSnapshots: () => listLinuxFdSnapshots(uid, now),
    async signalProcess(pid, signal, expectedStartTime) {
      if (expectedStartTime) {
        const actualStartTime = await readProcStartTime(`/proc/${pid}`, pid)
        if (actualStartTime === null) {
          const error = new Error(`Process ${pid} disappeared before signal`)
          ;(error as NodeJS.ErrnoException).code = 'ESRCH'
          throw error
        }
        assertStableProcessIdentity(expectedStartTime, actualStartTime)
      }
      process.kill(pid, signal)
    },
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
    runtimeCwd: '',
    durableRuntimeCwd: '',
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
    const next = applyLifecycleLine(
      {
        turnId: cache.unmatchedTurnId,
        cwd: cache.runtimeCwd,
        durableCwd: cache.durableRuntimeCwd,
      },
      bytes.subarray(lineStart, newline).toString('utf8'),
    )
    cache.unmatchedTurnId = next.turnId
    cache.runtimeCwd = next.cwd
    cache.durableRuntimeCwd = next.durableCwd
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
  return fd.uid === uid
    && typeof fd.startTime === 'string'
    && fd.startTime.length > 0
    && !belongsToExcludedProcessTree(fd, excludedPid)
    && isCodexRolloutWriterCommand(fd.cmdline)
    && fd.dev === identity.dev
    && fd.ino === identity.ino
    && isWritableDescriptor(fd.flags)
    && fd.position > 0
}

function isWritableDescriptor(flags: number): boolean {
  const accessMode = flags & 0b11
  return accessMode === 1 || accessMode === 2
}

function isRecentActiveRollout(identity: RuntimeFileIdentity, nowMs = Date.now()): boolean {
  if (typeof identity.mtimeMs !== 'number' || !Number.isFinite(identity.mtimeMs)) return false
  const ageMs = nowMs - identity.mtimeMs
  return ageMs >= 0 && ageMs <= EXTERNAL_RUNTIME_RECENT_ACTIVE_ROLLOUT_MS
}

function runningRuntimeFromUnmatched(
  runtime: Extract<PreparedRuntimeInspection, { state: 'unmatched' }>,
  interruptible: boolean,
): ExternalThreadRuntime {
  return {
    state: 'running',
    turnId: runtime.turnId,
    interruptible,
    source: 'external-session-writer',
    ...(runtime.cwd ? { cwd: runtime.cwd } : {}),
  }
}

function idleRuntimeFromPrepared(
  runtime: Extract<PreparedRuntimeInspection, { state: 'idle' }>,
): ExternalThreadRuntime {
  return {
    state: 'idle',
    ...(runtime.cwd ? { cwd: runtime.cwd } : {}),
  }
}

function isSameRuntimeIdentity(
  first: RuntimeFileIdentity,
  second: RuntimeFileIdentity,
): boolean {
  return first.path === second.path &&
    first.dev === second.dev &&
    first.ino === second.ino
}

function belongsToExcludedProcessTree(
  fd: RuntimeFdSnapshot,
  excludedPid: number | null,
): boolean {
  return excludedPid !== null
    && (fd.pid === excludedPid || fd.ancestorPids.includes(excludedPid))
}

export type ExternalRolloutWriterSnapshot = {
  writers: ExternalRolloutWriter[]
  complete: boolean
}

export async function discoverExternalRolloutWriterSnapshot(
  sessionsRoot: string,
  excludedPid: number | null,
  system: ExternalRuntimeSystem = createExternalRuntimeSystem(),
): Promise<ExternalRolloutWriterSnapshot> {
  if (system.platform !== 'linux' || system.uid === null) {
    return { writers: [], complete: true }
  }
  const canonicalRoot = await system.realpath(sessionsRoot)
  const writers = new Map<string, ExternalRolloutWriter>()
  const iterator = system.listFdSnapshots()[Symbol.asyncIterator]()
  let complete = true

  while (true) {
    const next = await iterator.next()
    if (next.done) {
      complete = complete && next.value !== false
      break
    }
    const fd = next.value
    if (fd.uid !== system.uid || belongsToExcludedProcessTree(fd, excludedPid)) continue
    if (!isCodexRolloutWriterCommand(fd.cmdline) || !isWritableDescriptor(fd.flags)) continue
    let path: string
    try {
      path = await system.realpath(fd.path)
    } catch {
      complete = false
      continue
    }
    if (!path.endsWith('.jsonl') || !isContainedPath(canonicalRoot, path)) continue
    let identity: RuntimeFileIdentity & { regular: boolean }
    try {
      identity = await system.statFile(path)
    } catch {
      complete = false
      continue
    }
    if (!identity.regular || identity.dev !== fd.dev || identity.ino !== fd.ino) continue
    const key = `${identity.dev}:${identity.ino}`
    if (!writers.has(key)) {
      writers.set(key, {
        path,
        dev: identity.dev,
        ino: identity.ino,
        size: identity.size,
        pid: fd.pid,
      })
      if (writers.size >= EXTERNAL_RUNTIME_MAX_ROLLOUT_WRITERS) {
        complete = false
        await iterator.return?.()
        break
      }
    }
  }

  return { writers: [...writers.values()], complete }
}

export async function discoverExternalRolloutWriters(
  sessionsRoot: string,
  excludedPid: number | null,
  system: ExternalRuntimeSystem = createExternalRuntimeSystem(),
): Promise<ExternalRolloutWriter[]> {
  return (await discoverExternalRolloutWriterSnapshot(
    sessionsRoot,
    excludedPid,
    system,
  )).writers
}

export class ExternalThreadRuntimeProbe {
  private readonly sessionsRoot: string
  private readonly system: ExternalRuntimeSystem
  private readonly threads = new Map<string, RegisteredThread>()

  constructor(options: { sessionsRoot: string; system?: ExternalRuntimeSystem }) {
    this.sessionsRoot = options.sessionsRoot
    this.system = options.system ?? createExternalRuntimeSystem()
  }

  registerThread(threadId: string, rolloutPath: string): void {
    const current = this.threads.get(threadId)
    if (current?.rolloutPath === rolloutPath) return
    this.threads.set(threadId, { rolloutPath, cache: null })
  }

  async inspectMany(
    threadIds: readonly string[],
    excludedPid: number | null,
    options: { verifyRecentActive?: boolean } = {},
  ): Promise<Record<string, ExternalThreadRuntime>> {
    const uniqueIds = [...new Set(threadIds)]
    const prepared = await Promise.all(uniqueIds.map(async (threadId) => ({
      threadId,
      runtime: await this.prepareInspection(threadId),
    })))
    const states: Record<string, ExternalThreadRuntime> = Object.create(null)
    const unmatched = prepared.filter((entry) => entry.runtime.state === 'unmatched')

    for (const entry of prepared) {
      if (entry.runtime.state === 'idle') states[entry.threadId] = idleRuntimeFromPrepared(entry.runtime)
      if (entry.runtime.state === 'unknown') states[entry.threadId] = { state: 'unknown' }
    }
    const unmatchedNeedingWriterEvidence = unmatched.filter((entry) => {
      const runtime = entry.runtime
      if (runtime.state !== 'unmatched') return false
      if (options.verifyRecentActive || !isRecentActiveRollout(runtime.identity)) return true
      states[entry.threadId] = runningRuntimeFromUnmatched(runtime, false)
      return false
    })
    if (unmatchedNeedingWriterEvidence.length === 0) return states

    try {
      const writers = new Map<string, boolean>()
      let complete = true
      const iterator = this.system.listFdSnapshots()[Symbol.asyncIterator]()
      while (true) {
        const next = await iterator.next()
        if (next.done) {
          complete = next.value !== false
          break
        }
        const fd = next.value
        for (const entry of unmatchedNeedingWriterEvidence) {
          const runtime = entry.runtime
          if (runtime.state !== 'unmatched') continue
          if (matchesWriter(fd, runtime.identity, this.system.uid!, excludedPid)) {
            const interruptible = isCodexAppServerCommand(fd.cmdline)
            writers.set(
              entry.threadId,
              (writers.get(entry.threadId) ?? true) && interruptible,
            )
          }
        }
      }
      for (const entry of unmatchedNeedingWriterEvidence) {
        const runtime = entry.runtime
        if (runtime.state !== 'unmatched') continue
        states[entry.threadId] = complete && writers.has(entry.threadId)
          ? runningRuntimeFromUnmatched(runtime, writers.get(entry.threadId) === true)
          : isRecentActiveRollout(runtime.identity)
            ? runningRuntimeFromUnmatched(runtime, false)
            : { state: 'unknown' }
      }
    } catch {
      for (const entry of unmatchedNeedingWriterEvidence) states[entry.threadId] = { state: 'unknown' }
    }
    return states
  }

  async inspect(threadId: string, excludedPid: number | null): Promise<ExternalThreadRuntime> {
    const states = await this.inspectMany([threadId], excludedPid, { verifyRecentActive: true })
    return states[threadId] ?? { state: 'unknown' }
  }

  async interrupt(
    threadId: string,
    turnId: string,
    excludedPid: number | null,
  ): Promise<{ interrupted: boolean; reason?: string }> {
    const normalizedTurnId = turnId.trim()
    if (!normalizedTurnId || this.system.uid === null) {
      return { interrupted: false, reason: 'writer-not-found' }
    }

    const runtime = await this.prepareInspection(threadId)
    if (runtime.state !== 'unmatched') {
      return {
        interrupted: false,
        reason: runtime.state === 'idle' ? 'turn-not-running' : 'writer-not-found',
      }
    }
    if (runtime.turnId !== normalizedTurnId) {
      return { interrupted: false, reason: 'turn-mismatch' }
    }

    const writer = await this.findSingleInterruptWriter(runtime, excludedPid)
    if ('reason' in writer) return { interrupted: false, reason: writer.reason }

    const revalidatedRuntime = await this.prepareInspection(threadId)
    if (revalidatedRuntime.state !== 'unmatched') {
      return {
        interrupted: false,
        reason: revalidatedRuntime.state === 'idle' ? 'turn-not-running' : 'writer-not-found',
      }
    }
    if (revalidatedRuntime.turnId !== normalizedTurnId) {
      return { interrupted: false, reason: 'turn-mismatch' }
    }
    if (!isSameRuntimeIdentity(runtime.identity, revalidatedRuntime.identity)) {
      return { interrupted: false, reason: 'writer-not-found' }
    }

    const revalidatedWriter = await this.findSingleInterruptWriter(
      revalidatedRuntime,
      excludedPid,
      writer.fd,
    )
    if ('reason' in revalidatedWriter) return { interrupted: false, reason: revalidatedWriter.reason }

    const pid = revalidatedWriter.fd.pid
    const expectedStartTime = revalidatedWriter.fd.startTime ?? writer.fd.startTime
    try {
      await this.system.signalProcess(pid, 'SIGTERM', expectedStartTime)
    } catch (error) {
      if (isProcessGone(error)) return { interrupted: false, reason: 'writer-not-found' }
      throw error
    }
    return { interrupted: true }
  }

  private async findSingleInterruptWriter(
    runtime: Extract<PreparedRuntimeInspection, { state: 'unmatched' }>,
    excludedPid: number | null,
    expectedWriter?: RuntimeFdSnapshot,
  ): Promise<{ fd: RuntimeFdSnapshot } | { reason: string }> {
    const writerFds: RuntimeFdSnapshot[] = []
    let hasNonInterruptibleWriter = false
    let complete = true
    const iterator = this.system.listFdSnapshots()[Symbol.asyncIterator]()
    try {
      while (true) {
        const next = await iterator.next()
        if (next.done) {
          complete = next.value !== false
          break
        }
        const fd = next.value
        if (!matchesWriter(fd, runtime.identity, this.system.uid!, excludedPid)) continue
        if (!isCodexAppServerCommand(fd.cmdline)) {
          hasNonInterruptibleWriter = true
          continue
        }
        if (expectedWriter) {
          if (fd.pid !== expectedWriter.pid) continue
          if (expectedWriter.startTime && fd.startTime !== expectedWriter.startTime) continue
        }
        writerFds.push(fd)
      }
    } catch {
      return { reason: 'writer-not-found' }
    }
    if (!complete) return { reason: 'writer-not-found' }
    if (hasNonInterruptibleWriter) return { reason: 'non-interruptible-writer' }

    const writerPids = new Set(writerFds.map((fd) => fd.pid))
    if (writerPids.size === 0) return { reason: 'writer-not-found' }
    if (writerPids.size > 1) return { reason: 'ambiguous-writer' }

    const [pid] = writerPids
    const expectedStartTimes = new Set(
      writerFds
        .filter((fd) => fd.pid === pid && fd.startTime)
        .map((fd) => fd.startTime),
    )
    if (expectedStartTimes.size > 1) return { reason: 'ambiguous-writer' }
    const [expectedStartTime] = expectedStartTimes
    const fd = writerFds.find((candidate) => candidate.startTime === expectedStartTime) ?? writerFds[0]
    return { fd }
  }

  private async prepareInspection(threadId: string): Promise<PreparedRuntimeInspection> {
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

      if (!nextCache.unmatchedTurnId) {
        return {
          state: 'idle',
          ...(nextCache.durableRuntimeCwd ? { cwd: nextCache.durableRuntimeCwd } : {}),
        }
      }
      return {
        state: 'unmatched',
        turnId: nextCache.unmatchedTurnId,
        cwd: preferRuntimeCwd(nextCache.runtimeCwd, nextCache.durableRuntimeCwd),
        identity: {
          path: revalidatedIdentity.path,
          dev: revalidatedIdentity.dev,
          ino: revalidatedIdentity.ino,
          size: revalidatedIdentity.size,
          ...(revalidatedIdentity.mtimeMs === undefined ? {} : { mtimeMs: revalidatedIdentity.mtimeMs }),
        },
      }
    } catch {
      return { state: 'unknown' }
    }
  }

  clear(): void {
    this.threads.clear()
  }
}
