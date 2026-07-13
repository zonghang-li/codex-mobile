import { describe, expect, it, vi } from 'vitest'
import {
  applyExternalRuntimeTakeover,
  canApplyAttachmentMutation,
  canApplyThreadUiMutation,
} from './externalThreadRuntimeUi'

describe('external thread runtime UI guards', () => {
  it.each([
    [undefined, true],
    ['idle', true],
    ['local', true],
    ['external', false],
  ] as const)('allows UI mutation for ownership %s: %s', (ownership, expected) => {
    expect(canApplyThreadUiMutation(ownership)).toBe(expected)
  })

  it('requires both a current attachment session and mutable ownership', () => {
    expect(canApplyAttachmentMutation('local', 4, 4)).toBe(true)
    expect(canApplyAttachmentMutation('idle', 4, 4)).toBe(true)
    expect(canApplyAttachmentMutation('local', 3, 4)).toBe(false)
    expect(canApplyAttachmentMutation('external', 4, 4)).toBe(false)
  })

  it('cancels dictation and invalidates attachments only on external takeover', () => {
    const cancelDictation = vi.fn()
    const invalidateAttachments = vi.fn()
    const effects = { cancelDictation, invalidateAttachments }

    expect(applyExternalRuntimeTakeover('idle', 'local', effects)).toBe(false)
    expect(applyExternalRuntimeTakeover('external', 'external', effects)).toBe(false)
    expect(cancelDictation).not.toHaveBeenCalled()
    expect(invalidateAttachments).not.toHaveBeenCalled()

    expect(applyExternalRuntimeTakeover('local', 'external', effects)).toBe(true)
    expect(cancelDictation).toHaveBeenCalledTimes(1)
    expect(invalidateAttachments).toHaveBeenCalledTimes(1)
  })
})
