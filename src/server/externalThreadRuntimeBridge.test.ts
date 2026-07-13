import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExternalThreadRuntime } from '../types/threadRuntime'
import {
  augmentThreadResultWithExternalRuntime,
  createCodexBridgeMiddleware,
} from './codexAppServerBridge'

function fakeProbe(runtime: ExternalThreadRuntime) {
  return {
    registerThread: vi.fn((_threadId: string, _rolloutPath: string): void => undefined),
    inspect: vi.fn(async (
      _threadId: string,
      _excludedPid: number | null,
    ): Promise<ExternalThreadRuntime> => runtime),
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
})

describe('GET /codex-api/thread-runtime-state', () => {
  const disposers: Array<() => void> = []

  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose()
  })

  it('rejects a missing threadId inside the bridge middleware', async () => {
    const middleware = createCodexBridgeMiddleware()
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
    const { port } = server.address() as AddressInfo

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-runtime-state`)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Missing threadId' })
  })
})
