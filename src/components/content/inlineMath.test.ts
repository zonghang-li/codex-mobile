import { describe, expect, it } from 'vitest'
import { splitInlineMathSpans } from './inlineMath'

describe('splitInlineMathSpans', () => {
  it('extracts inline formulas while preserving source order', () => {
    expect(splitInlineMathSpans('Energy \\(E=mc^2\\), then \\(x^2\\).')).toEqual([
      { kind: 'text', value: 'Energy ' },
      { kind: 'math', value: 'E=mc^2', source: '\\(E=mc^2\\)' },
      { kind: 'text', value: ', then ' },
      { kind: 'math', value: 'x^2', source: '\\(x^2\\)' },
      { kind: 'text', value: '.' },
    ])
  })

  it('keeps code, escaped, and unmatched delimiters literal', () => {
    const input = 'code `\\(x\\)` escaped \\\\(y\\\\) unmatched \\(z'
    expect(splitInlineMathSpans(input)).toEqual([{ kind: 'text', value: input }])
  })

  it('preserves mixed display delimiters as text for the block scanner', () => {
    const input = '\\[a\\] and \\(b\\)'
    expect(splitInlineMathSpans(input)).toEqual([
      { kind: 'text', value: '\\[a\\] and ' },
      { kind: 'math', value: 'b', source: '\\(b\\)' },
    ])
  })

  it('keeps unsupported dollar syntax literal', () => {
    const input = '$a$ $$b$$'
    expect(splitInlineMathSpans(input)).toEqual([{ kind: 'text', value: input }])
  })
})
