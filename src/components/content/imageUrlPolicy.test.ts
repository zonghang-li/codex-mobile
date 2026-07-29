import { describe, expect, it } from 'vitest'
import { safeImageFallbackHref } from './imageUrlPolicy'

describe('safeImageFallbackHref', () => {
  it.each([
    'javascript:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html,<script>alert(1)</script>',
    'data:image/svg+xml,<svg onload="alert(1)"/>',
    '//attacker.example/image.png',
  ])('rejects unsafe failed-image target %s', (value) => {
    expect(safeImageFallbackHref(value)).toBe('')
  })

  it.each([
    'https://example.com/image.png',
    'http://localhost:5173/image.png',
    'blob:https://example.com/1234',
    '/codex-local-image?path=%2Ftmp%2Fimage.png',
    './relative/image.webp',
    'data:image/png;base64,aGVsbG8=',
  ])('allows expected failed-image target %s', (value) => {
    expect(safeImageFallbackHref(value)).toBe(value)
  })
})
