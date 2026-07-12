import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEmptyNtfyState, type NtfyNotifierState } from '../safe/ntfyState'
import {
  NTFY_IMMEDIATE_ATTEMPTS,
  NTFY_MIN_DURATION_MS,
  NTFY_REQUEST_TIMEOUT_MS,
  NtfyCompletionNotifier,
  readLatestAssistantText,
  summarizeAssistantResponse,
  type NtfySendRequest,
} from './ntfyCompletionNotifier'

afterEach(() => {
  vi.unstubAllGlobals()
})

function cloneState(state: NtfyNotifierState): NtfyNotifierState {
  return structuredClone(state)
}

class MemoryStateStore {
  readonly saves: NtfyNotifierState[] = []

  constructor(public state: NtfyNotifierState = createEmptyNtfyState()) {}

  async load(): Promise<NtfyNotifierState> {
    return cloneState(this.state)
  }

  async save(state: NtfyNotifierState): Promise<void> {
    this.state = cloneState(state)
    this.saves.push(cloneState(state))
  }
}

type TestNotification = { method: string; params: unknown }

function started(threadId = 'thread-1', turnId = 'turn-1'): TestNotification {
  return { method: 'turn/started', params: { threadId, turn: { id: turnId } } }
}

function completed(status = 'completed', threadId = 'thread-1', turnId = 'turn-1'): TestNotification {
  return { method: 'turn/completed', params: { threadId, turn: { id: turnId, status } } }
}

function harness(options: {
  now?: () => number
  store?: MemoryStateStore
  readThread?: (threadId: string) => Promise<unknown>
  send?: (request: NtfySendRequest) => Promise<void>
  warn?: (message: string) => void
  createTimeoutSignal?: (milliseconds: number) => AbortSignal
} = {}) {
  const store = options.store ?? new MemoryStateStore()
  const readThread = vi.fn(options.readThread ?? (async () => ({
    thread: { turns: [{ items: [{ type: 'agentMessage', text: '工作完成。更多内容' }] }] },
  })))
  const requests: NtfySendRequest[] = []
  const send = vi.fn(options.send ?? (async (request: NtfySendRequest) => {
    requests.push(request)
  }))
  const warn = vi.fn(options.warn ?? (() => undefined))
  const notifier = new NtfyCompletionNotifier({
    publishUrl: 'https://ntfy.sh/private-test-topic',
    stateStore: store,
    readThread,
    send,
    now: options.now ?? (() => 0),
    createTimeoutSignal: options.createTimeoutSignal ?? (() => new AbortController().signal),
    warn,
  })
  return { notifier, store, readThread, requests, send, warn }
}

async function runTurn(
  elapsed: number,
  options: Parameters<typeof harness>[0] = {},
  status = 'completed',
) {
  let now = 10_000
  const fixture = harness({ ...options, now: () => now })
  await fixture.notifier.start()
  fixture.notifier.handle(started())
  now += elapsed
  fixture.notifier.handle(completed(status))
  await fixture.notifier.dispose()
  return fixture
}

describe('assistant response extraction', () => {
  it('returns the first non-empty sentence with collapsed whitespace', () => {
    expect(summarizeAssistantResponse('  \n **完成了。**\n后续内容')).toBe('完成了。')
  })

  it('truncates a response to 180 characters', () => {
    expect(summarizeAssistantResponse('A'.repeat(220))).toHaveLength(180)
  })

  it('reads the newest non-empty agent message', () => {
    expect(readLatestAssistantText({
      thread: {
        turns: [
          { items: [{ type: 'agentMessage', text: '旧回复。' }] },
          { items: [{ type: 'agentMessage', text: '较新回复。' }, { type: 'commandExecution' }] },
          { items: [{ type: 'agentMessage', text: '最新回复。' }] },
        ],
      },
    })).toBe('最新回复。')
  })

  it('returns empty text for malformed thread results', () => {
    expect(readLatestAssistantText({ thread: { turns: [{ items: null }] } })).toBe('')
  })
})

describe('long-turn notification decisions', () => {
  it('does no work before the notifier is started', async () => {
    const fixture = harness()
    fixture.notifier.handle(started())
    fixture.notifier.handle(completed())
    await fixture.notifier.dispose()
    expect(fixture.store.saves).toHaveLength(0)
    expect(fixture.readThread).not.toHaveBeenCalled()
    expect(fixture.send).not.toHaveBeenCalled()
  })

  it('does not read or send at 599,999 milliseconds', async () => {
    const fixture = await runTurn(599_999)
    expect(fixture.readThread).not.toHaveBeenCalled()
    expect(fixture.send).not.toHaveBeenCalled()
  })

  it('sends at exactly 600,000 milliseconds', async () => {
    const fixture = await runTurn(NTFY_MIN_DURATION_MS)
    expect(fixture.send).toHaveBeenCalledTimes(1)
    expect(fixture.send.mock.calls[0]?.[0].record.message).toBe('工作完成。')
  })

  it.each([
    ['completed', 'Codex 任务完成'],
    ['failed', 'Codex 任务失败'],
    ['cancelled', 'Codex 任务已中断'],
  ] as const)('maps %s to the exact title %s', async (status, title) => {
    const fixture = await runTurn(NTFY_MIN_DURATION_MS, {}, status)
    expect(fixture.send.mock.calls[0]?.[0].record.title).toBe(title)
  })

  it.each([
    ['completed', '任务已完成。'],
    ['failed', '任务执行失败。'],
    ['cancelled', '任务已中断。'],
  ] as const)('uses the %s fallback when no assistant message exists', async (status, message) => {
    const fixture = await runTurn(
      NTFY_MIN_DURATION_MS,
      { readThread: async () => ({ thread: { turns: [] } }) },
      status,
    )
    expect(fixture.send.mock.calls[0]?.[0].record.message).toBe(message)
  })

  it('ignores missing IDs and completions without a matching start', async () => {
    const fixture = harness()
    await fixture.notifier.start()
    fixture.notifier.handle({ method: 'turn/started', params: { turn: { id: 'turn-1' } } })
    fixture.notifier.handle({ method: 'turn/started', params: { threadId: 'thread-1' } })
    fixture.notifier.handle(completed())
    fixture.notifier.handle(completed('completed', 'thread-2', 'turn-2'))
    await fixture.notifier.dispose()
    expect(fixture.readThread).not.toHaveBeenCalled()
    expect(fixture.send).not.toHaveBeenCalled()
  })

  it('extracts snake-case and nested identifiers', async () => {
    let now = 0
    const fixture = harness({ now: () => now })
    await fixture.notifier.start()
    fixture.notifier.handle({
      method: 'turn/started',
      params: { thread: { id: 'nested-thread' }, turn: { turn_id: 'nested-turn' } },
    })
    now = NTFY_MIN_DURATION_MS
    fixture.notifier.handle({
      method: 'turn/completed',
      params: { thread_id: 'nested-thread', turn_id: 'nested-turn', status: 'failed' },
    })
    await fixture.notifier.dispose()
    expect(fixture.send.mock.calls[0]?.[0].record.title).toBe('Codex 任务失败')
  })

  it('keeps the earliest timestamp for duplicate starts', async () => {
    let now = 100
    const fixture = harness({ now: () => now })
    await fixture.notifier.start()
    fixture.notifier.handle(started())
    now = 500
    fixture.notifier.handle(started())
    now = 100 + NTFY_MIN_DURATION_MS
    fixture.notifier.handle(completed())
    await fixture.notifier.dispose()
    expect(fixture.send).toHaveBeenCalledTimes(1)
    expect(fixture.store.saves.find((state) => state.active.length === 1)?.active[0]?.startedAt).toBe(100)
  })

  it('deduplicates duplicate completions by thread and turn', async () => {
    let now = 0
    const fixture = harness({ now: () => now })
    await fixture.notifier.start()
    fixture.notifier.handle(started())
    now = NTFY_MIN_DURATION_MS
    fixture.notifier.handle(completed())
    fixture.notifier.handle(completed())
    await fixture.notifier.dispose()
    expect(fixture.send).toHaveBeenCalledTimes(1)
    expect(fixture.store.state.pending).toHaveLength(0)
    expect(fixture.store.state.sent.map(({ key }) => key)).toEqual(['thread-1:turn-1'])
  })
})

describe('durable sequential delivery', () => {
  it('returns from handle before an active-record save completes', async () => {
    let releaseSave: (() => void) | undefined
    const store = new MemoryStateStore()
    store.save = vi.fn(async (state: NtfyNotifierState) => {
      await new Promise<void>((resolve) => { releaseSave = resolve })
      store.state = cloneState(state)
      store.saves.push(cloneState(state))
    })
    const fixture = harness({ store })
    await fixture.notifier.start()

    expect(fixture.notifier.handle(started())).toBeUndefined()
    await vi.waitFor(() => expect(releaseSave).toBeTypeOf('function'))
    expect(store.state.active).toHaveLength(0)
    releaseSave?.()
    await fixture.notifier.dispose()
    expect(store.state.active).toHaveLength(1)
  })

  it('loads an active start after reconstruction and qualifies completion', async () => {
    let now = 1_000
    const store = new MemoryStateStore()
    const first = harness({ store, now: () => now })
    await first.notifier.start()
    first.notifier.handle(started())
    await first.notifier.dispose()

    now += NTFY_MIN_DURATION_MS
    const second = harness({ store, now: () => now })
    await second.notifier.start()
    second.notifier.handle(completed())
    await second.notifier.dispose()
    expect(second.send).toHaveBeenCalledTimes(1)
  })

  it('persists pending before the first send', async () => {
    const store = new MemoryStateStore()
    const fixture = await runTurn(NTFY_MIN_DURATION_MS, {
      store,
      send: async () => {
        expect(store.state.pending).toHaveLength(1)
        expect(store.state.sent).toHaveLength(0)
      },
    })
    expect(fixture.store.saves.some((state) => state.pending.length === 1)).toBe(true)
  })

  it('makes exactly three immediate attempts and keeps failed pending durable', async () => {
    const fixture = await runTurn(NTFY_MIN_DURATION_MS, {
      send: async () => { throw new Error('failure') },
    })
    expect(fixture.send).toHaveBeenCalledTimes(NTFY_IMMEDIATE_ATTEMPTS)
    expect(fixture.store.state.pending).toHaveLength(1)
    expect(fixture.store.state.sent).toHaveLength(0)
  })

  it('retries persisted pending during start and marks success durable', async () => {
    const store = new MemoryStateStore({
      active: [],
      pending: [{
        key: 'thread-1:turn-1',
        title: 'Codex 任务完成',
        message: '持久消息。',
        createdAt: 5,
      }],
      sent: [],
    })
    const fixture = harness({ store, now: () => 10 })
    await fixture.notifier.start()
    expect(fixture.send).toHaveBeenCalledTimes(1)
    expect(store.state.pending).toHaveLength(0)
    expect(store.state.sent).toEqual([{ key: 'thread-1:turn-1', sentAt: 10 }])
  })

  it('reconstructs and retries a pending record left by failed delivery', async () => {
    const store = new MemoryStateStore()
    const firstSequenceIds: string[] = []
    const first = await runTurn(NTFY_MIN_DURATION_MS, {
      store,
      send: async (request) => {
        firstSequenceIds.push(request.sequenceId)
        throw new Error('offline')
      },
    })
    expect(first.store.state.pending).toHaveLength(1)

    const secondSequenceIds: string[] = []
    const secondWithSender = harness({
      store,
      now: () => NTFY_MIN_DURATION_MS + 1,
      send: async (request) => { secondSequenceIds.push(request.sequenceId) },
    })
    await secondWithSender.notifier.start()
    expect(secondWithSender.send).toHaveBeenCalledTimes(1)
    expect(new Set(firstSequenceIds)).toEqual(new Set([secondSequenceIds[0]]))
    expect(store.state.pending).toHaveLength(0)
    expect(store.state.sent).toHaveLength(1)
  })

  it('does not repeat an accepted request when saving sent state fails', async () => {
    const store = new MemoryStateStore()
    let saveCount = 0
    const originalSave = store.save.bind(store)
    store.save = async (state) => {
      saveCount += 1
      if (saveCount === 3) throw new Error('sent-state save failed')
      await originalSave(state)
    }
    const fixture = await runTurn(NTFY_MIN_DURATION_MS, { store })
    expect(fixture.send).toHaveBeenCalledTimes(1)
    expect(fixture.warn).toHaveBeenCalledWith('Unable to process long-task notification state')
  })

  it('drains multiple pending records sequentially', async () => {
    const store = new MemoryStateStore({
      active: [],
      pending: [1, 2].map((number) => ({
        key: `thread-${number}:turn-${number}`,
        title: 'Codex 任务完成' as const,
        message: `消息 ${number}。`,
        createdAt: number,
      })),
      sent: [],
    })
    let concurrent = 0
    let maximumConcurrent = 0
    const fixture = harness({
      store,
      send: async () => {
        concurrent += 1
        maximumConcurrent = Math.max(maximumConcurrent, concurrent)
        await Promise.resolve()
        concurrent -= 1
      },
    })
    await fixture.notifier.start()
    expect(fixture.send).toHaveBeenCalledTimes(2)
    expect(maximumConcurrent).toBe(1)
  })

  it('uses stable, distinct, bounded ASCII sequence IDs for turn pairs', async () => {
    const store = new MemoryStateStore({
      active: [],
      pending: [
        { key: '线程一:轮次一', title: 'Codex 任务完成', message: '一。', createdAt: 1 },
        { key: '线程二:轮次二', title: 'Codex 任务完成', message: '二。', createdAt: 2 },
      ],
      sent: [],
    })
    const sequenceIds: string[] = []
    const fixture = harness({
      store,
      send: async (request) => { sequenceIds.push(request.sequenceId) },
    })
    await fixture.notifier.start()

    expect(sequenceIds).toHaveLength(2)
    expect(sequenceIds[0]).not.toBe(sequenceIds[1])
    for (const sequenceId of sequenceIds) {
      expect(sequenceId).toMatch(/^[A-Za-z0-9_-]+$/u)
      expect(sequenceId.length).toBeLessThanOrEqual(64)
    }
  })

  it('builds the real default fetch request with RFC 2047 title and sequence ID headers', async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>): Promise<Response> => (
      { ok: true, status: 200 } as Response
    ))
    vi.stubGlobal('fetch', fetchMock)
    const store = new MemoryStateStore({
      active: [],
      pending: [{
        key: 'thread-real:turn-real',
        title: 'Codex 任务完成',
        message: '默认请求测试。',
        createdAt: 1,
      }],
      sent: [],
    })
    const notifier = new NtfyCompletionNotifier({
      publishUrl: 'https://ntfy.sh/private-test-topic',
      stateStore: store,
      readThread: async () => ({}),
      createTimeoutSignal: () => new AbortController().signal,
      warn: vi.fn(),
    })

    await notifier.start()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] ?? []
    const headers = new Headers(init?.headers)
    const encodedTitle = headers.get('Title') ?? ''
    expect(url).toBe('https://ntfy.sh/private-test-topic')
    expect(init?.method).toBe('POST')
    expect(init?.body).toBe('默认请求测试。')
    expect(encodedTitle).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/]+=*\?=$/u)
    expect(Buffer.from(encodedTitle.slice(10, -2), 'base64').toString('utf8')).toBe('Codex 任务完成')
    expect([...encodedTitle].every((character) => character.charCodeAt(0) <= 0x7f)).toBe(true)
    expect(headers.get('X-Sequence-ID')).toMatch(/^[A-Za-z0-9_-]{1,64}$/u)
    expect(headers.get('Priority')).toBe('default')
    expect(headers.get('Tags')).toBe('white_check_mark')
  })

  it('creates a fresh 5,000 ms timeout signal for every attempt', async () => {
    const signals: AbortSignal[] = []
    const createTimeoutSignal = vi.fn((milliseconds: number) => {
      const signal = new AbortController().signal
      signals.push(signal)
      return signal
    })
    const fixture = await runTurn(NTFY_MIN_DURATION_MS, {
      createTimeoutSignal,
      send: async () => { throw new Error('failure') },
    })
    expect(createTimeoutSignal).toHaveBeenCalledTimes(NTFY_IMMEDIATE_ATTEMPTS)
    expect(createTimeoutSignal.mock.calls.every(([milliseconds]) => milliseconds === NTFY_REQUEST_TIMEOUT_MS)).toBe(true)
    expect(new Set(signals).size).toBe(NTFY_IMMEDIATE_ATTEMPTS)
    expect(fixture.send.mock.calls.map(([request]) => request.signal)).toEqual(signals)
  })

  it('redacts the URL, topic, message, and sender error from warnings', async () => {
    const secretError = 'https://ntfy.sh/private-test-topic 工作完成。'
    const fixture = await runTurn(NTFY_MIN_DURATION_MS, {
      send: async () => { throw new Error(secretError) },
    })
    const warnings = fixture.warn.mock.calls.flat().join('\n')
    expect(warnings).not.toContain('https://')
    expect(warnings).not.toContain('private-test-topic')
    expect(warnings).not.toContain('工作完成')
    expect(warnings).not.toContain(secretError)
  })
})
