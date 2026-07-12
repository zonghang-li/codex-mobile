import { describe, expect, it } from 'vitest'
import {
  clampThreadRenderWindowStart,
  earlierThreadRenderWindowStart,
  filterRenderableThreadMessages,
  latestThreadRenderWindowStart,
} from './threadConversationWindow'

describe('thread conversation render window', () => {
  it('clamps a stale oversized start so a non-empty list remains visible', () => {
    expect(clampThreadRenderWindowStart(140, 94)).toBe(93)
  })

  it('uses zero for empty lists and invalid negative starts', () => {
    expect(clampThreadRenderWindowStart(20, 0)).toBe(0)
    expect(clampThreadRenderWindowStart(-4, 10)).toBe(0)
  })

  it('expands from the effective bounded start in one click', () => {
    expect(earlierThreadRenderWindowStart(140, 94)).toBe(63)
  })

  it('keeps the latest render window bounded to fifty messages', () => {
    expect(latestThreadRenderWindowStart(94)).toBe(44)
    expect(latestThreadRenderWindowStart(20)).toBe(0)
  })

  it('keeps a visible anchor when a stale start ends on hidden file-change metadata', () => {
    const messages = [
      { id: 'earlier-visible-anchor' },
      { id: 'hidden-file-change-metadata' },
    ]
    const renderableMessages = filterRenderableThreadMessages(
      messages,
      new Set(['hidden-file-change-metadata']),
    )
    const effectiveStart = clampThreadRenderWindowStart(140, renderableMessages.length)

    expect(renderableMessages.slice(effectiveStart)).toEqual([{ id: 'earlier-visible-anchor' }])
  })
})
