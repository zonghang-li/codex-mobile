import { describe, expect, it } from 'vitest'
import { augmentThreadReadWithNotificationTitle } from './codexAppServerBridge'

describe('notifier conversation title enrichment', () => {
  it('copies a nested thread result and adds the cached title', () => {
    const thread = { id: 'thread-1', turns: [] }
    const result = { thread }
    const enriched = augmentThreadReadWithNotificationTitle(result, 'Renamed conversation')

    expect(enriched).toEqual({
      thread: { id: 'thread-1', turns: [], notificationTitle: 'Renamed conversation' },
    })
    expect(enriched).not.toBe(result)
    expect((enriched as { thread: unknown }).thread).not.toBe(thread)
    expect(result).toEqual({ thread })
  })

  it('returns malformed results and empty titles unchanged', () => {
    const result = { thread: { id: 'thread-1', turns: [] } }
    expect(augmentThreadReadWithNotificationTitle(result, '  ')).toBe(result)
    expect(augmentThreadReadWithNotificationTitle({ thread: null }, 'Title'))
      .toEqual({ thread: null })
  })
})
