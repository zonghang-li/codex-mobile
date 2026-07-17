export type InlineMathSpan =
  | { kind: 'text'; value: string }
  | { kind: 'math'; value: string; source: string }

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) {
    slashCount += 1
  }
  return slashCount % 2 === 1
}

function markerRunLength(text: string, index: number): number {
  let cursor = index
  while (text[cursor] === '`') cursor += 1
  return cursor - index
}

export function splitInlineMathSpans(text: string): InlineMathSpan[] {
  if (!text.includes('\\(')) return [{ kind: 'text', value: text }]

  const spans: InlineMathSpan[] = []
  let cursor = 0
  let textStart = 0
  let inlineTicks = 0

  const emitText = (end: number): void => {
    if (end > textStart) spans.push({ kind: 'text', value: text.slice(textStart, end) })
  }

  while (cursor < text.length) {
    if (text[cursor] === '`' && !isEscaped(text, cursor)) {
      const run = markerRunLength(text, cursor)
      if (inlineTicks === 0) inlineTicks = run
      else if (inlineTicks === run) inlineTicks = 0
      cursor += run
      continue
    }

    if (inlineTicks === 0 && text.startsWith('\\(', cursor) && !isEscaped(text, cursor)) {
      let close = cursor + 2
      while (close < text.length && !(text.startsWith('\\)', close) && !isEscaped(text, close))) {
        close += 1
      }
      if (close < text.length) {
        emitText(cursor)
        const source = text.slice(cursor, close + 2)
        spans.push({
          kind: 'math',
          value: text.slice(cursor + 2, close).trim(),
          source,
        })
        cursor = close + 2
        textStart = cursor
        continue
      }
    }

    cursor += 1
  }

  emitText(text.length)
  return spans.length > 0 ? spans : [{ kind: 'text', value: text }]
}
