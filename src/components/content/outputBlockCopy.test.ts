import { describe, expect, it } from 'vitest'
import { serializeMessageBlockForCopy } from './outputBlockCopy'

describe('output block clipboard serialization', () => {
  it.each([
    [{ kind: 'paragraph', value: 'Plain **source** text' } as const, 'Plain **source** text'],
    [{ kind: 'heading', level: 2, value: 'Heading source' } as const, 'Heading source'],
    [{ kind: 'blockquote', value: 'Quoted source' } as const, 'Quoted source'],
  ])('copies textual blocks as their original plain source', (block, expected) => {
    expect(serializeMessageBlockForCopy(block)).toBe(expected)
  })

  it('copies code without fences or language labels', () => {
    expect(serializeMessageBlockForCopy({ kind: 'codeBlock', language: 'ts', value: 'const n = 1' }))
      .toBe('const n = 1')
  })

  it('preserves unordered and ordered list markers, blank lines, and nested blocks', () => {
    expect(serializeMessageBlockForCopy({
      kind: 'unorderedList',
      items: [
        {
          paragraphs: ['parent', 'second paragraph'],
          children: [{
            kind: 'orderedList',
            start: 3,
            items: [{ paragraphs: ['child'] }],
          }],
        },
        { paragraphs: ['next'] },
      ],
    })).toBe('- parent\n\nsecond paragraph\n\n3. child\n- next')
  })

  it('preserves list and task markers', () => {
    expect(serializeMessageBlockForCopy({
      kind: 'taskList',
      items: [
        { text: 'done', checked: true },
        { text: 'next', checked: false },
      ],
    })).toBe('- [x] done\n- [ ] next')
  })

  it('copies tables as tab-separated rows', () => {
    expect(serializeMessageBlockForCopy({
      kind: 'table',
      headers: ['Name', 'Value'],
      rows: [['alpha', '1']],
      alignments: [null, null],
    })).toBe('Name\tValue\nalpha\t1')
  })

  it('returns empty text for thematic breaks and images', () => {
    expect(serializeMessageBlockForCopy({ kind: 'thematicBreak' })).toBe('')
    expect(serializeMessageBlockForCopy({ kind: 'image', url: '/image.png', alt: 'image', markdown: '![]()' })).toBe('')
  })
})
