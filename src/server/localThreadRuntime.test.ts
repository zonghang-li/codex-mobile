import { describe, expect, it } from 'vitest'
import { LocalThreadRuntimeLedger } from './localThreadRuntime'

describe('LocalThreadRuntimeLedger', () => {
  it('records a start and removes only its matching completion', () => {
    const ledger = new LocalThreadRuntimeLedger()
    ledger.record({
      method: 'turn/started',
      params: { threadId: 'thread-a', turn: { id: 'turn-a' } },
    })

    expect(ledger.getRunning('thread-a')).toEqual({
      threadId: 'thread-a',
      turnId: 'turn-a',
    })

    ledger.record({
      method: 'turn/completed',
      params: { threadId: 'thread-a', turn: { id: 'turn-a' } },
    })

    expect(ledger.getRunning('thread-a')).toBeNull()
  })

  it('does not let an older completion clear a newer turn', () => {
    const ledger = new LocalThreadRuntimeLedger()
    ledger.record({
      method: 'turn/started',
      params: { threadId: 'thread-a', turn: { id: 'turn-old' } },
    })
    ledger.record({
      method: 'turn/started',
      params: { threadId: 'thread-a', turn: { id: 'turn-new' } },
    })
    ledger.record({
      method: 'turn/completed',
      params: { threadId: 'thread-a', turn: { id: 'turn-old' } },
    })

    expect(ledger.getRunning('thread-a')).toEqual({
      threadId: 'thread-a',
      turnId: 'turn-new',
    })
  })

  it('ignores malformed lifecycle notifications and clears on disposal', () => {
    const ledger = new LocalThreadRuntimeLedger()
    ledger.record({
      method: 'turn/started',
      params: { threadId: '', turn: { id: 'turn-a' } },
    })
    ledger.record({
      method: 'item/started',
      params: { threadId: 'thread-a', turnId: 'turn-a' },
    })

    expect(ledger.getRunning('thread-a')).toBeNull()

    ledger.record({
      method: 'turn/started',
      params: { threadId: 'thread-a', turn: { id: 'turn-a' } },
    })
    ledger.clear()

    expect(ledger.getRunning('thread-a')).toBeNull()
  })
})
