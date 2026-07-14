import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createExternalRuntimeSystem,
  discoverExternalRolloutWriters,
  EXTERNAL_RUNTIME_MAX_DESCRIPTORS_PER_APP_SERVER,
  EXTERNAL_RUNTIME_MAX_FD_SNAPSHOTS,
  EXTERNAL_RUNTIME_MAX_NUMERIC_PROCESSES,
  EXTERNAL_RUNTIME_SCAN_WALL_BUDGET_MS,
  EXTERNAL_RUNTIME_MAX_ROLLOUT_WRITERS,
  ExternalThreadRuntimeProbe,
  type ExternalRuntimeSystem,
  type RuntimeFdSnapshot,
  type RuntimeFileIdentity,
} from './externalThreadRuntime'

const nodeFs = vi.hoisted(() => ({
  open: vi.fn(),
  readdir: vi.fn(),
  readFile: vi.fn(),
  realpath: vi.fn(),
  stat: vi.fn(),
}))

vi.mock('node:fs/promises', () => nodeFs)

const sessionsRoot = '/sessions'
const rolloutPath = '/sessions/2026/07/rollout-thread-1.jsonl'

function lifecycle(type: 'task_started' | 'task_complete' | 'turn_aborted', turnId: string): string {
  return `${JSON.stringify({
    type: 'event_msg',
    payload: { type, turn_id: turnId },
  })}\n`
}

function writerFd(overrides: Partial<RuntimeFdSnapshot> = {}): RuntimeFdSnapshot {
  return {
    path: rolloutPath,
    pid: 42,
    ancestorPids: [],
    uid: 1000,
    cmdline: '/usr/local/bin/codex\0app-server\0',
    dev: '8',
    ino: '21',
    position: 10,
    flags: 0o100001,
    ...overrides,
  }
}

type FakeRuntimeOptions = {
  log?: string | Buffer
  rollouts?: FakeRollout[]
  fds?: RuntimeFdSnapshot[]
  platform?: NodeJS.Platform
  uid?: number | null
  resolvedSessionsRoot?: string
  resolvedRolloutPath?: string
  regular?: boolean
  scanError?: Error
  replacementDuringRead?: { log: string; ino: string }
  abaReplacementDuringRead?: { log: string; dev: string; ino: string }
}

type FakeRollout = {
  path: string
  log: string
  dev: string
  ino: string
}

type MutableFakeRollout = Omit<FakeRollout, 'log'> & { bytes: Buffer }

class FakeRuntimeSystem implements ExternalRuntimeSystem {
  readonly platform: NodeJS.Platform
  readonly uid: number | null
  readonly readCalls: Array<{ path: string; offset: number; length: number }> = []
  scanCount = 0
  snapshotYieldCount = 0

  private readonly rollouts: Map<string, MutableFakeRollout>
  private readonly fds: RuntimeFdSnapshot[]
  private readonly resolvedSessionsRoot: string
  private readonly resolvedRolloutPath: string
  private readonly regular: boolean
  private readonly scanError: Error | undefined
  private replacementDuringRead: { log: string; ino: string } | undefined
  private abaReplacementDuringRead: { log: string; dev: string; ino: string } | undefined

  constructor(options: FakeRuntimeOptions = {}) {
    this.platform = options.platform ?? 'linux'
    this.uid = options.uid === undefined ? 1000 : options.uid
    this.fds = options.fds ?? []
    this.resolvedSessionsRoot = options.resolvedSessionsRoot ?? sessionsRoot
    this.resolvedRolloutPath = options.resolvedRolloutPath ?? rolloutPath
    const rollouts: MutableFakeRollout[] = options.rollouts
      ? options.rollouts.map((rollout) => ({
          path: rollout.path,
          bytes: Buffer.from(rollout.log),
          dev: rollout.dev,
          ino: rollout.ino,
        }))
      : [{
          path: this.resolvedRolloutPath,
          bytes: Buffer.isBuffer(options.log)
            ? Buffer.from(options.log)
            : Buffer.from(options.log ?? ''),
          dev: '8',
          ino: '21',
        }]
    this.rollouts = new Map(rollouts.map((rollout) => [rollout.path, rollout]))
    this.regular = options.regular ?? true
    this.scanError = options.scanError
    this.replacementDuringRead = options.replacementDuringRead
    this.abaReplacementDuringRead = options.abaReplacementDuringRead
  }

  async realpath(path: string): Promise<string> {
    if (path === sessionsRoot) return this.resolvedSessionsRoot
    if (path === rolloutPath) return this.resolvedRolloutPath
    return path
  }

  async statFile(path: string): Promise<RuntimeFileIdentity & { regular: boolean }> {
    const rollout = this.rollout(path)
    return {
      path,
      dev: rollout.dev,
      ino: rollout.ino,
      size: rollout.bytes.length,
      regular: this.regular,
    }
  }

  async readRange(
    path: string,
    offset: number,
    length: number,
    expectedIdentity: RuntimeFileIdentity,
  ): Promise<Buffer> {
    this.readCalls.push({ path, offset, length })
    const rollout = this.rollout(path)
    if (this.abaReplacementDuringRead) {
      const replacement = this.abaReplacementDuringRead
      this.abaReplacementDuringRead = undefined
      if (
        replacement.dev !== expectedIdentity.dev
        || replacement.ino !== expectedIdentity.ino
      ) {
        throw new Error('Opened rollout identity does not match expected identity')
      }
      const replacementBytes = Buffer.from(replacement.log)
      return replacementBytes.subarray(offset, Math.min(offset + length, replacementBytes.length))
    }
    if (this.replacementDuringRead) {
      const replacement = this.replacementDuringRead
      this.replacementDuringRead = undefined
      rollout.bytes = Buffer.from(replacement.log)
      rollout.ino = replacement.ino
    }
    return rollout.bytes.subarray(offset, Math.min(offset + length, rollout.bytes.length))
  }

  async *listFdSnapshots(): AsyncIterable<RuntimeFdSnapshot> {
    this.scanCount += 1
    if (this.scanError) throw this.scanError
    for (const fd of this.fds) {
      this.snapshotYieldCount += 1
      yield fd
    }
  }

  append(value: string | Buffer): void {
    const rollout = this.rollout(this.resolvedRolloutPath)
    rollout.bytes = Buffer.concat([
      rollout.bytes,
      Buffer.isBuffer(value) ? value : Buffer.from(value),
    ])
  }

  truncate(value: string): void {
    this.rollout(this.resolvedRolloutPath).bytes = Buffer.from(value)
  }

  replace(value: string, ino?: string): void {
    const rollout = this.rollout(this.resolvedRolloutPath)
    rollout.bytes = Buffer.from(value)
    rollout.ino = ino ?? `${Number(rollout.ino) + 1}`
  }

  private rollout(path: string): MutableFakeRollout {
    const rollout = this.rollouts.get(path)
    if (!rollout) throw new Error(`Unknown fake rollout: ${path}`)
    return rollout
  }
}

describe('discoverExternalRolloutWriters', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('discovers one canonical same-user external rollout writer', async () => {
    const system = fakeRuntimeSystem({ fds: [writerFd()] })

    await expect(discoverExternalRolloutWriters(sessionsRoot, 900, system)).resolves.toEqual([
      { path: rolloutPath, dev: '8', ino: '21', size: 0, pid: 42 },
    ])
    expect(system.scanCount).toBe(1)
  })

  it('deduplicates descriptors for the same device and inode', async () => {
    const system = fakeRuntimeSystem({
      fds: [writerFd({ pid: 42 }), writerFd({ pid: 43 })],
    })

    await expect(discoverExternalRolloutWriters(sessionsRoot, null, system)).resolves.toEqual([
      { path: rolloutPath, dev: '8', ino: '21', size: 0, pid: 42 },
    ])
  })

  it.each([
    ['safe app-server PID', { pid: 900 }],
    ['safe app-server descendant', { pid: 901, ancestorPids: [900, 1] }],
    ['different user', { uid: 1001 }],
    ['read-only descriptor', { flags: 0o100000 }],
    ['non-Codex command', { cmdline: '/usr/bin/node\0server.js\0' }],
  ] satisfies Array<[string, Partial<RuntimeFdSnapshot>]>) (
    'rejects a %s',
    async (_label, overrides) => {
      const system = fakeRuntimeSystem({ fds: [writerFd(overrides)] })

      await expect(discoverExternalRolloutWriters(sessionsRoot, 900, system)).resolves.toEqual([])
    },
  )

  it('rejects writers outside the canonical sessions root', async () => {
    const outsidePath = '/tmp/outside.jsonl'
    const system = fakeRuntimeSystem({
      rollouts: [{ path: outsidePath, log: '', dev: '8', ino: '21' }],
      fds: [writerFd({ path: outsidePath })],
    })

    await expect(discoverExternalRolloutWriters(sessionsRoot, null, system)).resolves.toEqual([])
  })

  it('rejects non-JSONL files', async () => {
    const textPath = '/sessions/2026/07/rollout-thread-1.txt'
    const system = fakeRuntimeSystem({
      rollouts: [{ path: textPath, log: '', dev: '8', ino: '21' }],
      fds: [writerFd({ path: textPath })],
    })

    await expect(discoverExternalRolloutWriters(sessionsRoot, null, system)).resolves.toEqual([])
  })

  it('rejects non-regular files', async () => {
    const system = fakeRuntimeSystem({ regular: false, fds: [writerFd()] })

    await expect(discoverExternalRolloutWriters(sessionsRoot, null, system)).resolves.toEqual([])
  })

  it('rejects a descriptor whose target identity does not match', async () => {
    const system = fakeRuntimeSystem({ fds: [writerFd({ ino: '22' })] })

    await expect(discoverExternalRolloutWriters(sessionsRoot, null, system)).resolves.toEqual([])
  })

  it('discovers the canonical target resolved from a stable proc descriptor', async () => {
    defaultRuntimeProbe()

    await expect(discoverExternalRolloutWriters(sessionsRoot, 99)).resolves.toEqual([
      {
        path: rolloutPath,
        dev: '8',
        ino: '21',
        size: Buffer.byteLength(lifecycle('task_started', 'turn-a')),
        pid: 42,
      },
    ])
    expect(nodeFs.realpath).toHaveBeenCalledWith('/proc/42/fd/7')
  })

  it('returns at most 256 unique rollout writers and stops consuming snapshots', async () => {
    const rollouts = Array.from({ length: 276 }, (_, index) => ({
      path: `/sessions/${index}.jsonl`,
      log: '',
      dev: '8',
      ino: `${index + 1}`,
    }))
    const system = fakeRuntimeSystem({
      rollouts,
      fds: rollouts.map((rollout, index) => writerFd({
        path: rollout.path,
        ino: rollout.ino,
        pid: index + 10,
      })),
    })

    const writers = await discoverExternalRolloutWriters(sessionsRoot, null, system)

    expect(EXTERNAL_RUNTIME_MAX_ROLLOUT_WRITERS).toBe(256)
    expect(writers).toHaveLength(256)
    expect(system.snapshotYieldCount).toBe(256)
  })
})

describe('default Linux descriptor discovery work caps', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('inspects no more than the numeric process cap', async () => {
    const pids = Array.from({ length: 16_385 }, (_, index) => index + 2)
    const uid = typeof process.getuid === 'function' ? process.getuid() : 1000
    nodeFs.readdir.mockImplementation(async (path: string) => {
      if (path === '/proc') return pids.map(String)
      throw new Error(`Unexpected readdir: ${path}`)
    })
    nodeFs.readFile.mockImplementation(async (path: string) => {
      const match = /^\/proc\/(\d+)\/(stat|status|cmdline)$/u.exec(path)
      if (!match) throw new Error(`Unexpected readFile: ${path}`)
      const pid = Number.parseInt(match[1], 10)
      if (match[2] === 'stat') {
        return procStat({ pid, parentPid: 0, cmdline: '', fds: [] }, BigInt(pid) * 1_000n)
      }
      if (match[2] === 'status') return `Name:\tother\nPPid:\t0\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`
      return '/usr/bin/other\0'
    })
    const system = createExternalRuntimeSystem({ now: () => 0 })

    for await (const _snapshot of system.listFdSnapshots()) { /* no candidates */ }

    expect(EXTERNAL_RUNTIME_MAX_NUMERIC_PROCESSES).toBe(16_384)
    const excludedPid = pids.at(-1)
    expect(nodeFs.readFile).not.toHaveBeenCalledWith(`/proc/${excludedPid}/stat`, 'utf8')
  })

  it('inspects no more than the descriptor cap for one app-server', async () => {
    const fds = Array.from(
      { length: 4_097 },
      (_, index) => `${index + 3}`,
    )
    defaultRuntimeProbe({ processes: [{
      pid: 42,
      parentPid: 0,
      cmdline: '/usr/local/bin/codex\0app-server\0',
      fds,
    }] })
    const system = createExternalRuntimeSystem({ now: () => 0 })
    let snapshots = 0

    for await (const _snapshot of system.listFdSnapshots()) snapshots += 1

    expect(EXTERNAL_RUNTIME_MAX_DESCRIPTORS_PER_APP_SERVER).toBe(4_096)
    expect(snapshots).toBe(4_096)
    expect(nodeFs.stat).not.toHaveBeenCalledWith(`/proc/42/fd/${fds.at(-1)}`, { bigint: true })
  })

  it('yields no more than the global snapshot cap', async () => {
    const processes = Array.from({ length: 3 }, (_, processIndex): DefaultRuntimeProcessFixture => ({
      pid: 42 + processIndex,
      parentPid: 0,
      cmdline: '/usr/local/bin/codex\0app-server\0',
      fds: Array.from(
        { length: 4_096 },
        (_, fdIndex) => `${processIndex * 4_096 + fdIndex + 3}`,
      ),
    }))
    defaultRuntimeProbe({ processes })
    const system = createExternalRuntimeSystem({ now: () => 0 })
    let snapshots = 0

    for await (const _snapshot of system.listFdSnapshots()) snapshots += 1

    expect(EXTERNAL_RUNTIME_MAX_FD_SNAPSHOTS).toBe(8_192)
    expect(snapshots).toBe(8_192)
  })

  it('returns partial results when the scan wall budget is exhausted', async () => {
    defaultRuntimeProbe({ processes: [{
      pid: 42,
      parentPid: 0,
      cmdline: '/usr/local/bin/codex\0app-server\0',
      fds: ['3', '4'],
    }] })
    let current = 0
    const system = createExternalRuntimeSystem({
      now: () => {
        const value = current
        current += 5_000
        return value
      },
    })
    const snapshots: RuntimeFdSnapshot[] = []

    for await (const snapshot of system.listFdSnapshots()) snapshots.push(snapshot)

    expect(EXTERNAL_RUNTIME_SCAN_WALL_BUDGET_MS).toBe(5_000)
    expect(snapshots).toEqual([])
    expect(nodeFs.stat).not.toHaveBeenCalled()
  })
})

function fakeRuntimeSystem(options: FakeRuntimeOptions = {}): FakeRuntimeSystem {
  return new FakeRuntimeSystem(options)
}

function registeredProbe(system: ExternalRuntimeSystem): ExternalThreadRuntimeProbe {
  const probe = new ExternalThreadRuntimeProbe({ sessionsRoot, system })
  probe.registerThread('thread-1', rolloutPath)
  return probe
}

function batchProbe(
  rollouts: FakeRollout[],
  fds: RuntimeFdSnapshot[],
): { probe: ExternalThreadRuntimeProbe; system: FakeRuntimeSystem } {
  const system = fakeRuntimeSystem({ rollouts, fds })
  const probe = new ExternalThreadRuntimeProbe({ sessionsRoot, system })
  for (const rollout of rollouts) {
    probe.registerThread(rollout.path.split('/').at(-1)!, rollout.path)
  }
  return { probe, system }
}

type DefaultRuntimeProcessFixture = {
  pid: number
  parentPid: number
  cmdline: string
  fds: string[]
  uid?: number
  statStartTimes?: bigint[]
  statusReads?: string[]
  cmdlineReads?: string[]
}

type DefaultRuntimeFixture = {
  log?: string
  openedLog?: string
  rolloutDev?: bigint
  rolloutIno?: bigint
  openedDev?: bigint
  openedIno?: bigint
  fdDev?: bigint
  fdIno?: bigint
  status?: string
  fdinfo?: string
  fdinfoReads?: string[]
  fdIdentities?: Array<{ dev: bigint; ino: bigint }>
  fdStatGoneAt?: number[]
  processes?: DefaultRuntimeProcessFixture[]
}

function procStat(process: DefaultRuntimeProcessFixture, startTime: bigint): string {
  const fieldsFromStateThroughStartTime = Array<string>(20).fill('0')
  fieldsFromStateThroughStartTime[0] = 'S'
  fieldsFromStateThroughStartTime[1] = `${process.parentPid}`
  fieldsFromStateThroughStartTime[19] = `${startTime}`
  return `${process.pid} (codex worker (native)) ${fieldsFromStateThroughStartTime.join(' ')}\n`
}

function defaultRuntimeProbe(fixture: DefaultRuntimeFixture = {}): ExternalThreadRuntimeProbe {
  const log = Buffer.from(fixture.log ?? lifecycle('task_started', 'turn-a'))
  const openedLog = Buffer.from(fixture.openedLog ?? log)
  const rolloutDev = fixture.rolloutDev ?? 8n
  const rolloutIno = fixture.rolloutIno ?? 21n
  const openedDev = fixture.openedDev ?? rolloutDev
  const openedIno = fixture.openedIno ?? rolloutIno
  const fdDev = fixture.fdDev ?? rolloutDev
  const fdIno = fixture.fdIno ?? rolloutIno
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000
  const processes = fixture.processes ?? [{
    pid: 42,
    parentPid: 1,
    cmdline: '/usr/local/bin/codex\0app-server\0',
    fds: ['7'],
  }]
  const statReadCounts = new Map<number, number>()
  const statusReadCounts = new Map<number, number>()
  const cmdlineReadCounts = new Map<number, number>()
  let fdIdentityReadCount = 0
  let fdinfoReadCount = 0

  function readSequence<T>(values: T[], index: number): T {
    return values[Math.min(index, values.length - 1)]
  }

  nodeFs.realpath.mockImplementation(async (path: string) => (
    path.startsWith('/proc/') ? rolloutPath : path
  ))
  nodeFs.stat.mockImplementation(async (path: string, options?: { bigint?: boolean }) => {
    const isProcFd = path.startsWith('/proc/')
    const identityReadIndex = isProcFd ? fdIdentityReadCount++ : -1
    if (isProcFd && fixture.fdStatGoneAt?.includes(identityReadIndex)) {
      throw Object.assign(new Error('descriptor disappeared'), { code: 'ENOENT' })
    }
    const fdIdentity = isProcFd && fixture.fdIdentities
      ? readSequence(fixture.fdIdentities, identityReadIndex)
      : null
    const dev = path === rolloutPath ? rolloutDev : (fdIdentity?.dev ?? fdDev)
    const ino = path === rolloutPath ? rolloutIno : (fdIdentity?.ino ?? fdIno)
    if (options?.bigint) {
      return {
        dev,
        ino,
        size: BigInt(log.length),
        isFile: () => true,
      }
    }
    return {
      dev: Number(dev),
      ino: Number(ino),
      size: log.length,
      isFile: () => true,
    }
  })
  nodeFs.open.mockResolvedValue({
    async read(buffer: Buffer, bufferOffset: number, length: number, position: number) {
      const bytes = openedLog.subarray(position, position + length)
      bytes.copy(buffer, bufferOffset)
      return { bytesRead: bytes.length, buffer }
    },
    async stat() {
      return {
        dev: openedDev,
        ino: openedIno,
        size: BigInt(openedLog.length),
        isFile: () => true,
      }
    },
    async close() {},
  })
  nodeFs.readdir.mockImplementation(async (path: string) => {
    if (path === '/proc') return processes.map(({ pid }) => `${pid}`)
    const process = processes.find(({ pid }) => path === `/proc/${pid}/fd`)
    if (process) return process.fds
    throw new Error(`Unexpected readdir: ${path}`)
  })
  nodeFs.readFile.mockImplementation(async (path: string) => {
    const process = processes.find(({ pid }) => path.startsWith(`/proc/${pid}/`))
    if (!process) throw new Error(`Unexpected readFile: ${path}`)
    if (path === `/proc/${process.pid}/status`) {
      const processUid = process.uid ?? uid
      const reads = process.statusReads ?? [fixture.status
        ?? `Name:\tcodex\nPPid:\t${process.parentPid}\nUid:\t${processUid}\t${processUid}\t${processUid}\t${processUid}\n`]
      const readCount = statusReadCounts.get(process.pid) ?? 0
      statusReadCounts.set(process.pid, readCount + 1)
      return readSequence(reads, readCount)
    }
    if (path === `/proc/${process.pid}/stat`) {
      const readCount = statReadCounts.get(process.pid) ?? 0
      statReadCounts.set(process.pid, readCount + 1)
      const startTimes = process.statStartTimes ?? [BigInt(process.pid) * 1_000n]
      return procStat(process, startTimes[Math.min(readCount, startTimes.length - 1)])
    }
    if (path === `/proc/${process.pid}/cmdline`) {
      const reads = process.cmdlineReads ?? [process.cmdline]
      const readCount = cmdlineReadCounts.get(process.pid) ?? 0
      cmdlineReadCounts.set(process.pid, readCount + 1)
      return readSequence(reads, readCount)
    }
    if (process.fds.some((fd) => path === `/proc/${process.pid}/fdinfo/${fd}`)) {
      const reads = fixture.fdinfoReads ?? [fixture.fdinfo ?? 'pos:\t10\nflags:\t0100001\n']
      return readSequence(reads, fdinfoReadCount++)
    }
    throw new Error(`Unexpected readFile: ${path}`)
  })

  const probe = new ExternalThreadRuntimeProbe({ sessionsRoot })
  probe.registerThread('thread-1', rolloutPath)
  return probe
}

describe('ExternalThreadRuntimeProbe', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('inspects multiple runtimes with one descriptor snapshot pass', async () => {
    const { probe, system } = batchProbe([
      { path: '/sessions/thread-a', log: lifecycle('task_started', 'turn-a'), dev: '8', ino: '21' },
      { path: '/sessions/thread-b', log: lifecycle('task_started', 'turn-b'), dev: '8', ino: '22' },
      {
        path: '/sessions/thread-c',
        log: lifecycle('task_started', 'turn-c') + lifecycle('task_complete', 'turn-c'),
        dev: '8',
        ino: '23',
      },
    ], [
      writerFd({ dev: '8', ino: '21' }),
    ])

    await expect(probe.inspectMany(
      ['thread-a', 'thread-b', 'thread-c', 'missing'],
      99,
    )).resolves.toEqual({
      'thread-a': {
        state: 'running',
        turnId: 'turn-a',
        interruptible: false,
        source: 'external-session-writer',
      },
      'thread-b': { state: 'idle' },
      'thread-c': { state: 'idle' },
      missing: { state: 'unknown' },
    })
    expect(system.scanCount).toBe(1)
  })

  it('keeps valid writer evidence when another rollout escapes the sessions root', async () => {
    const { probe, system } = batchProbe([
      { path: '/sessions/thread-a', log: lifecycle('task_started', 'turn-a'), dev: '8', ino: '21' },
      { path: '/tmp/thread-b', log: lifecycle('task_started', 'turn-b'), dev: '8', ino: '22' },
    ], [
      writerFd({ dev: '8', ino: '21' }),
    ])

    await expect(probe.inspectMany(['thread-a', 'thread-b'], 99)).resolves.toEqual({
      'thread-a': {
        state: 'running',
        turnId: 'turn-a',
        interruptible: false,
        source: 'external-session-writer',
      },
      'thread-b': { state: 'unknown' },
    })
    expect(system.scanCount).toBe(1)
  })

  it('keeps single-thread inspection in parity with batch inspection', async () => {
    const { probe } = batchProbe([
      { path: '/sessions/thread-a', log: lifecycle('task_started', 'turn-a'), dev: '8', ino: '21' },
    ], [
      writerFd({ dev: '8', ino: '21' }),
    ])

    const states = await probe.inspectMany(['thread-a'], 99)
    await expect(probe.inspect('thread-a', 99)).resolves.toEqual(states['thread-a'])
  })

  it('requires an unmatched start and a live external writer', async () => {
    const system = fakeRuntimeSystem({
      log: lifecycle('task_started', 'turn-a'),
      fds: [writerFd()],
    })
    const probe = registeredProbe(system)

    await expect(probe.inspect('thread-1', 99)).resolves.toEqual({
      state: 'running',
      turnId: 'turn-a',
      interruptible: false,
      source: 'external-session-writer',
    })
  })

  it('returns idle when the current turn has a matching terminal event', async () => {
    const system = fakeRuntimeSystem({
      log: lifecycle('task_started', 'turn-a') + lifecycle('task_complete', 'turn-a'),
      fds: [writerFd()],
    })

    await expect(registeredProbe(system).inspect('thread-1', 99)).resolves.toEqual({
      state: 'idle',
    })
    expect(system.scanCount).toBe(0)
  })

  it('does not let an older terminal event clear a newer start', async () => {
    const system = fakeRuntimeSystem({
      log: lifecycle('task_started', 'turn-a'),
      fds: [writerFd()],
    })
    const probe = registeredProbe(system)
    await probe.inspect('thread-1', 99)

    system.append(lifecycle('task_started', 'turn-b') + lifecycle('task_complete', 'turn-a'))

    await expect(probe.inspect('thread-1', 99)).resolves.toMatchObject({
      state: 'running',
      turnId: 'turn-b',
    })
  })

  it('accepts turn_aborted only when it matches the current turn', async () => {
    const system = fakeRuntimeSystem({
      log: lifecycle('task_started', 'turn-a') + lifecycle('turn_aborted', 'turn-a'),
      fds: [writerFd()],
    })

    await expect(registeredProbe(system).inspect('thread-1', 99)).resolves.toEqual({
      state: 'idle',
    })
  })

  it('returns idle when an unmatched start has no live writer', async () => {
    const system = fakeRuntimeSystem({ log: lifecycle('task_started', 'turn-a') })

    await expect(registeredProbe(system).inspect('thread-1', 99)).resolves.toEqual({
      state: 'idle',
    })
  })

  it('excludes the bridge child PID from writer evidence', async () => {
    const system = fakeRuntimeSystem({
      log: lifecycle('task_started', 'turn-a'),
      fds: [writerFd({ pid: 42 })],
    })

    await expect(registeredProbe(system).inspect('thread-1', 42)).resolves.toEqual({
      state: 'idle',
    })
  })

  it.each([
    ['direct child', [99]],
    ['deep descendant', [150, 120, 99, 1]],
  ])('excludes a mobile launcher %s from writer evidence', async (_label, ancestorPids) => {
    const system = fakeRuntimeSystem({
      log: lifecycle('task_started', 'turn-a'),
      fds: [writerFd({ pid: 200, ancestorPids })],
    })

    await expect(registeredProbe(system).inspect('thread-1', 99)).resolves.toEqual({ state: 'idle' })
  })

  it('accepts a separate desktop app-server whose ancestors do not include the mobile launcher', async () => {
    const system = fakeRuntimeSystem({
      log: lifecycle('task_started', 'turn-a'),
      fds: [writerFd({ pid: 200, ancestorPids: [150, 1] })],
    })

    await expect(registeredProbe(system).inspect('thread-1', 99)).resolves.toMatchObject({
      state: 'running',
      turnId: 'turn-a',
    })
  })

  it('does not treat a read-only descriptor as writer evidence', async () => {
    const system = fakeRuntimeSystem({
      log: lifecycle('task_started', 'turn-a'),
      fds: [writerFd({ flags: 0o100000 })],
    })

    await expect(registeredProbe(system).inspect('thread-1', 99)).resolves.toEqual({
      state: 'idle',
    })
  })

  it.each([
    ['different user', { uid: 1001 }],
    ['non-Codex command', { cmdline: '/usr/bin/node\0server.js\0' }],
    ['different device', { dev: '9' }],
    ['different inode', { ino: '22' }],
    ['zero descriptor position', { position: 0 }],
  ] satisfies Array<[string, Partial<RuntimeFdSnapshot>]>) (
    'rejects writer evidence from a %s',
    async (_label, overrides) => {
      const system = fakeRuntimeSystem({
        log: lifecycle('task_started', 'turn-a'),
        fds: [writerFd(overrides)],
      })

      await expect(registeredProbe(system).inspect('thread-1', 99)).resolves.toEqual({
        state: 'idle',
      })
    },
  )

  it.each([
    [
      'direct app-server subcommand',
      '/usr/local/bin/codex\0app-server\0-c\0approval_policy="never"\0',
    ],
    [
      'desktop options before app-server',
      '/usr/lib/node_modules/@openai/codex/bin/codex\0-c\0features.code_mode_host=true\0app-server\0--listen\0unix://\0',
    ],
    [
      'Node launcher with a Codex script argument',
      '/usr/bin/node\0/usr/bin/codex\0-c\0sandbox_mode="danger-full-access"\0app-server\0',
    ],
  ])('accepts writer evidence from a %s command', async (_label, cmdline) => {
    const system = fakeRuntimeSystem({
      log: lifecycle('task_started', 'turn-a'),
      fds: [writerFd({ cmdline })],
    })

    await expect(registeredProbe(system).inspect('thread-1', 99)).resolves.toMatchObject({
      state: 'running',
      turnId: 'turn-a',
    })
  })

  it.each([
    ['codex-like basename', '/usr/bin/my-codex\0app-server\0'],
    ['app-server before codex', 'app-server\0/usr/bin/codex\0'],
    ['missing app-server token', '/usr/bin/codex\0-c\0app-server-like\0'],
  ])('rejects writer evidence from a %s command', async (_label, cmdline) => {
    const system = fakeRuntimeSystem({
      log: lifecycle('task_started', 'turn-a'),
      fds: [writerFd({ cmdline })],
    })

    await expect(registeredProbe(system).inspect('thread-1', 99)).resolves.toEqual({ state: 'idle' })
  })

  it('accepts a writable read-write descriptor', async () => {
    const system = fakeRuntimeSystem({
      log: lifecycle('task_started', 'turn-a'),
      fds: [writerFd({ flags: 0o100002 })],
    })

    await expect(registeredProbe(system).inspect('thread-1', 99)).resolves.toMatchObject({
      state: 'running',
      turnId: 'turn-a',
    })
  })

  it('returns unknown without probing on unsupported platforms', async () => {
    const system = fakeRuntimeSystem({
      platform: 'darwin',
      log: lifecycle('task_started', 'turn-a'),
      fds: [writerFd()],
    })

    await expect(registeredProbe(system).inspect('thread-1', 99)).resolves.toEqual({
      state: 'unknown',
    })
    expect(system.readCalls).toEqual([])
    expect(system.scanCount).toBe(0)
  })

  it('returns unknown when the process UID is unavailable', async () => {
    const system = fakeRuntimeSystem({ uid: null })

    await expect(registeredProbe(system).inspect('thread-1', 99)).resolves.toEqual({
      state: 'unknown',
    })
  })

  it('rejects a rollout path that resolves outside the sessions root', async () => {
    const system = fakeRuntimeSystem({
      resolvedRolloutPath: '/tmp/escaped-rollout.jsonl',
      log: lifecycle('task_started', 'turn-a'),
      fds: [writerFd()],
    })

    await expect(registeredProbe(system).inspect('thread-1', 99)).resolves.toEqual({
      state: 'unknown',
    })
    expect(system.readCalls).toEqual([])
    expect(system.scanCount).toBe(0)
  })

  it('waits for a newline before applying a partial lifecycle line', async () => {
    const completeLine = lifecycle('task_started', 'turn-a')
    const system = fakeRuntimeSystem({
      log: completeLine.slice(0, -1),
      fds: [writerFd()],
    })
    const probe = registeredProbe(system)

    await expect(probe.inspect('thread-1', 99)).resolves.toEqual({ state: 'idle' })
    expect(system.scanCount).toBe(0)

    system.append('\n')
    await expect(probe.inspect('thread-1', 99)).resolves.toMatchObject({
      state: 'running',
      turnId: 'turn-a',
    })
  })

  it('validates a bounded checkpoint and then reads only appended bytes after the initial parse', async () => {
    const initial = lifecycle('task_started', 'turn-a')
    const appended = lifecycle('task_complete', 'turn-a')
    const system = fakeRuntimeSystem({ log: initial, fds: [writerFd()] })
    const probe = registeredProbe(system)

    await probe.inspect('thread-1', 99)
    system.append(appended)
    await expect(probe.inspect('thread-1', 99)).resolves.toEqual({ state: 'idle' })

    expect(system.readCalls).toEqual([
      { path: rolloutPath, offset: 0, length: Buffer.byteLength(initial) },
      { path: rolloutPath, offset: 0, length: Buffer.byteLength(initial) },
      {
        path: rolloutPath,
        offset: Buffer.byteLength(initial),
        length: Buffer.byteLength(appended),
      },
    ])
  })

  it('caps individual reads at 64 KiB and parses a line across chunk boundaries', async () => {
    const ignoredLine = `${JSON.stringify({ type: 'ignored', padding: 'x'.repeat(70_000) })}\n`
    const system = fakeRuntimeSystem({
      log: ignoredLine + lifecycle('task_started', 'turn-a'),
      fds: [writerFd()],
    })

    await expect(registeredProbe(system).inspect('thread-1', 99)).resolves.toMatchObject({
      state: 'running',
      turnId: 'turn-a',
    })
    expect(system.readCalls.length).toBeGreaterThan(1)
    expect(system.readCalls.every(({ length }) => length <= 64 * 1024)).toBe(true)
  })

  it('revalidates an unchanged large cache with one bounded boundary read', async () => {
    const log = `${JSON.stringify({ type: 'ignored', padding: 'x'.repeat(70_000) })}\n${lifecycle('task_started', 'turn-a')}`
    const system = fakeRuntimeSystem({ log, fds: [writerFd()] })
    const probe = registeredProbe(system)
    await probe.inspect('thread-1', 99)
    system.readCalls.splice(0)

    await expect(probe.inspect('thread-1', 99)).resolves.toMatchObject({
      state: 'running',
      turnId: 'turn-a',
    })
    expect(system.readCalls).toEqual([{
      path: rolloutPath,
      offset: Buffer.byteLength(log) - 256,
      length: 256,
    }])
  })

  it('resets cached parsing when the file is truncated', async () => {
    const initial = `${JSON.stringify({ type: 'ignored', padding: 'x'.repeat(256) })}\n${lifecycle('task_started', 'turn-a')}`
    const system = fakeRuntimeSystem({ log: initial, fds: [writerFd()] })
    const probe = registeredProbe(system)
    await probe.inspect('thread-1', 99)

    system.truncate(lifecycle('task_started', 'turn-b'))

    await expect(probe.inspect('thread-1', 99)).resolves.toMatchObject({
      state: 'running',
      turnId: 'turn-b',
    })
    expect(system.readCalls.at(-1)?.offset).toBe(0)
  })

  it('resets cached parsing after same-inode copytruncate regrows past the cached offset', async () => {
    const initial = lifecycle('task_started', 'turn-a')
    const system = fakeRuntimeSystem({ log: initial, fds: [writerFd()] })
    const probe = registeredProbe(system)
    await expect(probe.inspect('thread-1', 99)).resolves.toMatchObject({
      state: 'running',
      turnId: 'turn-a',
    })

    system.truncate(`${lifecycle('task_started', 'turn-b')}${JSON.stringify({ type: 'ignored', padding: 'x'.repeat(initial.length) })}\n`)

    await expect(probe.inspect('thread-1', 99)).resolves.toMatchObject({
      state: 'running',
      turnId: 'turn-b',
    })
    expect(system.readCalls.some(({ offset }) => offset === 0)).toBe(true)
  })

  it('resets cached parsing after a cross-poll ABA replacement reuses the same inode', async () => {
    const initial = lifecycle('task_started', 'turn-a')
    const system = fakeRuntimeSystem({ log: initial, fds: [writerFd()] })
    const probe = registeredProbe(system)
    await probe.inspect('thread-1', 99)
    const readsBeforeReplacement = system.readCalls.length

    system.replace(lifecycle('task_started', 'turn-b'), '21')

    await expect(probe.inspect('thread-1', 99)).resolves.toMatchObject({
      state: 'running',
      turnId: 'turn-b',
    })
    expect(system.readCalls.slice(readsBeforeReplacement).some(({ offset }) => offset === 0)).toBe(true)
  })

  it('resets cached parsing when the file inode is replaced', async () => {
    const system = fakeRuntimeSystem({
      log: lifecycle('task_started', 'turn-a'),
      fds: [writerFd({ ino: '22' })],
    })
    const probe = registeredProbe(system)
    await probe.inspect('thread-1', 99)

    system.replace(lifecycle('task_started', 'turn-b'), '22')

    await expect(probe.inspect('thread-1', 99)).resolves.toMatchObject({
      state: 'running',
      turnId: 'turn-b',
    })
    expect(system.readCalls.at(-1)?.offset).toBe(0)
  })

  it('does not combine replacement bytes with writer evidence from the old inode', async () => {
    const system = fakeRuntimeSystem({
      log: lifecycle('task_started', 'turn-a'),
      fds: [writerFd({ ino: '21' })],
      replacementDuringRead: {
        log: lifecycle('task_started', 'turn-b'),
        ino: '22',
      },
    })

    await expect(registeredProbe(system).inspect('thread-1', 99)).resolves.toEqual({
      state: 'unknown',
    })
  })

  it('rejects bytes from a reopened descriptor even when the path identity changes back', async () => {
    const probe = defaultRuntimeProbe({
      log: lifecycle('task_started', 'turn-a'),
      openedLog: lifecycle('task_started', 'turn-b'),
      rolloutIno: 21n,
      openedIno: 22n,
      fdIno: 21n,
    })

    await expect(probe.inspect('thread-1', 99)).resolves.toEqual({
      state: 'unknown',
    })
  })

  it('rejects an ABA replacement that is consistent only during readRange', async () => {
    const system = fakeRuntimeSystem({
      log: lifecycle('task_started', 'turn-a'),
      fds: [writerFd({ dev: '8', ino: '21' })],
      abaReplacementDuringRead: {
        log: lifecycle('task_started', 'turn-b'),
        dev: '8',
        ino: '22',
      },
    })

    await expect(registeredProbe(system).inspect('thread-1', 99)).resolves.toEqual({
      state: 'unknown',
    })
  })

  it('keeps distinct large bigint file identities distinct', async () => {
    const firstLargeInode = 9_007_199_254_740_992n
    const nextLargeInode = firstLargeInode + 1n
    const probe = defaultRuntimeProbe({
      rolloutIno: firstLargeInode,
      fdIno: nextLargeInode,
    })

    await expect(probe.inspect('thread-1', 99)).resolves.toEqual({ state: 'idle' })
  })

  it('excludes a native Codex process descended from the mobile Node launcher', async () => {
    const probe = defaultRuntimeProbe({
      processes: [
        {
          pid: 99,
          parentPid: 1,
          cmdline: '/usr/bin/node\0/usr/bin/codex\0app-server\0',
          fds: [],
        },
        {
          pid: 100,
          parentPid: 99,
          cmdline: '/opt/codex/bin/codex\0app-server\0',
          fds: ['7'],
        },
      ],
    })

    await expect(probe.inspect('thread-1', 99)).resolves.toEqual({ state: 'idle' })
  })

  it('returns unknown when a candidate app-server ancestry contains a cycle', async () => {
    const probe = defaultRuntimeProbe({
      processes: [
        { pid: 100, parentPid: 101, cmdline: '/opt/codex/bin/codex\0app-server\0', fds: ['7'] },
        { pid: 101, parentPid: 100, cmdline: '/usr/bin/node\0worker.js\0', fds: [] },
      ],
    })

    await expect(probe.inspect('thread-1', 99)).resolves.toEqual({ state: 'unknown' })
  })

  it('accepts descriptor evidence when the candidate process identity stays stable', async () => {
    const probe = defaultRuntimeProbe({
      processes: [{
        pid: 100,
        parentPid: 1,
        cmdline: '/opt/codex/bin/codex\0app-server\0',
        fds: ['7'],
        statStartTimes: [9_007_199_254_740_993n],
      }],
    })

    await expect(probe.inspect('thread-1', 99)).resolves.toMatchObject({
      state: 'running',
      turnId: 'turn-a',
    })
    expect(nodeFs.readFile.mock.calls.filter(([path]) => path === '/proc/100/stat')).toHaveLength(6)
  })

  it.each([
    ['before descriptor enumeration', [101n, 101n, 202n]],
    ['during descriptor enumeration', [101n, 101n, 101n, 101n, 202n]],
  ])('returns unknown when PID replacement occurs %s', async (_label, statStartTimes) => {
    const probe = defaultRuntimeProbe({
      processes: [{
        pid: 100,
        parentPid: 1,
        cmdline: '/opt/codex/bin/codex\0app-server\0',
        fds: ['7'],
        statStartTimes,
      }],
    })

    await expect(probe.inspect('thread-1', 99)).resolves.toEqual({ state: 'unknown' })
  })

  it.each([
    [
      'UID before descriptor enumeration',
      {
        statusReads: [
          `Name:\tcodex\nPPid:\t1\nUid:\t${typeof process.getuid === 'function' ? process.getuid() : 1000}\n`,
          'Name:\tcodex\nPPid:\t1\nUid:\t2000\n',
        ],
      },
    ],
    [
      'UID after descriptor enumeration',
      {
        statusReads: [
          `Name:\tcodex\nPPid:\t1\nUid:\t${typeof process.getuid === 'function' ? process.getuid() : 1000}\n`,
          `Name:\tcodex\nPPid:\t1\nUid:\t${typeof process.getuid === 'function' ? process.getuid() : 1000}\n`,
          'Name:\tcodex\nPPid:\t1\nUid:\t2000\n',
        ],
      },
    ],
    [
      'parent PID before descriptor enumeration',
      {
        statusReads: [
          `Name:\tcodex\nPPid:\t1\nUid:\t${typeof process.getuid === 'function' ? process.getuid() : 1000}\n`,
          `Name:\tcodex\nPPid:\t99\nUid:\t${typeof process.getuid === 'function' ? process.getuid() : 1000}\n`,
        ],
      },
    ],
    [
      'parent PID after descriptor enumeration',
      {
        statusReads: [
          `Name:\tcodex\nPPid:\t1\nUid:\t${typeof process.getuid === 'function' ? process.getuid() : 1000}\n`,
          `Name:\tcodex\nPPid:\t1\nUid:\t${typeof process.getuid === 'function' ? process.getuid() : 1000}\n`,
          `Name:\tcodex\nPPid:\t99\nUid:\t${typeof process.getuid === 'function' ? process.getuid() : 1000}\n`,
        ],
      },
    ],
    [
      'command line before descriptor enumeration',
      {
        cmdlineReads: [
          '/opt/codex/bin/codex\0app-server\0',
          '/usr/bin/node\0worker.js\0',
        ],
      },
    ],
    [
      'command line after descriptor enumeration',
      {
        cmdlineReads: [
          '/opt/codex/bin/codex\0app-server\0',
          '/opt/codex/bin/codex\0app-server\0',
          '/usr/bin/node\0worker.js\0',
        ],
      },
    ],
  ])('returns unknown when candidate %s changes with a constant starttime', async (_label, mutation) => {
    const probe = defaultRuntimeProbe({
      processes: [{
        pid: 100,
        parentPid: 1,
        cmdline: '/opt/codex/bin/codex\0app-server\0',
        fds: ['7'],
        statStartTimes: [101n],
        ...mutation,
      }],
    })

    await expect(probe.inspect('thread-1', 999)).resolves.toEqual({ state: 'unknown' })
  })

  it.each([
    ['before descriptor enumeration', [99n, 99n, 199n]],
    ['after descriptor enumeration', [99n, 99n, 99n, 99n, 199n]],
  ])('returns unknown when an ancestor is replaced with the same PID %s', async (_label, statStartTimes) => {
    const probe = defaultRuntimeProbe({
      processes: [
        {
          pid: 100,
          parentPid: 99,
          cmdline: '/opt/codex/bin/codex\0app-server\0',
          fds: ['7'],
          statStartTimes: [100n],
        },
        {
          pid: 99,
          parentPid: 1,
          cmdline: '/usr/bin/node\0launcher.js\0',
          fds: [],
          statStartTimes,
        },
      ],
    })

    await expect(probe.inspect('thread-1', 999)).resolves.toEqual({ state: 'unknown' })
  })

  it('returns unknown when an ancestor parent PID changes during inspection', async () => {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 1000
    const probe = defaultRuntimeProbe({
      processes: [
        {
          pid: 100,
          parentPid: 99,
          cmdline: '/opt/codex/bin/codex\0app-server\0',
          fds: ['7'],
        },
        {
          pid: 99,
          parentPid: 1,
          cmdline: '/usr/bin/node\0launcher.js\0',
          fds: [],
          statusReads: [
            `Name:\tnode\nPPid:\t1\nUid:\t${uid}\n`,
            `Name:\tnode\nPPid:\t1\nUid:\t${uid}\n`,
            `Name:\tnode\nPPid:\t500\nUid:\t${uid}\n`,
          ],
        },
      ],
    })

    await expect(probe.inspect('thread-1', 999)).resolves.toEqual({ state: 'unknown' })
  })

  it('returns unknown when an FD number is reused between fdinfo and identity reads', async () => {
    const probe = defaultRuntimeProbe({
      fdIdentities: [
        { dev: 8n, ino: 21n },
        { dev: 8n, ino: 22n },
      ],
    })

    await expect(probe.inspect('thread-1', 99)).resolves.toEqual({ state: 'unknown' })
  })

  it('returns unknown when a same-file FD changes from writable to read-only', async () => {
    const probe = defaultRuntimeProbe({
      fdIdentities: [
        { dev: 8n, ino: 21n },
        { dev: 8n, ino: 21n },
        { dev: 8n, ino: 21n },
      ],
      fdinfoReads: [
        'pos:\t10\nflags:\t0100001\n',
        'pos:\t0\nflags:\t0100000\n',
      ],
    })

    await expect(probe.inspect('thread-1', 99)).resolves.toEqual({ state: 'unknown' })
  })

  it('uses a stable writable FD latest zero position as non-writer evidence', async () => {
    const probe = defaultRuntimeProbe({
      fdIdentities: [
        { dev: 8n, ino: 21n },
        { dev: 8n, ino: 21n },
        { dev: 8n, ino: 21n },
      ],
      fdinfoReads: [
        'pos:\t10\nflags:\t0100001\n',
        'pos:\t0\nflags:\t0100001\n',
      ],
    })

    await expect(probe.inspect('thread-1', 99)).resolves.toEqual({ state: 'idle' })
  })

  it('accepts a stable writable FD whose position advances during inspection', async () => {
    const probe = defaultRuntimeProbe({
      fdIdentities: [
        { dev: 8n, ino: 21n },
        { dev: 8n, ino: 21n },
        { dev: 8n, ino: 21n },
      ],
      fdinfoReads: [
        'pos:\t10\nflags:\t0100001\n',
        'pos:\t20\nflags:\t0100001\n',
      ],
    })

    await expect(probe.inspect('thread-1', 99)).resolves.toMatchObject({
      state: 'running',
      turnId: 'turn-a',
    })
  })

  it.each([
    ['between fdinfo reads', 1],
    ['after the second fdinfo read', 2],
  ])('skips a descriptor that disappears %s', async (_label, goneAt) => {
    const probe = defaultRuntimeProbe({ fdStatGoneAt: [goneAt] })

    await expect(probe.inspect('thread-1', 99)).resolves.toEqual({ state: 'idle' })
  })

  it('returns unknown when a proc status has a malformed parent PID', async () => {
    const probe = defaultRuntimeProbe({
      status: 'Name:\tcodex\nPPid:\tnot-a-number\nUid:\t1000\n',
    })

    await expect(probe.inspect('thread-1', 99)).resolves.toEqual({ state: 'unknown' })
  })

  it('returns unknown when a candidate process parent is missing from the process table', async () => {
    const probe = defaultRuntimeProbe({
      processes: [{
        pid: 100,
        parentPid: 99,
        cmdline: '/opt/codex/bin/codex\0app-server\0',
        fds: ['7'],
      }],
    })

    await expect(probe.inspect('thread-1', 999)).resolves.toEqual({ state: 'unknown' })
  })

  it('returns unknown when process ancestry exceeds 128 hops', async () => {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 1000
    const processes: DefaultRuntimeProcessFixture[] = Array.from({ length: 130 }, (_, index) => ({
      pid: 1_000 + index,
      parentPid: index === 129 ? 1 : 1_001 + index,
      uid: index === 0 ? uid : uid + 1,
      cmdline: index === 0 ? '/opt/codex/bin/codex\0app-server\0' : '',
      fds: index === 0 ? ['7'] : [],
    }))
    const probe = defaultRuntimeProbe({ processes })

    await expect(probe.inspect('thread-1', 999)).resolves.toEqual({ state: 'unknown' })
  })

  it('accepts process ancestry at the 128-hop limit', async () => {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 1000
    const processes: DefaultRuntimeProcessFixture[] = Array.from({ length: 128 }, (_, index) => ({
      pid: 1_000 + index,
      parentPid: index === 127 ? 1 : 1_001 + index,
      uid: index === 0 ? uid : uid + 1,
      cmdline: index === 0 ? '/opt/codex/bin/codex\0app-server\0' : '',
      fds: index === 0 ? ['7'] : [],
    }))
    const probe = defaultRuntimeProbe({ processes })

    await expect(probe.inspect('thread-1', 999)).resolves.toMatchObject({
      state: 'running',
      turnId: 'turn-a',
    })
  })

  it('uses a cross-UID parent when validating candidate ancestry', async () => {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 1000
    const probe = defaultRuntimeProbe({
      processes: [
        {
          pid: 100,
          parentPid: 99,
          uid,
          cmdline: '/opt/codex/bin/codex\0app-server\0',
          fds: ['7'],
        },
        {
          pid: 99,
          parentPid: 1,
          uid: uid + 1,
          cmdline: '/usr/bin/foreign-parent\0',
          fds: [],
        },
      ],
    })

    await expect(probe.inspect('thread-1', 999)).resolves.toMatchObject({
      state: 'running',
      turnId: 'turn-a',
    })
  })

  it('returns unknown when a proc status has a malformed UID', async () => {
    const probe = defaultRuntimeProbe({
      status: 'Name:\tcodex\nUid:\tnot-a-number\n',
    })

    await expect(probe.inspect('thread-1', 99)).resolves.toEqual({ state: 'unknown' })
  })

  it('returns unknown when proc fdinfo has malformed descriptor evidence', async () => {
    const probe = defaultRuntimeProbe({
      fdinfo: 'pos:\t10\nflags:\tnot-octal\n',
    })

    await expect(probe.inspect('thread-1', 99)).resolves.toEqual({ state: 'unknown' })
  })

  it('returns unknown when descriptor scanning is inconclusive', async () => {
    const system = fakeRuntimeSystem({
      log: lifecycle('task_started', 'turn-a'),
      scanError: new Error('permission denied'),
    })

    await expect(registeredProbe(system).inspect('thread-1', 99)).resolves.toEqual({
      state: 'unknown',
    })
  })

  it('returns unknown for unregistered and cleared threads', async () => {
    const system = fakeRuntimeSystem()
    const probe = new ExternalThreadRuntimeProbe({ sessionsRoot, system })
    await expect(probe.inspect('missing', null)).resolves.toEqual({ state: 'unknown' })

    probe.registerThread('thread-1', rolloutPath)
    probe.clear()
    await expect(probe.inspect('thread-1', null)).resolves.toEqual({ state: 'unknown' })
  })

  it('rejects non-regular rollout paths', async () => {
    const system = fakeRuntimeSystem({ regular: false })

    await expect(registeredProbe(system).inspect('thread-1', 99)).resolves.toEqual({
      state: 'unknown',
    })
  })
})
