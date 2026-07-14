import { describe, expect, it, vi } from 'vitest'
import type {
  ExternalRuntimeSystem,
  RuntimeFdSnapshot,
  RuntimeFileIdentity,
} from './externalThreadRuntime'
import {
  createExternalTurnMonitor,
  EXTERNAL_TURN_INACTIVE_EXPIRY_MS,
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
  beforeDiscovery: (() => void) | null = null
  discoveryComplete: boolean | void = undefined

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

  async *listFdSnapshots(): AsyncGenerator<RuntimeFdSnapshot, boolean | void, void> {
    this.beforeDiscovery?.()
    yield* this.writers
    return this.discoveryComplete
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

function monitorFixture(options: {
  now?: number | (() => number)
  cursorLimit?: number
  inactiveExpiryMs?: number
  onLifecycle?: (event: ObservedTurnLifecycle) => void | Promise<void>
} = {}) {
  const system = new FakeMonitorSystem()
  const events: ObservedTurnLifecycle[] = []
  const warnings: string[] = []
  const scheduled: Array<() => Promise<void>> = []
  const cleared: unknown[] = []
  const configuredNow = options.now
  const now: () => number = typeof configuredNow === 'function'
    ? configuredNow
    : () => configuredNow ?? 1_000
  const monitor = createExternalTurnMonitor({
    sessionsRoot,
    excludedPid: 900,
    system,
    now,
    cursorLimit: options.cursorLimit,
    inactiveExpiryMs: options.inactiveExpiryMs,
    onLifecycle: options.onLifecycle ?? ((event) => { events.push(event) }),
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

  it('deduplicates a suppressed historical terminal when the pair appears again', async () => {
    const fixture = monitorFixture({ now: 700_000 })
    const historicalPair = started('turn-1', 0) + completed('turn-1', 600_000, 600_000)
    const rollout = fixture.system.add(
      '/sessions/rollout-1.jsonl',
      sessionMeta('thread-1') + historicalPair,
      '1',
    )
    await fixture.monitor.start()

    fixture.system.append(rollout, historicalPair)
    await fixture.runScheduledScan()

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

  it('does not replay an older completed turn after a newer turn completes', async () => {
    const fixture = monitorFixture()
    const rollout = fixture.system.add(
      '/sessions/rollout-1.jsonl',
      sessionMeta('thread-1') + started('turn-1', 1_000),
      '1',
    )
    await fixture.monitor.start()
    fixture.system.append(
      rollout,
      completed('turn-1', 2_000, 1_000)
        + started('turn-2', 3_000)
        + completed('turn-2', 4_000, 1_000),
    )
    await fixture.runScheduledScan()

    fixture.system.append(
      rollout,
      started('turn-1', 1_000) + completed('turn-1', 2_000, 1_000),
    )
    await fixture.runScheduledScan()

    expect(fixture.events.map((event) => `${event.turnId}:${event.status}`)).toEqual([
      'turn-1:inProgress',
      'turn-1:completed',
      'turn-2:inProgress',
      'turn-2:completed',
    ])
  })

  it('tracks two rollouts and limits unchanged-file reads to bounded checkpoints', async () => {
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
    expect(new Set(fixture.system.readCalls.map(({ path }) => path))).toEqual(new Set([
      '/sessions/a.jsonl',
      '/sessions/b.jsonl',
    ]))
    expect(fixture.system.readCalls.every(({ length }) => length <= 256)).toBe(true)
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

  it('detects truncate-and-regrow on the same inode using a bounded checkpoint', async () => {
    const fixture = monitorFixture()
    const rollout = fixture.system.add(
      '/sessions/rollout-1.jsonl',
      sessionMeta('thread-1') + started('turn-1', 1_000),
      '1',
    )
    await fixture.monitor.start()

    rollout.bytes = Buffer.from(sessionMeta('thread-1') + started('turn-2', 2_000))
    fixture.system.writers = [fixture.system.writer(rollout)]
    await fixture.runScheduledScan()

    expect(fixture.events).toEqual([
      observedStarted('thread-1', 'turn-1', 1_000),
      observedStarted('thread-1', 'turn-2', 2_000),
    ])
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

  it('checks tracked rollouts before starting process discovery', async () => {
    const fixture = monitorFixture()
    const rollout = fixture.system.add(
      '/sessions/rollout-1.jsonl',
      sessionMeta('thread-1') + started('turn-1', 1_000),
      '1',
    )
    await fixture.monitor.start()
    fixture.system.append(rollout, completed('turn-1', 601_000, 600_000))
    fixture.system.readCalls.length = 0
    fixture.system.beforeDiscovery = () => {
      expect(fixture.system.readCalls.length).toBeGreaterThan(0)
    }

    await fixture.runScheduledScan()
    expect(fixture.events.at(-1)).toEqual(
      observedCompleted('thread-1', 'turn-1', 601_000, 600_000),
    )
  })

  it('retains a missing-writer active cursor before the inactive-expiry boundary', async () => {
    let time = 1_000
    const fixture = monitorFixture({ now: () => time, inactiveExpiryMs: 100 })
    const rollout = fixture.system.add(
      '/sessions/rollout-1.jsonl',
      sessionMeta('thread-1') + started('turn-1', 1_000),
      '1',
    )
    await fixture.monitor.start()
    fixture.system.writers = []
    time += 99
    await fixture.runScheduledScan()

    fixture.system.append(rollout, completed('turn-1', 601_000, 600_000))
    fixture.system.writers = []
    await fixture.runScheduledScan()
    expect(fixture.events).toEqual([
      observedStarted('thread-1', 'turn-1', 1_000),
      observedCompleted('thread-1', 'turn-1', 601_000, 600_000),
    ])
  })

  it('evicts a missing-writer active cursor at expiry without emitting a terminal event', async () => {
    let time = 1_000
    const fixture = monitorFixture({ now: () => time, cursorLimit: 1, inactiveExpiryMs: 100 })
    fixture.system.add(
      '/sessions/old.jsonl',
      sessionMeta('old-thread') + started('old-turn', 1_000),
      '1',
    )
    await fixture.monitor.start()
    fixture.system.writers = []
    time += 100
    await fixture.runScheduledScan()
    expect(fixture.events).toEqual([observedStarted('old-thread', 'old-turn', 1_000)])

    fixture.system.add(
      '/sessions/new.jsonl',
      sessionMeta('new-thread') + started('new-turn', time),
      '2',
    )
    await fixture.runScheduledScan()
    expect(fixture.events).toEqual([
      observedStarted('old-thread', 'old-turn', 1_000),
      observedStarted('new-thread', 'new-turn', time),
    ])
  })

  it('retains long turns while the writer is live or the rollout keeps growing', async () => {
    let time = 1_000
    const fixture = monitorFixture({ now: () => time, inactiveExpiryMs: 100 })
    const rollout = fixture.system.add(
      '/sessions/rollout-1.jsonl',
      sessionMeta('thread-1') + started('turn-1', 1_000),
      '1',
    )
    await fixture.monitor.start()

    time += 100
    await fixture.runScheduledScan()
    fixture.system.writers = []
    time += 100
    fixture.system.append(rollout, `${JSON.stringify({ type: 'event_msg', payload: { type: 'progress' } })}\n`)
    await fixture.runScheduledScan()
    time += 99
    fixture.system.append(rollout, completed('turn-1', 601_000, 600_000))
    await fixture.runScheduledScan()

    expect(fixture.events.at(-1)).toEqual(
      observedCompleted('thread-1', 'turn-1', 601_000, 600_000),
    )
  })

  it('retains an aged missing writer when descriptor discovery is incomplete', async () => {
    let time = 1_000
    const fixture = monitorFixture({ now: () => time, inactiveExpiryMs: 100 })
    const rollout = fixture.system.add(
      '/sessions/rollout-1.jsonl',
      sessionMeta('thread-1') + started('turn-1', 1_000),
      '1',
    )
    await fixture.monitor.start()
    fixture.system.writers = []
    fixture.system.discoveryComplete = false
    time += 100
    await fixture.runScheduledScan()

    fixture.system.append(rollout, completed('turn-1', 601_000, 600_000))
    await fixture.runScheduledScan()

    expect(fixture.events).toEqual([
      observedStarted('thread-1', 'turn-1', 1_000),
      observedCompleted('thread-1', 'turn-1', 601_000, 600_000),
    ])
  })

  it('retains an aged live tracked writer omitted by the 256-writer discovery cap', async () => {
    let time = 1_000
    const fixture = monitorFixture({
      now: () => time,
      cursorLimit: 1,
      inactiveExpiryMs: 100,
    })
    const rollout = fixture.system.add(
      '/sessions/tracked.jsonl',
      sessionMeta('tracked-thread') + started('tracked-turn', 1_000),
      'tracked',
    )
    const trackedWriter = fixture.system.writers[0]!
    await fixture.monitor.start()

    for (let index = 0; index < 256; index += 1) {
      fixture.system.add(
        `/sessions/other-${index}.jsonl`,
        sessionMeta(`other-thread-${index}`),
        `other-${index}`,
      )
    }
    fixture.system.writers = [...fixture.system.writers.slice(1), trackedWriter]
    time += 100
    await fixture.runScheduledScan()

    fixture.system.append(rollout, completed('tracked-turn', 601_000, 600_000))
    fixture.system.writers = [...fixture.system.writers.slice(0, 256), fixture.system.writer(rollout)]
    await fixture.runScheduledScan()

    expect(fixture.events).toEqual([
      observedStarted('tracked-thread', 'tracked-turn', 1_000),
      observedCompleted('tracked-thread', 'tracked-turn', 601_000, 600_000),
    ])
  })

  it('exports a 24-hour production inactive-expiry default', () => {
    expect(EXTERNAL_TURN_INACTIVE_EXPIRY_MS).toBe(24 * 60 * 60 * 1_000)
  })

  it('never registers or emits more active cursors than the cursor limit', async () => {
    const fixture = monitorFixture({ cursorLimit: 256 })
    for (let index = 0; index < 257; index += 1) {
      fixture.system.add(
        `/sessions/${index}.jsonl`,
        sessionMeta(`thread-${index}`) + started(`turn-${index}`, index),
        `${index}`,
      )
    }
    await fixture.monitor.start()
    expect(fixture.events).toHaveLength(256)
    expect(new Set(fixture.system.readCalls.map(({ path }) => path)).size).toBe(256)

    await fixture.runScheduledScan()
    expect(fixture.events).toHaveLength(256)
    expect(new Set(fixture.system.readCalls.map(({ path }) => path)).size).toBe(256)
  })

  it('does not replay completed turns while inactive cursors churn beyond the limit', async () => {
    const fixture = monitorFixture({ now: 1_000, cursorLimit: 2 })
    for (let index = 0; index < 3; index += 1) {
      fixture.system.add(
        `/sessions/${index}.jsonl`,
        sessionMeta(`thread-${index}`) + completed(`turn-${index}`, 2_000, 2_000),
        `${index}`,
      )
    }
    await fixture.monitor.start()
    expect(fixture.events).toHaveLength(6)

    await fixture.runScheduledScan()
    await fixture.runScheduledScan()
    await fixture.runScheduledScan()

    expect(fixture.events).toHaveLength(6)
  })

  it('retries a terminal callback rejection without losing the completion offset', async () => {
    const events: ObservedTurnLifecycle[] = []
    let rejectTerminal = true
    const fixture = monitorFixture({
      onLifecycle: async (event) => {
        if (event.method === 'turn/completed' && rejectTerminal) {
          throw new Error('temporary callback failure')
        }
        events.push(event)
      },
    })
    const rollout = fixture.system.add(
      '/sessions/rollout-1.jsonl',
      sessionMeta('thread-1') + started('turn-1', 1_000),
      '1',
    )
    await fixture.monitor.start()
    fixture.system.append(rollout, completed('turn-1', 601_000, 600_000))

    await fixture.runScheduledScan()
    expect(events).toEqual([observedStarted('thread-1', 'turn-1', 1_000)])

    rejectTerminal = false
    await fixture.runScheduledScan()
    expect(events).toEqual([
      observedStarted('thread-1', 'turn-1', 1_000),
      observedCompleted('thread-1', 'turn-1', 601_000, 600_000),
    ])
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
