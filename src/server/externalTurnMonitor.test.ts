import { describe, expect, it, vi } from 'vitest'
import type {
  ExternalRuntimeSystem,
  RuntimeFdSnapshot,
  RuntimeFileIdentity,
} from './externalThreadRuntime'
import {
  createExternalTurnMonitor,
  type ObservedTurnLifecycle,
} from './externalTurnMonitor'

const sessionsRoot = '/sessions'

type FakeFile = {
  path: string
  bytes: Buffer
  dev: string
  ino: string
  regular: boolean
}

class FakeMonitorSystem implements ExternalRuntimeSystem {
  readonly platform: NodeJS.Platform = 'linux'
  readonly uid: number | null = 1000
  readonly files = new Map<string, FakeFile>()
  readonly readCalls: Array<{ path: string; offset: number; length: number }> = []
  writers: RuntimeFdSnapshot[] = []
  activeReads = 0
  maxActiveReads = 0
  blockReads: Promise<void> | null = null

  add(path: string, value = '', ino = path): FakeFile {
    const file = { path, bytes: Buffer.from(value), dev: '8', ino, regular: true }
    this.files.set(path, file)
    this.writers.push(this.writer(file))
    return file
  }

  writer(file: FakeFile): RuntimeFdSnapshot {
    return {
      path: file.path,
      pid: 42,
      ancestorPids: [],
      uid: 1000,
      cmdline: '/usr/local/bin/codex\0app-server\0',
      dev: file.dev,
      ino: file.ino,
      position: Math.max(file.bytes.length, 1),
      flags: 0o100001,
    }
  }

  async realpath(path: string): Promise<string> {
    return path
  }

  async statFile(path: string): Promise<RuntimeFileIdentity & { regular: boolean }> {
    const file = this.files.get(path)
    if (!file) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    return {
      path,
      dev: file.dev,
      ino: file.ino,
      size: file.bytes.length,
      regular: file.regular,
    }
  }

  async readRange(
    path: string,
    offset: number,
    length: number,
    expected: RuntimeFileIdentity,
  ): Promise<Buffer> {
    this.readCalls.push({ path, offset, length })
    this.activeReads += 1
    this.maxActiveReads = Math.max(this.maxActiveReads, this.activeReads)
    try {
      if (this.blockReads) await this.blockReads
      const file = this.files.get(path)
      if (!file || file.dev !== expected.dev || file.ino !== expected.ino) {
        throw new Error('Opened rollout identity does not match expected identity')
      }
      return file.bytes.subarray(offset, Math.min(offset + length, file.bytes.length))
    } finally {
      this.activeReads -= 1
    }
  }

  async *listFdSnapshots(): AsyncIterable<RuntimeFdSnapshot> {
    yield* this.writers
  }

  append(file: FakeFile, value: string): void {
    file.bytes = Buffer.concat([file.bytes, Buffer.from(value)])
    this.writers = this.writers.map((writer) => writer.path === file.path
      ? this.writer(file)
      : writer)
  }
}

function sessionMeta(threadId: string): string {
  return `${JSON.stringify({ type: 'session_meta', payload: { id: threadId } })}\n`
}

function started(turnId: string, occurredAt: number): string {
  return `${JSON.stringify({
    timestamp: new Date(occurredAt).toISOString(),
    type: 'event_msg',
    payload: { type: 'task_started', turn_id: turnId },
  })}\n`
}

function completed(turnId: string, occurredAt: number, durationMs?: number): string {
  return `${JSON.stringify({
    timestamp: new Date(occurredAt).toISOString(),
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      turn_id: turnId,
      completed_at: new Date(occurredAt).toISOString(),
      ...(durationMs === undefined ? {} : { duration_ms: durationMs }),
    },
  })}\n`
}

function observedStarted(
  threadId: string,
  turnId: string,
  occurredAt: number,
): ObservedTurnLifecycle {
  return { method: 'turn/started', threadId, turnId, status: 'inProgress', occurredAt }
}

function observedCompleted(
  threadId: string,
  turnId: string,
  occurredAt: number,
  durationMs: number,
): ObservedTurnLifecycle {
  return {
    method: 'turn/completed',
    threadId,
    turnId,
    status: 'completed',
    occurredAt,
    durationMs,
  }
}

function monitorFixture(options: { now?: number; cursorLimit?: number } = {}) {
  const system = new FakeMonitorSystem()
  const events: ObservedTurnLifecycle[] = []
  const warnings: string[] = []
  const scheduled: Array<() => Promise<void>> = []
  const cleared: unknown[] = []
  const now = options.now ?? 1_000
  const monitor = createExternalTurnMonitor({
    sessionsRoot,
    excludedPid: 900,
    system,
    now: () => now,
    cursorLimit: options.cursorLimit,
    onLifecycle: (event) => { events.push(event) },
    warn: (message) => { warnings.push(message) },
    setTimer: (callback) => {
      scheduled.push(callback)
      return callback
    },
    clearTimer: (handle) => cleared.push(handle),
  })
  return {
    system,
    events,
    warnings,
    scheduled,
    cleared,
    monitor,
    async runScheduledScan() {
      const callback = scheduled.shift()
      if (!callback) throw new Error('No scheduled scan')
      await callback()
    },
  }
}

describe('ExternalTurnMonitor', () => {
  it('emits an external start and later completion without a browser', async () => {
    const fixture = monitorFixture({ now: 1_000 })
    const rollout = fixture.system.add(
      '/sessions/rollout-1.jsonl',
      sessionMeta('thread-1') + started('turn-1', 1_000),
      '1',
    )

    await fixture.monitor.start()
    expect(fixture.events).toEqual([observedStarted('thread-1', 'turn-1', 1_000)])

    fixture.system.append(rollout, completed('turn-1', 601_000, 600_000))
    await fixture.runScheduledScan()
    expect(fixture.events.at(-1)).toEqual(
      observedCompleted('thread-1', 'turn-1', 601_000, 600_000),
    )
  })

  it('recovers a turn that was already running at monitor startup', async () => {
    const fixture = monitorFixture({ now: 500_000 })
    const rollout = fixture.system.add(
      '/sessions/rollout-1.jsonl',
      sessionMeta('thread-1') + started('turn-1', 0),
      '1',
    )

    await fixture.monitor.start()
    fixture.system.append(rollout, completed('turn-1', 600_000, 600_000))
    await fixture.runScheduledScan()

    expect(fixture.events.map(({ occurredAt }) => occurredAt)).toEqual([0, 600_000])
  })

  it('suppresses a terminal record that predates startup', async () => {
    const fixture = monitorFixture({ now: 700_000 })
    fixture.system.add(
      '/sessions/rollout-1.jsonl',
      sessionMeta('thread-1') + started('turn-1', 0) + completed('turn-1', 600_000, 600_000),
      '1',
    )

    await fixture.monitor.start()

    expect(fixture.events).toEqual([])
  })

  it('reconstructs a start when a terminal races the initial scan', async () => {
    const fixture = monitorFixture({ now: 500_000 })
    fixture.system.add(
      '/sessions/rollout-1.jsonl',
      sessionMeta('thread-1') + completed('turn-1', 600_000, 600_000),
      '1',
    )

    await fixture.monitor.start()

    expect(fixture.events).toEqual([
      observedStarted('thread-1', 'turn-1', 0),
      observedCompleted('thread-1', 'turn-1', 600_000, 600_000),
    ])
  })

  it('buffers split JSONL lines and ignores duplicate lifecycle records', async () => {
    const fixture = monitorFixture()
    const start = started('turn-1', 1_000)
    const split = Math.floor(start.length / 2)
    const rollout = fixture.system.add(
      '/sessions/rollout-1.jsonl',
      sessionMeta('thread-1') + start.slice(0, split),
      '1',
    )
    await fixture.monitor.start()
    expect(fixture.events).toEqual([])

    fixture.system.append(rollout, start.slice(split) + start + completed('turn-1', 601_000, 600_000))
    await fixture.runScheduledScan()
    fixture.system.append(rollout, completed('turn-1', 601_000, 600_000))
    await fixture.runScheduledScan()

    expect(fixture.events).toEqual([
      observedStarted('thread-1', 'turn-1', 1_000),
      observedCompleted('thread-1', 'turn-1', 601_000, 600_000),
    ])
  })

  it('tracks two rollouts and reads no payload bytes from unchanged files', async () => {
    const fixture = monitorFixture()
    fixture.system.add('/sessions/a.jsonl', sessionMeta('a') + started('ta', 1_000), '1')
    fixture.system.add('/sessions/b.jsonl', sessionMeta('b') + started('tb', 2_000), '2')
    await fixture.monitor.start()
    fixture.system.readCalls.length = 0

    await fixture.runScheduledScan()

    expect(fixture.events).toEqual([
      observedStarted('a', 'ta', 1_000),
      observedStarted('b', 'tb', 2_000),
    ])
    expect(fixture.system.readCalls).toEqual([])
  })

  it('drops a cursor on file replacement or truncation without replaying history', async () => {
    const fixture = monitorFixture()
    const rollout = fixture.system.add(
      '/sessions/rollout-1.jsonl',
      sessionMeta('thread-1') + started('turn-1', 1_000),
      '1',
    )
    await fixture.monitor.start()

    rollout.bytes = Buffer.from(sessionMeta('thread-1') + completed('turn-1', 500, 500))
    rollout.ino = '2'
    fixture.system.writers = [fixture.system.writer(rollout)]
    await fixture.runScheduledScan()

    rollout.bytes = Buffer.from(sessionMeta('thread-1'))
    await fixture.runScheduledScan()
    expect(fixture.events).toEqual([observedStarted('thread-1', 'turn-1', 1_000)])
  })

  it('rejects an unsafe identity and never infers terminal from writer disappearance', async () => {
    const fixture = monitorFixture()
    const rollout = fixture.system.add(
      '/sessions/rollout-1.jsonl',
      sessionMeta('thread-1') + started('turn-1', 1_000),
      '1',
    )
    fixture.system.writers[0] = { ...fixture.system.writers[0], ino: 'unsafe' }
    await fixture.monitor.start()
    expect(fixture.events).toEqual([])

    fixture.system.writers = [fixture.system.writer(rollout)]
    await fixture.runScheduledScan()
    fixture.system.writers = []
    await fixture.runScheduledScan()
    expect(fixture.events).toEqual([observedStarted('thread-1', 'turn-1', 1_000)])
  })

  it('bounds cursor state at 256 and prefers evicting inactive cursors', async () => {
    const fixture = monitorFixture({ cursorLimit: 256 })
    for (let index = 0; index < 257; index += 1) {
      fixture.system.add(
        `/sessions/${index}.jsonl`,
        sessionMeta(`thread-${index}`)
          + started(`turn-${index}`, index)
          + (index === 0 ? completed('turn-0', 10, 10) : ''),
        `${index}`,
      )
    }
    await fixture.monitor.start()
    fixture.system.writers = []
    fixture.system.readCalls.length = 0

    const oldestActive = fixture.system.files.get('/sessions/1.jsonl')!
    fixture.system.append(oldestActive, completed('turn-1', 601_000, 600_999))
    await fixture.runScheduledScan()

    expect(fixture.events.some((event) => event.turnId === 'turn-1' && event.status === 'completed'))
      .toBe(true)
  })

  it('serializes scheduled scans and clears the timer on dispose', async () => {
    const fixture = monitorFixture()
    const rollout = fixture.system.add(
      '/sessions/rollout-1.jsonl',
      sessionMeta('thread-1') + started('turn-1', 1_000),
      '1',
    )
    await fixture.monitor.start()
    fixture.system.append(rollout, completed('turn-1', 601_000, 600_000))
    let release!: () => void
    fixture.system.blockReads = new Promise<void>((resolve) => { release = resolve })

    const first = fixture.runScheduledScan()
    expect(fixture.scheduled).toHaveLength(0)
    release()
    await first
    expect(fixture.system.maxActiveReads).toBe(1)
    expect(fixture.scheduled).toHaveLength(1)

    await fixture.monitor.dispose()
    expect(fixture.cleared).toHaveLength(1)
    expect(fixture.scheduled).toHaveLength(1)
  })

  it('warns with a redacted message and drops an oversized trailing line', async () => {
    const fixture = monitorFixture()
    fixture.system.add(
      '/sessions/rollout-1.jsonl',
      sessionMeta('thread-1') + 'x'.repeat(256 * 1024 + 1),
      '1',
    )

    await fixture.monitor.start()

    expect(fixture.warnings).toEqual(['Unable to parse external turn lifecycle'])
    expect(fixture.warnings.join(' ')).not.toContain('/sessions/')
  })
})
