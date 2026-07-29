import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  applySessionSkillEnrichmentForRpc,
  buildThreadLiveStateReadFailureFallback,
  mergeSessionModelSettingsIntoThreadResult,
  prepareRpcProxyRequest,
  readSessionModelSettingsFromFile,
  readSessionModelSettingsFromLog,
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
      forceFreshThreadList: false,
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

  it('reads the latest session model and effort from turn_context metadata', () => {
    const raw = [
      JSON.stringify({
        type: 'session_meta',
        payload: {
          model: 'gpt-5.6-sol',
          model_provider: 'openai',
        },
      }),
      JSON.stringify({
        type: 'turn_context',
        payload: {
          model: 'gpt-5.5',
          effort: 'xhigh',
          collaboration_mode: {
            settings: {
              model: 'gpt-5.5',
              reasoning_effort: 'xhigh',
            },
          },
        },
      }),
    ].join('\n')

    expect(readSessionModelSettingsFromLog(raw)).toEqual({
      model: 'gpt-5.5',
      modelProvider: 'openai',
      reasoningEffort: 'xhigh',
    })
  })

  it('recovers the latest model and effort when later output exceeds the fixed tail window', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'codex-mobile-session-model-'))
    const sessionPath = join(tempDir, 'rollout.jsonl')
    try {
      await writeFile(sessionPath, [
        JSON.stringify({
          type: 'session_meta',
          payload: {
            model: 'gpt-5.6-sol',
            model_provider: 'openai',
          },
        }),
        JSON.stringify({
          type: 'turn_context',
          payload: {
            model: 'gpt-5.5',
            effort: 'xhigh',
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            output: 'x'.repeat(768 * 1024),
          },
        }),
      ].join('\n'), 'utf8')

      await expect(readSessionModelSettingsFromFile(sessionPath)).resolves.toEqual({
        model: 'gpt-5.5',
        modelProvider: 'openai',
        reasoningEffort: 'xhigh',
      })

      await appendFile(sessionPath, `\n${JSON.stringify({
        type: 'turn_context',
        payload: {
          model: 'gpt-5.6-sol',
          effort: 'max',
        },
      })}\n${JSON.stringify({
        type: 'response_item',
        payload: {
          output: 'y'.repeat(768 * 1024),
        },
      })}`, 'utf8')

      await expect(readSessionModelSettingsFromFile(sessionPath)).resolves.toEqual({
        model: 'gpt-5.6-sol',
        modelProvider: 'openai',
        reasoningEffort: 'max',
      })
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('treats latest session model settings as authoritative over stale app-server thread fields', () => {
    const result = {
      model: 'gpt-5.6-sol',
      modelProvider: 'openai',
      reasoningEffort: 'max',
      reasoning_effort: 'max',
      thread: {
        id: 'thread-1',
        model: 'gpt-5.6-sol',
        modelProvider: 'openai',
        reasoningEffort: 'max',
        reasoning_effort: 'max',
        turns: [],
      },
    }

    expect(mergeSessionModelSettingsIntoThreadResult(result, {
      model: 'gpt-5.5',
      modelProvider: 'openai',
      reasoningEffort: 'xhigh',
    })).toMatchObject({
      model: 'gpt-5.5',
      modelProvider: 'openai',
      reasoningEffort: 'xhigh',
      reasoning_effort: 'xhigh',
      thread: {
        model: 'gpt-5.5',
        modelProvider: 'openai',
        reasoningEffort: 'xhigh',
        reasoning_effort: 'xhigh',
      },
    })
  })

  it('keeps full thread detail history while pruning reasoning from non-active turns', () => {
    const turns = [
      {
        id: 'turn-0',
        status: 'completed',
        items: [
          { id: 'reasoning-0', type: 'reasoning', summary: ['old thinking'], content: [] },
          { id: 'message-0', type: 'agentMessage', text: 'old body' },
        ],
      },
      {
        id: 'turn-1',
        status: 'completed',
        items: [
          { id: 'reasoning-1', type: 'reasoning', summary: ['middle thinking'], content: [] },
          { id: 'message-1', type: 'agentMessage', text: 'middle body' },
        ],
      },
      {
        id: 'turn-2',
        status: 'inProgress',
        items: [
          { id: 'reasoning-2', type: 'reasoning', summary: ['live thinking'], content: [] },
          { id: 'message-2', type: 'agentMessage', text: 'live body' },
        ],
      },
    ]
    const result = trimThreadTurnsInRpcResult('thread/read', {
      threadTurnStartIndex: 0,
      thread: {
        id: 'thread-full-history',
        turns,
      },
    }) as { threadTurnStartIndex: number; thread: { turns: Array<{ id: string; items: Array<{ id: string }> }> } }

    expect(result.threadTurnStartIndex).toBe(0)
    expect(result.thread.turns.map((turn) => turn.id)).toEqual(['turn-0', 'turn-1', 'turn-2'])
    expect(result.thread.turns[0]?.items.map((item) => item.id)).toEqual(['message-0'])
    expect(result.thread.turns[1]?.items.map((item) => item.id)).toEqual(['message-1'])
    expect(result.thread.turns[2]?.items.map((item) => item.id)).toEqual(['reasoning-2', 'message-2'])
  })

  it('prunes reasoning from every turn when no turn is running', () => {
    const result = trimThreadTurnsInRpcResult('thread/read', {
      threadTurnStartIndex: 4,
      thread: {
        id: 'thread-completed',
        turns: [
          {
            id: 'turn-4',
            status: 'completed',
            items: [
              { id: 'reasoning-4', type: 'reasoning', summary: ['completed thinking'], content: [] },
              { id: 'message-4', type: 'agentMessage', text: 'completed body' },
            ],
          },
        ],
      },
    }) as { threadTurnStartIndex: number; thread: { turns: Array<{ id: string; items: Array<{ id: string }> }> } }

    expect(result.threadTurnStartIndex).toBe(4)
    expect(result.thread.turns.map((turn) => turn.id)).toEqual(['turn-4'])
    expect(result.thread.turns[0]?.items.map((item) => item.id)).toEqual(['message-4'])
  })

  it('keeps full live snapshot history while pruning reasoning outside the active turn', () => {
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
    const result = trimLiveThreadTurnsInRpcResult({
      threadTurnStartIndex: 0,
      thread: {
        id: 'thread-live',
        turns,
      },
    }) as { threadTurnStartIndex: number; thread: { turns: Array<{ id: string; items: Array<{ id: string }> }> } }

    expect(result.threadTurnStartIndex).toBe(0)
    expect(result.thread.turns).toHaveLength(12)
    expect(result.thread.turns[0]?.items.map((item) => item.id)).toEqual(['item-0'])
    expect(result.thread.turns[11]?.items.map((item) => item.id)).toEqual(['reasoning-11', 'item-11'])
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

    expect(fallback.threadTurnStartIndex).toBe(0)
    expect(fallback.hasMoreOlder).toBe(false)
    expect(fallback.conversationState.turns).toHaveLength(12)
    expect(fallback.conversationState.turns.at(-1)?.id).toBe('turn-11')
  })

  it('keeps full cached detail when the first live read fails', () => {
    const cachedDetail = trimThreadTurnsInRpcResult('thread/read', {
      thread: {
        id: 'thread-live',
        turns: Array.from({ length: 12 }, (_unused, index) => ({
          id: `turn-${index}`,
          status: index === 11 ? 'inProgress' : 'completed',
          items: [],
        })),
      },
    }) as { threadTurnStartIndex: number; thread: { turns: Array<{ id: string }> } }
    expect(cachedDetail.threadTurnStartIndex).toBeUndefined()
    expect(cachedDetail.thread.turns).toHaveLength(12)

    const fallback = buildThreadLiveStateReadFailureFallback(
      'thread-live',
      cachedDetail,
      new Error('first live read failed'),
      (_threadId, turns) => turns,
    ) as {
      threadTurnStartIndex: number
      hasMoreOlder: boolean
      conversationState: { turns: Array<{ id: string }> }
    }

    expect(fallback.threadTurnStartIndex).toBe(0)
    expect(fallback.hasMoreOlder).toBe(false)
    expect(fallback.conversationState.turns).toHaveLength(12)
    expect(fallback.conversationState.turns.at(-1)?.id).toBe('turn-11')
  })
})
