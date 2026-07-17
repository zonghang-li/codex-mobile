import { describe, expect, it, vi } from 'vitest'
import { tryRenderDisplayMathToHtml, tryRenderMathToHtml } from './displayMathRenderer'

describe('tryRenderDisplayMathToHtml', () => {
  it('uses locked safe display options', () => {
    const renderer = vi.fn(() => '<span class="katex">x</span>')
    expect(tryRenderDisplayMathToHtml(renderer, 'x')).toContain('katex')
    expect(renderer).toHaveBeenCalledWith('x', {
      displayMode: true,
      throwOnError: true,
      trust: false,
      strict: 'warn',
    })
  })

  it('uses inline mode without relaxing safe options', () => {
    const renderer = vi.fn(() => '<span class="katex">x</span>')
    expect(tryRenderMathToHtml(renderer, 'x', false)).toContain('katex')
    expect(renderer).toHaveBeenCalledWith('x', {
      displayMode: false,
      throwOnError: true,
      trust: false,
      strict: 'warn',
    })
  })

  it('returns null when unavailable or invalid', () => {
    expect(tryRenderDisplayMathToHtml(null, 'x')).toBeNull()
    expect(tryRenderDisplayMathToHtml(() => {
      throw new Error('invalid')
    }, '\\bad{')).toBeNull()
  })
})
