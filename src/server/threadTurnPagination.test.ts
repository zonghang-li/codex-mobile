import { describe, expect, it, vi } from 'vitest'
import {
  isThreadTurnsListMethodNotFoundError,
  readNativeThreadTurnPage,
} from './threadTurnPagination.js'

function readId(value: unknown): string {
  return typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string'
    ? value.id
    : ''
}

describe('native thread turn pagination', () => {
  it('requests a bounded full descending page and returns it chronologically', async () => {
    const rpc = vi.fn(async () => ({
      data: [
        { id: 'turn-4', status: 'completed', items: [] },
        { id: 'turn-3', status: 'completed', items: [] },
      ],
      nextCursor: 'older-2',
      backwardsCursor: 'newer-4',
    }))

    const page = await readNativeThreadTurnPage(rpc, {
      threadId: 'thread-1',
      limit: 5,
    })

    expect(rpc).toHaveBeenCalledWith('thread/turns/list', {
      threadId: 'thread-1',
      cursor: null,
      limit: 5,
      sortDirection: 'desc',
      itemsView: 'full',
    })
    expect(page.turns.map(readId)).toEqual(['turn-3', 'turn-4'])
    expect(page.nextCursor).toBe('older-2')
    expect(page.backwardsCursor).toBe('newer-4')
  })

  it('forwards opaque cursors and clamps the requested page size', async () => {
    const rpc = vi.fn(async () => ({
      data: [],
      nextCursor: '',
      backwardsCursor: null,
    }))

    await readNativeThreadTurnPage(rpc, {
      threadId: 'thread-1',
      cursor: 'opaque+/= cursor',
      limit: 500,
    })

    expect(rpc).toHaveBeenCalledWith('thread/turns/list', {
      threadId: 'thread-1',
      cursor: 'opaque+/= cursor',
      limit: 50,
      sortDirection: 'desc',
      itemsView: 'full',
    })
  })

  it('rejects malformed app-server turn pages', async () => {
    await expect(readNativeThreadTurnPage(
      async () => ({ data: null }),
      { threadId: 'thread-1', limit: 0 },
    )).rejects.toThrow('thread/turns/list returned an invalid response')
  })

  it('classifies only JSON-RPC method-not-found failures as unsupported', () => {
    expect(isThreadTurnsListMethodNotFoundError(new Error('Method not found: thread/turns/list'))).toBe(true)
    expect(isThreadTurnsListMethodNotFoundError(new Error('Unknown method thread/turns/list'))).toBe(true)
    expect(isThreadTurnsListMethodNotFoundError(new Error('thread/turns/list timed out'))).toBe(false)
  })
})
