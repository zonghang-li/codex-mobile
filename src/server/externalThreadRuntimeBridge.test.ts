import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  it('attaches batch runtime observations to thread-list rows', async () => {
    const probe = fakeProbe({ state: 'idle' })
    probe.inspectMany.mockResolvedValue({
      'thread-a': {
        state: 'running',
        turnId: 'turn-external',
        interruptible: false,
        source: 'external-session-writer',
      },
      'thread-b': { state: 'idle' },
    })
    const payload = {
      data: [
        { id: 'thread-a', path: '/sessions/a.jsonl' },
        { id: 'thread-b', path: '/sessions/b.jsonl' },
        { id: '', path: '/sessions/invalid.jsonl' },
      ],
    }

    await expect(augmentThreadResultWithExternalRuntime(
      'thread/list', payload, probe, 4242,
    )).resolves.toEqual({
      data: [
        {
          id: 'thread-a',
          path: '/sessions/a.jsonl',
          externalRuntime: {
            state: 'running',
            turnId: 'turn-external',
            interruptible: false,
            source: 'external-session-writer',
          },
        },
        { id: 'thread-b', path: '/sessions/b.jsonl', externalRuntime: { state: 'idle' } },
        { id: '', path: '/sessions/invalid.jsonl' },
      ],
    })
    expect(probe.registerThread.mock.calls).toEqual([
      ['thread-a', '/sessions/a.jsonl'],
      ['thread-b', '/sessions/b.jsonl'],
    ])
    expect(probe.inspect).not.toHaveBeenCalled()
    expect(probe.inspectMany).toHaveBeenCalledWith(['thread-a', 'thread-b'], 4242)
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
      localRuntimeLedger: {
        record: (notification: { method: string; params: unknown }) => void
      }
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

describe('POST /codex-api/rpc guarded resume', () => {
  it('degrades thread/resume to thread/read while another process owns the task', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running',
      turnId: 'turn-external',
      interruptible: false,
      source: 'external-session-writer',
    })
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({
      thread: {
        id: 'thread-external',
        path: '/home/user/.codex/sessions/rollout-thread-external.jsonl',
        status: { type: 'idle' },
        turns: [],
      },
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/resume',
        params: { threadId: 'thread-external' },
      }),
    })

    expect(response.status).toBe(200)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('thread/read', {
      threadId: 'thread-external',
      includeTurns: true,
    })
    await expect(response.json()).resolves.toMatchObject({
      result: {
        thread: {
          id: 'thread-external',
          externalRuntime: { state: 'running', source: 'external-session-writer' },
        },
      },
    })
  })

  it('degrades an active thread/resume to thread/read when another process owns the writer', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running',
      turnId: 'turn-external',
      interruptible: false,
      source: 'external-session-writer',
    })
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({
      thread: {
        id: 'thread-active-external',
        path: '/home/user/.codex/sessions/rollout-thread-active-external.jsonl',
        status: { type: 'active' },
        turns: [{ id: 'turn-external', status: 'inProgress' }],
      },
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/resume',
        params: { threadId: 'thread-active-external' },
      }),
    })

    expect(response.status).toBe(200)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('thread/read', {
      threadId: 'thread-active-external',
      includeTurns: true,
    })
    expect(inspect).toHaveBeenCalledWith('thread-active-external', 4242)
  })

  it('does not resume when writer ownership is unknown', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'unknown',
    })
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({
      thread: {
        id: 'thread-unknown-writer',
        path: '/home/user/.codex/sessions/rollout-thread-unknown-writer.jsonl',
        status: { type: 'idle' },
        turns: [],
      },
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/resume',
        params: { threadId: 'thread-unknown-writer' },
      }),
    })

    expect(response.status).toBe(200)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('thread/read', {
      threadId: 'thread-unknown-writer',
      includeTurns: true,
    })
    expect(inspect).toHaveBeenCalledWith('thread-unknown-writer', 4242)
  })
})

describe('dynamic tool server requests', () => {
  it('fails an unsupported request owned by the current app-server without listing it as pending', () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    const appServer = shared.appServer as unknown as {
      handleServerRequest(requestId: number, method: string, params: unknown): void
      listPendingServerRequests(): unknown[]
      sendServerRequestReply(requestId: number, reply: unknown): void
    }
    const reply = vi.spyOn(appServer, 'sendServerRequestReply').mockImplementation(() => undefined)
    disposers.push(() => middleware.dispose())

    appServer.handleServerRequest(77, 'item/tool/call', {
      threadId: 'thread-local',
      toolName: 'codex_app/list_threads',
      arguments: [],
    })

    expect(appServer.listPendingServerRequests()).toEqual([])
    expect(reply).toHaveBeenCalledWith(77, {
      error: {
        code: -32601,
        message: 'Dynamic tool calls are not supported by codex-mobile.',
      },
    })
  })
})

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

describe('GET /codex-api/thread-live-state external runtime parity', () => {
  it('marks a stale idle thread read as in progress when an external writer is active', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.appServer, 'rpc').mockResolvedValue({
      thread: {
        id: 'thread-external',
        path: '/sessions/thread-external.jsonl',
        turns: [{ id: 'turn-complete', status: 'completed', items: [] }],
      },
    })
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running',
      turnId: 'turn-external',
      interruptible: false,
      source: 'external-session-writer',
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-external`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      threadId: 'thread-external',
      isInProgress: true,
      externalRuntime: {
        state: 'running',
        turnId: 'turn-external',
        interruptible: false,
        source: 'external-session-writer',
      },
    })
    expect(inspect).toHaveBeenCalledWith('thread-external', 4242)
  })

  it('does not serve a cached idle live-state while an external writer is active', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.appServer, 'rpc').mockResolvedValue({
      thread: {
        id: 'thread-cached',
        path: '/sessions/thread-cached.jsonl',
        turns: [{ id: 'turn-complete', status: 'completed', items: [] }],
      },
    })
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect')
    inspect.mockResolvedValueOnce({ state: 'idle' })
    inspect.mockResolvedValueOnce({
      state: 'running',
      turnId: 'turn-external',
      interruptible: false,
      source: 'external-session-writer',
    })
    const port = await listenWithMiddleware(middleware)

    const first = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-cached`)
    await expect(first.json()).resolves.toMatchObject({ isInProgress: false })

    const second = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-cached`)

    await expect(second.json()).resolves.toMatchObject({
      isInProgress: true,
      externalRuntime: {
        state: 'running',
        turnId: 'turn-external',
        interruptible: false,
        source: 'external-session-writer',
      },
    })
    expect(inspect).toHaveBeenCalledTimes(2)
  })

  it('reuses a cached running live-state when the external session file has not changed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-running.jsonl')
    await writeFile(rolloutPath, '{"type":"session_meta"}\n')

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const rpc = vi.spyOn(shared.appServer, 'rpc').mockResolvedValue({
      thread: {
        id: 'thread-running',
        path: rolloutPath,
        turns: [{ id: 'turn-complete', status: 'completed', items: [] }],
      },
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running',
      turnId: 'turn-external',
      interruptible: false,
      source: 'external-session-writer',
    })
    const port = await listenWithMiddleware(middleware)

    const first = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-running`)
    await expect(first.json()).resolves.toMatchObject({ isInProgress: true })

    const second = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-running`)
    await expect(second.json()).resolves.toMatchObject({ isInProgress: true })

    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('projects live state to the newest absolute turn', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    const turns = Array.from({ length: 12 }, (_unused, index) => ({
      id: `turn-${index}`,
      status: index === 11 ? 'inProgress' : 'completed',
      items: [{
        id: `item-${index}`,
        type: 'agentMessage',
        text: `message ${index}`,
      }],
    }))
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.appServer, 'rpc').mockResolvedValue({
      thread: {
        id: 'thread-windowed',
        path: '/sessions/thread-windowed.jsonl',
        turns,
      },
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({ state: 'idle' })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-windowed`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      threadId: 'thread-windowed',
      threadTurnStartIndex: 11,
      hasMoreOlder: true,
      conversationState: {
        turns: [
          expect.objectContaining({ id: 'turn-11' }),
        ],
      },
    })
  })

  it('preserves canonical item order when recovering command items from the session log', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-session-order-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-order.jsonl')
    await writeFile(rolloutPath, [
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-order' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'call-order',
          arguments: JSON.stringify({ cmd: 'echo recovered' }),
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call-order',
          output: 'Process exited with code 0\nWall time: 0.001 seconds\nOutput:\nrecovered\n',
        },
      }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant' } }),
      '',
    ].join('\n'))

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.appServer, 'rpc').mockResolvedValue({
      thread: {
        id: 'thread-order',
        path: rolloutPath,
        turns: [{
          id: 'turn-order',
          status: 'completed',
          items: [
            { id: 'user-1', type: 'userMessage', content: [] },
            { id: 'reasoning-1', type: 'reasoning', summary: ['thinking'], content: [] },
            { id: 'agent-1', type: 'agentMessage', text: 'first' },
            { id: 'tool-1', type: 'mcpToolCall', status: 'completed' },
            { id: 'agent-2', type: 'agentMessage', text: 'second' },
          ],
        }],
      },
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({ state: 'idle' })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-order`)
    const payload = await response.json() as {
      conversationState?: { turns?: Array<{ items?: Array<{ id?: string; type?: string }> }> }
    }
    const itemIds = payload.conversationState?.turns?.[0]?.items?.map((item) => item.id) ?? []

    expect(response.status).toBe(200)
    expect(itemIds).toEqual([
      'user-1',
      'reasoning-1',
      'agent-1',
      'session-cmd-call-order',
      'tool-1',
      'agent-2',
    ])
  })

  it('recovers session command rows for normal thread/read RPC responses', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-rpc-session-command-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-rpc.jsonl')
    await writeFile(rolloutPath, [
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-rpc' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'call-rpc',
          arguments: JSON.stringify({ cmd: 'ls -lh' }),
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call-rpc',
          output: 'Process exited with code 0\nWall time: 0.001 seconds\nOutput:\ntotal 0\n',
        },
      }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant' } }),
      '',
    ].join('\n'))

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.appServer, 'rpc').mockResolvedValue({
      thread: {
        id: 'thread-rpc',
        path: rolloutPath,
        turns: [{
          id: 'turn-rpc',
          status: 'completed',
          items: [
            { id: 'user-1', type: 'userMessage', content: [] },
            { id: 'agent-1', type: 'agentMessage', text: 'first' },
            { id: 'native-file-change', type: 'fileChange', status: 'completed', changes: [] },
            { id: 'agent-2', type: 'agentMessage', text: 'second' },
          ],
        }],
      },
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({ state: 'idle' })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/read',
        params: { threadId: 'thread-rpc', includeTurns: true },
      }),
    })
    const payload = await response.json() as {
      result?: { thread?: { turns?: Array<{ items?: Array<{ id?: string; type?: string; command?: string }> }> } }
    }
    const items = payload.result?.thread?.turns?.[0]?.items ?? []

    expect(response.status).toBe(200)
    expect(items.map((item) => item.id)).toEqual([
      'user-1',
      'agent-1',
      'session-cmd-call-rpc',
      'native-file-change',
      'agent-2',
    ])
    expect(items[2]).toMatchObject({
      type: 'commandExecution',
      command: 'ls -lh',
    })
  })

  it('caps recovered session command output in normal thread/read RPC responses', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-rpc-session-command-large-output-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-rpc-large-output.jsonl')
    const longOutput = `first-line\n${'x'.repeat(70_000)}\nlast-line`
    await writeFile(rolloutPath, [
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-rpc-large-output' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'call-rpc-large-output',
          arguments: JSON.stringify({ cmd: 'journalctl --user -n 5000' }),
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call-rpc-large-output',
          output: `Process exited with code 0\nWall time: 0.001 seconds\nOutput:\n${longOutput}\n`,
        },
      }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant' } }),
      '',
    ].join('\n'))

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.appServer, 'rpc').mockResolvedValue({
      thread: {
        id: 'thread-rpc-large-output',
        path: rolloutPath,
        turns: [{
          id: 'turn-rpc-large-output',
          status: 'completed',
          items: [
            { id: 'user-1', type: 'userMessage', content: [] },
            { id: 'agent-1', type: 'agentMessage', text: 'done' },
          ],
        }],
      },
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({ state: 'idle' })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/read',
        params: { threadId: 'thread-rpc-large-output', includeTurns: true },
      }),
    })
    const payload = await response.json() as {
      result?: { thread?: { turns?: Array<{ items?: Array<{ id?: string; aggregatedOutput?: string }> }> } }
    }
    const command = payload.result?.thread?.turns?.[0]?.items?.find((item) => item.id === 'session-cmd-call-rpc-large-output')

    expect(response.status).toBe(200)
    expect(command?.aggregatedOutput?.length).toBeLessThan(20_000)
    expect(command?.aggregatedOutput).toContain('first-line')
    expect(command?.aggregatedOutput).toContain('last-line')
    expect(command?.aggregatedOutput).toContain('truncated')
  })
})

describe('POST /codex-api/thread-runtime-states', () => {
  it('prefers a currently running local app-server turn over external idle', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.runtimeProbe, 'inspectMany').mockResolvedValue({
      'thread-local': { state: 'idle' },
    })
    shared.localRuntimeLedger.record({
      method: 'turn/started',
      params: { threadId: 'thread-local', turn: { id: 'turn-local' } },
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-runtime-states`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadIds: ['thread-local'] }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      states: {
        'thread-local': {
          state: 'running',
          turnId: 'turn-local',
          interruptible: true,
          source: 'local-app-server',
        },
      },
    })
  })

  it('reads local authority after the external scan settles', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    let resolveInspection!: (value: Record<string, ExternalThreadRuntime>) => void
    const inspectMany = vi.spyOn(shared.runtimeProbe, 'inspectMany').mockImplementation(
      () => new Promise((resolve) => {
        resolveInspection = resolve
      }),
    )
    const port = await listenWithMiddleware(middleware)

    const responsePromise = fetch(`http://127.0.0.1:${port}/codex-api/thread-runtime-states`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadIds: ['thread-local'] }),
    })
    await vi.waitFor(() => expect(inspectMany).toHaveBeenCalledTimes(1))
    shared.localRuntimeLedger.record({
      method: 'turn/started',
      params: { threadId: 'thread-local', turn: { id: 'turn-during-scan' } },
    })
    resolveInspection({ 'thread-local': { state: 'idle' } })

    const response = await responsePromise
    await expect(response.json()).resolves.toEqual({
      states: {
        'thread-local': {
          state: 'running',
          turnId: 'turn-during-scan',
          interruptible: true,
          source: 'local-app-server',
        },
      },
    })
  })

  it('returns external idle after the matching local turn completes', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.runtimeProbe, 'inspectMany').mockResolvedValue({
      'thread-local': { state: 'idle' },
    })
    shared.localRuntimeLedger.record({
      method: 'turn/started',
      params: { threadId: 'thread-local', turn: { id: 'turn-local' } },
    })
    shared.localRuntimeLedger.record({
      method: 'turn/completed',
      params: { threadId: 'thread-local', turn: { id: 'turn-local' } },
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-runtime-states`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadIds: ['thread-local'] }),
    })

    await expect(response.json()).resolves.toEqual({
      states: { 'thread-local': { state: 'idle' } },
    })
  })

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
