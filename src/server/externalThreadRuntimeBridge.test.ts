import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { appendFile, mkdir, mkdtemp, rm, truncate, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExternalThreadRuntime } from '../types/threadRuntime'
import {
  augmentThreadResultWithExternalRuntime,
  createCodexBridgeMiddleware,
  pruneExpiredCachedHttpResponses,
  trimCachedHttpResponses,
  withThreadStartClaim,
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

describe('HTTP response cache bounds', () => {
  it('prunes expired entries and trims the oldest cached responses', () => {
    const cache = new Map([
      ['expired', { response: { status: 200, payload: { value: 'expired' } }, expiresAt: 999 }],
      ['oldest', { response: { status: 200, payload: { value: 'oldest' } }, expiresAt: 2_000 }],
      ['newest', { response: { status: 200, payload: { value: 'newest' } }, expiresAt: 2_000 }],
    ])

    pruneExpiredCachedHttpResponses(cache, 1_000)
    expect([...cache.keys()]).toEqual(['oldest', 'newest'])

    trimCachedHttpResponses(cache, 1)
    expect([...cache.keys()]).toEqual(['newest'])
  })
})

describe('external thread runtime bridge augmentation', () => {
  it('canonicalizes a stale interrupted CLI turn as the single running projection', async () => {
    const probe = fakeProbe({
      state: 'running',
      turnId: 'turn-cli',
      interruptible: false,
      source: 'external-session-writer',
    })
    const payload = {
      thread: {
        id: 'thread-cli',
        path: '/home/user/.codex/sessions/rollout-thread-cli.jsonl',
        status: { type: 'notLoaded' },
        turns: [{
          id: 'turn-cli',
          status: 'interrupted',
          items: [{ id: 'agent-existing', type: 'agentMessage', text: 'existing output' }],
        }],
      },
    }

    await expect(augmentThreadResultWithExternalRuntime(
      'thread/read',
      payload,
      probe,
      4242,
    )).resolves.toEqual({
      thread: {
        ...payload.thread,
        turns: [{
          id: 'turn-cli',
          status: 'inProgress',
          items: [{ id: 'agent-existing', type: 'agentMessage', text: 'existing output' }],
        }],
        externalRuntime: {
          state: 'running',
          turnId: 'turn-cli',
          interruptible: false,
          source: 'external-session-writer',
        },
      },
    })
    expect(payload.thread.turns[0]?.status).toBe('interrupted')
  })

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

  it('lets a confirmed external writer override an active app-server status', async () => {
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
    )).resolves.toEqual({
      thread: {
        ...payload.thread,
        externalRuntime: {
          state: 'running',
          turnId: 'turn-external',
          interruptible: false,
          source: 'external-session-writer',
        },
      },
    })
    expect(probe.registerThread).toHaveBeenCalledOnce()
    expect(probe.inspect).toHaveBeenCalledWith('thread-1', 4242)
  })

  it('attaches unknown writer evidence to an active thread so clients fail closed', async () => {
    const probe = fakeProbe({ state: 'unknown' })
    const payload = {
      thread: {
        id: 'thread-unknown',
        path: '/home/user/.codex/sessions/rollout-thread-unknown.jsonl',
        status: { type: 'active' },
        turns: [{ id: 'turn-observed', status: 'inProgress' }],
      },
    }

    await expect(augmentThreadResultWithExternalRuntime(
      'thread/read',
      payload,
      probe,
      4242,
    )).resolves.toEqual({
      thread: {
        ...payload.thread,
        externalRuntime: { state: 'unknown' },
      },
    })
    expect(probe.inspect).toHaveBeenCalledWith('thread-unknown', 4242)
  })

  it('preserves local app-server ownership on ordinary thread reads after refresh', async () => {
    const probe = fakeProbe({
      state: 'running',
      turnId: 'turn-external-stale',
      interruptible: false,
      source: 'external-session-writer',
    })
    const localRuntimeLedger = {
      getRunning: vi.fn((threadId: string) => ({ threadId, turnId: 'turn-local-mobile' })),
    }
    const payload = {
      thread: {
        id: 'thread-local-refresh',
        path: '/home/user/.codex/sessions/rollout-thread-local-refresh.jsonl',
        status: { type: 'active' },
        turns: [{ id: 'turn-stale', status: 'completed' }],
      },
    }

    await expect(augmentThreadResultWithExternalRuntime(
      'thread/read',
      payload,
      probe,
      4242,
      localRuntimeLedger,
    )).resolves.toEqual({
      thread: {
        ...payload.thread,
        externalRuntime: {
          state: 'running',
          turnId: 'turn-local-mobile',
          interruptible: true,
          source: 'local-app-server',
        },
      },
    })
    expect(probe.inspect).toHaveBeenCalledWith('thread-local-refresh', 4242)
    expect(localRuntimeLedger.getRunning).toHaveBeenCalledWith('thread-local-refresh')
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

const disposers: Array<() => void | Promise<void>> = []
const originalCodexHome = process.env.CODEX_HOME

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodexHome
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
        interrupt: (
          threadId: string,
          turnId: string,
          excludedPid: number | null,
        ) => Promise<{ interrupted: boolean; reason?: string }>
      }
      appServer: {
        getPid: () => number | null
        invalidateThreadListRpcCache: () => void
      }
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

describe('GET /codex-api/thread-turn-page native pagination', () => {
  it('uses thread/turns/list without materializing full thread history', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (method, params) => {
      if (method === 'thread/read' && (params as { includeTurns?: boolean }).includeTurns === true) {
        throw new Error('full history read forbidden')
      }
      if (method === 'thread/turns/list') {
        return {
          data: [
            {
              id: 'turn-5',
              status: 'inProgress',
              items: [
                { id: 'reasoning-5', type: 'reasoning', summary: ['live'], content: [] },
                { id: 'message-5', type: 'agentMessage', text: 'latest' },
              ],
            },
            {
              id: 'turn-4',
              status: 'completed',
              items: [
                { id: 'reasoning-4', type: 'reasoning', summary: ['old'], content: [] },
                { id: 'message-4', type: 'agentMessage', text: 'older' },
              ],
            },
          ],
          nextCursor: 'older-page',
          backwardsCursor: 'newer-page',
        }
      }
      throw new Error(`unexpected RPC ${method}`)
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-turn-page?threadId=thread-1&limit=5`,
    )
    const payload = await response.json() as {
      result?: { thread?: { turns?: Array<{ id?: string; items?: Array<{ id?: string }> }> } }
      nextCursor?: string | null
      hasMoreOlder?: boolean
    }

    expect(response.status).toBe(200)
    expect(rpc).toHaveBeenCalledWith('thread/turns/list', {
      threadId: 'thread-1',
      cursor: null,
      limit: 5,
      sortDirection: 'desc',
      itemsView: 'full',
    })
    expect(rpc).not.toHaveBeenCalledWith('thread/read', expect.objectContaining({
      includeTurns: true,
    }))
    expect(payload.nextCursor).toBe('older-page')
    expect(payload.hasMoreOlder).toBe(true)
    expect(payload.result?.thread?.turns?.map((turn) => turn.id)).toEqual(['turn-4', 'turn-5'])
    expect(payload.result?.thread?.turns?.[0]?.items?.map((item) => item.id)).toEqual(['message-4'])
    expect(payload.result?.thread?.turns?.[1]?.items?.map((item) => item.id)).toEqual([
      'reasoning-5',
      'message-5',
    ])
  })

  it('limits native historical turn summaries instead of returning every assistant segment', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/turns/list') {
        return {
          data: [
            {
              id: 'turn-history',
              status: 'completed',
              items: [
                {
                  id: 'user-history',
                  type: 'userMessage',
                  content: [{ type: 'text', text: 'old prompt' }],
                },
                ...Array.from({ length: 20 }, (_, index) => ({
                  id: `agent-history-${index}`,
                  type: 'agentMessage',
                  text: `old assistant segment ${index}`,
                })),
              ],
            },
          ],
          nextCursor: null,
          backwardsCursor: null,
        }
      }
      throw new Error(`unexpected RPC ${method}`)
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-turn-page?threadId=thread-1&limit=3`,
    )
    const payload = await response.json() as {
      result?: { thread?: { turns?: Array<{ id?: string; items?: Array<{ id?: string }> }> } }
    }

    expect(response.status).toBe(200)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(payload.result?.thread?.turns?.[0]?.items?.map((item) => item.id)).toEqual([
      'user-history',
      'agent-history-12',
      'agent-history-13',
      'agent-history-14',
      'agent-history-15',
      'agent-history-16',
      'agent-history-17',
      'agent-history-18',
      'agent-history-19',
    ])
  })

  it('compacts a running active turn out of cold turn pages when activeTurnId is known', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    const activeItems = Array.from({ length: 130 }, (_, index) => ({
      id: `active-${index}`,
      type: 'agentMessage',
      text: `stale active output ${index}`,
    }))
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (method, params) => {
      if (method === 'thread/turns/list') {
        expect(params).toMatchObject({
          threadId: 'thread-1',
          cursor: null,
          limit: 3,
          sortDirection: 'desc',
          itemsView: 'full',
        })
        return {
          data: [
            {
              id: 'turn-live',
              status: 'interrupted',
              items: activeItems,
            },
            {
              id: 'turn-old',
              status: 'completed',
              items: [
                {
                  id: 'delegation-old',
                  type: 'userMessage',
                  content: [{
                    type: 'text',
                    text: '<codex_delegation>\n<input>visible native handoff</input>\n</codex_delegation>',
                  }],
                },
                {
                  id: 'user-old',
                  type: 'userMessage',
                  content: [{ type: 'text', text: 'old prompt' }],
                },
                { id: 'reasoning-old', type: 'reasoning', summary: ['old'], content: [] },
                {
                  id: 'command-old',
                  type: 'commandExecution',
                  command: 'printf stale',
                  aggregatedOutput: 'stale command output',
                },
                {
                  id: 'progress-old',
                  type: 'agentMessage',
                  phase: 'commentary',
                  text: 'old commentary progress',
                },
                {
                  id: 'message-old',
                  type: 'agentMessage',
                  phase: 'final',
                  text: 'old visible text',
                },
              ],
            },
          ],
          nextCursor: 'older-page',
          backwardsCursor: null,
        }
      }
      throw new Error(`unexpected RPC ${method}`)
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-turn-page?threadId=thread-1&activeTurnId=turn-live&limit=3`,
    )
    const payload = await response.json() as {
      result?: {
        thread?: {
          turns?: Array<{
            id?: string
            status?: string
            items?: Array<{ id?: string; type?: string; text?: string }>
            rawItemCompression?: {
              originalItemCount?: number
              retainedItemCount?: number
              omittedItemCount?: number
            }
          }>
        }
      }
    }
    const turns = payload.result?.thread?.turns ?? []
    const activeTurn = turns.find((turn) => turn.id === 'turn-live')
    const oldTurn = turns.find((turn) => turn.id === 'turn-old')

    expect(response.status).toBe(200)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(oldTurn?.items?.map((item) => item.id)).toEqual(['delegation-old', 'user-old', 'progress-old', 'message-old'])
    expect(JSON.stringify(payload)).toContain('codex_delegation')
    expect(JSON.stringify(payload)).toContain('visible native handoff')
    expect(activeTurn).toMatchObject({
      status: 'inProgress',
      items: [],
      rawItemCompression: {
        originalItemCount: 130,
        retainedItemCount: 0,
        omittedItemCount: 130,
      },
    })
    expect(JSON.stringify(payload)).not.toContain('stale active output')
    expect(JSON.stringify(payload)).not.toContain('stale command output')
  })

  it('recovers newest local rollout turns when the native turn page is empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-empty-native-turn-page-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-recovered.jsonl')
    const lines = [
      { type: 'session_meta', payload: { id: 'thread-recovered' } },
      {
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-old' },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'msg-user-old',
          role: 'user',
          content: [{ type: 'input_text', text: 'old prompt' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'msg-assistant-old',
          role: 'assistant',
          phase: 'commentary',
          content: [{ type: 'output_text', text: 'old visible progress' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'msg-subagent-hidden',
          role: 'user',
          content: [{ type: 'input_text', text: '<subagent_notification>\n{"status":{"completed":"hidden"}}' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'msg-goal-context-hidden',
          role: 'user',
          content: [{
            type: 'input_text',
            text: '<codex_internal_context source="goal">\nDo not render this internal goal context.\n</codex_internal_context>',
          }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'msg-encoded-goal-context-hidden',
          role: 'user',
          content: [{
            type: 'input_text',
            text: '&lt;codex_internal_context source="goal"&gt;\nDo not render this encoded internal goal context.\n&lt;/codex_internal_context&gt;',
          }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'msg-ordinary-similar-prefix',
          role: 'user',
          content: [{
            type: 'input_text',
            text: '<codex_internal_contextual source="user">visible ordinary text</codex_internal_contextual>',
          }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'msg-delegation-visible',
          role: 'user',
          content: [{ type: 'input_text', text: '<codex_delegation>\n<input>visible handoff</input>\n</codex_delegation>' }],
        },
      },
      {
        type: 'event_msg',
        payload: { type: 'turn_aborted', turn_id: 'turn-old' },
      },
      {
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-active' },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'msg-user-active',
          role: 'user',
          content: [{ type: 'input_text', text: 'continue' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'msg-assistant-active',
          role: 'assistant',
          phase: 'commentary',
          content: [{ type: 'output_text', text: 'active text served by text page' }],
        },
      },
    ]
    await writeFile(rolloutPath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (method, params) => {
      if (method === 'thread/turns/list') {
        return {
          data: [],
          nextCursor: null,
          backwardsCursor: null,
        }
      }
      if (method === 'thread/read' && (params as { includeTurns?: boolean }).includeTurns === false) {
        return {
          thread: {
            id: 'thread-recovered',
            path: rolloutPath,
            turns: [],
          },
        }
      }
      if (method === 'thread/read' && (params as { includeTurns?: boolean }).includeTurns === true) {
        throw new Error('full history read forbidden')
      }
      throw new Error(`unexpected RPC ${method}`)
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-turn-page?threadId=thread-recovered&activeTurnId=turn-active&limit=3`,
    )
    const payload = await response.json() as {
      result?: {
        thread?: {
          turns?: Array<{
            id?: string
            status?: string
            items?: Array<{ id?: string; type?: string; text?: string; content?: Array<{ text?: string }> }>
          }>
        }
      }
    }
    const turns = payload.result?.thread?.turns ?? []

    expect(response.status).toBe(200)
    expect(rpc).not.toHaveBeenCalledWith('thread/read', expect.objectContaining({
      includeTurns: true,
    }))
    expect(turns.map((turn) => turn.id)).toEqual(['turn-old', 'turn-active'])
    expect(turns[0]?.items?.map((item) => item.id)).toEqual([
      'msg-user-old',
      'msg-assistant-old',
      'msg-ordinary-similar-prefix',
      'msg-delegation-visible',
    ])
    expect(turns[0]?.items?.map((item) => item.text)).toContain('old visible progress')
    expect(turns[0]?.items?.find((item) => item.id === 'msg-ordinary-similar-prefix')?.content?.[0]?.text)
      .toBe('<codex_internal_contextual source="user">visible ordinary text</codex_internal_contextual>')
    expect(turns[0]?.items?.find((item) => item.id === 'msg-delegation-visible')?.content?.[0]?.text)
      .toBe('<codex_delegation>\n<input>visible handoff</input>\n</codex_delegation>')
    expect(turns[1]).toMatchObject({
      id: 'turn-active',
      status: 'inProgress',
      items: [],
    })
    expect(JSON.stringify(payload)).not.toContain('subagent_notification')
    expect(JSON.stringify(payload)).not.toContain('codex_internal_context source')
    expect(JSON.stringify(payload)).not.toContain('Do not render this internal goal context')
    expect(JSON.stringify(payload)).not.toContain('Do not render this encoded internal goal context')
    expect(JSON.stringify(payload)).toContain('codex_delegation')
    expect(JSON.stringify(payload)).toContain('visible handoff')
    expect(JSON.stringify(payload)).not.toContain('active text served by text page')
  })

  it('keeps older recovered local rollout turns reachable with a fallback cursor', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-empty-native-turn-page-cursor-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-recovered-cursor.jsonl')
    const lines = [
      { type: 'session_meta', payload: { id: 'thread-recovered-cursor' } },
      ...Array.from({ length: 5 }, (_, index) => {
        const turnNumber = index + 1
        return [
          {
            type: 'event_msg',
            payload: { type: 'task_started', turn_id: `turn-${turnNumber}` },
          },
          {
            type: 'response_item',
            payload: {
              type: 'message',
              id: `msg-user-${turnNumber}`,
              role: 'user',
              content: [{ type: 'input_text', text: `prompt ${turnNumber}` }],
            },
          },
          {
            type: 'response_item',
            payload: {
              type: 'message',
              id: `msg-assistant-${turnNumber}`,
              role: 'assistant',
              phase: 'final',
              content: [{ type: 'output_text', text: `answer ${turnNumber}` }],
            },
          },
          {
            type: 'event_msg',
            payload: { type: 'task_complete', turn_id: `turn-${turnNumber}` },
          },
        ]
      }).flat(),
    ]
    await writeFile(rolloutPath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (method, params) => {
      if (method === 'thread/turns/list') {
        return {
          data: [],
          nextCursor: null,
          backwardsCursor: null,
        }
      }
      if (method === 'thread/read' && (params as { includeTurns?: boolean }).includeTurns === false) {
        return {
          thread: {
            id: 'thread-recovered-cursor',
            path: rolloutPath,
            turns: [],
          },
        }
      }
      if (method === 'thread/read' && (params as { includeTurns?: boolean }).includeTurns === true) {
        throw new Error('full history read forbidden')
      }
      throw new Error(`unexpected RPC ${method}`)
    })
    const port = await listenWithMiddleware(middleware)

    const firstResponse = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-turn-page?threadId=thread-recovered-cursor&limit=3`,
    )
    const firstPayload = await firstResponse.json() as {
      result?: { thread?: { turns?: Array<{ id?: string }> } }
      nextCursor?: string | null
      hasMoreOlder?: boolean
    }

    expect(firstResponse.status).toBe(200)
    expect(firstPayload.result?.thread?.turns?.map((turn) => turn.id)).toEqual(['turn-3', 'turn-4', 'turn-5'])
    expect(firstPayload.nextCursor).toEqual(expect.stringMatching(/^local-rollout-turns:/u))
    expect(firstPayload.hasMoreOlder).toBe(true)

    const secondResponse = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-turn-page?threadId=thread-recovered-cursor&cursor=${encodeURIComponent(firstPayload.nextCursor ?? '')}&limit=3`,
    )
    const secondPayload = await secondResponse.json() as {
      result?: { thread?: { turns?: Array<{ id?: string }> } }
      nextCursor?: string | null
      hasMoreOlder?: boolean
    }

    expect(secondResponse.status).toBe(200)
    expect(secondPayload.result?.thread?.turns?.map((turn) => turn.id)).toEqual(['turn-1', 'turn-2'])
    expect(secondPayload.nextCursor).toBeNull()
    expect(secondPayload.hasMoreOlder).toBe(false)
    expect(rpc).not.toHaveBeenCalledWith('thread/turns/list', expect.objectContaining({
      cursor: firstPayload.nextCursor,
    }))
  })

  it('compacts recovered in-progress rollout turns even when activeTurnId is unknown', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-empty-native-turn-page-active-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-recovered-active.jsonl')
    const lines = [
      { type: 'session_meta', payload: { id: 'thread-recovered-active' } },
      {
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-old' },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'msg-user-old',
          role: 'user',
          content: [{ type: 'input_text', text: 'old prompt' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'msg-assistant-old',
          role: 'assistant',
          phase: 'final',
          content: [{ type: 'output_text', text: 'old final' }],
        },
      },
      {
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'turn-old' },
      },
      {
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-active' },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'msg-user-active',
          role: 'user',
          content: [{ type: 'input_text', text: 'continue' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'msg-assistant-active',
          role: 'assistant',
          phase: 'commentary',
          content: [{ type: 'output_text', text: 'active text must stay on text page' }],
        },
      },
    ]
    await writeFile(rolloutPath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (method, params) => {
      if (method === 'thread/turns/list') {
        return {
          data: [],
          nextCursor: null,
          backwardsCursor: null,
        }
      }
      if (method === 'thread/read' && (params as { includeTurns?: boolean }).includeTurns === false) {
        return {
          thread: {
            id: 'thread-recovered-active',
            path: rolloutPath,
            turns: [],
          },
        }
      }
      if (method === 'thread/read' && (params as { includeTurns?: boolean }).includeTurns === true) {
        throw new Error('full history read forbidden')
      }
      throw new Error(`unexpected RPC ${method}`)
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-turn-page?threadId=thread-recovered-active&limit=3`,
    )
    const payload = await response.json() as {
      result?: {
        thread?: {
          turns?: Array<{
            id?: string
            status?: string
            items?: Array<{ id?: string }>
          }>
        }
      }
    }
    const turns = payload.result?.thread?.turns ?? []

    expect(response.status).toBe(200)
    expect(turns.map((turn) => turn.id)).toEqual(['turn-old', 'turn-active'])
    expect(turns[1]).toMatchObject({
      id: 'turn-active',
      status: 'inProgress',
      items: [],
    })
    expect(JSON.stringify(payload)).not.toContain('active text must stay on text page')
  })

  it('returns an explicit legacy fallback only when the native method is unavailable', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockRejectedValue(new Error('Method not found: thread/turns/list'))
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-turn-page?threadId=thread-legacy&limit=5`,
    )
    const payload = await response.json() as { fallback?: string }

    expect(response.status).toBe(501)
    expect(payload.fallback).toBe('thread/read')
  })
})

describe('GET /codex-api/thread-text-page', () => {
  async function createRolloutFixture(): Promise<{
    sessionPath: string
    cleanup: () => void
  }> {
    const directory = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-text-page-'))
    const rows = [
      {
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-active' },
      },
      {
        type: 'response_item',
        payload: {
          type: 'reasoning',
          id: 'reason-1',
          summary: [{ type: 'summary_text', text: 'First thought' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          arguments: '{"cmd":"pnpm test","secret":"raw function arguments must not escape"}',
          call_id: 'call-1',
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call-1',
          output: 'raw function output must not escape',
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          id: 'agent-1',
          content: [{ type: 'output_text', text: 'First update' }],
        },
      },
      {
        type: 'event_msg',
        payload: { type: 'context_compacted' },
      },
      {
        type: 'response_item',
        payload: {
          type: 'reasoning',
          id: 'reason-2',
          summary: [{ type: 'summary_text', text: 'Second thought' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          id: 'agent-2',
          content: [{ type: 'output_text', text: 'Second update' }],
        },
      },
    ]
    const sessionPath = join(directory, 'rollout.jsonl')
    await writeFile(
      sessionPath,
      `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
      'utf8',
    )
    return {
      sessionPath,
      cleanup: () => {
        void rm(directory, { recursive: true, force: true })
      },
    }
  }

  function stubThreadRead(sessionPath: string) {
    const shared = sharedBridgeForTest()
    return vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (method, params) => {
      if (method !== 'thread/read') throw new Error(`unexpected RPC ${method}`)
      return {
        thread: {
          id: (params as { threadId?: string }).threadId,
          path: sessionPath,
        },
      }
    })
  }

  function stubActiveRuntime(turnId = 'turn-active') {
    const shared = sharedBridgeForTest()
    return vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running',
      turnId,
      interruptible: false,
      source: 'external-session-writer',
    })
  }

  it('pages projected active-turn text from the trusted thread rollout', async () => {
    const fixture = await createRolloutFixture()
    disposers.push(fixture.cleanup)
    const middleware = createCodexBridgeMiddleware()
    const rpc = stubThreadRead(fixture.sessionPath)
    stubActiveRuntime()
    const port = await listenWithMiddleware(middleware)

    const firstResponse = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-text-page?threadId=thread-1&turnId=turn-active&limit=2`,
    )
    const firstBody = await firstResponse.json() as {
      items: Array<{ id: string; type: string }>
      nextOlderCursor: string | null
      hasMoreOlder: boolean
    }

    expect(firstResponse.status).toBe(200)
    expect(rpc).toHaveBeenCalledWith('thread/read', {
      threadId: 'thread-1',
      includeTurns: false,
    })
    expect(firstBody.items.map((item) => item.type)).toEqual([
      'reasoning',
      'agentMessage',
    ])
    expect(firstBody.items.map((item) => item.id)).toEqual([
      'reason-2',
      'agent-2',
    ])
    expect(firstBody.hasMoreOlder).toBe(true)

    const secondResponse = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-text-page?threadId=thread-1&turnId=turn-active&limit=2&cursor=${encodeURIComponent(firstBody.nextOlderCursor ?? '')}`,
    )
    const secondBody = await secondResponse.json() as {
      items: Array<{ id: string; type: string; text?: string }>
      nextOlderCursor: string | null
      hasMoreOlder: boolean
    }
    expect(secondResponse.status).toBe(200)
    expect(secondBody.items.map((item) => item.type)).toEqual(['agentMessage', 'contextCompaction'])
    expect(secondBody.items.map((item) => item.id)).toEqual([
      'agent-1',
      expect.stringMatching(/^rollout:contextCompaction:\d+$/u),
    ])
    expect(secondBody.items[1]?.text).toBe('Context automatically compacted')
    expect(secondBody.hasMoreOlder).toBe(true)

    const thirdResponse = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-text-page?threadId=thread-1&turnId=turn-active&limit=2&cursor=${encodeURIComponent(secondBody.nextOlderCursor ?? '')}`,
    )
    const thirdBody = await thirdResponse.json() as {
      items: Array<{ id: string }>
      hasMoreOlder: boolean
    }
    expect(thirdResponse.status).toBe(200)
    expect(thirdBody.items.map((item) => item.id)).toEqual(['reason-1'])
    expect(thirdBody.hasMoreOlder).toBe(false)

    const serialized = JSON.stringify([firstBody, secondBody, thirdBody])
    expect(serialized).not.toContain('raw function arguments')
    expect(serialized).not.toContain('raw function output')
  })

  it('deduplicates concurrent active text-page requests for the same tail signature', async () => {
    const fixture = await createRolloutFixture()
    disposers.push(fixture.cleanup)
    const middleware = createCodexBridgeMiddleware()
    const rpc = stubThreadRead(fixture.sessionPath)
    const shared = sharedBridgeForTest()
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return {
        state: 'running',
        turnId: 'turn-active',
        interruptible: false,
        source: 'external-session-writer',
      }
    })
    const port = await listenWithMiddleware(middleware)
    const url = `http://127.0.0.1:${port}/codex-api/thread-text-page?threadId=thread-1&turnId=turn-active&limit=2&knownTailSignature=stale&afterSessionOrder=0`

    const [first, second] = await Promise.all([
      fetch(url),
      fetch(url),
    ])
    const firstBody = await first.json()
    const secondBody = await second.json()

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(firstBody).toEqual(secondBody)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(inspect).toHaveBeenCalledTimes(1)
  })

  it('uses a cached thread snapshot path without retrying thread/read', async () => {
    const fixture = await createRolloutFixture()
    disposers.push(fixture.cleanup)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
        storeThreadReadSnapshot: (threadId: string, snapshot: unknown) => void
      }
    }
    shared.appServer.storeThreadReadSnapshot('thread-1', {
      thread: {
        id: 'thread-1',
        path: fixture.sessionPath,
        turns: [],
      },
    })
    const rpc = vi.spyOn(shared.appServer, 'rpc').mockRejectedValue(new Error('thread/read should not be called'))
    stubActiveRuntime()
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-text-page?threadId=thread-1&turnId=turn-active&limit=1`,
    )
    const body = await response.json() as { items?: Array<{ id: string }> }

    expect(response.status).toBe(200)
    expect(body.items?.map((item) => item.id)).toEqual(['agent-2'])
    expect(rpc).not.toHaveBeenCalled()
  })

  it('finds the local rollout path for active text without retrying thread/read', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-text-page-local-path-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => {
      void rm(codexHome, { recursive: true, force: true }).catch(() => undefined)
    })
    const threadId = '019faabf-f76e-7fe0-a38f-3f12d03ecaf7'
    const sessionDir = join(codexHome, 'sessions', '2026', '07', '29')
    await mkdir(sessionDir, { recursive: true })
    const sessionPath = join(sessionDir, `rollout-test-${threadId}.jsonl`)
    await writeFile(sessionPath, [
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-active' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          id: 'agent-local',
          content: [{ type: 'output_text', text: 'Local path update' }],
        },
      }),
      '',
    ].join('\n'), 'utf8')

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    const rpc = vi.spyOn(shared.appServer, 'rpc').mockRejectedValue(new Error('thread/read should not be called'))
    stubActiveRuntime()
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-text-page?threadId=${threadId}&turnId=turn-active&limit=1`,
    )
    const body = await response.json() as { items?: Array<{ id: string }> }

    expect(response.status).toBe(200)
    expect(body.items?.map((item) => item.id)).toEqual(['agent-local'])
    expect(rpc).not.toHaveBeenCalled()
  })

  it('keeps serving active text from a quiet local rollout without retrying thread/read', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-text-page-quiet-local-path-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => {
      void rm(codexHome, { recursive: true, force: true }).catch(() => undefined)
    })
    const threadId = '019faabf-f76e-7fe0-a38f-3f12d03ecaf7'
    const sessionDir = join(codexHome, 'sessions', '2026', '07', '29')
    await mkdir(sessionDir, { recursive: true })
    const sessionPath = join(sessionDir, `rollout-test-${threadId}.jsonl`)
    await writeFile(sessionPath, [
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-active' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          id: 'agent-quiet-local',
          content: [{ type: 'output_text', text: 'Quiet local path update' }],
        },
      }),
      '',
    ].join('\n'), 'utf8')
    const quietTime = new Date(Date.now() - (9 * 60 * 1000))
    await utimes(sessionPath, quietTime, quietTime)

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    const rpc = vi.spyOn(shared.appServer, 'rpc').mockRejectedValue(new Error('thread/read should not be called'))
    stubActiveRuntime()
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-text-page?threadId=${threadId}&turnId=turn-active&limit=1`,
    )
    const body = await response.json() as { items?: Array<{ id: string }> }

    expect(response.status).toBe(200)
    expect(body.items?.map((item) => item.id)).toEqual(['agent-quiet-local'])
    expect(rpc).not.toHaveBeenCalled()
  })

  it('returns 400 when threadId or turnId is missing', async () => {
    const middleware = createCodexBridgeMiddleware()
    const port = await listenWithMiddleware(middleware)

    const missingThread = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-text-page?turnId=turn-active`,
    )
    const missingTurn = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-text-page?threadId=thread-1`,
    )

    expect(missingThread.status).toBe(400)
    expect(missingTurn.status).toBe(400)
  })

  it('returns 400 for a cursor from a different thread', async () => {
    const fixture = await createRolloutFixture()
    disposers.push(fixture.cleanup)
    const middleware = createCodexBridgeMiddleware()
    stubThreadRead(fixture.sessionPath)
    stubActiveRuntime()
    const port = await listenWithMiddleware(middleware)
    const firstResponse = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-text-page?threadId=thread-1&turnId=turn-active&limit=1`,
    )
    const firstBody = await firstResponse.json() as { nextOlderCursor: string }

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-text-page?threadId=thread-2&turnId=turn-active&cursor=${encodeURIComponent(firstBody.nextOlderCursor)}`,
    )

    expect(response.status).toBe(400)
  })

  it('returns 404 when the trusted rollout file is missing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-mobile-missing-rollout-'))
    disposers.push(() => {
      void rm(directory, { recursive: true, force: true })
    })
    const middleware = createCodexBridgeMiddleware()
    stubThreadRead(join(directory, 'missing.jsonl'))
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-text-page?threadId=thread-1&turnId=turn-active`,
    )

    expect(response.status).toBe(404)
  })

  it('returns 409 when a cursor rollout snapshot has been truncated', async () => {
    const fixture = await createRolloutFixture()
    disposers.push(fixture.cleanup)
    const middleware = createCodexBridgeMiddleware()
    stubThreadRead(fixture.sessionPath)
    stubActiveRuntime()
    const port = await listenWithMiddleware(middleware)
    const firstResponse = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-text-page?threadId=thread-1&turnId=turn-active&limit=1`,
    )
    const firstBody = await firstResponse.json() as { nextOlderCursor: string }
    await truncate(fixture.sessionPath, 8)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-text-page?threadId=thread-1&turnId=turn-active&cursor=${encodeURIComponent(firstBody.nextOlderCursor)}`,
    )

    expect(response.status).toBe(409)
  })

  it('rejects a requested turn that is not the trusted active runtime turn', async () => {
    const fixture = await createRolloutFixture()
    disposers.push(fixture.cleanup)
    const middleware = createCodexBridgeMiddleware()
    stubThreadRead(fixture.sessionPath)
    stubActiveRuntime('turn-active')
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-text-page?threadId=thread-1&turnId=turn-stale`,
    )
    const body = await response.text()

    expect(response.status).toBe(409)
    expect(body).not.toContain('agent-1')
    expect(body).not.toContain('agent-2')
  })

  it('serves active text when runtime writer discovery is temporarily unavailable', async () => {
    const fixture = await createRolloutFixture()
    disposers.push(fixture.cleanup)
    const middleware = createCodexBridgeMiddleware()
    stubThreadRead(fixture.sessionPath)
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'idle',
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-text-page?threadId=thread-1&turnId=turn-active&limit=2`,
    )
    const body = await response.json() as {
      items?: Array<{ id: string; type: string }>
    }

    expect(response.status).toBe(200)
    expect(body.items?.map((item) => item.id)).toEqual(['reason-2', 'agent-2'])
  })

  it('rejects a forged active-turn cursor whose offset points into an older turn', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-mobile-forged-text-cursor-'))
    disposers.push(() => {
      void rm(directory, { recursive: true, force: true })
    })
    const rows = [
      {
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-old' },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          id: 'agent-old-1',
          content: [{ type: 'output_text', text: 'First old update' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          id: 'agent-old-2',
          content: [{ type: 'output_text', text: 'Second old update' }],
        },
      },
      {
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'turn-old' },
      },
      {
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-active' },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          id: 'agent-active',
          content: [{ type: 'output_text', text: 'Active update' }],
        },
      },
    ]
    const serializedRows = rows.map((row) => JSON.stringify(row))
    const sessionPath = join(directory, 'rollout.jsonl')
    const rollout = `${serializedRows.join('\n')}\n`
    await writeFile(sessionPath, rollout, 'utf8')
    const forgedCursor = Buffer.from(JSON.stringify({
      v: 1,
      threadId: 'thread-1',
      turnId: 'turn-active',
      beforeOffset: Buffer.byteLength(`${serializedRows.slice(0, 3).join('\n')}\n`, 'utf8'),
      snapshotEndOffset: Buffer.byteLength(rollout, 'utf8'),
    }), 'utf8').toString('base64url')
    const middleware = createCodexBridgeMiddleware()
    stubThreadRead(sessionPath)
    stubActiveRuntime()
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-text-page?threadId=thread-1&turnId=turn-active&limit=1&cursor=${encodeURIComponent(forgedCursor)}`,
    )
    const body = await response.text()

    expect(response.status).toBe(400)
    expect(body).not.toContain('agent-old-1')
    expect(body).not.toContain('agent-old-2')
  })

  it('does not preflight the full active turn before returning a trusted newest page', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-mobile-trusted-text-page-'))
    disposers.push(() => {
      void rm(directory, { recursive: true, force: true })
    })
    const rows = [
      {
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-active' },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          id: 'agent-oversized-older',
          content: [{ type: 'output_text', text: 'x'.repeat((1024 * 1024) + 64) }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          id: 'agent-previous',
          content: [{ type: 'output_text', text: 'Previous update' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          id: 'agent-latest',
          content: [{ type: 'output_text', text: 'Latest update' }],
        },
      },
    ]
    const sessionPath = join(directory, 'rollout.jsonl')
    await writeFile(
      sessionPath,
      `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
      'utf8',
    )
    const middleware = createCodexBridgeMiddleware()
    stubThreadRead(sessionPath)
    stubActiveRuntime()
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-text-page?threadId=thread-1&turnId=turn-active&limit=1`,
    )
    const body = await response.json() as {
      items: Array<{ id: string }>
      hasMoreOlder: boolean
    }

    expect(response.status).toBe(200)
    expect(body.items.map((item) => item.id)).toEqual(['agent-latest'])
    expect(body.hasMoreOlder).toBe(true)
  })

  it('freezes the rollout snapshot before active-turn authorization', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-mobile-text-page-race-'))
    disposers.push(() => {
      void rm(directory, { recursive: true, force: true })
    })
    const sessionPath = join(directory, 'rollout.jsonl')
    await writeFile(sessionPath, [
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-a' },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          id: 'agent-a',
          content: [{ type: 'output_text', text: 'Authorized update' }],
        },
      }),
      '',
    ].join('\n'), 'utf8')
    const middleware = createCodexBridgeMiddleware()
    stubThreadRead(sessionPath)
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.runtimeProbe, 'inspect').mockImplementation(async () => {
      await appendFile(sessionPath, [
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'task_started', turn_id: 'turn-b' },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            id: 'agent-b-1',
            content: [{ type: 'output_text', text: 'First unauthorized update' }],
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            id: 'agent-b-2',
            content: [{ type: 'output_text', text: 'Second unauthorized update' }],
          },
        }),
        '',
      ].join('\n'), 'utf8')
      return {
        state: 'running',
        turnId: 'turn-a',
        interruptible: false,
        source: 'external-session-writer',
      }
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-text-page?threadId=thread-1&turnId=turn-a&limit=1`,
    )
    const body = await response.json() as {
      items: Array<{ id: string }>
      hasMoreOlder: boolean
    }

    expect(response.status).toBe(200)
    expect(body.items.map((item) => item.id)).toEqual(['agent-a'])
    expect(body.hasMoreOlder).toBe(false)
  })
})

describe('POST /codex-api/rpc guarded resume', () => {
  it('serves cached first-page thread/list RPC data without waiting for runtime state', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-list-cache-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => {
      void rm(codexHome, { recursive: true, force: true })
    })
    await writeFile(join(codexHome, 'session_index.jsonl'), '{"id":"thread-cached","updated_at":"2026-07-27T00:00:00.000Z"}\n')

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({
      data: [
        {
          id: 'thread-cached',
          path: join(codexHome, 'sessions', 'thread-cached.jsonl'),
          status: { type: 'idle' },
          externalRuntime: {
            state: 'running',
            turnId: 'turn-stale-runtime',
            interruptible: false,
            source: 'external-session-writer',
          },
          turns: [{ id: 'turn-heavy', items: [{ id: 'item-heavy' }] }],
          items: [{ id: 'top-item-heavy' }],
          messages: [{ id: 'message-heavy' }],
          conversation: { turns: [] },
          transcript: [{ id: 'transcript-heavy' }],
        },
      ],
      nextCursor: null,
    })
    const inspectMany = vi.spyOn(shared.runtimeProbe, 'inspectMany')
      .mockResolvedValueOnce({})
      .mockImplementation(() => new Promise(() => {}))
    const port = await listenWithMiddleware(middleware)
    const body = JSON.stringify({
      method: 'thread/list',
      params: {
        archived: false,
        limit: 5,
        sortKey: 'updated_at',
        modelProviders: [],
        cursor: null,
      },
    })

    const first = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    const controller = new AbortController()
    const second = await Promise.race([
      fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      }),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 50)),
    ])

    if (second === 'timeout') {
      controller.abort()
    }

    expect(first.status).toBe(200)
    const firstPayload = await first.json() as {
      result?: { data?: Array<Record<string, unknown>> }
    }
    expect(firstPayload.result?.data?.[0]).toMatchObject({
      id: 'thread-cached',
      path: join(codexHome, 'sessions', 'thread-cached.jsonl'),
      status: { type: 'idle' },
    })
    expect(firstPayload.result?.data?.[0]).not.toHaveProperty('turns')
    expect(firstPayload.result?.data?.[0]).not.toHaveProperty('items')
    expect(firstPayload.result?.data?.[0]).not.toHaveProperty('messages')
    expect(firstPayload.result?.data?.[0]).not.toHaveProperty('conversation')
    expect(firstPayload.result?.data?.[0]).not.toHaveProperty('transcript')
    expect(firstPayload.result?.data?.[0]).not.toHaveProperty('externalRuntime')
    expect(second).not.toBe('timeout')
    expect(second).toHaveProperty('status', 200)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(inspectMany).not.toHaveBeenCalled()
  })

  it('serves a lightweight session-index first page when cold thread/list has no persisted cache', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-list-session-index-fallback-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => {
      void rm(codexHome, { recursive: true, force: true })
    })
    await writeFile(join(codexHome, 'session_index.jsonl'), [
      { id: 'thread-1', thread_name: 'Oldest', updated_at: '2026-07-27T00:00:00.000Z' },
      { id: 'thread-2', thread_name: 'Second', updated_at: '2026-07-28T02:00:00.000Z' },
      { id: 'thread-3', thread_name: 'Third', updated_at: '2026-07-28T03:00:00.000Z' },
      { id: 'thread-4', thread_name: 'Fourth', updated_at: '2026-07-28T04:00:00.000Z' },
      { id: 'thread-5', thread_name: 'Fifth', updated_at: '2026-07-28T05:00:00.000Z' },
      { id: 'thread-6', thread_name: 'Newest', updated_at: '2026-07-28T06:00:00.000Z' },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8')

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    let resolveRpc!: (value: unknown) => void
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(() => new Promise((resolve) => {
      resolveRpc = resolve
    }))
    vi.spyOn(shared.runtimeProbe, 'inspectMany').mockResolvedValue({})
    const port = await listenWithMiddleware(middleware)

    const responseOrTimeout = await Promise.race([
      fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'thread/list',
          params: {
            archived: false,
            limit: 5,
            sortKey: 'updated_at',
            modelProviders: [],
            cursor: null,
          },
        }),
      }),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 50)),
    ])

    expect(responseOrTimeout).not.toBe('timeout')
    const response = responseOrTimeout as Response
    expect(response.status).toBe(200)
    const payload = await response.json() as {
      result?: { data?: Array<{ id?: string; title?: string; turns?: unknown[] }>; nextCursor?: unknown }
    }
    expect(payload.result?.data?.map((row) => row.id)).toEqual([
      'thread-6',
      'thread-5',
      'thread-4',
      'thread-3',
      'thread-2',
    ])
    expect(payload.result?.data?.[0]).toMatchObject({
      title: 'Newest',
      cwd: '',
      preview: '',
    })
    expect(payload.result?.data?.[0]).not.toHaveProperty('turns')
    expect(payload.result?.nextCursor ?? null).toBe(null)

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(rpc).toHaveBeenCalledTimes(1)
    resolveRpc({ data: [], nextCursor: null })
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  it('serves cached first-page thread/list RPC data while refreshing when mobile requests a fresh page', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-list-force-fresh-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => {
      void rm(codexHome, { recursive: true, force: true })
    })
    await writeFile(join(codexHome, 'session_index.jsonl'), '{"id":"thread-fresh","updated_at":"2026-07-27T00:01:00.000Z"}\n')

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc')
      .mockResolvedValueOnce({
        data: [
          {
            id: 'thread-cached',
            path: join(codexHome, 'sessions', 'thread-cached.jsonl'),
            status: { type: 'idle' },
          },
        ],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: 'thread-fresh',
            path: join(codexHome, 'sessions', 'thread-fresh.jsonl'),
            status: { type: 'idle' },
          },
        ],
        nextCursor: null,
      })
    vi.spyOn(shared.runtimeProbe, 'inspectMany').mockResolvedValue({})
    const port = await listenWithMiddleware(middleware)
    const baseParams = {
      archived: false,
      limit: 5,
      sortKey: 'updated_at',
      modelProviders: [],
      cursor: null,
    }

    const first = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/list',
        params: baseParams,
      }),
    })
    const fresh = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/list',
        params: {
          ...baseParams,
          __codexMobileForceFresh: true,
        },
      }),
    })

    expect(first.status).toBe(200)
    expect(fresh.status).toBe(200)
    const payload = await fresh.json() as {
      result?: { data?: Array<{ id?: string }> }
    }
    expect(payload.result?.data?.[0]?.id).toBe('thread-cached')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(rpc.mock.calls[1]?.[1]).toEqual(baseParams)
  })

  it('serves a persisted first-page thread/list snapshot when the cold app-server list is slow', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-list-persisted-cache-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => {
      void rm(codexHome, { recursive: true, force: true })
    })
    await writeFile(join(codexHome, 'session_index.jsonl'), '{"id":"thread-cached","updated_at":"2026-07-27T00:00:00.000Z"}\n')

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const staleResult = {
      data: [
        {
          id: 'thread-stale',
          path: join(codexHome, 'sessions', 'thread-stale.jsonl'),
          status: { type: 'idle' },
        },
      ],
      nextCursor: null,
    }
    const freshDeferred: { resolve?: (value: unknown) => void } = {}
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc')
      .mockResolvedValueOnce(staleResult)
      .mockImplementationOnce(() => new Promise((resolve) => {
        freshDeferred.resolve = resolve
      }))
    const inspectMany = vi.spyOn(shared.runtimeProbe, 'inspectMany')
      .mockImplementation(() => new Promise(() => {}))
    const port = await listenWithMiddleware(middleware)
    const body = JSON.stringify({
      method: 'thread/list',
      params: {
        archived: false,
        limit: 5,
        sortKey: 'updated_at',
        modelProviders: [],
        cursor: null,
      },
    })

    const warm = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    expect(warm.status).toBe(200)
    shared.appServer.invalidateThreadListRpcCache()

    const controller = new AbortController()
    const coldResponse = await Promise.race([
      fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      }),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 100)),
    ])

    if (coldResponse === 'timeout') {
      controller.abort()
      freshDeferred.resolve?.({ data: [], nextCursor: null })
    }

    expect(coldResponse).not.toBe('timeout')
    expect(coldResponse).toHaveProperty('status', 200)
    const payload = await (coldResponse as Response).json() as {
      result?: {
        data?: Array<{
          id?: string
          externalRuntime?: { state?: string; turnId?: string }
        }>
      }
    }
    expect(payload.result?.data?.[0]?.id).toBe('thread-stale')
    expect(payload.result?.data?.[0]?.externalRuntime).toBeUndefined()
    expect(rpc.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(inspectMany).not.toHaveBeenCalled()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(rpc).toHaveBeenCalledTimes(2)

    freshDeferred.resolve?.({
      data: [
        {
          id: 'thread-fresh',
          path: join(codexHome, 'sessions', 'thread-fresh.jsonl'),
          status: { type: 'idle' },
        },
      ],
      nextCursor: null,
    })
  })

  it('falls back to a persisted first-page thread/list snapshot when a forced fresh list is slow', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-list-force-fallback-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => {
      void rm(codexHome, { recursive: true, force: true })
    })
    await writeFile(join(codexHome, 'session_index.jsonl'), '{"id":"thread-cached","updated_at":"2026-07-27T00:00:00.000Z"}\n')

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const staleResult = {
      data: [
        {
          id: 'thread-stale',
          path: join(codexHome, 'sessions', 'thread-stale.jsonl'),
          status: { type: 'idle' },
        },
      ],
      nextCursor: null,
    }
    const freshDeferred: { resolve?: (value: unknown) => void } = {}
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc')
      .mockResolvedValueOnce(staleResult)
      .mockImplementationOnce(() => new Promise((resolve) => {
        freshDeferred.resolve = resolve
      }))
    vi.spyOn(shared.runtimeProbe, 'inspectMany').mockResolvedValue({})
    const port = await listenWithMiddleware(middleware)
    const baseParams = {
      archived: false,
      limit: 5,
      sortKey: 'updated_at',
      modelProviders: [],
      cursor: null,
    }
    const warm = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/list',
        params: baseParams,
      }),
    })
    expect(warm.status).toBe(200)
    shared.appServer.invalidateThreadListRpcCache()

    const controller = new AbortController()
    const forcedResponse = await Promise.race([
      fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'thread/list',
          params: {
            ...baseParams,
            __codexMobileForceFresh: true,
          },
        }),
        signal: controller.signal,
      }),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 100)),
    ])

    if (forcedResponse === 'timeout') {
      controller.abort()
      freshDeferred.resolve?.({ data: [], nextCursor: null })
    }

    expect(forcedResponse).not.toBe('timeout')
    expect(forcedResponse).toHaveProperty('status', 200)
    const payload = await (forcedResponse as Response).json() as {
      result?: { data?: Array<{ id?: string }> }
    }
    expect(payload.result?.data?.[0]?.id).toBe('thread-stale')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(rpc).toHaveBeenCalledTimes(2)
    freshDeferred.resolve?.({ data: [], nextCursor: null })
  })

  it('prewarms the first-page thread/list cache after middleware startup', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-list-prewarm-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => {
      void rm(codexHome, { recursive: true, force: true })
    })
    await writeFile(join(codexHome, 'session_index.jsonl'), '{"id":"thread-prewarm","updated_at":"2026-07-27T00:00:00.000Z"}\n')

    const middleware = createCodexBridgeMiddleware({ prewarmThreadListCache: true })
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({
      data: [
        {
          id: 'thread-prewarm',
          path: join(codexHome, 'sessions', 'thread-prewarm.jsonl'),
          status: { type: 'idle' },
        },
      ],
      nextCursor: null,
    })
    vi.spyOn(shared.runtimeProbe, 'inspectMany').mockResolvedValue({})
    await listenWithMiddleware(middleware)

    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(rpc).toHaveBeenCalledWith('thread/list', {
      archived: false,
      limit: 5,
      sortKey: 'updated_at',
      modelProviders: [],
      cursor: null,
    })
  })

  it('degrades thread/resume to thread/read while another process owns the task', async () => {
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

describe('POST /codex-api/rpc guarded user turns', () => {
  it('blocks only the exact state-db archived thread without affecting an active neighbor', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-rpc-archived-exact-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const stateDbPath = join(codexHome, 'state_5.sqlite')
    const sqlite = spawnSync('sqlite3', [stateDbPath, [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER);',
      "INSERT INTO threads (id, archived) VALUES ('thread-archived', 1);",
      "INSERT INTO threads (id, archived) VALUES ('thread-active', 0);",
    ].join(' ')], { encoding: 'utf8' })
    expect(sqlite.status).toBe(0)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (_method, params) => ({
      thread: { id: (params as { threadId?: string }).threadId, turns: [] },
    }))
    const port = await listenWithMiddleware(middleware)
    const read = (threadId: string) => fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'thread/read', params: { threadId } }),
    })

    const archivedResponse = await read('thread-archived')
    const activeResponse = await read('thread-active')

    expect(archivedResponse.status).toBe(409)
    expect(activeResponse.status).toBe(200)
    expect(rpc).not.toHaveBeenCalledWith('thread/read', { threadId: 'thread-archived' })
    expect(rpc).toHaveBeenCalledWith('thread/read', { threadId: 'thread-active' })
  })

  it.each([
    'thread/archive',
    'thread/unarchive',
    'thread/fork',
    'thread/rollback',
    'thread/name/set',
    'thread/goal/set',
    'thread/goal/clear',
    'thread/start-turn',
    'turn/interrupt',
  ])('returns 409 without dispatching %s while a direct CLI owns the thread', async (method) => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (calledMethod) => {
      if (calledMethod === 'thread/read') {
        return {
          thread: {
            id: 'thread-cli-owned',
            path: '/home/user/.codex/sessions/rollout-thread-cli-owned.jsonl',
            status: { type: 'idle' },
            turns: [],
          },
        }
      }
      return { ok: true }
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running',
      turnId: 'turn-cli',
      interruptible: false,
      source: 'external-session-writer',
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, params: { threadId: 'thread-cli-owned' } }),
    })

    expect(response.status).toBe(409)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('thread/read', {
      threadId: 'thread-cli-owned',
      includeTurns: true,
    })
    expect(rpc).not.toHaveBeenCalledWith(method, expect.anything())
  })

  it('returns 409 when a cross-process turn-start claim already exists', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-rpc-start-conflict-'))
    process.env.CODEX_HOME = codexHome
    let release!: () => void
    const held = withThreadStartClaim('thread-start-conflict-http', async () => (
      new Promise<void>((resolve) => { release = resolve })
    ))
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const middleware = createCodexBridgeMiddleware()
    const port = await listenWithMiddleware(middleware)
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    try {
      const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'turn/start',
          params: { threadId: 'thread-start-conflict-http', input: [{ type: 'text', text: 'loser' }] },
        }),
      })
      expect(response.status).toBe(409)
    } finally {
      release()
      await held
    }
  })

  it('augments an empty thread/read fallback with current external ownership', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
        storeThreadReadSnapshot: (threadId: string, snapshot: unknown) => void
      }
    }
    shared.appServer.storeThreadReadSnapshot('thread-empty-fallback', {
      thread: {
        id: 'thread-empty-fallback',
        path: '/tmp/thread-empty-fallback.jsonl',
        status: { type: 'idle' },
        turns: [{ id: 'turn-cli', status: 'interrupted', items: [] }],
      },
    })
    vi.spyOn(shared.appServer, 'rpc').mockRejectedValue(new Error(
      'failed to read thread: failed to read rollout /tmp/thread-empty-fallback.jsonl: rollout at /tmp/thread-empty-fallback.jsonl is empty',
    ))
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running', turnId: 'turn-cli', interruptible: false, source: 'external-session-writer',
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'thread/read', params: { threadId: 'thread-empty-fallback' } }),
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      result: {
        thread: {
          id: 'thread-empty-fallback',
          status: { type: 'idle' },
          externalRuntime: {
            state: 'running', turnId: 'turn-cli', interruptible: false, source: 'external-session-writer',
          },
        },
      },
    })
  })
  it.each([
    ['running', {
      state: 'running' as const,
      turnId: 'turn-desktop',
      interruptible: false as const,
      source: 'external-session-writer' as const,
    }],
    ['unknown', { state: 'unknown' as const }],
  ])('blocks turn/start when the immediate writer probe is %s', async (_label, runtime) => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue(runtime)
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/read') {
        return {
          thread: {
            id: 'thread-existing',
            path: '/home/user/.codex/sessions/rollout-thread-existing.jsonl',
            status: { type: 'idle' },
            turns: [],
          },
        }
      }
      if (method === 'turn/start') return { turn: { id: 'turn-raced' } }
      return {}
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'turn/start',
        params: { threadId: 'thread-existing', input: [{ type: 'text', text: 'race' }] },
      }),
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining('writer ownership is not idle'),
    })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('thread/read', {
      threadId: 'thread-existing',
      includeTurns: true,
    })
    expect(inspect).toHaveBeenCalledWith('thread-existing', 4242)
    expect(rpc).not.toHaveBeenCalledWith('turn/start', expect.anything())
  })

  it('blocks explicit external steer turn/start when another writer owns the task', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running',
      turnId: 'turn-desktop',
      interruptible: true,
      source: 'external-session-writer',
    })
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/read') {
        return {
          thread: {
            id: 'thread-existing',
            path: '/home/user/.codex/sessions/rollout-thread-existing.jsonl',
            status: { type: 'idle' },
            turns: [],
          },
        }
      }
      if (method === 'turn/start') return { turn: { id: 'turn-steered' } }
      return {}
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'turn/start',
        params: {
          threadId: 'thread-existing',
          input: [{ type: 'text', text: 'steer' }],
          __codexMobileExternalSteer: true,
        },
      }),
    })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('writer ownership is not idle'),
    })
    expect(inspect).toHaveBeenCalledWith('thread-existing', 4242)
    expect(rpc).not.toHaveBeenCalledWith('turn/start', expect.anything())
  })

  it('blocks an old external-steer marker regardless of payload shape', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running',
      turnId: 'turn-desktop',
      interruptible: true,
      source: 'external-session-writer',
    })
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/read') {
        return {
          thread: {
            id: 'thread-existing',
            path: '/home/user/.codex/sessions/rollout-thread-existing.jsonl',
            status: { type: 'idle' },
            turns: [],
          },
        }
      }
      return {}
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'turn/start',
        params: {
          threadId: 'thread-existing',
          input: [{ type: 'text', text: 'steer' }],
          attachments: [{ label: 'file', path: '/tmp/file', fsPath: '/tmp/file' }],
          __codexMobileExternalSteer: true,
        },
      }),
    })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('writer ownership is not idle'),
    })
    expect(inspect).toHaveBeenCalledWith('thread-existing', null)
    expect(rpc).not.toHaveBeenCalledWith('turn/start', expect.anything())
  })

  it('allows the first turn only after a materialized rollout has an explicit idle probe', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({ state: 'idle' })
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/start') {
        return { thread: { id: 'thread-new', path: '/home/user/.codex/sessions/rollout-thread-new.jsonl' } }
      }
      if (method === 'thread/read') {
        return {
          thread: {
            id: 'thread-new',
            path: '/home/user/.codex/sessions/rollout-thread-new.jsonl',
            status: { type: 'idle' },
            turns: [],
          },
        }
      }
      if (method === 'turn/start') return { turn: { id: 'turn-first' } }
      return {}
    })
    const port = await listenWithMiddleware(middleware)

    const startResponse = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'thread/start', params: { cwd: '/tmp/project' } }),
    })
    expect(startResponse.status).toBe(200)

    const turnResponse = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'turn/start',
        params: { threadId: 'thread-new', input: [{ type: 'text', text: 'first' }] },
      }),
    })

    expect(turnResponse.status).toBe(200)
    await expect(turnResponse.json()).resolves.toMatchObject({
      result: { turn: { id: 'turn-first' } },
    })
    expect(inspect).toHaveBeenCalledWith('thread-new', 4242)
    expect(rpc.mock.calls.map(([method]) => method)).toEqual([
      'thread/start',
      'thread/read',
      'turn/start',
    ])
    expect(rpc).toHaveBeenCalledWith('turn/start', expect.objectContaining({ threadId: 'thread-new' }))
  })

  it('preserves first-turn resume recovery when a newly created thread is not materialized yet', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect')
    let turnStartCalls = 0
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/start') return { thread: { id: 'thread-new-recovery' } }
      if (method === 'thread/read') throw new Error('thread not found: thread-new-recovery')
      if (method === 'turn/start') {
        turnStartCalls += 1
        if (turnStartCalls === 1) throw new Error('thread not found: thread-new-recovery')
        return { turn: { id: 'turn-first-recovered' } }
      }
      if (method === 'thread/resume') return { thread: { id: 'thread-new-recovery', turns: [] } }
      throw new Error(`unexpected method ${method}`)
    })
    const port = await listenWithMiddleware(middleware)

    await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'thread/start', params: { cwd: '/tmp/project' } }),
    })
    const turnResponse = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'turn/start',
        params: { threadId: 'thread-new-recovery', input: [{ type: 'text', text: 'first' }] },
      }),
    })

    expect(turnResponse.status).toBe(200)
    await expect(turnResponse.json()).resolves.toMatchObject({
      result: { turn: { id: 'turn-first-recovered' } },
    })
    expect(rpc.mock.calls.map(([method]) => method)).toEqual([
      'thread/start',
      'thread/read',
      'turn/start',
      'thread/read',
      'thread/resume',
      'turn/start',
    ])
    expect(inspect).not.toHaveBeenCalled()
  })

  it('allows a locally created first turn when thread/read reports exact pending materialization', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect')
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/start') return { thread: { id: 'thread-pending-materialization' } }
      if (method === 'thread/read') {
        throw new Error(
          'thread thread-pending-materialization is not materialized yet; includeTurns is unavailable before first user message',
        )
      }
      if (method === 'turn/start') return { turn: { id: 'turn-first-materialized' } }
      throw new Error(`unexpected method ${method}`)
    })
    const port = await listenWithMiddleware(middleware)

    const startResponse = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'thread/start', params: { cwd: '/tmp/project' } }),
    })
    expect(startResponse.status).toBe(200)

    const turnResponse = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'turn/start',
        params: {
          threadId: 'thread-pending-materialization',
          input: [{ type: 'text', text: 'first' }],
        },
      }),
    })

    expect(turnResponse.status).toBe(200)
    await expect(turnResponse.json()).resolves.toMatchObject({
      result: { turn: { id: 'turn-first-materialized' } },
    })
    expect(rpc.mock.calls.map(([method]) => method)).toEqual([
      'thread/start',
      'thread/read',
      'turn/start',
    ])
    expect(inspect).not.toHaveBeenCalled()
  })

  it('fails closed on pending materialization without a local first-turn capability', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect')
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/read') {
        throw new Error(
          'thread thread-existing-pending is not materialized yet; includeTurns is unavailable before first user message',
        )
      }
      if (method === 'turn/start') return { turn: { id: 'turn-competing' } }
      throw new Error(`unexpected method ${method}`)
    })
    const port = await listenWithMiddleware(middleware)

    const turnResponse = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'turn/start',
        params: {
          threadId: 'thread-existing-pending',
          input: [{ type: 'text', text: 'ordinary' }],
        },
      }),
    })

    expect(turnResponse.status).toBe(409)
    expect(await turnResponse.json()).toMatchObject({
      error: expect.stringContaining('writer ownership is not idle'),
    })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('thread/read', {
      threadId: 'thread-existing-pending',
      includeTurns: true,
    })
    expect(rpc).not.toHaveBeenCalledWith('turn/start', expect.anything())
    expect(inspect).not.toHaveBeenCalled()
  })

  it.each([
    ['running', {
      state: 'running' as const,
      turnId: 'turn-desktop-first-takeover',
      interruptible: false as const,
      source: 'external-session-writer' as const,
    }],
    ['unknown', { state: 'unknown' as const }],
  ])('blocks a materialized %s writer takeover before the locally created first turn', async (_label, runtime) => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue(runtime)
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/start') return { thread: { id: 'thread-first-takeover' } }
      if (method === 'thread/read') {
        return {
          thread: {
            id: 'thread-first-takeover',
            path: '/home/user/.codex/sessions/rollout-thread-first-takeover.jsonl',
            status: { type: 'active' },
            turns: [{ id: 'turn-desktop-first-takeover', status: 'inProgress' }],
          },
        }
      }
      if (method === 'turn/start') return { turn: { id: 'turn-competing' } }
      return {}
    })
    const port = await listenWithMiddleware(middleware)

    const startResponse = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'thread/start', params: { cwd: '/tmp/project' } }),
    })
    expect(startResponse.status).toBe(200)

    const turnResponse = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'turn/start',
        params: { threadId: 'thread-first-takeover', input: [{ type: 'text', text: 'first' }] },
      }),
    })

    expect(turnResponse.status).toBe(409)
    expect(await turnResponse.json()).toMatchObject({
      error: expect.stringContaining('writer ownership is not idle'),
    })
    expect(inspect).toHaveBeenCalledWith('thread-first-takeover', 4242)
    expect(rpc).not.toHaveBeenCalledWith('turn/start', expect.anything())
  })

  it('rechecks ownership and blocks a writer takeover after an earlier idle UI read', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect')
      .mockResolvedValueOnce({ state: 'idle' })
      .mockResolvedValueOnce({
        state: 'running',
        turnId: 'turn-desktop-takeover',
        interruptible: false,
        source: 'external-session-writer',
      })
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/read') {
        return {
          thread: {
            id: 'thread-takeover',
            path: '/home/user/.codex/sessions/rollout-thread-takeover.jsonl',
            status: { type: 'idle' },
            turns: [],
          },
        }
      }
      if (method === 'turn/start') return { turn: { id: 'turn-raced' } }
      return {}
    })
    const port = await listenWithMiddleware(middleware)

    const readResponse = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/read',
        params: { threadId: 'thread-takeover', includeTurns: true },
      }),
    })
    expect(readResponse.status).toBe(200)
    await expect(readResponse.json()).resolves.toMatchObject({
      result: { thread: { externalRuntime: { state: 'idle' } } },
    })

    const turnResponse = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'turn/start',
        params: { threadId: 'thread-takeover', input: [{ type: 'text', text: 'race' }] },
      }),
    })

    expect(turnResponse.status).toBe(409)
    expect(inspect).toHaveBeenCalledTimes(2)
    expect(rpc).not.toHaveBeenCalledWith('turn/start', expect.anything())
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

  it('prefers local app-server runtime evidence for single-thread polling', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({ state: 'idle' })
    shared.localRuntimeLedger.record({
      method: 'turn/started',
      params: { threadId: 'thread-local-single', turn: { id: 'turn-local-single' } },
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-runtime-state?threadId=thread-local-single`,
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      state: 'running',
      turnId: 'turn-local-single',
      interruptible: true,
      source: 'local-app-server',
    })
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
  it('refreshes a recent non-interruptible batch runtime observation for the first live-state projection', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-runtime-cache-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-runtime-cache.jsonl')
    await writeFile(rolloutPath, '{"type":"session_meta"}\n')

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.appServer, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/turns/list') {
        return {
          data: [{ id: 'turn-complete', status: 'completed', items: [] }],
          nextCursor: null,
          backwardsCursor: null,
        }
      }
      return {
        thread: {
          id: 'thread-runtime-cache',
          path: rolloutPath,
          turns: [],
        },
      }
    })
    const inspectMany = vi.spyOn(shared.runtimeProbe, 'inspectMany').mockResolvedValue({
      'thread-runtime-cache': {
        state: 'running',
        turnId: 'turn-external',
        interruptible: false,
        source: 'external-session-writer',
      },
    })
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running',
      turnId: 'turn-external',
      interruptible: false,
      source: 'external-session-writer',
    })
    const port = await listenWithMiddleware(middleware)

    const runtimeResponse = await fetch(`http://127.0.0.1:${port}/codex-api/thread-runtime-states`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadIds: ['thread-runtime-cache'] }),
    })
    expect(runtimeResponse.status).toBe(200)

    const liveResponse = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-runtime-cache`)

    expect(liveResponse.status).toBe(200)
    await expect(liveResponse.json()).resolves.toMatchObject({
      isInProgress: true,
      externalRuntime: {
        state: 'running',
        turnId: 'turn-external',
        interruptible: false,
        source: 'external-session-writer',
      },
    })
    expect(inspectMany).toHaveBeenCalledTimes(1)
    expect(inspect).toHaveBeenCalledWith('thread-runtime-cache', 4242)
  })

  it('upgrades a recent non-interruptible batch runtime observation when live-state confirms an interruptible writer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-runtime-cache-upgrade-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-runtime-cache-upgrade.jsonl')
    await writeFile(rolloutPath, '{"type":"session_meta"}\n')

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.appServer, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/turns/list') {
        return {
          data: [{ id: 'turn-complete', status: 'completed', items: [] }],
          nextCursor: null,
          backwardsCursor: null,
        }
      }
      return {
        thread: {
          id: 'thread-runtime-cache-upgrade',
          path: rolloutPath,
          turns: [],
        },
      }
    })
    const inspectMany = vi.spyOn(shared.runtimeProbe, 'inspectMany').mockResolvedValue({
      'thread-runtime-cache-upgrade': {
        state: 'running',
        turnId: 'turn-external',
        interruptible: false,
        source: 'external-session-writer',
      },
    })
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running',
      turnId: 'turn-external',
      interruptible: true,
      source: 'external-session-writer',
      cwd: '/tmp/codex-mobile-runtime-worktree',
    })
    const port = await listenWithMiddleware(middleware)

    const runtimeResponse = await fetch(`http://127.0.0.1:${port}/codex-api/thread-runtime-states`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadIds: ['thread-runtime-cache-upgrade'] }),
    })
    expect(runtimeResponse.status).toBe(200)

    const liveResponse = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-runtime-cache-upgrade`)

    expect(liveResponse.status).toBe(200)
    await expect(liveResponse.json()).resolves.toMatchObject({
      isInProgress: true,
      externalRuntime: {
        state: 'running',
        turnId: 'turn-external',
        interruptible: true,
        source: 'external-session-writer',
        cwd: '/tmp/codex-mobile-runtime-worktree',
      },
    })
    expect(inspectMany).toHaveBeenCalledTimes(1)
    expect(inspect).toHaveBeenCalledWith('thread-runtime-cache-upgrade', 4242)
  })

  it('uses a fresh running writer snapshot as a fallback when runtime inspection is idle', async () => {
    const liveStateDir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-snapshot-first-'))
    const previousLiveStateDir = process.env.CODEX_MOBILE_LIVE_STATE_DIR
    process.env.CODEX_MOBILE_LIVE_STATE_DIR = liveStateDir
    const rolloutPath = join(liveStateDir, 'thread-snapshot-first.jsonl')
    try {
      await writeFile(rolloutPath, '{"type":"session_meta"}\n')
      await writeFile(join(liveStateDir, 'thread-snapshot-first.json'), JSON.stringify({
        schemaVersion: 1,
        threadId: 'thread-snapshot-first',
        activeTurnId: 'turn-external',
        revision: 2,
        generatedAt: new Date(Date.now() - 500).toISOString(),
        expiresAt: new Date(Date.now() + 30000).toISOString(),
        source: 'desktop-writer',
        state: 'running',
        footer: null,
        timeline: [],
        pendingRequest: null,
        sidebar: { indicator: 'running' },
      }), 'utf8')

      const middleware = createCodexBridgeMiddleware()
      const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
        appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
          rpc: (method: string, params: unknown) => Promise<unknown>
        }
      }
      vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
      vi.spyOn(shared.appServer, 'rpc').mockImplementation(async (method) => {
        if (method === 'thread/turns/list') {
          return {
            data: [{ id: 'turn-complete', status: 'completed', items: [] }],
            nextCursor: null,
            backwardsCursor: null,
          }
        }
        return {
          thread: {
            id: 'thread-snapshot-first',
            path: rolloutPath,
            turns: [],
          },
        }
      })
      const inspect = vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({ state: 'idle' })
      const port = await listenWithMiddleware(middleware)

      const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-snapshot-first`)

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        isInProgress: true,
        externalRuntime: {
          state: 'running',
          turnId: 'turn-external',
          interruptible: false,
          source: 'external-session-writer',
        },
        liveAuthority: 'writer-snapshot',
        liveSnapshot: { activeTurnId: 'turn-external', footer: null },
      })
      expect(inspect).toHaveBeenCalledWith('thread-snapshot-first', 4242)
    } finally {
      if (previousLiveStateDir === undefined) {
        delete process.env.CODEX_MOBILE_LIVE_STATE_DIR
      } else {
        process.env.CODEX_MOBILE_LIVE_STATE_DIR = previousLiveStateDir
      }
      await rm(liveStateDir, { recursive: true, force: true })
    }
  })

  it('keeps external live-state interruptible when fd runtime inspection confirms a writer', async () => {
    const liveStateDir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-snapshot-interruptible-'))
    const previousLiveStateDir = process.env.CODEX_MOBILE_LIVE_STATE_DIR
    process.env.CODEX_MOBILE_LIVE_STATE_DIR = liveStateDir
    const rolloutPath = join(liveStateDir, 'thread-snapshot-interruptible.jsonl')
    try {
      await writeFile(rolloutPath, '{"type":"session_meta"}\n')
      await writeFile(join(liveStateDir, 'thread-snapshot-interruptible.json'), JSON.stringify({
        schemaVersion: 1,
        threadId: 'thread-snapshot-interruptible',
        activeTurnId: 'turn-external',
        revision: 2,
        generatedAt: new Date(Date.now() - 500).toISOString(),
        expiresAt: new Date(Date.now() + 30000).toISOString(),
        source: 'desktop-writer',
        state: 'running',
        footer: null,
        timeline: [],
        pendingRequest: null,
        sidebar: { indicator: 'running' },
      }), 'utf8')

      const middleware = createCodexBridgeMiddleware()
      const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
        appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
          rpc: (method: string, params: unknown) => Promise<unknown>
        }
      }
      vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
      vi.spyOn(shared.appServer, 'rpc').mockImplementation(async (method) => {
        if (method === 'thread/turns/list') {
          return {
            data: [{ id: 'turn-complete', status: 'completed', items: [] }],
            nextCursor: null,
            backwardsCursor: null,
          }
        }
        return {
          thread: {
            id: 'thread-snapshot-interruptible',
            path: rolloutPath,
            turns: [],
          },
        }
      })
      const inspect = vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
        state: 'running',
        turnId: 'turn-external',
        interruptible: true,
        source: 'external-session-writer',
      })
      const port = await listenWithMiddleware(middleware)

      const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-snapshot-interruptible`)

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        isInProgress: true,
        externalRuntime: {
          state: 'running',
          turnId: 'turn-external',
          interruptible: true,
          source: 'external-session-writer',
        },
        liveAuthority: 'writer-snapshot',
        liveSnapshot: { activeTurnId: 'turn-external', footer: null },
      })
      expect(inspect).toHaveBeenCalledWith('thread-snapshot-interruptible', 4242)
    } finally {
      if (previousLiveStateDir === undefined) {
        delete process.env.CODEX_MOBILE_LIVE_STATE_DIR
      } else {
        process.env.CODEX_MOBILE_LIVE_STATE_DIR = previousLiveStateDir
      }
      await rm(liveStateDir, { recursive: true, force: true })
    }
  })

  it('returns a fresh writer snapshot as authoritative for an externally running task without footer stats', async () => {
    const liveStateDir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-'))
    const previousLiveStateDir = process.env.CODEX_MOBILE_LIVE_STATE_DIR
    process.env.CODEX_MOBILE_LIVE_STATE_DIR = liveStateDir
    try {
      await writeFile(join(liveStateDir, 'thread-external.json'), JSON.stringify({
        schemaVersion: 1,
        threadId: 'thread-external',
        activeTurnId: 'turn-external',
        revision: 3,
        generatedAt: new Date(Date.now() - 1000).toISOString(),
        expiresAt: new Date(Date.now() + 30000).toISOString(),
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
      }), 'utf8')
      const middleware = createCodexBridgeMiddleware()
      const shared = sharedBridgeForTest()
      vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
      vi.spyOn(shared.appServer as unknown as {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }, 'rpc').mockResolvedValue({
        thread: {
          id: 'thread-external',
          path: join(liveStateDir, 'thread-external.jsonl'),
          turns: [{
            id: 'turn-external',
            status: 'interrupted',
            items: [{
              id: 'old-plan',
              type: 'plan',
              text: '- [x] old\n- [~] stale\n- [ ] stale\n- [ ] stale\n- [ ] stale',
            }],
          }],
        },
      })
      vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
        state: 'running',
        turnId: 'turn-external',
        interruptible: false,
        source: 'external-session-writer',
      })
      const port = await listenWithMiddleware(middleware)

      const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-external`)

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        isInProgress: true,
        liveAuthority: 'writer-snapshot',
        liveSnapshot: {
          activeTurnId: 'turn-external',
          footer: null,
        },
      })
    } finally {
      if (previousLiveStateDir === undefined) {
        delete process.env.CODEX_MOBILE_LIVE_STATE_DIR
      } else {
        process.env.CODEX_MOBILE_LIVE_STATE_DIR = previousLiveStateDir
      }
      await rm(liveStateDir, { recursive: true, force: true })
    }
  })

  it('does not change the running projection for writer footer-only stat updates', async () => {
    const liveStateDir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-footer-slim-'))
    const previousLiveStateDir = process.env.CODEX_MOBILE_LIVE_STATE_DIR
    process.env.CODEX_MOBILE_LIVE_STATE_DIR = liveStateDir
    const snapshotPath = join(liveStateDir, 'thread-footer-slim.json')
    const rolloutPath = join(liveStateDir, 'thread-footer-slim.jsonl')
    try {
      await writeFile(rolloutPath, '{"type":"session_meta"}\n')
      await writeFile(snapshotPath, JSON.stringify({
        schemaVersion: 1,
        threadId: 'thread-footer-slim',
        activeTurnId: 'turn-external',
        revision: 1,
        generatedAt: new Date(Date.now() - 1000).toISOString(),
        expiresAt: new Date(Date.now() + 30000).toISOString(),
        source: 'desktop-writer',
        state: 'running',
        footer: {
          stepCurrent: 1,
          stepTotal: 5,
          completedPercent: 20,
          fileCount: 5,
          additions: 10,
          deletions: 2,
          label: 'Step 1 / 5 · 5 files changed +10 -2',
        },
        timeline: [],
        pendingRequest: null,
        sidebar: { indicator: 'running' },
      }), 'utf8')
      const middleware = createCodexBridgeMiddleware()
      const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
        appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
          rpc: (method: string, params: unknown) => Promise<unknown>
        }
      }
      vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
      vi.spyOn(shared.appServer, 'rpc').mockImplementation(async (method) => {
        if (method === 'thread/turns/list') {
          return {
            data: [{ id: 'turn-complete', status: 'completed', items: [] }],
            nextCursor: null,
            backwardsCursor: null,
          }
        }
        return {
          thread: {
            id: 'thread-footer-slim',
            path: rolloutPath,
            turns: [],
          },
        }
      })
      vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
        state: 'running',
        turnId: 'turn-external',
        interruptible: false,
        source: 'external-session-writer',
      })
      const port = await listenWithMiddleware(middleware)

      const first = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-footer-slim`)
      const firstPayload = await first.json() as { projectionKey?: string; liveSnapshot?: { footer?: unknown } }
      expect(firstPayload.projectionKey).toEqual(expect.any(String))
      expect(firstPayload.liveSnapshot?.footer).toBeNull()

      await writeFile(snapshotPath, JSON.stringify({
        schemaVersion: 1,
        threadId: 'thread-footer-slim',
        activeTurnId: 'turn-external',
        revision: 2,
        generatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30000).toISOString(),
        source: 'desktop-writer',
        state: 'running',
        footer: {
          stepCurrent: 3,
          stepTotal: 5,
          completedPercent: 60,
          fileCount: 24,
          additions: 2597,
          deletions: 24,
          label: 'Step 3 / 5 · 24 files changed +2597 -24',
        },
        timeline: [],
        pendingRequest: null,
        sidebar: { indicator: 'running' },
      }), 'utf8')

      const second = await fetch(
        `http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-footer-slim&knownProjectionKey=${encodeURIComponent(firstPayload.projectionKey ?? '')}`,
      )
      await expect(second.json()).resolves.toMatchObject({
        notModified: true,
        projectionKey: firstPayload.projectionKey,
        liveSnapshot: { footer: null },
      })
    } finally {
      if (previousLiveStateDir === undefined) {
        delete process.env.CODEX_MOBILE_LIVE_STATE_DIR
      } else {
        process.env.CODEX_MOBILE_LIVE_STATE_DIR = previousLiveStateDir
      }
      await rm(liveStateDir, { recursive: true, force: true })
    }
  })

  it('marks external running live state as missing instead of authorizing stale thread/read footer data', async () => {
    const liveStateDir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-missing-'))
    const previousLiveStateDir = process.env.CODEX_MOBILE_LIVE_STATE_DIR
    process.env.CODEX_MOBILE_LIVE_STATE_DIR = liveStateDir
    try {
      const middleware = createCodexBridgeMiddleware()
      const shared = sharedBridgeForTest()
      vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
      vi.spyOn(shared.appServer as unknown as {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }, 'rpc').mockResolvedValue({
        thread: {
          id: 'thread-external',
          turns: [{
            id: 'turn-external',
            status: 'interrupted',
            items: [{
              id: 'stale-plan',
              type: 'plan',
              text: '- [x] old\n- [~] stale\n- [ ] stale\n- [ ] stale\n- [ ] stale',
            }],
          }],
        },
      })
      vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
        state: 'running',
        turnId: 'turn-external',
        interruptible: false,
        source: 'external-session-writer',
      })
      const port = await listenWithMiddleware(middleware)

      const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-external`)

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        isInProgress: true,
        liveAuthority: 'missing',
        liveSnapshot: null,
      })
    } finally {
      if (previousLiveStateDir === undefined) {
        delete process.env.CODEX_MOBILE_LIVE_STATE_DIR
      } else {
        process.env.CODEX_MOBILE_LIVE_STATE_DIR = previousLiveStateDir
      }
      await rm(liveStateDir, { recursive: true, force: true })
    }
  })

  it('preserves external running state from the last snapshot without retrying live thread/read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-read-failure-'))
    const previousLiveStateDir = process.env.CODEX_MOBILE_LIVE_STATE_DIR
    process.env.CODEX_MOBILE_LIVE_STATE_DIR = dir
    try {
      const rolloutPath = join(dir, 'thread-read-failure.jsonl')
      await writeFile(rolloutPath, '{"type":"session_meta"}\n')

      const middleware = createCodexBridgeMiddleware()
      const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
        appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
          rpc: (method: string, params: unknown) => Promise<unknown>
          storeThreadReadSnapshot: (threadId: string, snapshot: unknown) => void
        }
      }
      shared.appServer.storeThreadReadSnapshot('thread-read-failure', {
        threadTurnStartIndex: 4,
        thread: {
          id: 'thread-read-failure',
          path: rolloutPath,
          turns: [{
            id: 'turn-external',
            status: 'interrupted',
            items: [{ id: 'old-message', type: 'agentMessage', text: 'stale but useful' }],
          }],
        },
      })
      vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
      const rpc = vi.spyOn(shared.appServer, 'rpc').mockRejectedValue(new Error('thread/read failed in test'))
      vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
        state: 'running',
        turnId: 'turn-external',
        interruptible: false,
        source: 'external-session-writer',
      })
      const port = await listenWithMiddleware(middleware)

      const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-read-failure`)

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        threadId: 'thread-read-failure',
        isInProgress: true,
        externalRuntime: {
          state: 'running',
          turnId: 'turn-external',
          interruptible: false,
          source: 'external-session-writer',
        },
        liveAuthority: 'missing',
        liveSnapshot: null,
        liveStateError: null,
      })
      expect(rpc).not.toHaveBeenCalled()
    } finally {
      if (previousLiveStateDir === undefined) {
        delete process.env.CODEX_MOBILE_LIVE_STATE_DIR
      } else {
        process.env.CODEX_MOBILE_LIVE_STATE_DIR = previousLiveStateDir
      }
      await rm(dir, { recursive: true, force: true })
    }
  })

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

  it('does not keep an orphaned local in-progress turn locked when no writer is alive', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-orphaned-local-turn-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-orphaned.jsonl')
    await writeFile(rolloutPath, '{"type":"session_meta"}\n')

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.appServer, 'rpc').mockResolvedValue({
      thread: {
        id: 'thread-orphaned',
        path: rolloutPath,
        turns: [{
          id: 'turn-orphaned',
          status: 'inProgress',
          items: [{ id: 'message-1', type: 'agentMessage', text: 'work was interrupted by backend restart' }],
        }],
      },
    })
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({ state: 'idle' })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-orphaned`)
    const payload = await response.json() as {
      isInProgress?: boolean
      externalRuntime?: { state?: string }
      liveAuthority?: string
      liveSnapshot?: unknown
      conversationState?: { turns?: Array<{ id?: string; status?: string }> }
    }

    expect(response.status).toBe(200)
    expect(payload).toMatchObject({
      isInProgress: false,
      externalRuntime: { state: 'idle' },
      liveAuthority: 'persisted',
      liveSnapshot: null,
    })
    expect(payload.conversationState?.turns?.at(-1)).toMatchObject({
      id: 'turn-orphaned',
      status: 'orphaned',
    })
    expect(inspect).toHaveBeenCalledWith('thread-orphaned', 4242)
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
    inspect.mockResolvedValue({ state: 'idle' })
    inspect.mockResolvedValueOnce({
      state: 'running',
      turnId: 'turn-external',
      interruptible: false,
      source: 'external-session-writer',
    })
    const port = await listenWithMiddleware(middleware)

    const first = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-cached`)
    await expect(first.json()).resolves.toMatchObject({
      isInProgress: true,
      externalRuntime: {
        state: 'running',
        turnId: 'turn-external',
        interruptible: false,
        source: 'external-session-writer',
      },
    })

    const second = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-cached`)

    await expect(second.json()).resolves.toMatchObject({
      isInProgress: false,
      externalRuntime: { state: 'idle' },
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
    const rpc = vi.spyOn(shared.appServer, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/turns/list') {
        return {
          data: [{ id: 'turn-complete', status: 'completed', items: [] }],
          nextCursor: null,
          backwardsCursor: null,
        }
      }
      return {
        thread: {
          id: 'thread-running',
          path: rolloutPath,
          turns: [],
        },
      }
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

    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it('returns a lightweight not-modified live-state when the projection key matches', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-not-modified-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-not-modified.jsonl')
    await writeFile(rolloutPath, '{"type":"session_meta"}\n')

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const rpc = vi.spyOn(shared.appServer, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/turns/list') {
        return {
          data: [{
            id: 'turn-complete',
            status: 'completed',
            items: [{
              id: 'large-item',
              type: 'agentMessage',
              text: 'x'.repeat(128_000),
            }],
          }],
          nextCursor: null,
          backwardsCursor: null,
        }
      }
      return {
        thread: {
          id: 'thread-not-modified',
          path: rolloutPath,
          turns: [],
        },
      }
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running',
      turnId: 'turn-external',
      interruptible: false,
      source: 'external-session-writer',
    })
    const port = await listenWithMiddleware(middleware)

    const first = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-not-modified`)
    const firstPayload = await first.json() as {
      projectionKey?: string
      conversationState?: unknown
    }

    expect(firstPayload.projectionKey).toEqual(expect.any(String))
    expect(firstPayload.conversationState).toEqual(expect.objectContaining({
      turns: expect.any(Array),
    }))

    const second = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-not-modified&knownProjectionKey=${encodeURIComponent(firstPayload.projectionKey ?? '')}`,
    )
    const secondPayload = await second.json() as {
      notModified?: boolean
      projectionKey?: string
      conversationState?: unknown
      isInProgress?: boolean
      liveAuthority?: string
      liveSnapshot?: unknown
    }

    expect(secondPayload).toMatchObject({
      notModified: true,
      projectionKey: firstPayload.projectionKey,
      isInProgress: true,
      liveAuthority: 'missing',
      liveSnapshot: null,
    })
    expect(secondPayload).not.toHaveProperty('conversationState')
    expect(JSON.stringify(secondPayload).length).toBeLessThan(2048)
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it('compresses running active-turn text and prompt bulk out of the initial live-state projection', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-active-text-compressed-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-active-text-compressed.jsonl')
    await writeFile(rolloutPath, '{"type":"session_meta"}\n')

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.appServer, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/turns/list') {
        return {
          data: [{
            id: 'turn-external',
            status: 'inProgress',
            items: [
              {
                id: 'user-active',
                type: 'userMessage',
                content: [{ type: 'text', text: `Continue ${'x'.repeat(8192)}` }],
              },
              ...Array.from({ length: 50 }, (_, index) => ({
                id: `agent-${index}`,
                type: 'agentMessage',
                text: `active output ${index}`,
              })),
            ],
          }],
          nextCursor: null,
          backwardsCursor: null,
        }
      }
      return {
        thread: {
          id: 'thread-active-text-compressed',
          path: rolloutPath,
          turns: [],
        },
      }
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running',
      turnId: 'turn-external',
      interruptible: false,
      source: 'external-session-writer',
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-active-text-compressed`,
    )
    const payload = await response.json() as {
      activeTurnId?: string
      conversationState?: {
        turns?: Array<{
          id?: string
          items?: Array<{ id?: string; type?: string }>
          rawItemCompression?: {
            originalItemCount?: number
            retainedItemCount?: number
            omittedItemCount?: number
          }
        }>
      }
    }
    const activeTurn = payload.conversationState?.turns?.find((turn) => turn.id === 'turn-external')

    expect(response.status).toBe(200)
    expect(payload.activeTurnId).toBe('turn-external')
    expect(activeTurn?.items).toEqual([])
    expect(activeTurn?.rawItemCompression).toEqual({
      originalItemCount: 51,
      retainedItemCount: 0,
      omittedItemCount: 51,
    })
    expect(JSON.stringify(payload)).not.toContain('user-active')
    expect(JSON.stringify(payload)).not.toContain('Continue')
    expect(JSON.stringify(payload)).not.toContain('active output')
    expect(JSON.stringify(payload).length).toBeLessThan(3072)
  })

  it('deduplicates concurrent running live-state projections for the same known key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-concurrent-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-concurrent.jsonl')
    await writeFile(rolloutPath, '{"type":"session_meta"}\n')

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const rpc = vi.spyOn(shared.appServer, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/turns/list') {
        await new Promise((resolve) => setTimeout(resolve, 20))
        return {
          data: [{
            id: 'turn-external',
            status: 'inProgress',
            items: [{
              id: 'agent-heavy',
              type: 'agentMessage',
              text: 'x'.repeat(128_000),
            }],
          }],
          nextCursor: null,
          backwardsCursor: null,
        }
      }
      return {
        thread: {
          id: 'thread-concurrent',
          path: rolloutPath,
          turns: [],
        },
      }
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running',
      turnId: 'turn-external',
      interruptible: false,
      source: 'external-session-writer',
    })
    const port = await listenWithMiddleware(middleware)

    const [first, second] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-concurrent&knownProjectionKey=stale`),
      fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-concurrent&knownProjectionKey=stale`),
    ])
    const firstPayload = await first.json() as { projectionKey?: string; isInProgress?: boolean }
    const secondPayload = await second.json() as { projectionKey?: string; isInProgress?: boolean }

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(firstPayload).toMatchObject({ isInProgress: true })
    expect(secondPayload).toMatchObject({ isInProgress: true, projectionKey: firstPayload.projectionKey })
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it('returns a lightweight not-modified cached idle live-state when the projection key matches', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-idle-not-modified-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-idle-not-modified.jsonl')
    await writeFile(rolloutPath, '{"type":"session_meta"}\n')

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const rpc = vi.spyOn(shared.appServer, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/turns/list') {
        return {
          data: [{
            id: 'turn-complete',
            status: 'interrupted',
            items: [{
              id: 'large-idle-item',
              type: 'agentMessage',
              text: 'x'.repeat(128_000),
            }],
          }],
          nextCursor: null,
          backwardsCursor: null,
        }
      }
      return {
        thread: {
          id: 'thread-idle-not-modified',
          path: rolloutPath,
          turns: [],
        },
      }
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({ state: 'unknown' })
    const port = await listenWithMiddleware(middleware)

    const first = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-idle-not-modified`)
    const firstPayload = await first.json() as {
      projectionKey?: string
      conversationState?: unknown
      isInProgress?: boolean
    }

    expect(firstPayload).toMatchObject({
      projectionKey: expect.any(String),
      isInProgress: false,
      conversationState: expect.objectContaining({ turns: expect.any(Array) }),
    })

    const second = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-idle-not-modified&knownProjectionKey=${encodeURIComponent(firstPayload.projectionKey ?? '')}`,
    )
    const secondPayload = await second.json() as {
      notModified?: boolean
      projectionKey?: string
      conversationState?: unknown
      isInProgress?: boolean
    }

    expect(secondPayload).toMatchObject({
      notModified: true,
      projectionKey: firstPayload.projectionKey,
      isInProgress: false,
    })
    expect(secondPayload).not.toHaveProperty('conversationState')
    expect(JSON.stringify(secondPayload).length).toBeLessThan(2048)
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it('rechecks a known non-interruptible running projection before reusing it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-known-running-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-known-running.jsonl')
    await writeFile(rolloutPath, '{"type":"session_meta"}\n')

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.appServer, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/turns/list') {
        return {
          data: [{ id: 'turn-complete', status: 'completed', items: [] }],
          nextCursor: null,
          backwardsCursor: null,
        }
      }
      return {
        thread: {
          id: 'thread-known-running',
          path: rolloutPath,
          turns: [],
        },
      }
    })
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running',
      turnId: 'turn-external',
      interruptible: false,
      source: 'external-session-writer',
    })
    const port = await listenWithMiddleware(middleware)

    const first = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-known-running`)
    const firstPayload = await first.json() as { projectionKey?: string }

    const second = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-known-running&knownProjectionKey=${encodeURIComponent(firstPayload.projectionKey ?? '')}`,
    )
    await expect(second.json()).resolves.toMatchObject({
      notModified: true,
      projectionKey: firstPayload.projectionKey,
      isInProgress: true,
    })
    expect(inspect).toHaveBeenCalledTimes(2)
  })

  it('upgrades a known non-interruptible running projection when the next live-state probe confirms a writer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-known-running-upgrade-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-known-running-upgrade.jsonl')
    await writeFile(rolloutPath, '{"type":"session_meta"}\n')

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.appServer, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/turns/list') {
        return {
          data: [{ id: 'turn-complete', status: 'completed', items: [] }],
          nextCursor: null,
          backwardsCursor: null,
        }
      }
      return {
        thread: {
          id: 'thread-known-running-upgrade',
          path: rolloutPath,
          turns: [],
        },
      }
    })
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect')
      .mockResolvedValueOnce({
        state: 'running',
        turnId: 'turn-external',
        interruptible: false,
        source: 'external-session-writer',
      })
      .mockResolvedValueOnce({
        state: 'running',
        turnId: 'turn-external',
        interruptible: true,
        source: 'external-session-writer',
        cwd: '/tmp/codex-mobile-runtime-worktree',
      })
    const port = await listenWithMiddleware(middleware)

    const first = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-known-running-upgrade`)
    const firstPayload = await first.json() as {
      projectionKey?: string
      externalRuntime?: { interruptible?: boolean }
    }
    expect(firstPayload.projectionKey).toEqual(expect.any(String))
    expect(firstPayload.externalRuntime?.interruptible).toBe(false)

    const second = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-known-running-upgrade&knownProjectionKey=${encodeURIComponent(firstPayload.projectionKey ?? '')}`,
    )
    const secondPayload = await second.json() as {
      notModified?: boolean
      projectionKey?: string
      externalRuntime?: { interruptible?: boolean; cwd?: string }
      conversationState?: unknown
    }

    expect(second.status).toBe(200)
    expect(secondPayload).toMatchObject({
      notModified: true,
      externalRuntime: {
        interruptible: true,
        cwd: '/tmp/codex-mobile-runtime-worktree',
      },
    })
    expect(secondPayload.projectionKey).toEqual(expect.any(String))
    expect(secondPayload.projectionKey).not.toBe(firstPayload.projectionKey)
    expect(secondPayload).not.toHaveProperty('conversationState')
    expect(inspect).toHaveBeenCalledTimes(2)
  })

  it('rechecks a known interruptible external running projection before reusing it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-known-running-interruptible-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-known-running-interruptible.jsonl')
    await writeFile(rolloutPath, '{"type":"session_meta"}\n')

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.appServer, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/turns/list') {
        return {
          data: [{ id: 'turn-complete', status: 'completed', items: [] }],
          nextCursor: null,
          backwardsCursor: null,
        }
      }
      return {
        thread: {
          id: 'thread-known-running-interruptible',
          path: rolloutPath,
          turns: [],
        },
      }
    })
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect')
    inspect.mockResolvedValueOnce({
      state: 'running',
      turnId: 'turn-external',
      interruptible: true,
      source: 'external-session-writer',
      cwd: '/tmp/codex-mobile-runtime-worktree',
    })
    inspect.mockResolvedValueOnce({ state: 'unknown' })
    const port = await listenWithMiddleware(middleware)

    const first = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-known-running-interruptible`)
    const firstPayload = await first.json() as { projectionKey?: string }
    expect(firstPayload.projectionKey).toEqual(expect.any(String))

    const second = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-known-running-interruptible&knownProjectionKey=${encodeURIComponent(firstPayload.projectionKey ?? '')}`,
    )
    const secondPayload = await second.json() as {
      isInProgress?: boolean
      externalRuntime?: { state?: string }
    }

    expect(second.status).toBe(200)
    expect(secondPayload).toMatchObject({
      isInProgress: false,
      externalRuntime: { state: 'unknown' },
    })
  })

  it('rechecks a cached external running projection when runtime cwd is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-known-running-cwd-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-known-running-cwd.jsonl')
    await writeFile(rolloutPath, '{"type":"session_meta"}\n')

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.appServer, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/turns/list') {
        return {
          data: [{ id: 'turn-complete', status: 'completed', items: [] }],
          nextCursor: null,
          backwardsCursor: null,
        }
      }
      return {
        thread: {
          id: 'thread-known-running-cwd',
          path: rolloutPath,
          turns: [],
        },
      }
    })
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect')
      .mockResolvedValueOnce({
        state: 'running',
        turnId: 'turn-external',
        interruptible: true,
        source: 'external-session-writer',
      })
      .mockResolvedValueOnce({
        state: 'running',
        turnId: 'turn-external',
        interruptible: true,
        source: 'external-session-writer',
        cwd: '/tmp/codex-mobile-runtime-worktree',
      })
    const port = await listenWithMiddleware(middleware)

    const first = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-known-running-cwd`)
    const firstPayload = await first.json() as {
      projectionKey?: string
      externalRuntime?: { cwd?: string }
    }
    expect(firstPayload.projectionKey).toEqual(expect.any(String))
    expect(firstPayload.externalRuntime?.cwd).toBeUndefined()

    const second = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-known-running-cwd&knownProjectionKey=${encodeURIComponent(firstPayload.projectionKey ?? '')}`,
    )
    const secondPayload = await second.json() as {
      notModified?: boolean
      projectionKey?: string
      externalRuntime?: { cwd?: string }
      conversationState?: unknown
    }

    expect(secondPayload).toMatchObject({
      notModified: true,
      externalRuntime: {
        cwd: '/tmp/codex-mobile-runtime-worktree',
      },
    })
    expect(secondPayload.projectionKey).toEqual(expect.any(String))
    expect(secondPayload.projectionKey).not.toBe(firstPayload.projectionKey)
    expect(secondPayload).not.toHaveProperty('conversationState')
    expect(inspect).toHaveBeenCalledTimes(2)
  })

  it('prefers a local app-server live-state runtime over a stale desktop writer snapshot', async () => {
    const liveStateDir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-local-over-snapshot-'))
    const previousLiveStateDir = process.env.CODEX_MOBILE_LIVE_STATE_DIR
    process.env.CODEX_MOBILE_LIVE_STATE_DIR = liveStateDir
    const rolloutPath = join(liveStateDir, 'thread-local-over-snapshot.jsonl')
    try {
      await writeFile(rolloutPath, '{"type":"session_meta"}\n')
      await writeFile(join(liveStateDir, 'thread-local-over-snapshot.json'), JSON.stringify({
        schemaVersion: 1,
        threadId: 'thread-local-over-snapshot',
        activeTurnId: 'turn-external-stale',
        revision: 3,
        generatedAt: new Date(Date.now() - 1000).toISOString(),
        expiresAt: new Date(Date.now() + 30000).toISOString(),
        source: 'desktop-writer',
        state: 'running',
        footer: null,
        timeline: [],
        pendingRequest: null,
        sidebar: { indicator: 'running' },
      }), 'utf8')

      const middleware = createCodexBridgeMiddleware()
      const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
        appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
          rpc: (method: string, params: unknown) => Promise<unknown>
        }
      }
      vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
      vi.spyOn(shared.appServer, 'rpc').mockImplementation(async (method) => {
        if (method === 'thread/turns/list') {
          return {
            data: [{
              id: 'turn-local-current',
              status: 'inProgress',
              items: [{ id: 'agent-local-current', type: 'agentMessage', text: 'local active text' }],
            }],
            nextCursor: null,
            backwardsCursor: null,
          }
        }
        return {
          thread: {
            id: 'thread-local-over-snapshot',
            path: rolloutPath,
            turns: [],
          },
        }
      })
      vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({ state: 'idle' })
      shared.localRuntimeLedger.record({
        method: 'turn/started',
        params: {
          threadId: 'thread-local-over-snapshot',
          turn: { id: 'turn-local-current' },
        },
      })
      const port = await listenWithMiddleware(middleware)

      const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-local-over-snapshot`)
      const payload = await response.json() as {
        isInProgress?: boolean
        activeTurnId?: string
        externalRuntime?: { state?: string; turnId?: string; interruptible?: boolean; source?: string }
        liveAuthority?: string
        liveSnapshot?: unknown
        conversationState?: { turns?: Array<{ id?: string; items?: unknown[] }> }
      }

      expect(response.status).toBe(200)
      expect(payload).toMatchObject({
        isInProgress: true,
        activeTurnId: 'turn-local-current',
        externalRuntime: {
          state: 'running',
          turnId: 'turn-local-current',
          interruptible: true,
          source: 'local-app-server',
        },
        liveAuthority: 'local-stream',
        liveSnapshot: null,
      })
      expect(payload.conversationState?.turns?.[0]?.items).toEqual([])
    } finally {
      if (previousLiveStateDir === undefined) {
        delete process.env.CODEX_MOBILE_LIVE_STATE_DIR
      } else {
        process.env.CODEX_MOBILE_LIVE_STATE_DIR = previousLiveStateDir
      }
      await rm(liveStateDir, { recursive: true, force: true })
    }
  })

  it('prefers a local app-server live-state runtime over a known external running projection cache', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-local-over-cache-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-local-over-cache.jsonl')
    await writeFile(rolloutPath, '{"type":"session_meta"}\n')

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    let localStarted = false
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.appServer, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/turns/list') {
        return {
          data: [localStarted
            ? {
                id: 'turn-local-current',
                status: 'inProgress',
                items: [{ id: 'agent-local-current', type: 'agentMessage', text: 'local active text' }],
              }
            : { id: 'turn-external', status: 'inProgress', items: [] }],
          nextCursor: null,
          backwardsCursor: null,
        }
      }
      return {
        thread: {
          id: 'thread-local-over-cache',
          path: rolloutPath,
          turns: [],
        },
      }
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running',
      turnId: 'turn-external',
      interruptible: true,
      source: 'external-session-writer',
      cwd: '/tmp/codex-mobile-runtime-worktree',
    })
    const port = await listenWithMiddleware(middleware)

    const first = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-local-over-cache`)
    const firstPayload = await first.json() as { projectionKey?: string }
    expect(firstPayload.projectionKey).toEqual(expect.any(String))

    localStarted = true
    shared.localRuntimeLedger.record({
      method: 'turn/started',
      params: {
        threadId: 'thread-local-over-cache',
        turn: { id: 'turn-local-current' },
      },
    })

    const second = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-local-over-cache&knownProjectionKey=${encodeURIComponent(firstPayload.projectionKey ?? '')}`,
    )
    const payload = await second.json() as {
      isInProgress?: boolean
      activeTurnId?: string
      externalRuntime?: { state?: string; turnId?: string; interruptible?: boolean; source?: string }
      liveAuthority?: string
      liveSnapshot?: unknown
    }

    expect(second.status).toBe(200)
    expect(payload).toMatchObject({
      isInProgress: true,
      activeTurnId: 'turn-local-current',
      externalRuntime: {
        state: 'running',
        turnId: 'turn-local-current',
        interruptible: true,
        source: 'local-app-server',
      },
      liveAuthority: 'local-stream',
      liveSnapshot: null,
    })
  })

  it('keeps a known running projection unchanged when the rollout only appends hidden records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-hidden-append-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-hidden-append.jsonl')
    await writeFile(rolloutPath, '{"type":"session_meta"}\n')

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const rpc = vi.spyOn(shared.appServer, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/turns/list') {
        return {
          data: [{ id: 'turn-complete', status: 'completed', items: [] }],
          nextCursor: null,
          backwardsCursor: null,
        }
      }
      return {
        thread: {
          id: 'thread-hidden-append',
          path: rolloutPath,
          turns: [],
        },
      }
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running',
      turnId: 'turn-external',
      interruptible: false,
      source: 'external-session-writer',
    })
    const port = await listenWithMiddleware(middleware)

    const first = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-hidden-append`)
    const firstPayload = await first.json() as { projectionKey?: string }
    expect(firstPayload.projectionKey).toEqual(expect.any(String))

    await appendFile(rolloutPath, `${JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'call-hidden',
        arguments: JSON.stringify({ cmd: 'large hidden command' }),
      },
    })}\n`, 'utf8')

    const second = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-hidden-append&knownProjectionKey=${encodeURIComponent(firstPayload.projectionKey ?? '')}`,
    )
    const secondPayload = await second.json() as {
      notModified?: boolean
      projectionKey?: string
      conversationState?: unknown
    }

    expect(secondPayload).toMatchObject({
      notModified: true,
      projectionKey: firstPayload.projectionKey,
    })
    expect(secondPayload).not.toHaveProperty('conversationState')
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it('changes a known running projection when the rollout appends visible active text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-visible-append-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-visible-append.jsonl')
    await writeFile(rolloutPath, '{"type":"session_meta"}\n')

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const rpc = vi.spyOn(shared.appServer, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/turns/list') {
        return {
          data: [{ id: 'turn-complete', status: 'completed', items: [] }],
          nextCursor: null,
          backwardsCursor: null,
        }
      }
      return {
        thread: {
          id: 'thread-visible-append',
          path: rolloutPath,
          turns: [],
        },
      }
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running',
      turnId: 'turn-external',
      interruptible: false,
      source: 'external-session-writer',
    })
    const port = await listenWithMiddleware(middleware)

    const first = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-visible-append`)
    const firstPayload = await first.json() as { projectionKey?: string }
    expect(firstPayload.projectionKey).toEqual(expect.any(String))

    await appendFile(rolloutPath, `${JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        id: 'visible-message-after-projection',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Visible active text after the previous projection.' }],
      },
    })}\n`, 'utf8')

    const second = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-visible-append&knownProjectionKey=${encodeURIComponent(firstPayload.projectionKey ?? '')}`,
    )
    const secondPayload = await second.json() as {
      notModified?: boolean
      projectionKey?: string
      conversationState?: unknown
    }

    expect(secondPayload).toMatchObject({
      notModified: true,
    })
    expect(secondPayload.projectionKey).toEqual(expect.any(String))
    expect(secondPayload.projectionKey).not.toBe(firstPayload.projectionKey)
    expect(secondPayload).not.toHaveProperty('conversationState')
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it('changes a known running projection when visible text appends after a user anchor', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-anchor-append-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-anchor-append.jsonl')
    await writeFile(rolloutPath, [
      JSON.stringify({ type: 'session_meta' }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-external' },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'user-anchor',
          role: 'user',
          content: [{ type: 'input_text', text: '继续' }],
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'visible-message-before-projection',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Visible active text before the projection.' }],
        },
      }),
      '',
    ].join('\n'), 'utf8')

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const rpc = vi.spyOn(shared.appServer, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/turns/list') {
        return {
          data: [{ id: 'turn-complete', status: 'completed', items: [] }],
          nextCursor: null,
          backwardsCursor: null,
        }
      }
      return {
        thread: {
          id: 'thread-anchor-append',
          path: rolloutPath,
          turns: [],
        },
      }
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running',
      turnId: 'turn-external',
      interruptible: false,
      source: 'external-session-writer',
    })
    const port = await listenWithMiddleware(middleware)

    const first = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-anchor-append`)
    const firstPayload = await first.json() as { projectionKey?: string }
    expect(firstPayload.projectionKey).toEqual(expect.any(String))

    await appendFile(rolloutPath, `${JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        id: 'visible-message-after-projection',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Visible active text after the previous projection.' }],
      },
    })}\n`, 'utf8')

    const second = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-anchor-append&knownProjectionKey=${encodeURIComponent(firstPayload.projectionKey ?? '')}`,
    )
    const secondPayload = await second.json() as {
      notModified?: boolean
      projectionKey?: string
      conversationState?: unknown
    }

    expect(secondPayload).toMatchObject({
      notModified: true,
    })
    expect(secondPayload.projectionKey).toEqual(expect.any(String))
    expect(secondPayload.projectionKey).not.toBe(firstPayload.projectionKey)
    expect(secondPayload).not.toHaveProperty('conversationState')
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it('returns a full live-state when the known projection key is stale', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-stale-key-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-stale-key.jsonl')
    await writeFile(rolloutPath, '{"type":"session_meta"}\n')

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.appServer, 'rpc').mockResolvedValue({
      thread: {
        id: 'thread-stale-key',
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

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-stale-key&knownProjectionKey=stale`,
    )
    const payload = await response.json() as {
      notModified?: boolean
      projectionKey?: string
      conversationState?: unknown
    }

    expect(payload.notModified).not.toBe(true)
    expect(payload.projectionKey).toEqual(expect.any(String))
    expect(payload.conversationState).toEqual(expect.objectContaining({
      turns: expect.any(Array),
    }))
  })

  it('does not reuse cached writer authority after the external runtime becomes idle', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-cache-authority-'))
    const previousLiveStateDir = process.env.CODEX_MOBILE_LIVE_STATE_DIR
    process.env.CODEX_MOBILE_LIVE_STATE_DIR = dir
    disposers.push(() => {
      if (previousLiveStateDir === undefined) {
        delete process.env.CODEX_MOBILE_LIVE_STATE_DIR
      } else {
        process.env.CODEX_MOBILE_LIVE_STATE_DIR = previousLiveStateDir
      }
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-cache-authority.jsonl')
    await writeFile(rolloutPath, '{"type":"session_meta"}\n')
    await writeFile(join(dir, 'thread-cache-authority.json'), JSON.stringify({
      schemaVersion: 1,
      threadId: 'thread-cache-authority',
      activeTurnId: 'turn-external',
      revision: 7,
      generatedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 30000).toISOString(),
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
    }), 'utf8')

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.appServer, 'rpc').mockResolvedValue({
      thread: {
        id: 'thread-cache-authority',
        path: rolloutPath,
        turns: [{ id: 'turn-complete', status: 'completed', items: [] }],
      },
    })
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect')
    inspect.mockResolvedValue({ state: 'idle' })
    const port = await listenWithMiddleware(middleware)

    const first = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-cache-authority`)
    await expect(first.json()).resolves.toMatchObject({
      isInProgress: true,
      liveAuthority: 'writer-snapshot',
      liveSnapshot: { activeTurnId: 'turn-external' },
    })

    const second = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-cache-authority`)
    await expect(second.json()).resolves.toMatchObject({
      isInProgress: false,
      externalRuntime: { state: 'idle' },
      liveAuthority: 'persisted',
      liveSnapshot: null,
    })
    expect(inspect).toHaveBeenCalledTimes(2)
  })

  it('uses the last snapshot when a cached idle projection becomes externally running', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-cache-idle-to-running-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-idle-to-running.jsonl')
    await writeFile(rolloutPath, `${JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-external' },
    })}\n`, 'utf8')

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const rpc = vi.spyOn(shared.appServer, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/turns/list') {
        return {
          data: [{ id: 'turn-external', status: 'interrupted', items: [] }],
          nextCursor: null,
          backwardsCursor: null,
        }
      }
      return {
        thread: {
          id: 'thread-idle-to-running',
          path: rolloutPath,
          turns: [],
        },
      }
    })
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect')
    inspect.mockResolvedValueOnce({ state: 'unknown' })
    inspect.mockResolvedValueOnce({
      state: 'running',
      turnId: 'turn-external',
      interruptible: false,
      source: 'external-session-writer',
    })
    const port = await listenWithMiddleware(middleware)

    const first = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-idle-to-running`)
    await expect(first.json()).resolves.toMatchObject({
      isInProgress: false,
      externalRuntime: { state: 'unknown' },
    })
    expect(rpc).toHaveBeenCalledTimes(2)

    const second = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-idle-to-running`)
    await expect(second.json()).resolves.toMatchObject({
      isInProgress: true,
      externalRuntime: {
        state: 'running',
        turnId: 'turn-external',
        source: 'external-session-writer',
      },
      conversationState: {
        turns: [{ id: 'turn-external' }],
      },
    })
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it('uses a local rollout path for known-key live-state without retrying thread/read', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-local-path-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => {
      void rm(codexHome, { recursive: true, force: true }).catch(() => undefined)
    })
    const threadId = '019faabf-f76e-7fe0-a38f-3f12d03ecaf7'
    const turnId = '019faac4-37bc-7601-bf0a-7149ce84cabb'
    const sessionDir = join(codexHome, 'sessions', '2026', '07', '29')
    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(sessionDir, `rollout-test-${threadId}.jsonl`), [
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          id: 'agent-local-live-state',
          content: [{ type: 'output_text', text: 'Local live state update' }],
        },
      }),
      '',
    ].join('\n'), 'utf8')

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const rpc = vi.spyOn(shared.appServer, 'rpc').mockRejectedValue(new Error('thread/read should not be called'))
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running',
      turnId,
      interruptible: false,
      source: 'external-session-writer',
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=${threadId}&knownProjectionKey=stale`,
    )
    const body = await response.json() as {
      notModified?: boolean
      isInProgress?: boolean
      externalRuntime?: { state?: string; turnId?: string }
      conversationState?: unknown
    }

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      notModified: true,
      isInProgress: true,
      externalRuntime: {
        state: 'running',
        turnId,
      },
    })
    expect(body).not.toHaveProperty('conversationState')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('projects live state from a bounded native turn page without a full thread read', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    const turns = Array.from({ length: 12 }, (_unused, index) => ({
      id: `turn-${index}`,
      status: index === 11 ? 'inProgress' : 'completed',
      items: [
        {
          id: `reasoning-${index}`,
          type: 'reasoning',
          summary: [`thinking ${index}`],
          content: [],
        },
        {
          id: `item-${index}`,
          type: 'agentMessage',
          text: `message ${index}`,
        },
      ],
    }))
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const rpc = vi.spyOn(shared.appServer, 'rpc').mockImplementation(async (method, params) => {
      if (method === 'thread/read') {
        expect(params).toEqual({
          threadId: 'thread-windowed',
          includeTurns: false,
        })
        return {
          thread: {
            id: 'thread-windowed',
            path: '/sessions/thread-windowed.jsonl',
            turns: [],
          },
        }
      }
      if (method === 'thread/turns/list') {
        expect(params).toEqual({
          threadId: 'thread-windowed',
          cursor: null,
          limit: 3,
          sortDirection: 'desc',
          itemsView: 'full',
        })
        return {
          data: turns.slice(-3).reverse(),
          nextCursor: 'opaque-older',
          backwardsCursor: null,
        }
      }
      throw new Error(`Unexpected RPC method: ${method}`)
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running',
      turnId: 'turn-11',
      interruptible: false,
      source: 'external-session-writer',
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-windowed`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      threadId: 'thread-windowed',
      threadTurnStartIndex: 0,
      hasMoreOlder: true,
      olderCursor: 'opaque-older',
      conversationState: {
        turns: expect.arrayContaining([
          expect.objectContaining({
            id: 'turn-11',
            items: [],
            rawItemCompression: {
              originalItemCount: 2,
              retainedItemCount: 0,
              omittedItemCount: 2,
            },
          }),
        ]),
      },
    })
    expect(rpc).not.toHaveBeenCalledWith(
      'thread/read',
      expect.objectContaining({ includeTurns: true }),
    )
  })

  it('does not fall back to a full history read when the native live page is malformed', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const rpc = vi.spyOn(shared.appServer, 'rpc').mockImplementation(async (method, params) => {
      if (method === 'thread/read' && (params as { includeTurns?: boolean }).includeTurns === true) {
        throw new Error('full history read forbidden')
      }
      if (method === 'thread/read') {
        return {
          thread: {
            id: 'thread-malformed-page',
            path: '/sessions/thread-malformed-page.jsonl',
            turns: [],
          },
        }
      }
      if (method === 'thread/turns/list') return {}
      throw new Error(`Unexpected RPC method: ${method}`)
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({ state: 'idle' })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-malformed-page`,
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      threadId: 'thread-malformed-page',
      conversationState: null,
      liveStateError: { kind: 'readFailed' },
    })
    expect(rpc).not.toHaveBeenCalledWith(
      'thread/read',
      expect.objectContaining({ includeTurns: true }),
    )
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
      'agent-1',
      'session-cmd-call-order',
      'tool-1',
      'agent-2',
    ])
  })

  it('recovers no-id user message rows before the matching assistant output in live-state responses', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-user-message-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-live-user-message.jsonl')
    await writeFile(rolloutPath, [
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-live-user-message' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '我在两个机器上配置了免密登录，为什么我ssh还需要输入密码' }],
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '我会按 SSH 认证链逐层检查。' }],
        },
      }),
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
        id: 'thread-live-user-message',
        path: rolloutPath,
        turns: [{
          id: 'turn-live-user-message',
          status: 'completed',
          items: [
            { id: 'agent-live-user-message-1', type: 'agentMessage', text: '我会按 SSH 认证链逐层检查。' },
          ],
        }],
      },
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({ state: 'idle' })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-live-user-message`,
    )
    const payload = await response.json() as {
      conversationState?: { turns?: Array<{ items?: Array<Record<string, unknown>> }> }
    }
    const items = payload.conversationState?.turns?.[0]?.items ?? []

    expect(response.status).toBe(200)
    expect(items.map((item) => item.type)).toEqual(['userMessage', 'agentMessage'])
    expect(JSON.stringify(items[0])).toContain('我在两个机器上配置了免密登录')
    expect(JSON.stringify(items[1])).toContain('我会按 SSH 认证链逐层检查')
  })

  it('reorders late delegated user messages before their matching assistant output in live-state responses', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-user-message-order-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-live-user-message-order.jsonl')
    await writeFile(rolloutPath, [
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-live-user-message-order' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          id: 'agent-after-steer',
          content: [{ type: 'output_text', text: '收到。继续 Task2。' }],
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'user_message',
          client_id: 'client-steer-order',
          message: '<codex_delegation>\n<input>TASK2_PLANNER_FINDING_2</input>\n</codex_delegation>',
          images: [],
          local_images: [],
          text_elements: [],
        },
      }),
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
        id: 'thread-live-user-message-order',
        path: rolloutPath,
        turns: [{
          id: 'turn-live-user-message-order',
          status: 'completed',
          items: [
            { id: 'agent-after-steer', type: 'agentMessage', text: '收到。继续 Task2。' },
            {
              id: 'item-user-existing',
              type: 'userMessage',
              content: [{
                type: 'text',
                text: '<codex_delegation>\n<input>TASK2_PLANNER_FINDING_2</input>\n</codex_delegation>',
              }],
            },
          ],
        }],
      },
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({ state: 'idle' })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-live-user-message-order`,
    )
    const payload = await response.json() as {
      conversationState?: { turns?: Array<{ items?: Array<Record<string, unknown>> }> }
    }
    const items = payload.conversationState?.turns?.[0]?.items ?? []

    expect(response.status).toBe(200)
    expect(items.map((item) => ({ id: item.id, type: item.type }))).toEqual([
      { id: 'item-user-existing', type: 'userMessage' },
      { id: 'agent-after-steer', type: 'agentMessage' },
    ])
  })

  it('reorders wrapped late delegated user messages before their matching assistant output in live-state responses', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-wrapped-user-message-order-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const wrappedDelegation = [
      'TASK2_PLANNER_FINDING_2 (apply before Task2 final stop; no history rewrite):',
      '<codex_delegation>',
      '<input>收到。继续 Task2。</input>',
      '</codex_delegation>',
    ].join('\n')
    const rolloutPath = join(dir, 'thread-live-wrapped-user-message-order.jsonl')
    await writeFile(rolloutPath, [
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-live-wrapped-user-message-order' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          id: 'agent-after-steer',
          content: [{ type: 'output_text', text: '收到。继续 Task2。' }],
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'user_message',
          client_id: 'client-wrapped-steer-order',
          message: wrappedDelegation,
          images: [],
          local_images: [],
          text_elements: [],
        },
      }),
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
        id: 'thread-live-wrapped-user-message-order',
        path: rolloutPath,
        turns: [{
          id: 'turn-live-wrapped-user-message-order',
          status: 'completed',
          items: [
            { id: 'agent-after-steer', type: 'agentMessage', text: '收到。继续 Task2。' },
            {
              id: 'item-user-existing',
              type: 'userMessage',
              content: [{
                type: 'text',
                text: wrappedDelegation,
              }],
            },
          ],
        }],
      },
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({ state: 'idle' })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-live-wrapped-user-message-order`,
    )
    const payload = await response.json() as {
      conversationState?: { turns?: Array<{ items?: Array<Record<string, unknown>> }> }
    }
    const items = payload.conversationState?.turns?.[0]?.items ?? []

    expect(response.status).toBe(200)
    expect(items.map((item) => ({ id: item.id, type: item.type }))).toEqual([
      { id: 'item-user-existing', type: 'userMessage' },
      { id: 'agent-after-steer', type: 'agentMessage' },
    ])
  })

  it('does not reorder ordinary late event-sourced user messages before existing live-state output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-late-user-message-order-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const lateUserInput = 'TASK2_PLANNER_FINDING_2 (apply before Task2 final stop; no history rewrite)'
    const rolloutPath = join(dir, 'thread-live-late-user-message-order.jsonl')
    await writeFile(rolloutPath, [
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-live-late-user-message-order' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          id: 'agent-after-steer',
          content: [{ type: 'output_text', text: '收到。继续 Task2。' }],
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'user_message',
          client_id: 'client-late-user-input',
          message: lateUserInput,
          images: [],
          local_images: [],
          text_elements: [],
        },
      }),
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
        id: 'thread-live-late-user-message-order',
        path: rolloutPath,
        turns: [{
          id: 'turn-live-late-user-message-order',
          status: 'completed',
          items: [
            { id: 'agent-after-steer', type: 'agentMessage', text: '收到。继续 Task2。' },
            {
              id: 'item-user-existing',
              type: 'userMessage',
              content: [{ type: 'text', text: lateUserInput }],
            },
          ],
        }],
      },
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({ state: 'idle' })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-live-late-user-message-order`,
    )
    const payload = await response.json() as {
      conversationState?: { turns?: Array<{ items?: Array<Record<string, unknown>> }> }
    }
    const items = payload.conversationState?.turns?.[0]?.items ?? []

    expect(response.status).toBe(200)
    expect(items.map((item) => ({ id: item.id, type: item.type }))).toEqual([
      { id: 'agent-after-steer', type: 'agentMessage' },
      { id: 'item-user-existing', type: 'userMessage' },
    ])
  })

  it('keeps multiple late delegated user messages paired with their own live-state response segment', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-multi-user-message-order-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const firstDelegation = '<codex_delegation>\n<input>FIRST_STEER</input>\n</codex_delegation>'
    const secondDelegation = '<codex_delegation>\n<input>SECOND_STEER</input>\n</codex_delegation>'
    const rolloutPath = join(dir, 'thread-live-multi-user-message-order.jsonl')
    await writeFile(rolloutPath, [
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-live-multi-user-message-order' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          id: 'agent-first',
          content: [{ type: 'output_text', text: 'First response' }],
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'user_message',
          client_id: 'client-late-first',
          message: firstDelegation,
          images: [],
          local_images: [],
          text_elements: [],
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          id: 'agent-second',
          content: [{ type: 'output_text', text: 'Second response' }],
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'user_message',
          client_id: 'client-late-second',
          message: secondDelegation,
          images: [],
          local_images: [],
          text_elements: [],
        },
      }),
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
        id: 'thread-live-multi-user-message-order',
        path: rolloutPath,
        turns: [{
          id: 'turn-live-multi-user-message-order',
          status: 'completed',
          items: [
            { id: 'agent-first', type: 'agentMessage', text: 'First response' },
            {
              id: 'item-user-first-existing',
              type: 'userMessage',
              content: [{ type: 'text', text: firstDelegation }],
            },
            { id: 'agent-second', type: 'agentMessage', text: 'Second response' },
            {
              id: 'item-user-second-existing',
              type: 'userMessage',
              content: [{ type: 'text', text: secondDelegation }],
            },
          ],
        }],
      },
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({ state: 'idle' })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-live-multi-user-message-order`,
    )
    const payload = await response.json() as {
      conversationState?: { turns?: Array<{ items?: Array<Record<string, unknown>> }> }
    }
    const items = payload.conversationState?.turns?.[0]?.items ?? []

    expect(response.status).toBe(200)
    expect(items.map((item) => ({ id: item.id, type: item.type }))).toEqual([
      { id: 'item-user-first-existing', type: 'userMessage' },
      { id: 'agent-first', type: 'agentMessage' },
      { id: 'item-user-second-existing', type: 'userMessage' },
      { id: 'agent-second', type: 'agentMessage' },
    ])
  })

  it('recovers redacted parent coordination activity in live-state responses', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-collaboration-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-live-collaboration.jsonl')
    await writeFile(rolloutPath, [
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-live-collaboration' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'send_message',
          call_id: 'call-live-send',
          arguments: JSON.stringify({
            target: '/root/private-reviewer',
            message: 'live-state secret prompt',
          }),
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'wait_threads',
          call_id: 'call-live-wait',
          arguments: JSON.stringify({ targets: [{ threadId: 'private-child-thread' }] }),
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
        id: 'thread-live-collaboration',
        path: rolloutPath,
        turns: [{
          id: 'turn-live-collaboration',
          status: 'completed',
          items: [
            { id: 'agent-live-1', type: 'agentMessage', text: 'first' },
            { id: 'agent-live-2', type: 'agentMessage', text: 'second' },
          ],
        }],
      },
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({ state: 'idle' })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-live-collaboration`,
    )
    const payload = await response.json() as {
      conversationState?: { turns?: Array<{ items?: Array<Record<string, unknown>> }> }
    }
    const items = payload.conversationState?.turns?.[0]?.items ?? []
    const serialized = JSON.stringify(items)

    expect(response.status).toBe(200)
    expect(items).toEqual([
      { id: 'agent-live-1', type: 'agentMessage', text: 'first' },
      {
        id: 'session-collab-call-live-send',
        type: 'collaborationActivity',
        activityKind: 'sendMessage',
        sourceCallId: 'call-live-send',
      },
      {
        id: 'session-collab-call-live-wait',
        type: 'collaborationActivity',
        activityKind: 'waitThreads',
        sourceCallId: 'call-live-wait',
      },
      { id: 'agent-live-2', type: 'agentMessage', text: 'second' },
    ])
    expect(serialized).not.toContain('live-state secret prompt')
    expect(serialized).not.toContain('/root/private-reviewer')
    expect(serialized).not.toContain('private-child-thread')
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

  it('recovers a session command without output as in progress while the turn is still running', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-rpc-running-session-command-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-rpc-running.jsonl')
    await writeFile(rolloutPath, [
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-rpc-running' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'call-rpc-running',
          arguments: JSON.stringify({ cmd: 'sleep 300' }),
        },
      }),
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
        id: 'thread-rpc-running',
        path: rolloutPath,
        turns: [{
          id: 'turn-rpc-running',
          status: 'inProgress',
          items: [
            { id: 'user-1', type: 'userMessage', content: [] },
            { id: 'agent-1', type: 'agentMessage', text: 'checking' },
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
        params: { threadId: 'thread-rpc-running', includeTurns: true },
      }),
    })
    const payload = await response.json() as {
      result?: { thread?: { turns?: Array<{ items?: Array<{ id?: string; status?: string; exitCode?: number | null }> }> } }
    }
    const command = payload.result?.thread?.turns?.[0]?.items?.find((item) => item.id === 'session-cmd-call-rpc-running')

    expect(response.status).toBe(200)
    expect(command).toMatchObject({
      status: 'inProgress',
      exitCode: null,
    })
  })

  it('recovers allowlisted parent coordination activity without leaking payloads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-rpc-collaboration-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-collaboration.jsonl')
    await writeFile(rolloutPath, [
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-collaboration' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'send_message',
          call_id: 'call-send',
          arguments: JSON.stringify({ target: '/root/reviewer', message: 'secret child prompt' }),
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'wait_agent',
          call_id: 'call-wait',
          arguments: JSON.stringify({ timeout_ms: 30_000 }),
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'list_agents',
          call_id: 'call-list',
          arguments: '{}',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'send_message_to_thread',
          call_id: 'call-send-thread',
          arguments: JSON.stringify({ threadId: 'thread-child', message: 'private thread message' }),
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'followup_task',
          call_id: 'call-followup',
          arguments: JSON.stringify({ target: '/root/reviewer', message: 'private follow-up' }),
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'wait_threads',
          call_id: 'call-wait-threads',
          arguments: JSON.stringify({ targets: [{ threadId: 'thread-child' }] }),
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'send_message',
          arguments: JSON.stringify({ message: 'missing call id' }),
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'untrusted_private_tool',
          call_id: 'call-private',
          arguments: JSON.stringify({ token: 'must-not-appear' }),
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
        id: 'thread-collaboration',
        path: rolloutPath,
        turns: [{
          id: 'turn-collaboration',
          status: 'completed',
          items: [
            { id: 'agent-1', type: 'agentMessage', text: 'first' },
            {
              id: 'call-send',
              type: 'subAgentActivity',
              agentThreadId: 'thread-reviewer',
              agentPath: '/root/reviewer',
              kind: 'interacted',
            },
            {
              id: 'call-spawn',
              type: 'subAgentActivity',
              agentThreadId: 'thread-started',
              agentPath: '/root/started',
              kind: 'started',
            },
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
        params: { threadId: 'thread-collaboration', includeTurns: true },
      }),
    })
    const payload = await response.json() as {
      result?: { thread?: { turns?: Array<{ items?: Array<Record<string, unknown>> }> } }
    }
    const items = payload.result?.thread?.turns?.[0]?.items ?? []
    const serialized = JSON.stringify(items)

    expect(items.map((item) => item.id)).toEqual([
      'agent-1',
      'session-collab-call-send',
      'session-collab-call-wait',
      'session-collab-call-list',
      'session-collab-call-send-thread',
      'session-collab-call-followup',
      'session-collab-call-wait-threads',
      'call-spawn',
      'agent-2',
    ])
    expect(items.slice(1, 7)).toEqual([
      {
        id: 'session-collab-call-send',
        type: 'collaborationActivity',
        activityKind: 'sendMessage',
        sourceCallId: 'call-send',
      },
      {
        id: 'session-collab-call-wait',
        type: 'collaborationActivity',
        activityKind: 'waitThreads',
        sourceCallId: 'call-wait',
      },
      {
        id: 'session-collab-call-list',
        type: 'collaborationActivity',
        activityKind: 'listAgents',
        sourceCallId: 'call-list',
      },
      {
        id: 'session-collab-call-send-thread',
        type: 'collaborationActivity',
        activityKind: 'sendMessage',
        sourceCallId: 'call-send-thread',
      },
      {
        id: 'session-collab-call-followup',
        type: 'collaborationActivity',
        activityKind: 'sendMessage',
        sourceCallId: 'call-followup',
      },
      {
        id: 'session-collab-call-wait-threads',
        type: 'collaborationActivity',
        activityKind: 'waitThreads',
        sourceCallId: 'call-wait-threads',
      },
    ])
    expect(serialized).not.toContain('secret child prompt')
    expect(serialized).not.toContain('private thread message')
    expect(serialized).not.toContain('private follow-up')
    expect(serialized).not.toContain('thread-child')
    expect(serialized).not.toContain('missing call id')
    expect(serialized).not.toContain('must-not-appear')
    expect(serialized).not.toContain('thread-reviewer')
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

describe('POST /codex-api/thread-runtime-interrupt', () => {
  it('interrupts an externally owned turn through the runtime probe', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const interrupt = vi.spyOn(shared.runtimeProbe, 'interrupt').mockResolvedValue({ interrupted: true })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-runtime-interrupt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId: 'thread-external', turnId: 'turn-external' }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(interrupt).toHaveBeenCalledWith('thread-external', 'turn-external', 4242)
  })

  it('does not invoke the runtime probe when the route is disabled', async () => {
    const isRouteDisabled = vi.fn((_method: string, pathname: string) => pathname === '/codex-api/thread-runtime-interrupt')
    const middleware = createCodexBridgeMiddleware({
      securityPolicy: { ...PERMISSIVE_SECURITY_POLICY, isRouteDisabled, backgroundIntegrationsEnabled: false },
    })
    const shared = sharedBridgeForTest()
    const interrupt = vi.spyOn(shared.runtimeProbe, 'interrupt')
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-runtime-interrupt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId: 'thread-external', turnId: 'turn-external' }),
    })

    expect(response.status).toBe(403)
    expect(interrupt).not.toHaveBeenCalled()
  })
})
