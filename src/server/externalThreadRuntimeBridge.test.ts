import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExternalThreadRuntime } from '../types/threadRuntime'
import {
  augmentThreadResultWithExternalRuntime,
  createCodexBridgeMiddleware,
} from './codexAppServerBridge'
import { PERMISSIVE_SECURITY_POLICY } from './securityPolicy'

function fakeProbe(runtime: ExternalThreadRuntime) {
  return {
    registerThread: vi.fn((_threadId: string, _rolloutPath: string): void => undefined),
    inspect: vi.fn(async (
      _threadId: string,
      _excludedPid: number | null,
    ): Promise<ExternalThreadRuntime> => runtime),
    inspectMany: vi.fn(async (
      threadIds: readonly string[],
      _excludedPid: number | null,
    ): Promise<Record<string, ExternalThreadRuntime>> => Object.fromEntries(
      threadIds.map((threadId) => [threadId, runtime]),
    )),
  }
}

describe('external thread runtime bridge augmentation', () => {
  it('attaches external runtime to an idle thread without mutating the sanitized response', async () => {
    const probe = fakeProbe({
      state: 'running',
      turnId: 'turn-external',
      interruptible: false,
      source: 'external-session-writer',
    })
    const thread = {
      id: 'thread-1',
      path: '/home/user/.codex/sessions/rollout-thread-1.jsonl',
      status: { type: 'idle' },
      turns: [{ id: 'turn-complete', status: 'completed' }],
    }
    const payload = { thread }

    const result = await augmentThreadResultWithExternalRuntime(
      'thread/read',
      payload,
      probe,
      4242,
    ) as { thread: Record<string, unknown> }

    expect(result).not.toBe(payload)
    expect(result.thread).not.toBe(thread)
    expect(payload).toEqual({ thread })
    expect(result.thread.externalRuntime).toEqual({
      state: 'running',
      turnId: 'turn-external',
      interruptible: false,
      source: 'external-session-writer',
    })
    expect(result.thread.status).toEqual({ type: 'idle' })
    expect(probe.registerThread).toHaveBeenCalledWith(
      'thread-1',
      '/home/user/.codex/sessions/rollout-thread-1.jsonl',
    )
    expect(probe.inspect).toHaveBeenCalledWith('thread-1', 4242)
  })

  it('registers but does not inspect or augment a locally active thread', async () => {
    const probe = fakeProbe({
      state: 'running',
      turnId: 'turn-external',
      interruptible: false,
      source: 'external-session-writer',
    })
    const payload = {
      thread: {
        id: 'thread-1',
        path: '/home/user/.codex/sessions/rollout-thread-1.jsonl',
        status: { type: 'active' },
        turns: [{ id: 'turn-local', status: 'inProgress' }],
      },
    }

    await expect(augmentThreadResultWithExternalRuntime(
      'thread/resume',
      payload,
      probe,
      4242,
    )).resolves.toBe(payload)
    expect(probe.registerThread).toHaveBeenCalledOnce()
    expect(probe.inspect).not.toHaveBeenCalled()
    expect(payload.thread).not.toHaveProperty('externalRuntime')
  })

  it('registers thread-list rollout paths without inspecting them', async () => {
    const probe = fakeProbe({ state: 'idle' })
    const payload = {
      data: [
        { id: 'thread-a', path: '/sessions/a.jsonl' },
        { id: 'thread-b', path: '/sessions/b.jsonl' },
        { id: '', path: '/sessions/invalid.jsonl' },
      ],
    }

    await expect(augmentThreadResultWithExternalRuntime(
      'thread/list', payload, probe, 4242,
    )).resolves.toBe(payload)
    expect(probe.registerThread.mock.calls).toEqual([
      ['thread-a', '/sessions/a.jsonl'],
      ['thread-b', '/sessions/b.jsonl'],
    ])
    expect(probe.inspect).not.toHaveBeenCalled()
    expect(probe.inspectMany).not.toHaveBeenCalled()
  })
})

const disposers: Array<() => void> = []

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  vi.restoreAllMocks()
})

function sharedBridgeForTest() {
  return (globalThis as typeof globalThis & {
    __codexRemoteSharedBridge__: {
      runtimeProbe: {
        inspect: (threadId: string, excludedPid: number | null) => Promise<ExternalThreadRuntime>
        inspectMany: (
          threadIds: readonly string[],
          excludedPid: number | null,
        ) => Promise<Record<string, ExternalThreadRuntime>>
      }
      appServer: { getPid: () => number | null }
    }
  }).__codexRemoteSharedBridge__
}

async function listenWithMiddleware(middleware: ReturnType<typeof createCodexBridgeMiddleware>) {
  const server = createServer((req, res) => {
    void middleware(req, res, () => {
      res.statusCode = 404
      res.end()
    })
  })
  disposers.push(() => {
    middleware.dispose()
    server.close()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

describe('GET /codex-api/thread-runtime-state', () => {

  it('returns a successful runtime payload and excludes the mobile child PID', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running',
      turnId: 'turn-external',
      interruptible: false,
      source: 'external-session-writer',
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-runtime-state?threadId=thread-1`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      state: 'running',
      turnId: 'turn-external',
      interruptible: false,
      source: 'external-session-writer',
    })
    expect(inspect).toHaveBeenCalledWith('thread-1', 4242)
  })

  it('applies route security policy before invoking the runtime handler', async () => {
    const isRouteDisabled = vi.fn(() => true)
    const middleware = createCodexBridgeMiddleware({
      securityPolicy: { ...PERMISSIVE_SECURITY_POLICY, isRouteDisabled, backgroundIntegrationsEnabled: false },
    })
    const shared = sharedBridgeForTest()
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect')
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-runtime-state?threadId=thread-1`)

    expect(response.status).toBe(403)
    expect(isRouteDisabled).toHaveBeenCalledWith('GET', '/codex-api/thread-runtime-state')
    expect(inspect).not.toHaveBeenCalled()
  })

  it('rejects a missing threadId inside the bridge middleware', async () => {
    const middleware = createCodexBridgeMiddleware()
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-runtime-state`)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Missing threadId' })
  })
})

describe('POST /codex-api/thread-runtime-states', () => {
  it('returns runtime states for a validated batch and excludes the mobile child PID', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const inspectMany = vi.spyOn(shared.runtimeProbe, 'inspectMany').mockResolvedValue({
      'thread-a': {
        state: 'running',
        turnId: 'turn-a',
        interruptible: false,
        source: 'external-session-writer',
      },
      'thread-b': { state: 'idle' },
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-runtime-states`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadIds: ['thread-a', 'thread-b'] }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      states: {
        'thread-a': {
          state: 'running',
          turnId: 'turn-a',
          interruptible: false,
          source: 'external-session-writer',
        },
        'thread-b': { state: 'idle' },
      },
    })
    expect(inspectMany).toHaveBeenCalledTimes(1)
    expect(inspectMany).toHaveBeenCalledWith(['thread-a', 'thread-b'], 4242)
  })

  it('rejects malformed JSON without inspecting runtimes', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    const inspectMany = vi.spyOn(shared.runtimeProbe, 'inspectMany')
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-runtime-states`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"threadIds":',
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Invalid JSON body' })
    expect(inspectMany).not.toHaveBeenCalled()
  })

  it.each([
    ['null body', null],
    ['missing threadIds', {}],
    ['empty threadIds', { threadIds: [] }],
    ['more than 50 threadIds', { threadIds: Array.from({ length: 51 }, (_, index) => `thread-${index}`) }],
    ['duplicate threadIds', { threadIds: ['thread-a', 'thread-a'] }],
    ['empty threadId', { threadIds: [''] }],
    ['whitespace threadId', { threadIds: [' thread-a'] }],
    ['non-string threadId', { threadIds: [123] }],
    ['extra body property', { threadIds: ['thread-a'], extra: true }],
  ])('rejects %s without inspecting runtimes', async (_label, payload) => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    const inspectMany = vi.spyOn(shared.runtimeProbe, 'inspectMany')
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-runtime-states`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    expect(response.status).toBe(400)
    expect(inspectMany).not.toHaveBeenCalled()
  })

  it('applies route security policy before invoking the batch runtime handler', async () => {
    const isRouteDisabled = vi.fn(() => true)
    const middleware = createCodexBridgeMiddleware({
      securityPolicy: { ...PERMISSIVE_SECURITY_POLICY, isRouteDisabled, backgroundIntegrationsEnabled: false },
    })
    const shared = sharedBridgeForTest()
    const inspectMany = vi.spyOn(shared.runtimeProbe, 'inspectMany')
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-runtime-states`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadIds: ['thread-a'] }),
    })

    expect(response.status).toBe(403)
    expect(isRouteDisabled).toHaveBeenCalledWith('POST', '/codex-api/thread-runtime-states')
    expect(inspectMany).not.toHaveBeenCalled()
  })
})
