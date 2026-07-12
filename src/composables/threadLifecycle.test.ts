import { describe, expect, it } from 'vitest'
import { resolveTurnCompletionDisposition } from './threadLifecycle'

describe('turn completion disposition', () => {
  it.each([
    ['failed', true, false, true, false],
    ['completed', false, false, false, true],
    ['completed', false, true, false, false],
    ['failed', false, false, false, false],
    ['interrupted', false, false, false, false],
    ['declined', false, false, false, false],
    ['timeout', false, false, false, false],
  ])(
    'status=%s retry=%s selected=%s => running=%s unread=%s',
    (status, retry, selected, keepRunning, markUnread) => {
      expect(resolveTurnCompletionDisposition(status, retry, selected)).toEqual({
        keepRunning,
        markUnread,
      })
    },
  )
})
