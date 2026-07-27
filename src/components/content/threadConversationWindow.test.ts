import { describe, expect, it } from 'vitest'
import {
  clampThreadRenderWindowStart,
  earlierThreadRenderWindowStart,
  filterRenderableThreadMessages,
  latestThreadRenderWindowStart,
} from './threadConversationWindow'

describe('thread conversation render window', () => {
  it('normalizes stale starts to zero so loaded history stays visible', () => {
    expect(clampThreadRenderWindowStart(140, 94)).toBe(0)
  })

  it('uses zero for empty lists and invalid negative starts', () => {
    expect(clampThreadRenderWindowStart(20, 0)).toBe(0)
    expect(clampThreadRenderWindowStart(-4, 10)).toBe(0)
  })

  it('does not hide already-loaded older messages behind a render window', () => {
    expect(earlierThreadRenderWindowStart(140, 94)).toBe(0)
  })

  it('keeps the full loaded history visible when jumping to latest', () => {
    expect(latestThreadRenderWindowStart(94)).toBe(0)
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
