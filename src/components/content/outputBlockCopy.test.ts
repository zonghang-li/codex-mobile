import { describe, expect, it } from 'vitest'
import {
  messageBlockCopyLabel,
  messageBlockCopyText,
  serializeMessageBlockForCopy,
} from './outputBlockCopy'

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
            items: [{
              paragraphs: ['child'],
              children: [{
                kind: 'unorderedList',
                items: [{ paragraphs: ['grandchild'] }],
              }],
            }],
          }],
        },
        { paragraphs: ['next'] },
      ],
    })).toBe('- parent\n\n  second paragraph\n\n  3. child\n\n    - grandchild\n- next')
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

  it('only exposes structured output payloads and labels persisted reasoning and errors', () => {
    const paragraph = { kind: 'paragraph', value: 'visible summary' } as const

    expect(messageBlockCopyText({ role: 'user' }, paragraph)).toBe('')
    expect(messageBlockCopyText({ role: 'assistant', messageType: 'reasoning' }, paragraph)).toBe('visible summary')
    expect(messageBlockCopyLabel({ role: 'assistant', messageType: 'reasoning' })).toBe('Copy reasoning')
    expect(messageBlockCopyLabel({ role: 'system', messageType: 'turnError' })).toBe('Copy error')
  })
})
