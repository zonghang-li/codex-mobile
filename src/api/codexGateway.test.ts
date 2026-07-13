import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ThreadReadResponse } from './appServerDtos'
import {
  getAvailableModelIds,
  getThreadDetail,
  getThreadRuntimeState,
  getThreadRuntimeStates,
  listDirectoryComposioConnectors,
  readThreadDetailRuntime,
  resumeThread,
  startThreadTurn,
} from './codexGateway'

function runtimePayload(thread: Record<string, unknown>): ThreadReadResponse {
  return { thread } as unknown as ThreadReadResponse
}

function mockRpcFetch(): { requests: Array<{ method: string, params: Record<string, unknown> }> } {
  const requests: Array<{ method: string, params: Record<string, unknown> }> = []

  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === 'string'
      ? JSON.parse(init.body) as { method: string, params: Record<string, unknown> }
      : { method: '', params: {} }

    requests.push(body)

    return new Response(JSON.stringify({
      result: {
        turn: {
          id: `turn-${requests.length}`,
        },
      },
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    })
  }))

  return { requests }
}

describe('startThreadTurn collaboration mode payloads', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends default collaboration mode explicitly after a plan turn', async () => {
    const { requests } = mockRpcFetch()

    await startThreadTurn('thread-1', 'make a plan', [], 'gpt-5.4', 'medium', undefined, [], 'plan')
    await startThreadTurn('thread-1', 'implement it', [], 'gpt-5.4', 'medium', undefined, [], 'default')

    expect(requests).toHaveLength(2)
    expect(requests[0].method).toBe('turn/start')
    expect(requests[0].params.collaborationMode).toEqual({
      mode: 'plan',
      settings: {
        model: 'gpt-5.4',
        reasoning_effort: 'medium',
        developer_instructions: null,
      },
    })
    expect(requests[1].method).toBe('turn/start')
    expect(requests[1].params.collaborationMode).toEqual({
      mode: 'default',
      settings: {
        model: 'gpt-5.4',
        reasoning_effort: 'medium',
        developer_instructions: null,
      },
    })
  })
})

describe('listDirectoryComposioConnectors', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends search queries as query params expected by the server', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input))
      return new Response(JSON.stringify({
        data: [],
        nextCursor: null,
        total: 0,
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      })
    }))

    await listDirectoryComposioConnectors('instagram', '50', 25)

    expect(requests).toEqual(['/codex-api/composio/connectors?query=instagram&cursor=50&limit=25'])
  })
})

describe('getAvailableModelIds', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses provider models without waiting for model/list when provider models are required', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input))
      if (String(input) === '/codex-api/provider-models') {
        return new Response(JSON.stringify({
          data: ['big-pickle', 'deepseek-v4-flash-free'],
          exclusive: true,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      throw new Error(`unexpected request ${String(input)}`)
    }))

    await expect(getAvailableModelIds({
      includeProviderModels: true,
      requireProviderModels: true,
    })).resolves.toEqual(['big-pickle', 'deepseek-v4-flash-free'])
    expect(requests).toEqual(['/codex-api/provider-models'])
  })

  it('requests models for an explicit thread provider', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input))
      if (String(input) === '/codex-api/provider-models?provider=opencode-zen') {
        return new Response(JSON.stringify({
          data: ['big-pickle', 'ring-2.6-1t-free'],
          exclusive: true,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      throw new Error(`unexpected request ${String(input)}`)
    }))

    await expect(getAvailableModelIds({
      includeProviderModels: true,
      requireProviderModels: true,
      providerId: 'opencode-zen',
    })).resolves.toEqual(['big-pickle', 'ring-2.6-1t-free'])
    expect(requests).toEqual(['/codex-api/provider-models?provider=opencode-zen'])
  })

  it('falls back to model/list when provider models are optional and unavailable', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(String(input))
      if (String(input) === '/codex-api/provider-models') {
        return new Response(JSON.stringify({ data: [] }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as { method: string }
        : { method: '' }
      expect(body.method).toBe('model/list')
      return new Response(JSON.stringify({
        result: {
          data: [
            { id: 'gpt-5.5' },
            { model: 'gpt-5.4-mini' },
          ],
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    await expect(getAvailableModelIds({
      includeProviderModels: true,
    })).resolves.toEqual(['gpt-5.5', 'gpt-5.4-mini'])
    expect(requests).toEqual(['/codex-api/provider-models', '/codex-api/rpc'])
  })
})

describe('getThreadDetail', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads modelProvider from nested thread payloads returned by thread/read', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as { method: string; params: Record<string, unknown> }
        : { method: '', params: {} }
      expect(body.method).toBe('thread/read')
      return new Response(JSON.stringify({
        result: {
          thread: {
            id: body.params.threadId,
            modelProvider: 'opencode_zen',
            turns: [],
          },
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    await expect(getThreadDetail('legacy-thread')).resolves.toMatchObject({
      modelProvider: 'opencode_zen',
      ownership: 'idle',
      canInterrupt: false,
      externalRuntimeState: 'unknown',
    })
  })

  it('reports externally running idle app-server threads as non-interruptible', () => {
    const payload = runtimePayload({
      id: 'thread-1',
      turns: [],
      externalRuntime: {
        state: 'running',
        turnId: 'turn-external',
        interruptible: false,
        source: 'external-session-writer',
      },
    })

    expect(readThreadDetailRuntime(payload)).toMatchObject({
      inProgress: true,
      activeTurnId: 'turn-external',
      ownership: 'external',
      canInterrupt: false,
      externalRuntimeState: 'running',
    })
  })

  it('preserves inconclusive external runtime evidence without establishing ownership', () => {
    const payload = runtimePayload({
      id: 'thread-1',
      turns: [],
      externalRuntime: { state: 'unknown' },
    })

    expect(readThreadDetailRuntime(payload)).toEqual({
      inProgress: false,
      activeTurnId: '',
      ownership: 'idle',
      canInterrupt: false,
      externalRuntimeState: 'unknown',
    })
  })

  it('gives local app-server activity precedence over external metadata', () => {
    const payload = runtimePayload({
      id: 'thread-1',
      turns: [{ id: 'turn-local', status: 'inProgress', items: [] }],
      externalRuntime: {
        state: 'running',
        turnId: 'turn-external',
        interruptible: false,
        source: 'external-session-writer',
      },
    })

    expect(readThreadDetailRuntime(payload)).toMatchObject({
      inProgress: true,
      activeTurnId: 'turn-local',
      ownership: 'local',
      canInterrupt: true,
    })
  })

  it('treats nested running thread status as local activity before external metadata', () => {
    const payload = runtimePayload({
      id: 'thread-1',
      status: { type: 'running' },
      turns: [{ id: 'turn-local', status: 'completed', items: [] }],
      externalRuntime: {
        state: 'running',
        turnId: 'turn-external',
        interruptible: false,
        source: 'external-session-writer',
      },
    })

    expect(readThreadDetailRuntime(payload)).toMatchObject({
      inProgress: true,
      ownership: 'local',
      canInterrupt: true,
    })
  })
})

describe('resumeThread', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('coalesces repeated resume failures for the same thread', async () => {
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as { method: string; params: Record<string, unknown> }
        : { method: '', params: {} }
      requests.push(body)
      return new Response(JSON.stringify({ error: 'no rollout found for thread id missing-thread' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    const results = await Promise.allSettled([
      resumeThread('missing-thread'),
      resumeThread('missing-thread'),
    ])

    expect(results.every((result) => result.status === 'rejected')).toBe(true)
    expect(requests).toEqual([
      { method: 'thread/resume', params: { threadId: 'missing-thread' } },
    ])
  })

  it('evicts a stalled resume so later resume attempts are not pinned forever', async () => {
    vi.useFakeTimers()
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as { method: string; params: Record<string, unknown> }
        : { method: '', params: {} }
      requests.push(body)
      return new Promise<Response>(() => undefined)
    }))

    const first = resumeThread('stalled-thread')
    void resumeThread('stalled-thread')
    expect(requests).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(30_000)

    const retried = resumeThread('stalled-thread')
    expect(retried).not.toBe(first)
    expect(requests).toEqual([
      { method: 'thread/resume', params: { threadId: 'stalled-thread' } },
      { method: 'thread/resume', params: { threadId: 'stalled-thread' } },
    ])
  })

  it('returns explicit external ownership from thread/resume metadata', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      result: {
        thread: {
          id: 'external-resume-thread',
          modelProvider: 'openai',
          turns: [],
          externalRuntime: {
            state: 'running',
            turnId: 'turn-external',
            interruptible: false,
            source: 'external-session-writer',
          },
        },
        model: 'gpt-5.4',
        modelProvider: 'openai',
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))

    await expect(resumeThread('external-resume-thread')).resolves.toMatchObject({
      inProgress: true,
      activeTurnId: 'turn-external',
      ownership: 'external',
      canInterrupt: false,
      externalRuntimeState: 'running',
    })
  })
})

describe('getThreadRuntimeState', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('requests the thread runtime endpoint with an encoded thread id', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input))
      return new Response(JSON.stringify({
        state: 'running',
        turnId: 'turn-external',
        interruptible: false,
        source: 'external-session-writer',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    await expect(getThreadRuntimeState('thread 1')).resolves.toEqual({
      state: 'running',
      turnId: 'turn-external',
      interruptible: false,
      source: 'external-session-writer',
    })
    expect(requests).toEqual(['/codex-api/thread-runtime-state?threadId=thread+1'])
  })

  it('passes an abort signal to the runtime endpoint fetch', async () => {
    const controller = new AbortController()
    let receivedSignal: AbortSignal | null | undefined
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      receivedSignal = init?.signal
      return new Response(JSON.stringify({ state: 'unknown' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    await expect(getThreadRuntimeState('thread-1', controller.signal)).resolves.toEqual({ state: 'unknown' })
    expect(receivedSignal).toBe(controller.signal)
  })

  it.each([
    null,
    {},
    { state: 'running' },
    { state: 'running', turnId: '', interruptible: false, source: 'external-session-writer' },
    { state: 'running', turnId: 'turn-1', interruptible: true, source: 'external-session-writer' },
    { state: 'running', turnId: 'turn-1', interruptible: false, source: 'external-session-writer', extra: true },
    { state: 'idle', turnId: 'unexpected' },
    { state: 'other' },
  ])('normalizes malformed polling payload %j to unknown', async (payload) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))

    await expect(getThreadRuntimeState('thread-1')).resolves.toEqual({ state: 'unknown' })
  })

  it('normalizes a non-OK runtime response to unknown', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })))

    await expect(getThreadRuntimeState('thread-1')).resolves.toEqual({ state: 'unknown' })
  })

  it('normalizes invalid runtime JSON to unknown', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{not-json', { status: 200 })))

    await expect(getThreadRuntimeState('thread-1')).resolves.toEqual({ state: 'unknown' })
  })

  it('normalizes a rejected runtime request to unknown', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network unavailable')
    }))

    await expect(getThreadRuntimeState('thread-1')).resolves.toEqual({ state: 'unknown' })
  })
})

describe('getThreadRuntimeStates', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('posts one ordered runtime batch and parses exact states', async () => {
    let requestUrl = ''
    let requestInit: RequestInit | undefined
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input)
      requestInit = init
      return new Response(JSON.stringify({
        states: {
          'thread-a': {
            state: 'running',
            turnId: 'turn-a',
            interruptible: false,
            source: 'external-session-writer',
          },
          'thread-b': { state: 'idle' },
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    await expect(getThreadRuntimeStates(['thread-a', 'thread-b'])).resolves.toEqual({
      'thread-a': {
        state: 'running',
        turnId: 'turn-a',
        interruptible: false,
        source: 'external-session-writer',
      },
      'thread-b': { state: 'idle' },
    })
    expect(requestUrl).toBe('/codex-api/thread-runtime-states')
    expect(requestInit).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    expect(JSON.parse(String(requestInit?.body))).toEqual({ threadIds: ['thread-a', 'thread-b'] })
  })

  it('normalizes missing and malformed requested states to unknown', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      states: {
        'thread-b': { state: 'idle', extra: true },
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))

    await expect(getThreadRuntimeStates(['thread-a', 'thread-b'])).resolves.toEqual({
      'thread-a': { state: 'unknown' },
      'thread-b': { state: 'unknown' },
    })
  })

  it('ignores unrequested response states', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      states: {
        'thread-a': { state: 'idle' },
        'thread-extra': {
          state: 'running',
          turnId: 'turn-extra',
          interruptible: false,
          source: 'external-session-writer',
        },
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))

    await expect(getThreadRuntimeStates(['thread-a'])).resolves.toEqual({
      'thread-a': { state: 'idle' },
    })
  })

  it('normalizes a non-OK batch response to unknown states', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })))

    await expect(getThreadRuntimeStates(['thread-a', 'thread-b'])).resolves.toEqual({
      'thread-a': { state: 'unknown' },
      'thread-b': { state: 'unknown' },
    })
  })

  it('normalizes invalid batch JSON to unknown states', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{not-json', { status: 200 })))

    await expect(getThreadRuntimeStates(['thread-a', 'thread-b'])).resolves.toEqual({
      'thread-a': { state: 'unknown' },
      'thread-b': { state: 'unknown' },
    })
  })

  it('normalizes a rejected batch request to unknown states', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network unavailable')
    }))

    await expect(getThreadRuntimeStates(['thread-a', 'thread-b'])).resolves.toEqual({
      'thread-a': { state: 'unknown' },
      'thread-b': { state: 'unknown' },
    })
  })

  it('passes an abort signal to the batch runtime endpoint fetch', async () => {
    const controller = new AbortController()
    let receivedSignal: AbortSignal | null | undefined
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      receivedSignal = init?.signal
      return new Response(JSON.stringify({ states: { 'thread-a': { state: 'unknown' } } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    await expect(getThreadRuntimeStates(['thread-a'], controller.signal)).resolves.toEqual({
      'thread-a': { state: 'unknown' },
    })
    expect(receivedSignal).toBe(controller.signal)
  })
})
