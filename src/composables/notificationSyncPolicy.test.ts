import { describe, expect, it } from 'vitest'
import type { RpcNotification } from '../api/codexRpcClient'
import { shouldRefreshMessagesForNotification } from './notificationSyncPolicy'

function notification(method: string, itemType?: string): RpcNotification {
  return {
    method,
    params: itemType
      ? { threadId: 'thread-parent', item: { id: 'item-1', type: itemType } }
      : { threadId: 'thread-parent' },
    atIso: '2026-07-26T00:00:00.000Z',
  }
}

describe('shouldRefreshMessagesForNotification', () => {
  it('keeps existing authoritative turn refresh events', () => {
    expect(shouldRefreshMessagesForNotification(notification('turn/started'))).toBe(true)
    expect(shouldRefreshMessagesForNotification(notification('turn/completed'))).toBe(true)
    expect(shouldRefreshMessagesForNotification(notification('error'))).toBe(true)
  })

  it.each([
    ['item/started', 'subAgentActivity'],
    ['item/completed', 'subAgentActivity'],
    ['item/started', 'collabAgentToolCall'],
    ['item/completed', 'collabAgentToolCall'],
  ])('refreshes messages for %s %s lifecycle events', (method, itemType) => {
    expect(shouldRefreshMessagesForNotification(notification(method, itemType))).toBe(true)
  })

  it('does not add an authoritative refresh for unrelated item lifecycle events', () => {
    expect(shouldRefreshMessagesForNotification(notification('item/started', 'commandExecution'))).toBe(false)
    expect(shouldRefreshMessagesForNotification(notification('item/completed', 'agentMessage'))).toBe(false)
  })
})
