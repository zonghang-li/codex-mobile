import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ThreadReadResponse } from './appServerDtos'
import {
  appendThreadQueuedMessage,
  getAvailableModelIds,
  getCurrentModelConfig,
  getExternalThreadLiveSnapshot,
  getBackgroundThreadListLimit,
  getThreadDetail,
  getThreadGroupsPage,
  getOlderThreadMessages,
  getThreadGoal,
  getThreadQueueAppendReceipt,
  getThreadQueueSnapshot,
  getThreadRuntimeState,
  getThreadRuntimeStates,
  getThreadTextPage,
  getThreadQueueState,
  interruptThreadTurn,
  removeThreadQueuedMessage,
  reorderThreadQueuedMessages,
  setThreadQueueState,
  listDirectoryComposioConnectors,
  readThreadDetailRuntime,
  resumeThread,
  setThreadGoal,
  startThread,
  startThreadTurn,
  cleanupManagedUploads,
  cleanupUploadedFile,
  clearThreadGoal,
  uploadFile,
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

  it('does not add an external-steer bypass marker to turn starts', async () => {
    const { requests } = mockRpcFetch()

    await startThreadTurn('thread-1', 'mobile message', [], 'gpt-5.4', 'medium', undefined, [], 'default')

    expect(requests).toHaveLength(1)
    expect(requests[0].method).toBe('turn/start')
    expect(requests[0].params.__codexMobileExternalSteer).toBeUndefined()
  })

  it('allows max and ultra reasoning efforts in turn payloads and config reads', async () => {
    const { requests } = mockRpcFetch()

    await startThreadTurn('thread-1', 'solve hard task', [], 'gpt-5.6-sol', 'max', undefined, [], 'default')
    await startThreadTurn('thread-1', 'solve hardest task', [], 'gpt-5.6-sol', 'ultra', undefined, [], 'default')

    expect(requests[0].params.effort).toBe('max')
    expect(requests[0].params.collaborationMode).toMatchObject({
      settings: { reasoning_effort: 'max' },
    })
    expect(requests[1].params.effort).toBe('ultra')
    expect(requests[1].params.collaborationMode).toMatchObject({
      settings: { reasoning_effort: 'ultra' },
    })

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      result: {
        config: {
          model: 'gpt-5.6-sol',
          model_provider: '',
          model_reasoning_effort: 'ultra',
          service_tier: 'fast',
        },
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))

    await expect(getCurrentModelConfig()).resolves.toMatchObject({
      model: 'gpt-5.6-sol',
      reasoningEffort: 'ultra',
      speedMode: 'fast',
    })
  })

  it('pins mobile-started turns to the unrestricted no-approval runtime policy', async () => {
    const { requests } = mockRpcFetch()

    await startThreadTurn('thread-1', 'run without more prompts', [], 'gpt-5.6-sol', 'max', undefined, [], 'default')

    expect(requests[0].method).toBe('turn/start')
    expect(requests[0].params).toMatchObject({
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    })
  })

  it('keeps a managed image available after accepted turn handoff for lifecycle-owned cleanup', async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : null
      requests.push({ url, method: init?.method ?? 'GET', body })
      if (url === '/codex-api/rpc') {
        return new Response(JSON.stringify({ result: { turn: { id: 'turn-managed' } } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    const imageUrl = '/codex-local-image?path=%2Ftmp%2Fcodex-web-uploads%2Fupload%2Fphoto.png&uploadHandle=upload-handle'
    await expect(startThreadTurn('thread-1', 'inspect this', [imageUrl])).resolves.toBe('turn-managed')

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      url: '/codex-api/rpc',
      method: 'POST',
      body: {
        method: 'turn/start',
        params: {
          input: [
            { type: 'text', text: '@photo.png\n\ninspect this' },
            { type: 'localImage', path: '/tmp/codex-web-uploads/upload/photo.png' },
          ],
        },
      },
    })
  })

  it('does not consume a managed image when a turn handoff fails before fallback policy runs', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      requests.push(url)
      if (url === '/codex-api/rpc') {
        return new Response(JSON.stringify({ error: 'handoff failed' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    const imageUrl = '/codex-local-image?path=%2Ftmp%2Fcodex-web-uploads%2Fupload%2Fphoto.png&uploadHandle=upload-handle'
    await expect(startThreadTurn('thread-1', 'inspect this', [imageUrl])).rejects.toThrow()
    expect(requests).toEqual(['/codex-api/rpc'])
  })
})

describe('managed uploads', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns only the server-issued managed identity and temporary send path', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      uploadHandle: 'managed-upload',
      path: '/tmp/codex-web-uploads/managed-upload/photo.png',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))

    await expect(uploadFile(new File(['image'], 'photo.png', { type: 'image/png' }))).resolves.toEqual({
      uploadHandle: 'managed-upload',
      path: '/tmp/codex-web-uploads/managed-upload/photo.png',
    })
  })

  it('cleans by opaque upload handle without accepting a client path', async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, init })
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    await expect(cleanupUploadedFile('managed-upload')).resolves.toBe(true)
    expect(requests).toHaveLength(1)
    expect(String(requests[0].input)).toBe('/codex-api/upload-file')
    expect(requests[0].init).toMatchObject({
      method: 'DELETE',
      body: JSON.stringify({ uploadHandle: 'managed-upload' }),
    })
  })

  it('retries a failed cleanup response before reporting success', async () => {
    const requests: RequestInfo[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      requests.push(input as RequestInfo)
      const status = requests.length < 3 ? 503 : 200
      return new Response(JSON.stringify({ ok: status === 200 }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    await expect(cleanupUploadedFile('managed-upload')).resolves.toBe(true)
    expect(requests).toHaveLength(3)
  })

  it('reports cleanup failure after the bounded retry budget without exposing the handle', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    })))
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(cleanupUploadedFile('sensitive-handle')).resolves.toBe(false)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(warning).toHaveBeenCalledWith('Managed upload cleanup failed after retries')
    expect(warning.mock.calls.flat().join(' ')).not.toContain('sensitive-handle')
    warning.mockRestore()
  })

  it('deduplicates managed image and file capabilities during lifecycle cleanup', async () => {
    const requests: Array<{ body: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ body: String(init?.body ?? '') })
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))
    const imageUrl = '/codex-local-image?path=%2Ftmp%2Fcodex-web-uploads%2Fupload%2Fphoto.png&uploadHandle=shared-handle'

    await expect(cleanupManagedUploads([imageUrl], [{
      label: 'photo.png',
      path: '/tmp/codex-web-uploads/upload/photo.png',
      fsPath: '/tmp/codex-web-uploads/upload/photo.png',
      uploadHandle: 'shared-handle',
    }])).resolves.toBe(true)
    expect(requests).toEqual([{ body: JSON.stringify({ uploadHandle: 'shared-handle' }) }])
  })

  it('drops legacy managed capabilities when loading persisted queue state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: {
        'thread-1': [{
          id: 'legacy-queue',
          text: 'queued text survives',
          imageUrls: [
            '/codex-local-image?path=%2Ftmp%2Fcodex-web-uploads%2Ff-old%2Fphoto.png&uploadHandle=old-handle',
            '/codex-local-image?path=%2Ftmp%2Fcodex-web-uploads%2Ff-older%2Fcamera.png',
          ],
          skills: [],
          fileAttachments: [{
            label: 'notes.txt',
            path: '/tmp/codex-web-uploads/f-old/notes.txt',
            fsPath: '/tmp/codex-web-uploads/f-old/notes.txt',
          }],
          collaborationMode: 'default',
        }],
      },
      revision: 1,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))

    await expect(getThreadQueueState()).resolves.toEqual({
      'thread-1': [{
        id: 'legacy-queue',
        text: 'queued text survives',
        imageUrls: [],
        skills: [],
        fileAttachments: [],
        collaborationMode: 'default',
        model: '',
        effort: '',
      }],
    })
  })

  it('sends managed queue capabilities with a replacement base revision', async () => {
    let body = ''
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = String(init?.body ?? '')
      return new Response(JSON.stringify({ ok: true, revision: 8 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))
    const managedImageUrl = '/codex-local-image?path=%2Ftmp%2Fcodex-web-uploads%2Fupload%2Fphoto.png&uploadHandle=queue-handle'

    await setThreadQueueState({
      'thread-1': [{
        id: 'managed-queue',
        text: 'inspect later',
        imageUrls: [managedImageUrl],
        skills: [],
        fileAttachments: [],
        collaborationMode: 'default',
        model: 'gpt-5.5',
        effort: 'high',
      }],
    }, { baseRevision: 7 })

    expect(JSON.parse(body)).toMatchObject({
      baseRevision: 7,
      queueState: {
        'thread-1': [expect.objectContaining({ imageUrls: [managedImageUrl] })],
      },
    })
  })

  it('uses exact PATCH operations for queue removal and reorder', async () => {
    const requests: RequestInit[] = []
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init ?? {})
      return new Response(JSON.stringify({ ok: true, revision: requests.length }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    await removeThreadQueuedMessage('thread-1', 'queued-1', { baseRevision: 7, transferManagedUploads: true })
    await reorderThreadQueuedMessages('thread-1', ['queued-2', 'queued-1'], { baseRevision: 8 })

    expect(requests.map((request) => ({
      method: request.method,
      body: JSON.parse(String(request.body)),
    }))).toEqual([
      {
        method: 'PATCH',
        body: {
          threadId: 'thread-1',
          operation: 'remove',
          messageId: 'queued-1',
          baseRevision: 7,
          transferManagedUploads: true,
        },
      },
      {
        method: 'PATCH',
        body: {
          threadId: 'thread-1',
          operation: 'reorder',
          orderedMessageIds: ['queued-2', 'queued-1'],
          baseRevision: 8,
        },
      },
    ])
  })

  it('fails closed instead of replacing queue state when a legacy GET has no revision', async () => {
    const requests: RequestInit[] = []
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init ?? {})
      if (init?.method === 'PATCH') return new Response('', { status: 405 })
      if (!init?.method) {
        return new Response(JSON.stringify({ data: {
          'thread-1': [
            { id: 'queued-1', text: 'one', imageUrls: [], skills: [], fileAttachments: [], collaborationMode: 'default', model: '', effort: '' },
            { id: 'queued-2', text: 'two', imageUrls: [], skills: [], fileAttachments: [], collaborationMode: 'default', model: '', effort: '' },
          ],
        } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }))

    await expect(removeThreadQueuedMessage('thread-1', 'queued-1', { baseRevision: 1 }))
      .rejects.toThrow('Invalid thread queue revision')
    await expect(reorderThreadQueuedMessages('thread-1', ['queued-2', 'queued-1'], { baseRevision: 1 }))
      .rejects.toThrow('Invalid thread queue revision')
    expect(requests.map((request) => request.method ?? 'GET')).toEqual([
      'PATCH', 'GET', 'PATCH', 'GET',
    ])
  })

  it('appends one queued message atomically instead of replacing queue state', async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, init })
      return new Response(JSON.stringify({ ok: true, revision: 7 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    await expect(appendThreadQueuedMessage('thread-1', {
      id: 'queued-atomic',
      text: 'wait for CLI',
      imageUrls: [],
      skills: [],
      fileAttachments: [],
      collaborationMode: 'default',
      model: 'gpt-5.6-sol',
      effort: 'high',
    }, 1)).resolves.toBe(7)

    expect(String(requests[0]?.input)).toBe('/codex-api/thread-queue-state')
    expect(requests[0]?.init?.method).toBe('POST')
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      threadId: 'thread-1',
      message: expect.objectContaining({ id: 'queued-atomic', text: 'wait for CLI' }),
      queueInsertIndex: 1,
    })
  })

  it('does not replace queue state when atomic append and revision support are unavailable', async () => {
    const requests: RequestInit[] = []
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init ?? {})
      if (init?.method === 'POST') return new Response('', { status: 405 })
      if (!init?.method) {
        return new Response(JSON.stringify({ data: { 'thread-1': [] } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    await expect(appendThreadQueuedMessage('thread-1', {
      id: 'queued-legacy', text: 'survive mixed deployment', imageUrls: [], skills: [], fileAttachments: [],
      collaborationMode: 'default', model: '', effort: '',
    })).rejects.toThrow('Invalid thread queue revision')

    expect(requests.map((request) => request.method ?? 'GET')).toEqual(['POST', 'GET'])
  })

  it('forwards cancellation through the legacy queue append fallback', async () => {
    const requests: RequestInit[] = []
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init ?? {})
      if (init?.method === 'POST') return new Response('', { status: 405 })
      if (!init?.method) {
        return new Response(JSON.stringify({ data: { 'thread-1': [] }, revision: 4 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ ok: true, revision: 5 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))
    const controller = new AbortController()

    await appendThreadQueuedMessage('thread-1', {
      id: 'queued-legacy-signal', text: 'cancel mixed deployment', imageUrls: [], skills: [], fileAttachments: [],
      collaborationMode: 'default', model: '', effort: '',
    }, undefined, controller.signal)

    expect(requests.map((request) => request.signal)).toEqual([
      controller.signal,
      controller.signal,
      controller.signal,
    ])
  })

  it('forwards cancellation signals to queue append and receipt requests', async () => {
    const requests: RequestInit[] = []
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init ?? {})
      return new Response(JSON.stringify({ ok: true, revision: 5, data: { accepted: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))
    const controller = new AbortController()
    await appendThreadQueuedMessage('thread-1', {
      id: 'queued-signal', text: 'signal', imageUrls: [], skills: [], fileAttachments: [],
      collaborationMode: 'default', model: 'gpt-test', effort: '',
    }, undefined, controller.signal)
    await getThreadQueueAppendReceipt('thread-1', 'queued-signal', controller.signal)

    expect(requests.map((request) => request.signal)).toEqual([controller.signal, controller.signal])
  })

  it('marks a server-side append failure as ambiguous when a proxy may have lost the response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'bad gateway' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })))

    const append = appendThreadQueuedMessage('thread-1', {
      id: 'queued-ambiguous-http',
      text: 'may already be accepted',
      imageUrls: [],
      skills: [],
      fileAttachments: [],
      collaborationMode: 'default',
      model: 'gpt-test',
      effort: '',
    })
    await expect(append).rejects.toMatchObject({ name: 'ThreadQueueAppendAmbiguousError' })
  })

  it('marks a queue append claim timeout as retryable without retrying archived conflicts', async () => {
    const message = {
      id: 'queued-claim-timeout', text: 'keep retrying', imageUrls: [], skills: [], fileAttachments: [],
      collaborationMode: 'default' as const, model: '', effort: '' as const,
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: 'Cannot start a turn because another start is already in progress.',
    }), { status: 409, headers: { 'Content-Type': 'application/json' } })))
    await expect(appendThreadQueuedMessage('thread-1', message))
      .rejects.toMatchObject({ name: 'ThreadQueueAppendAmbiguousError' })

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: 'Cannot queue work for an archived task.',
    }), { status: 409, headers: { 'Content-Type': 'application/json' } })))
    await expect(appendThreadQueuedMessage('thread-1', message))
      .rejects.not.toMatchObject({ name: 'ThreadQueueAppendAmbiguousError' })
  })

  it('queries a durable queue append receipt by thread and message id', async () => {
    const requests: Array<RequestInfo | URL> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      requests.push(input)
      return new Response(JSON.stringify({ data: { accepted: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    await expect(getThreadQueueAppendReceipt('thread / 1', 'queued?1')).resolves.toBe(true)
    expect(String(requests[0])).toBe(
      '/codex-api/thread-queue-receipt?threadId=thread+%2F+1&messageId=queued%3F1',
    )
  })

  it('returns the server queue revision with a queue snapshot', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: {
        'thread-1': [{
          id: 'queued-revision',
          queueAfterId: 'queued-before',
          queueBeforeId: 'queued-after',
          text: 'revision aware',
          imageUrls: [],
          skills: [],
          fileAttachments: [],
          collaborationMode: 'default',
          model: 'gpt-test',
          effort: '',
        }],
      },
      revision: 17,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))

    await expect(getThreadQueueSnapshot()).resolves.toMatchObject({
      revision: 17,
      state: {
        'thread-1': [expect.objectContaining({
          id: 'queued-revision',
          queueAfterId: 'queued-before',
          queueBeforeId: 'queued-after',
        })],
      },
    })
  })
})

describe('startThread runtime policy payloads', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('pins mobile-created threads to the unrestricted no-approval runtime policy', async () => {
    let requestBody: { method: string; params: Record<string, unknown> } | null = null
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = typeof init?.body === 'string'
        ? JSON.parse(init.body) as { method: string; params: Record<string, unknown> }
        : null
      return new Response(JSON.stringify({
        result: {
          thread: { id: 'thread-new' },
          model: 'gpt-5.6-sol',
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))

    await expect(startThread('/tmp/project', 'gpt-5.6-sol')).resolves.toMatchObject({
      threadId: 'thread-new',
    })
    expect(requestBody).toMatchObject({
      method: 'thread/start',
      params: {
        cwd: '/tmp/project',
        model: 'gpt-5.6-sol',
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
      },
    })
  })
})

describe('thread goal RPCs', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('gets, sets, and clears the authoritative Codex thread goal', async () => {
    const requests: Array<{ method: string, params: Record<string, unknown> }> = []
    const goal = {
      objective: 'Finish desktop parity',
      status: 'active',
      updatedAt: 1_753_500_000,
      timeUsedSeconds: 45,
      tokensUsed: 1_200,
      tokenBudget: 10_000,
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as { method: string, params: Record<string, unknown> }
        : { method: '', params: {} }
      const path = String(input)
      if (path.endsWith('/thread-goal-set')) requests.push({ method: 'thread/goal/set', params: body as never })
      else if (path.endsWith('/thread-goal-clear')) requests.push({ method: 'thread/goal/clear', params: body as never })
      else requests.push(body)
      const payload = path.endsWith('/thread-goal-clear')
        ? { ok: true }
        : path.endsWith('/thread-goal-set')
          ? { goal }
          : { result: { goal } }
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    await expect(getThreadGoal('thread-1')).resolves.toEqual(goal)
    await expect(setThreadGoal({
      threadId: 'thread-1',
      objective: 'Finish desktop parity',
      status: 'active',
    })).resolves.toEqual(goal)
    await expect(clearThreadGoal('thread-1')).resolves.toBeUndefined()

    expect(requests).toEqual([
      { method: 'thread/goal/get', params: { threadId: 'thread-1' } },
      {
        method: 'thread/goal/set',
        params: {
          threadId: 'thread-1',
          objective: 'Finish desktop parity',
          status: 'active',
        },
      },
      { method: 'thread/goal/clear', params: { threadId: 'thread-1' } },
    ])
  })

  it('rejects malformed set responses and accepts every desktop goal status', async () => {
    const statuses = [
      'active',
      'paused',
      'blocked',
      'usageLimited',
      'budgetLimited',
      'complete',
    ]
    let responseGoal: Record<string, unknown> | null = null
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      goal: responseGoal,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))

    for (const status of statuses) {
      responseGoal = {
        objective: 'Goal',
        status,
        updatedAt: 100,
        timeUsedSeconds: 2,
        tokensUsed: 3,
        tokenBudget: null,
      }
      await expect(setThreadGoal({ threadId: 'thread-1', status: status as never }))
        .resolves.toMatchObject({ status })
    }

    responseGoal = { objective: 'Goal', status: 'unknown' }
    await expect(setThreadGoal({ threadId: 'thread-1', status: 'active' }))
      .rejects.toThrow('Invalid thread goal response')
  })
})

describe('thread list pagination', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('loads only the 5 most recent threads by default', async () => {
    const requests: Array<{ method: string, params: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as { method: string, params: Record<string, unknown> }
        : { method: '', params: {} }
      requests.push(body)
      return new Response(JSON.stringify({
        result: {
          data: [],
          nextCursor: null,
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    await getThreadGroupsPage()

    expect(requests[0]).toMatchObject({
      method: 'thread/list',
      params: {
        archived: false,
        limit: 5,
        sortKey: 'updated_at',
        modelProviders: [],
        cursor: null,
      },
    })
  })

  it('uses a small background thread-list page to avoid expensive runtime probes', () => {
    expect(getBackgroundThreadListLimit()).toBe(10)
  })

  it('can request a fresh first page without reusing mobile thread-list cache', async () => {
    const requests: Array<{ method: string, params: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as { method: string, params: Record<string, unknown> }
        : { method: '', params: {} }
      requests.push(body)
      return new Response(JSON.stringify({
        result: {
          data: [],
          nextCursor: null,
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    await getThreadGroupsPage(null, 5, { forceFresh: true })

    expect(requests[0]).toMatchObject({
      method: 'thread/list',
      params: {
        archived: false,
        limit: 5,
        sortKey: 'updated_at',
        modelProviders: [],
        cursor: null,
        __codexMobileForceFresh: true,
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

  it('hydrates metadata and the newest native turn page without a full thread read', async () => {
    const requests: Array<{ url: string; method?: string; params?: Record<string, unknown>; signal?: AbortSignal | null }> = []
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/codex-api/rpc') {
        const body = JSON.parse(String(init?.body)) as { method: string; params: Record<string, unknown> }
        requests.push({ url, method: body.method, params: body.params, signal: init?.signal })
        return new Response(JSON.stringify({
          result: {
            thread: {
              id: 'thread-paged',
              model: 'gpt-5.5',
              reasoning_effort: 'xhigh',
              turns: [],
            },
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      requests.push({ url, signal: init?.signal })
      return new Response(JSON.stringify({
        result: {
          thread: {
            id: 'thread-paged',
            turns: [
              {
                id: 'turn-4',
                status: 'completed',
                items: [{ id: 'agent-4', type: 'agentMessage', text: 'four' }],
              },
              {
                id: 'turn-5',
                status: 'completed',
                items: [{ id: 'agent-5', type: 'agentMessage', text: 'five' }],
              },
            ],
          },
        },
        nextCursor: 'opaque-older',
        hasMoreOlder: true,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))

    await expect(getThreadDetail('thread-paged', controller.signal)).resolves.toMatchObject({
      isPagedProjection: true,
      model: 'gpt-5.5',
      reasoningEffort: 'xhigh',
      olderCursor: 'opaque-older',
      hasMoreOlder: true,
      messages: [
        expect.objectContaining({ id: 'agent-4', text: 'four' }),
        expect.objectContaining({ id: 'agent-5', text: 'five' }),
      ],
    })
    expect(requests).toContainEqual({
      url: '/codex-api/rpc',
      method: 'thread/read',
      params: { threadId: 'thread-paged', includeTurns: false },
      signal: controller.signal,
    })
    expect(requests).toContainEqual({
      url: '/codex-api/thread-turn-page?threadId=thread-paged&limit=3',
      signal: controller.signal,
    })
    expect(requests).not.toContainEqual(expect.objectContaining({
      method: 'thread/read',
      params: expect.objectContaining({ includeTurns: true }),
    }))
  })

  it('falls back to a terminal external live-state snapshot when the native turn page is empty', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      requests.push(url)
      if (url === '/codex-api/rpc') {
        const body = JSON.parse(String(init?.body)) as { method: string; params: Record<string, unknown> }
        expect(body).toMatchObject({
          method: 'thread/read',
          params: { threadId: 'external-terminal', includeTurns: false },
        })
        return new Response(JSON.stringify({
          result: {
            thread: {
              id: 'external-terminal',
              turns: [],
              externalRuntime: { state: 'unknown' },
            },
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url === '/codex-api/thread-turn-page?threadId=external-terminal&limit=3') {
        return new Response(JSON.stringify({
          result: { thread: { id: 'external-terminal', turns: [] } },
          nextCursor: null,
          hasMoreOlder: false,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      expect(url).toBe('/codex-api/thread-live-state?threadId=external-terminal')
      return new Response(JSON.stringify({
        threadId: 'external-terminal',
        conversationState: {
          turns: [{
            id: 'turn-terminal',
            status: 'interrupted',
            items: [{
              id: 'agent-terminal',
              type: 'agentMessage',
              text: 'terminal external transcript text',
              phase: 'commentary',
            }],
          }],
        },
        externalRuntime: { state: 'unknown' },
        hasMoreOlder: false,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))

    await expect(getThreadDetail('external-terminal')).resolves.toMatchObject({
      isLiveProjection: true,
      ownership: 'idle',
      inProgress: false,
      messages: [expect.objectContaining({
        id: 'agent-terminal',
        text: 'terminal external transcript text',
      })],
    })
    expect(requests).toEqual([
      '/codex-api/rpc',
      '/codex-api/thread-turn-page?threadId=external-terminal&limit=3',
      '/codex-api/thread-live-state?threadId=external-terminal',
    ])
  })

  it('marks a running external active turn omitted from the newest turn page as partial', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      requests.push(url)
      if (url === '/codex-api/rpc') {
        const body = JSON.parse(String(init?.body)) as { method: string; params: Record<string, unknown> }
        expect(body).toMatchObject({
          method: 'thread/read',
          params: { threadId: 'external-running', includeTurns: false },
        })
        return new Response(JSON.stringify({
          result: {
            thread: {
              id: 'external-running',
              turns: [],
              externalRuntime: {
                state: 'running',
                turnId: 'turn-live',
                interruptible: false,
                source: 'external-session-writer',
              },
            },
            model: 'gpt-5.6-sol',
            modelProvider: 'openai',
            reasoningEffort: 'max',
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url === '/codex-api/thread-turn-page?threadId=external-running&activeTurnId=turn-live&limit=3') {
        return new Response(JSON.stringify({
          result: {
            thread: {
              id: 'external-running',
              turns: [{
                id: 'turn-history',
                status: 'completed',
                items: [{
                  id: 'agent-history',
                  type: 'agentMessage',
                  text: 'historical page text stays visible',
                }],
              }],
            },
          },
          nextCursor: 'older-cursor',
          hasMoreOlder: true,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      throw new Error(`Unexpected request ${url}`)
    }))

    await expect(getThreadDetail('external-running')).resolves.toMatchObject({
      isPagedProjection: true,
      isPartialTurnProjection: true,
      ownership: 'external',
      activeTurnId: 'turn-live',
      inProgress: true,
      model: 'gpt-5.6-sol',
      reasoningEffort: 'max',
      olderCursor: 'older-cursor',
      hasMoreOlder: true,
      messages: [
        expect.objectContaining({
          id: 'agent-history',
          text: 'historical page text stays visible',
        }),
      ],
    })
    expect(requests).toEqual([
      '/codex-api/rpc',
      '/codex-api/thread-turn-page?threadId=external-running&activeTurnId=turn-live&limit=3',
    ])
  })

  it('marks a compressed locally running active turn page as partial', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/codex-api/rpc') {
        const body = JSON.parse(String(init?.body)) as { method: string }
        expect(body.method).toBe('thread/read')
        return new Response(JSON.stringify({
          result: {
            thread: {
              id: 'thread-local',
              externalRuntime: { state: 'idle' },
              turns: [],
            },
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      expect(url).toBe('/codex-api/thread-turn-page?threadId=thread-local&limit=3')
      return new Response(JSON.stringify({
        result: {
          thread: {
            id: 'thread-local',
            turns: [{
              id: 'turn-local',
              status: 'inProgress',
              rawItemCompression: {
                originalItemCount: 500,
                retainedItemCount: 240,
                omittedItemCount: 260,
              },
              items: [{
                id: 'reasoning-latest',
                type: 'reasoning',
                summary: ['Latest retained reasoning'],
              }],
            }],
          },
        },
        nextCursor: null,
        hasMoreOlder: false,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))

    await expect(getThreadDetail('thread-local')).resolves.toMatchObject({
      isPagedProjection: true,
      isPartialTurnProjection: true,
      ownership: 'local',
      activeTurnId: 'turn-local',
      inProgress: true,
    })
  })

  it('forwards an opaque cursor when loading older native turns', async () => {
    let requestUrl = ''
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      requestUrl = String(input)
      return new Response(JSON.stringify({
        result: {
          thread: {
            id: 'thread-paged',
            turns: [{
              id: 'turn-3',
              status: 'completed',
              items: [{ id: 'agent-3', type: 'agentMessage', text: 'three' }],
            }],
          },
        },
        nextCursor: 'opaque-next',
        hasMoreOlder: true,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))

    await expect(getOlderThreadMessages('thread-paged', 'opaque+/= cursor', 10)).resolves.toMatchObject({
      nextCursor: 'opaque-next',
      turnIds: ['turn-3'],
      hasMoreOlder: true,
    })
    expect(requestUrl).toBe(
      '/codex-api/thread-turn-page?threadId=thread-paged&cursor=opaque%2B%2F%3D+cursor&limit=10',
    )
  })

  it('falls back to one legacy full read only when native pagination is unsupported', async () => {
    const readParams: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/codex-api/thread-turn-page')) {
        return new Response(JSON.stringify({ fallback: 'thread/read' }), {
          status: 501,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      const body = JSON.parse(String(init?.body)) as { method: string; params: Record<string, unknown> }
      readParams.push(body.params)
      const includeTurns = body.params.includeTurns === true
      return new Response(JSON.stringify({
        result: {
          thread: {
            id: 'thread-legacy',
            turns: includeTurns
              ? [{
                  id: 'turn-legacy',
                  status: 'completed',
                  items: [{ id: 'agent-legacy', type: 'agentMessage', text: 'legacy' }],
                }]
              : [],
          },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))

    await expect(getThreadDetail('thread-legacy')).resolves.toMatchObject({
      olderCursor: null,
      hasMoreOlder: false,
      messages: [expect.objectContaining({ id: 'agent-legacy', text: 'legacy' })],
    })
    expect(readParams).toEqual([
      { threadId: 'thread-legacy', includeTurns: false },
      { threadId: 'thread-legacy', includeTurns: true },
    ])
  })

  it('forwards the caller abort signal to thread/read', async () => {
    const controller = new AbortController()
    let requestSignal: AbortSignal | null | undefined
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal
      return new Response(JSON.stringify({
        result: {
          thread: {
            id: 'external-thread',
            turns: [],
            externalRuntime: {
              state: 'running',
              turnId: 'turn-external',
              interruptible: false,
              source: 'external-session-writer',
            },
          },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))

    await expect(getThreadDetail('external-thread', controller.signal)).resolves.toMatchObject({
      ownership: 'external',
      activeTurnId: 'turn-external',
    })
    expect(requestSignal).toBe(controller.signal)
  })

  it('hides managed user-upload previews while preserving assistant-generated images', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      result: {
        thread: {
          id: 'thread-images',
          turns: [{
            id: 'turn-images',
            status: 'completed',
            items: [
              {
                type: 'userMessage',
                id: 'user-image',
                content: [
                  { type: 'text', text: '@photo.png\n\ninspect this' },
                  { type: 'localImage', path: '/tmp/codex-web-uploads/upload-123/photo.png' },
                ],
              },
              {
                type: 'imageGeneration',
                id: 'assistant-image',
                result: 'aGVsbG8=',
              },
            ],
          }],
        },
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))

    const detail = await getThreadDetail('thread-images')
    expect(detail.messages.find((message) => message.id === 'user-image')).toMatchObject({
      text: '@photo.png\n\ninspect this',
    })
    expect(detail.messages.find((message) => message.id === 'user-image')?.images).toBeUndefined()
    expect(detail.messages.find((message) => message.id === 'assistant-image')?.images)
      .toEqual(['data:image/png;base64,aGVsbG8='])
  })

  it('normalizes an aborted thread/read through the existing API error model', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })))

    const detailPromise = getThreadDetail('external-thread', controller.signal)
    controller.abort()

    await expect(detailPromise).rejects.toMatchObject({
      name: 'CodexApiError',
      code: 'network_error',
      method: 'thread/read',
    })
  })

  it('loads external live snapshots from the lightweight live-state endpoint', async () => {
    let requestUrl = ''
    let requestSignal: AbortSignal | null | undefined
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input)
      requestSignal = init?.signal
      return new Response(JSON.stringify({
        threadId: 'external-thread',
        conversationState: {
          turns: [{
            id: 'turn-external',
            status: 'completed',
            rawItemCompression: {
              originalItemCount: 500,
              retainedItemCount: 240,
              omittedItemCount: 260,
            },
            items: [{
              id: 'agent-live',
              type: 'agentMessage',
              text: 'live output',
            }],
          }],
        },
        threadTurnStartIndex: 8,
        hasMoreOlder: true,
        olderCursor: 'opaque-live-older',
        isInProgress: true,
        externalRuntime: {
          state: 'running',
          turnId: 'turn-external',
          interruptible: false,
          source: 'external-session-writer',
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))

    await expect(getExternalThreadLiveSnapshot('external-thread', controller.signal)).resolves.toMatchObject({
      isLiveProjection: true,
      isPartialTurnProjection: true,
      ownership: 'external',
      activeTurnId: 'turn-external',
      inProgress: true,
      hasMoreOlder: true,
      olderCursor: 'opaque-live-older',
      turnIndexByTurnId: { 'turn-external': 8 },
      messages: [expect.objectContaining({
        id: 'agent-live',
        text: 'live output',
        turnId: 'turn-external',
        turnIndex: 8,
      })],
    })
    expect(requestUrl).toBe('/codex-api/thread-live-state?threadId=external-thread')
    expect(requestSignal).toBe(controller.signal)
  })

  it('preserves external live progress when the active turn status is stale interrupted', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      threadId: 'external-thread',
      conversationState: {
        turns: [{
          id: 'turn-external',
          status: 'interrupted',
          rawItemCompression: {
            originalItemCount: 700,
            retainedItemCount: 240,
            omittedItemCount: 460,
          },
          items: [
            {
              id: 'reason-live',
              type: 'reasoning',
              summary: ['Planning live recovery'],
              content: [],
            },
            {
              id: 'agent-live-1',
              type: 'agentMessage',
              text: 'first live progress',
            },
            {
              id: 'tool-live',
              type: 'mcpToolCall',
              server: 'codegraph',
              tool: 'codegraph_explore',
            },
            {
              id: 'agent-live-2',
              type: 'agentMessage',
              text: 'second live progress',
            },
          ],
        }],
      },
      isInProgress: true,
      externalRuntime: {
        state: 'running',
        turnId: 'turn-external',
        interruptible: false,
        source: 'external-session-writer',
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

    await expect(getExternalThreadLiveSnapshot('external-thread')).resolves.toMatchObject({
      activeTurnId: 'turn-external',
      inProgress: true,
      messages: [
        expect.objectContaining({ id: 'reason-live', text: 'Planning live recovery' }),
        expect.objectContaining({ id: 'agent-live-1', text: 'first live progress' }),
        expect.objectContaining({ id: 'tool-live', text: 'Called codegraph.codegraph_explore' }),
        expect.objectContaining({ id: 'agent-live-2', text: 'second live progress' }),
      ],
    })
  })

  it('derives partial projection status from only the resolved active turn', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      threadId: 'external-thread',
      conversationState: {
        turns: [
          {
            id: 'turn-compressed-history',
            status: 'completed',
            rawItemCompression: {
              originalItemCount: 500,
              retainedItemCount: 240,
              omittedItemCount: 260,
            },
            items: [],
          },
          {
            id: 'turn-external',
            status: 'inProgress',
            items: [{ id: 'agent-live', type: 'agentMessage', text: 'live output' }],
          },
        ],
      },
      isInProgress: true,
      externalRuntime: {
        state: 'running',
        turnId: 'turn-external',
        interruptible: false,
        source: 'external-session-writer',
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

    await expect(getExternalThreadLiveSnapshot('external-thread')).resolves.toMatchObject({
      activeTurnId: 'turn-external',
      isPartialTurnProjection: false,
    })
  })

  it('marks a compressed terminal live-state projection as partial when no active turn is known', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      threadId: 'external-thread',
      conversationState: {
        turns: [
          {
            id: 'turn-terminal',
            status: 'interrupted',
            rawItemCompression: {
              originalItemCount: 500,
              retainedItemCount: 240,
              omittedItemCount: 260,
            },
            items: [
              { id: 'agent-head', type: 'agentMessage', text: 'first retained output' },
              { id: 'agent-tail', type: 'agentMessage', text: 'latest retained output' },
            ],
          },
        ],
      },
      isInProgress: false,
      externalRuntime: { state: 'unknown' },
      hasMoreOlder: false,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

    await expect(getExternalThreadLiveSnapshot('external-thread')).resolves.toMatchObject({
      activeTurnId: '',
      inProgress: false,
      ownership: 'idle',
      isPartialTurnProjection: true,
    })
  })

  it('marks a lightweight running live-state projection as partial', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      threadId: 'external-thread',
      activeTurnId: 'turn-external',
      conversationState: {
        turns: [{
          id: 'turn-external',
          status: 'inProgress',
          rawItemCompression: {
            originalItemCount: 500,
            retainedItemCount: 0,
            omittedItemCount: 500,
          },
          items: [],
        }],
      },
      isInProgress: true,
      externalRuntime: {
        state: 'running',
        turnId: 'turn-external',
        interruptible: false,
        source: 'external-session-writer',
      },
      hasMoreOlder: true,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

    await expect(getExternalThreadLiveSnapshot('external-thread')).resolves.toMatchObject({
      activeTurnId: 'turn-external',
      inProgress: true,
      ownership: 'external',
      isPartialTurnProjection: true,
      messages: [],
      hasMoreOlder: true,
    })
  })

  it('sends the known live projection key and normalizes not-modified responses', async () => {
    let requestUrl = ''
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      requestUrl = String(input)
      return new Response(JSON.stringify({
        threadId: 'external-thread',
        notModified: true,
        projectionKey: 'projection-2',
        isInProgress: true,
        externalRuntime: {
          state: 'running',
          turnId: 'turn-external',
          interruptible: false,
          source: 'external-session-writer',
        },
        liveAuthority: 'missing',
        liveSnapshot: null,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))

    await expect(getExternalThreadLiveSnapshot(
      'external-thread',
      undefined,
      'projection-1',
    )).resolves.toMatchObject({
      isLiveProjection: true,
      notModified: true,
      projectionKey: 'projection-2',
      ownership: 'external',
      activeTurnId: 'turn-external',
      inProgress: true,
      messages: [],
      liveAuthority: 'missing',
      liveSnapshot: null,
    })
    expect(requestUrl).toBe('/codex-api/thread-live-state?threadId=external-thread&knownProjectionKey=projection-1')
  })

  it('normalizes authoritative writer footer snapshots from thread-live-state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      threadId: 'external-thread',
      conversationState: { turns: [] },
      threadTurnStartIndex: 8,
      hasMoreOlder: true,
      isInProgress: true,
      externalRuntime: {
        state: 'running',
        turnId: 'turn-external',
        interruptible: false,
        source: 'external-session-writer',
      },
      liveAuthority: 'writer-snapshot',
      liveSnapshot: {
        schemaVersion: 1,
        threadId: 'external-thread',
        activeTurnId: 'turn-external',
        revision: 3,
        generatedAt: '2026-07-27T00:00:00.000Z',
        expiresAt: '2026-07-27T00:01:00.000Z',
        source: 'desktop-writer',
        state: 'running',
        footer: {
          stepCurrent: 2,
          stepTotal: 6,
          completedPercent: 33.3333,
          fileCount: 29,
          additions: 5485,
          deletions: 417,
          label: 'Step 2 / 6 · 29 files changed +5485 -417',
        },
        timeline: [],
        pendingRequest: null,
        sidebar: { indicator: 'running' },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

    await expect(getExternalThreadLiveSnapshot('external-thread')).resolves.toMatchObject({
      liveAuthority: 'writer-snapshot',
      liveSnapshot: {
        revision: 3,
        activeTurnId: 'turn-external',
        footer: {
          stepCurrent: 2,
          stepTotal: 6,
          fileCount: 29,
          additions: 5485,
          deletions: 417,
        },
      },
    })
  })

  it('normalizes missing live authority without trusting malformed snapshot payloads', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      threadId: 'external-thread',
      conversationState: { turns: [] },
      isInProgress: true,
      externalRuntime: {
        state: 'running',
        turnId: 'turn-external',
        interruptible: false,
        source: 'external-session-writer',
      },
      liveAuthority: 'writer-snapshot',
      liveSnapshot: { revision: 'bad', footer: { stepTotal: '6' } },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

    await expect(getExternalThreadLiveSnapshot('external-thread')).resolves.toMatchObject({
      liveAuthority: 'missing',
      liveSnapshot: null,
      inProgress: true,
      ownership: 'external',
    })
  })

  it('returns terminal turn summaries for persisted completion folding', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      result: {
        thread: {
          id: 'thread-1',
          updatedAt: 1_753_500_000,
          turns: [
            {
              id: 'turn-completed',
              status: 'completed',
              completedAt: '2026-01-01T21:15:00.000Z',
              items: [],
            },
            {
              id: 'turn-stopped',
              status: 'interrupted',
              items: [],
            },
            {
              id: 'turn-running',
              status: 'inProgress',
              items: [],
            },
          ],
        },
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))

    await expect(getThreadDetail('thread-1')).resolves.toMatchObject({
      completionSummaries: [
        { turnId: 'turn-completed', status: 'completed', durationMs: null, completedAtMs: Date.parse('2026-01-01T21:15:00.000Z') },
        { turnId: 'turn-stopped', status: 'interrupted', durationMs: null, completedAtMs: 1_753_500_000_000 },
      ],
    })
  })

  it('reads model, reasoning effort, and modelProvider from nested thread payloads returned by thread/read', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('/codex-api/thread-turn-page')) {
        return new Response(JSON.stringify({
          result: {
            thread: {
              id: 'legacy-thread',
              turns: [],
            },
          },
          nextCursor: null,
          hasMoreOlder: false,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as { method: string; params: Record<string, unknown> }
        : { method: '', params: {} }
      expect(body.method).toBe('thread/read')
      return new Response(JSON.stringify({
        result: {
          thread: {
            id: body.params.threadId,
            model: 'gpt-5.5',
            reasoning_effort: 'xhigh',
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
      model: 'gpt-5.5',
      reasoningEffort: 'xhigh',
      modelProvider: 'opencode_zen',
      ownership: 'idle',
      canInterrupt: false,
      externalRuntimeState: 'unknown',
    })
  })

  it('reports externally running idle app-server threads as non-interruptible by active turn id', () => {
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

  it('reports confirmed interruptible external writers as externally interruptible', () => {
    const payload = runtimePayload({
      id: 'thread-1',
      turns: [],
      externalRuntime: {
        state: 'running',
        turnId: 'turn-external',
        interruptible: true,
        source: 'external-session-writer',
        cwd: '/tmp/runtime-worktree',
      },
    })

    expect(readThreadDetailRuntime(payload)).toMatchObject({
      inProgress: true,
      activeTurnId: 'turn-external',
      ownership: 'external',
      canInterrupt: true,
      externalRuntimeState: 'running',
      runtimeCwd: '/tmp/runtime-worktree',
    })
  })

  it('keeps runtime cwd from idle external runtime metadata', () => {
    const payload = runtimePayload({
      id: 'thread-1',
      turns: [],
      externalRuntime: {
        state: 'idle',
        cwd: '/tmp/runtime-worktree',
      },
    })

    expect(readThreadDetailRuntime(payload)).toMatchObject({
      inProgress: false,
      activeTurnId: '',
      ownership: 'idle',
      canInterrupt: false,
      externalRuntimeState: 'idle',
      runtimeCwd: '/tmp/runtime-worktree',
    })
  })

  it('preserves local ownership for a running mobile-started turn after refresh', () => {
    const payload = runtimePayload({
      id: 'thread-local',
      turns: [{ id: 'turn-stale', status: 'completed', items: [] }],
      externalRuntime: {
        state: 'running',
        turnId: 'turn-mobile',
        interruptible: true,
        source: 'local-app-server',
      },
    })

    expect(readThreadDetailRuntime(payload)).toMatchObject({
      inProgress: true,
      activeTurnId: 'turn-mobile',
      ownership: 'local',
      canInterrupt: true,
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

  it('gives a confirmed external writer precedence over active app-server status', () => {
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
      activeTurnId: 'turn-external',
      ownership: 'external',
      canInterrupt: false,
      externalRuntimeState: 'running',
    })
  })

  it('treats active status with unknown writer ownership as non-interruptible', () => {
    const payload = runtimePayload({
      id: 'thread-unknown',
      turns: [{ id: 'turn-observed', status: 'inProgress', items: [] }],
      externalRuntime: { state: 'unknown' },
    })

    expect(readThreadDetailRuntime(payload)).toEqual({
      inProgress: true,
      activeTurnId: 'turn-observed',
      ownership: 'external',
      canInterrupt: false,
      externalRuntimeState: 'unknown',
    })
  })

  it('does not treat a recovered in-progress turn with an idle external probe as locally interruptible', () => {
    const payload = runtimePayload({
      id: 'thread-recovered-external',
      turns: [{
        id: 'turn-recovered',
        status: 'inProgress',
        codexMobileRecoveredTurn: true,
        rawItemCompression: {
          originalItemCount: 240,
          retainedItemCount: 0,
          omittedItemCount: 240,
        },
        items: [],
      }],
      externalRuntime: { state: 'idle' },
    })

    expect(readThreadDetailRuntime(payload)).toEqual({
      inProgress: true,
      activeTurnId: 'turn-recovered',
      ownership: 'external',
      canInterrupt: false,
      externalRuntimeState: 'idle',
    })
  })

  it('treats nested running thread status as local only after an idle writer probe', () => {
    const payload = runtimePayload({
      id: 'thread-1',
      status: { type: 'running' },
      turns: [{ id: 'turn-local', status: 'completed', items: [] }],
      externalRuntime: { state: 'idle' },
    })

    expect(readThreadDetailRuntime(payload)).toMatchObject({
      inProgress: true,
      ownership: 'local',
      canInterrupt: true,
      externalRuntimeState: 'idle',
    })
  })
})

describe('thread text page', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('forwards the active turn cursor and normalizes messages in session order', async () => {
    let requestUrl = ''
    let requestSignal: AbortSignal | null | undefined
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input)
      requestSignal = init?.signal
      return new Response(JSON.stringify({
        threadId: 'thread 1',
        turnId: 'turn/1',
        items: [{
          id: 'reason-1',
          type: 'reasoning',
          summary: ['First thought'],
          sessionOrder: 120,
        }, {
          id: 'agent-1',
          type: 'agentMessage',
          text: 'Visible update',
          sessionOrder: 140,
        }],
        nextOlderCursor: 'next-cursor',
        hasMoreOlder: true,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))

    await expect(getThreadTextPage(
      'thread 1',
      'turn/1',
      'opaque+/= cursor',
      300,
      controller.signal,
    )).resolves.toMatchObject({
      threadId: 'thread 1',
      turnId: 'turn/1',
      nextOlderCursor: 'next-cursor',
      hasMoreOlder: true,
      messages: [
        expect.objectContaining({
          id: 'reason-1',
          messageType: 'reasoning',
          text: 'First thought',
          turnId: 'turn/1',
          sessionOrder: 120,
        }),
        expect.objectContaining({
          id: 'agent-1',
          messageType: 'agentMessage',
          text: 'Visible update',
          turnId: 'turn/1',
          sessionOrder: 140,
        }),
      ],
    })
    expect(requestUrl).toBe(
      '/codex-api/thread-text-page?threadId=thread+1&turnId=turn%2F1&cursor=opaque%2B%2F%3D+cursor&limit=300',
    )
    expect(requestSignal).toBe(controller.signal)
  })

  it('forwards active tail delta parameters and normalizes not-modified empty pages', async () => {
    let requestUrl = ''
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      requestUrl = String(input)
      return new Response(JSON.stringify({
        threadId: 'thread 1',
        turnId: 'turn/1',
        items: [],
        nextOlderCursor: null,
        hasMoreOlder: false,
        notModified: true,
        tailSignature: 'tail-1',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))

    await expect(getThreadTextPage(
      'thread 1',
      'turn/1',
      undefined,
      undefined,
      controller.signal,
      { knownTailSignature: 'tail-1', afterSessionOrder: 140 },
    )).resolves.toMatchObject({
      threadId: 'thread 1',
      turnId: 'turn/1',
      messages: [],
      nextOlderCursor: null,
      hasMoreOlder: false,
      notModified: true,
      tailSignature: 'tail-1',
    })
    expect(requestUrl).toBe(
      '/codex-api/thread-text-page?threadId=thread+1&turnId=turn%2F1&knownTailSignature=tail-1&afterSessionOrder=140',
    )
  })

  it('normalizes active tail user anchors with input_text content into user messages', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      threadId: 'thread-1',
      turnId: 'turn-active',
      items: [{
        id: 'user-active',
        type: 'userMessage',
        content: [{ type: 'input_text', text: '设置 goal: 需要最终审核 0/0/0 通过' }],
        sessionOrder: 100,
      }, {
        id: 'agent-latest',
        type: 'agentMessage',
        text: '继续执行验证。',
        sessionOrder: 200,
      }],
      nextOlderCursor: null,
      hasMoreOlder: false,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

    await expect(getThreadTextPage('thread-1', 'turn-active', undefined, 2)).resolves.toMatchObject({
      messages: [
        expect.objectContaining({
          id: 'user-active',
          role: 'user',
          text: '设置 goal: 需要最终审核 0/0/0 通过',
          messageType: 'userMessage',
          turnId: 'turn-active',
          sessionOrder: 100,
        }),
        expect.objectContaining({
          id: 'agent-latest',
          role: 'assistant',
          text: '继续执行验证。',
          messageType: 'agentMessage',
          phase: 'commentary',
          turnId: 'turn-active',
          sessionOrder: 200,
        }),
      ],
    })
  })

  it('preserves completed context compaction text from active tail pages', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      threadId: 'thread-1',
      turnId: 'turn-active',
      items: [{
        id: 'rollout:contextCompaction:120',
        type: 'contextCompaction',
        text: 'Context automatically compacted',
        sessionOrder: 120,
      }],
      nextOlderCursor: null,
      hasMoreOlder: false,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

    await expect(getThreadTextPage('thread-1', 'turn-active', undefined, 1)).resolves.toMatchObject({
      messages: [
        expect.objectContaining({
          id: 'rollout:contextCompaction:120',
          role: 'system',
          text: 'Context automatically compacted',
          messageType: 'contextCompaction',
          turnId: 'turn-active',
          sessionOrder: 120,
        }),
      ],
    })
  })

  it('normalizes an aborted request through the thread text page API method', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })))

    const pagePromise = getThreadTextPage('thread-1', 'turn-1', undefined, undefined, controller.signal)
    controller.abort()

    await expect(pagePromise).rejects.toMatchObject({
      name: 'CodexApiError',
      code: 'network_error',
      method: 'thread-text-page',
    })
  })

  it('normalizes an abort raised while parsing the response body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: vi.fn(async () => {
        throw new DOMException('aborted while parsing', 'AbortError')
      }),
    }) as unknown as Response))

    await expect(getThreadTextPage('thread-1', 'turn-1')).rejects.toMatchObject({
      name: 'CodexApiError',
      code: 'network_error',
      method: 'thread-text-page',
    })
  })

  it('preserves a conflict response message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: 'Rollout snapshot changed during pagination',
    }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    })))

    await expect(getThreadTextPage('thread-1', 'turn-1')).rejects.toMatchObject({
      name: 'CodexApiError',
      code: 'http_error',
      method: 'thread-text-page',
      status: 409,
      message: 'Rollout snapshot changed during pagination',
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

  it('normalizes local app-server runtime ownership from the single-thread endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      state: 'running',
      turnId: 'turn-local',
      interruptible: true,
      source: 'local-app-server',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))

    await expect(getThreadRuntimeState('thread-local')).resolves.toEqual({
      state: 'running',
      turnId: 'turn-local',
      interruptible: true,
      source: 'local-app-server',
    })
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

  it('normalizes interruptible external polling payloads as running', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      state: 'running',
      turnId: 'turn-1',
      interruptible: true,
      source: 'external-session-writer',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))

    await expect(getThreadRuntimeState('thread-1')).resolves.toEqual({
      state: 'running',
      turnId: 'turn-1',
      interruptible: true,
      source: 'external-session-writer',
    })
  })

  it.each([
    null,
    {},
    { state: 'running' },
    { state: 'running', turnId: '', interruptible: false, source: 'external-session-writer' },
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
            interruptible: true,
            source: 'external-session-writer',
          },
          'thread-b': { state: 'idle' },
          'thread-local': {
            state: 'running',
            turnId: 'turn-local',
            interruptible: true,
            source: 'local-app-server',
          },
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    await expect(getThreadRuntimeStates(['thread-a', 'thread-b', 'thread-local'])).resolves.toEqual({
      'thread-a': {
        state: 'running',
        turnId: 'turn-a',
        interruptible: true,
        source: 'external-session-writer',
      },
      'thread-b': { state: 'idle' },
      'thread-local': {
        state: 'running',
        turnId: 'turn-local',
        interruptible: true,
        source: 'local-app-server',
      },
    })
    expect(requestUrl).toBe('/codex-api/thread-runtime-states')
    expect(requestInit).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      threadIds: ['thread-a', 'thread-b', 'thread-local'],
    })
  })

  it.each([
    [
      'non-interruptible local source',
      { state: 'running', turnId: 'turn-a', interruptible: false, source: 'local-app-server' },
    ],
    [
      'empty local turn ID',
      { state: 'running', turnId: '', interruptible: true, source: 'local-app-server' },
    ],
    [
      'extra local property',
      {
        state: 'running',
        turnId: 'turn-a',
        interruptible: true,
        source: 'local-app-server',
        extra: true,
      },
    ],
  ])('normalizes a malformed %s record to unknown', async (_label, runtime) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      states: { 'thread-a': runtime },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))

    await expect(getThreadRuntimeStates(['thread-a'])).resolves.toEqual({
      'thread-a': { state: 'unknown' },
    })
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

describe('interruptThreadTurn', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('routes external runtime interrupts to the external interrupt endpoint', async () => {
    let requestUrl = ''
    let requestInit: RequestInit | undefined
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input)
      requestInit = init
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    await expect(interruptThreadTurn('thread-a', 'turn-a', 'external')).resolves.toBeUndefined()

    expect(requestUrl).toBe('/codex-api/thread-runtime-interrupt')
    expect(requestInit).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      threadId: 'thread-a',
      turnId: 'turn-a',
    })
  })
})
