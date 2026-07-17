import { describe, expect, it } from 'vitest'
import { splitDisplayMathSpans } from './displayMath'

describe('splitDisplayMathSpans', () => {
  it('extracts single-line and multiline display environments in order', () => {
    expect(splitDisplayMathSpans('Before \\[x^2\\] after\n\\[\n\\frac{1}{2}\n\\]')).toEqual([
      { kind: 'text', value: 'Before ' },
      { kind: 'math', value: 'x^2', source: '\\[x^2\\]' },
      { kind: 'text', value: ' after\n' },
      { kind: 'math', value: '\\frac{1}{2}', source: '\\[\n\\frac{1}{2}\n\\]' },
    ])
  })

  it('keeps multiple formulas distinct', () => {
    expect(splitDisplayMathSpans('\\[a\\]\ntext\n\\[b\\]')).toEqual([
      { kind: 'math', value: 'a', source: '\\[a\\]' },
      { kind: 'text', value: '\ntext\n' },
      { kind: 'math', value: 'b', source: '\\[b\\]' },
    ])
  })

  it('keeps escaped, inline-code, and unmatched delimiters literal', () => {
    const input = 'escaped \\\\[x\\\\] and inline `\\[y\\]` and unmatched \\[z'
    expect(splitDisplayMathSpans(input)).toEqual([{ kind: 'text', value: input }])
  })

  it('keeps backtick and tilde fence examples literal while parsing later math', () => {
    const input = ['```text', '\\[x\\]', '```', '~~~', '\\[y\\]', '~~~', '\\[z\\]'].join('\n')
    expect(splitDisplayMathSpans(input)).toEqual([
      { kind: 'text', value: ['```text', '\\[x\\]', '```', '~~~', '\\[y\\]', '~~~', ''].join('\n') },
      { kind: 'math', value: 'z', source: '\\[z\\]' },
    ])
  })

  it('leaves unsupported syntaxes literal', () => {
    const input = '$a$ $$b$$ \\(c\\) \\begin{equation}d\\end{equation}'
    expect(splitDisplayMathSpans(input)).toEqual([{ kind: 'text', value: input }])
  })

  it('never drops incomplete trailing source', () => {
    const input = 'prefix \\[x + 1'
    expect(splitDisplayMathSpans(input).map((span) => span.kind === 'text' ? span.value : span.source).join('')).toBe(input)
  })
})
