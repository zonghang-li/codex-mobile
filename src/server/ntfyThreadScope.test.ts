import { describe, expect, it } from 'vitest'
import { classifyNtfyThreadScope } from './ntfyThreadScope'

describe('classifyNtfyThreadScope', () => {
  it.each(['cli', 'vscode', 'exec', 'appServer'] as const)(
    'accepts parentless %s threads',
    (source) => {
      expect(classifyNtfyThreadScope({ parentThreadId: null, source })).toBe('topLevel')
    },
  )

  it.each([
    { parent_thread_id: 'parent-1', source: 'vscode' },
    { parentThreadId: 'parent-1', source: 'appServer' },
    { parentThreadId: 42, parent_thread_id: 'parent-1', source: 'vscode' },
    { source: { subagent: { thread_spawn: {} } } },
    { source: { subAgent: 'review' } },
    { parentThreadId: 42, source: { subagent: 'review' } },
  ])('rejects child evidence %#', (value) => {
    expect(classifyNtfyThreadScope(value)).toBe('child')
  })

  it.each([
    null,
    {},
    { source: 'unknown' },
    { source: { custom: 'desktop-future' } },
    { source: 'vscode', parentThreadId: 42 },
    { source: ['vscode'] },
  ])('fails closed for inconclusive evidence %#', (value) => {
    expect(classifyNtfyThreadScope(value)).toBe('unknown')
  })
})
