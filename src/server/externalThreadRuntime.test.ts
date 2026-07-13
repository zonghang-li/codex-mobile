import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
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
    pid: 42,
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

class FakeRuntimeSystem implements ExternalRuntimeSystem {
  readonly platform: NodeJS.Platform
  readonly uid: number | null
  readonly readCalls: Array<{ path: string; offset: number; length: number }> = []
  scanCount = 0

  private bytes: Buffer
  private readonly fds: RuntimeFdSnapshot[]
  private readonly resolvedSessionsRoot: string
  private readonly resolvedRolloutPath: string
  private readonly regular: boolean
  private readonly scanError: Error | undefined
  private replacementDuringRead: { log: string; ino: string } | undefined
  private abaReplacementDuringRead: { log: string; dev: string; ino: string } | undefined
  private dev = '8'
  private ino = '21'

  constructor(options: FakeRuntimeOptions = {}) {
    this.platform = options.platform ?? 'linux'
    this.uid = options.uid === undefined ? 1000 : options.uid
    this.bytes = Buffer.isBuffer(options.log)
      ? Buffer.from(options.log)
      : Buffer.from(options.log ?? '')
    this.fds = options.fds ?? []
    this.resolvedSessionsRoot = options.resolvedSessionsRoot ?? sessionsRoot
    this.resolvedRolloutPath = options.resolvedRolloutPath ?? rolloutPath
    this.regular = options.regular ?? true
    this.scanError = options.scanError
    this.replacementDuringRead = options.replacementDuringRead
    this.abaReplacementDuringRead = options.abaReplacementDuringRead
  }

  async realpath(path: string): Promise<string> {
    return path === sessionsRoot ? this.resolvedSessionsRoot : this.resolvedRolloutPath
  }

  async statFile(path: string): Promise<RuntimeFileIdentity & { regular: boolean }> {
    return {
      path,
      dev: this.dev,
      ino: this.ino,
      size: this.bytes.length,
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
      this.bytes = Buffer.from(replacement.log)
      this.ino = replacement.ino
    }
    return this.bytes.subarray(offset, Math.min(offset + length, this.bytes.length))
  }

  async *listFdSnapshots(): AsyncIterable<RuntimeFdSnapshot> {
    this.scanCount += 1
    if (this.scanError) throw this.scanError
    yield* this.fds
  }

  append(value: string | Buffer): void {
    this.bytes = Buffer.concat([
      this.bytes,
      Buffer.isBuffer(value) ? value : Buffer.from(value),
    ])
  }

  truncate(value: string): void {
    this.bytes = Buffer.from(value)
  }

  replace(value: string, ino = `${Number(this.ino) + 1}`): void {
    this.bytes = Buffer.from(value)
    this.ino = ino
  }
}

function fakeRuntimeSystem(options: FakeRuntimeOptions = {}): FakeRuntimeSystem {
  return new FakeRuntimeSystem(options)
}

function registeredProbe(system: ExternalRuntimeSystem): ExternalThreadRuntimeProbe {
  const probe = new ExternalThreadRuntimeProbe({ sessionsRoot, system })
  probe.registerThread('thread-1', rolloutPath)
  return probe
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

  nodeFs.realpath.mockImplementation(async (path: string) => path)
  nodeFs.stat.mockImplementation(async (path: string, options?: { bigint?: boolean }) => {
    const dev = path === rolloutPath ? rolloutDev : fdDev
    const ino = path === rolloutPath ? rolloutIno : fdIno
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
    if (path === '/proc') return ['42']
    if (path === '/proc/42/fd') return ['7']
    throw new Error(`Unexpected readdir: ${path}`)
  })
  nodeFs.readFile.mockImplementation(async (path: string) => {
    if (path === '/proc/42/status') {
      return fixture.status ?? `Name:\tcodex\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`
    }
    if (path === '/proc/42/cmdline') return '/usr/local/bin/codex\0app-server\0'
    if (path === '/proc/42/fdinfo/7') {
      return fixture.fdinfo ?? 'pos:\t10\nflags:\t0100001\n'
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
