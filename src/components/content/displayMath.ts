export type DisplayMathSpan =
  | { kind: 'text'; value: string }
  | { kind: 'math'; value: string; source: string }

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) {
    slashCount += 1
  }
  return slashCount % 2 === 1
}

function markerRunLength(text: string, index: number, marker: '`' | '~'): number {
  let cursor = index
  while (text[cursor] === marker) cursor += 1
  return cursor - index
}

export function splitDisplayMathSpans(text: string): DisplayMathSpan[] {
  if (!text.includes('\\[')) return [{ kind: 'text', value: text }]

  const spans: DisplayMathSpan[] = []
  let textStart = 0
  let cursor = 0
  let lineStart = true
  let inlineTicks = 0
  let fence: { marker: '`' | '~'; length: number } | null = null

  const emitText = (end: number): void => {
    if (end > textStart) spans.push({ kind: 'text', value: text.slice(textStart, end) })
  }

  while (cursor < text.length) {
    if (lineStart && inlineTicks === 0) {
      const line = text.slice(cursor).match(/^ {0,3}(`{3,}|~{3,})/u)
      if (line) {
        const marker = line[1][0] as '`' | '~'
        const length = line[1].length
        if (!fence) fence = { marker, length }
        else if (fence.marker === marker && length >= fence.length) fence = null

        const newline = text.indexOf('\n', cursor)
        cursor = newline === -1 ? text.length : newline + 1
        lineStart = true
        continue
      }
    }

    if (!fence && text[cursor] === '`' && !isEscaped(text, cursor)) {
      const run = markerRunLength(text, cursor, '`')
      if (inlineTicks === 0) inlineTicks = run
      else if (inlineTicks === run) inlineTicks = 0
      cursor += run
      lineStart = false
      continue
    }

    if (!fence && inlineTicks === 0 && text.startsWith('\\[', cursor) && !isEscaped(text, cursor)) {
      let close = cursor + 2
      while (close < text.length && !(text.startsWith('\\]', close) && !isEscaped(text, close))) {
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
        lineStart = cursor === 0 || text[cursor - 1] === '\n'
        continue
      }
    }

    lineStart = text[cursor] === '\n'
    cursor += 1
  }

  emitText(text.length)
  return spans.length > 0 ? spans : [{ kind: 'text', value: text }]
}
