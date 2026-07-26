import { describe, expect, it, vi } from 'vitest'
import {
  applySessionSkillEnrichmentForRpc,
  buildThreadLiveStateReadFailureFallback,
  prepareRpcProxyRequest,
  shouldStoreThreadReadSnapshotForRpc,
  trimLiveThreadTurnsInRpcResult,
  trimThreadTurnsInRpcResult,
} from './codexAppServerBridge'

describe('external live snapshot RPC preparation', () => {
  it('strips the internal lightweight marker before forwarding thread/read', () => {
    expect(prepareRpcProxyRequest('thread/read', {
      threadId: 'thread-1',
      includeTurns: true,
      __codexMobileLiveSnapshot: true,
    })).toEqual({
      params: {
        threadId: 'thread-1',
        includeTurns: true,
      },
      skipSessionSkillEnrichment: true,
    })
  })

  it('keeps ordinary thread/read enrichment semantics', async () => {
    const result = { thread: { id: 'thread-1', turns: [] } }
    const enrich = vi.fn(async () => ({ ...result, enriched: true }))

    await expect(applySessionSkillEnrichmentForRpc(
      'thread/read',
      false,
      result,
      enrich,
    )).resolves.toEqual({ ...result, enriched: true })
    expect(enrich).toHaveBeenCalledOnce()
  })

  it('never rescans a growing session for repeated live snapshots', async () => {
    const enrich = vi.fn(async (result: unknown) => result)

    for (let turnCount = 1; turnCount <= 100; turnCount += 1) {
      const result = {
        thread: {
          id: 'thread-1',
          turns: Array.from({ length: turnCount }, (_, index) => ({ id: `turn-${index}` })),
        },
      }
      await expect(applySessionSkillEnrichmentForRpc(
        'thread/read',
        true,
        result,
        enrich,
      )).resolves.toBe(result)
    }

    expect(enrich).not.toHaveBeenCalled()
  })

  it('does not replace the ordinary enriched fallback cache with a lightweight snapshot', () => {
    expect(shouldStoreThreadReadSnapshotForRpc('thread/read', true)).toBe(false)
    expect(shouldStoreThreadReadSnapshotForRpc('thread/read', false)).toBe(true)
    expect(shouldStoreThreadReadSnapshotForRpc('thread/start', false)).toBe(true)
  })

  it('limits an initial thread detail response to the newest five turns', () => {
    const turns = Array.from({ length: 12 }, (_unused, index) => ({
      id: `turn-${index}`,
      status: 'completed',
      items: [],
    }))
    const result = trimThreadTurnsInRpcResult('thread/read', {
      thread: {
        id: 'thread-windowed',
        turns,
      },
    }) as { threadTurnStartIndex: number; thread: { turns: Array<{ id: string }> } }

    expect(result.threadTurnStartIndex).toBe(7)
    expect(result.thread.turns.map((turn) => turn.id)).toEqual([
      'turn-7',
      'turn-8',
      'turn-9',
      'turn-10',
      'turn-11',
    ])
  })

  it('projects a live snapshot to only the newest absolute turn', () => {
    const turns = Array.from({ length: 12 }, (_unused, index) => ({
      id: `turn-${index}`,
      status: index === 11 ? 'inProgress' : 'completed',
      items: [{
        id: `item-${index}`,
        type: 'agentMessage',
        text: `message ${index}`,
      }],
    }))
    const result = trimLiveThreadTurnsInRpcResult({
      thread: {
        id: 'thread-live',
        turns,
      },
    }) as { threadTurnStartIndex: number; thread: { turns: Array<{ id: string }> } }

    expect(result.threadTurnStartIndex).toBe(11)
    expect(result.thread.turns.map((turn) => turn.id)).toEqual(['turn-11'])
  })

  it('preserves absolute pagination metadata when a later read falls back to a successful snapshot', () => {
    const successfulSnapshot = trimLiveThreadTurnsInRpcResult({
      thread: {
        id: 'thread-live',
        turns: Array.from({ length: 12 }, (_unused, index) => ({
          id: `turn-${index}`,
          status: index === 11 ? 'inProgress' : 'completed',
          items: [],
        })),
      },
    })
    const fallback = buildThreadLiveStateReadFailureFallback(
      'thread-live',
      successfulSnapshot,
      new Error('next read failed'),
      (_threadId, turns) => turns,
    ) as {
      threadTurnStartIndex: number
      hasMoreOlder: boolean
      conversationState: { turns: Array<{ id: string }> }
    }

    expect(fallback.threadTurnStartIndex).toBe(11)
    expect(fallback.hasMoreOlder).toBe(true)
    expect(fallback.conversationState.turns.map((turn) => turn.id)).toEqual(['turn-11'])
  })
})
