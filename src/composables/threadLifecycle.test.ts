import { describe, expect, it } from 'vitest'
import { resolveTurnCompletionDisposition } from './threadLifecycle'

describe('turn completion disposition', () => {
  it.each([
    ['failed', true, false, true, true, false],
    ['completed', false, false, true, false, true],
    ['completed', false, true, true, false, false],
    ['failed', false, false, true, false, false],
    ['interrupted', false, false, true, false, false],
    ['declined', false, false, true, false, false],
    ['timeout', false, false, true, false, false],
  ])(
    'status=%s retry=%s selected=%s => owns=%s running=%s unread=%s',
    (status, retry, selected, ownsActiveLease, keepRunning, markUnread) => {
      expect(resolveTurnCompletionDisposition(status, retry, selected)).toEqual({
        ownsActiveLease,
        keepRunning,
        markUnread,
      })
    },
  )

  it('keeps running when a stale turn completes', () => {
    expect(resolveTurnCompletionDisposition('completed', false, true, 'turn-b', 'turn-a')).toEqual({
      ownsActiveLease: false,
      keepRunning: true,
      markUnread: false,
    })
  })

  it('stops running when the active turn completes', () => {
    expect(resolveTurnCompletionDisposition('completed', false, true, 'turn-b', 'turn-b')).toEqual({
      ownsActiveLease: true,
      keepRunning: false,
      markUnread: false,
    })
  })

  it('owns an unleased completion and marks it unread when unselected', () => {
    expect(resolveTurnCompletionDisposition('completed', false, false, '', 'turn-a')).toEqual({
      ownsActiveLease: true,
      keepRunning: false,
      markUnread: true,
    })
  })
})
