import { describe, expect, it, vi } from 'vitest'
import {
  applySessionSkillEnrichmentForRpc,
  prepareRpcProxyRequest,
  shouldStoreThreadReadSnapshotForRpc,
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
})
