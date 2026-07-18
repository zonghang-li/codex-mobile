import { describe, expect, it } from 'vitest'
import {
  NTFY_THREAD_LABEL_MAX_LENGTH,
  composeNtfyNotificationTitle,
  isValidNtfyNotificationTitle,
  resolveNtfyThreadLabel,
} from './ntfyTitle'

describe('ntfy conversation titles', () => {
  it('uses the first normalized non-empty title candidate', () => {
    expect(resolveNtfyThreadLabel([
      '  桌面\n  会话\u0000名称  ',
      'secondary',
    ], 'thread-12345678')).toBe('桌面 会话 名称')
  })

  it('truncates labels by Unicode code point', () => {
    expect(resolveNtfyThreadLabel([
      '😀'.repeat(NTFY_THREAD_LABEL_MAX_LENGTH + 10),
    ], 'thread-12345678')).toBe('😀'.repeat(NTFY_THREAD_LABEL_MAX_LENGTH))
  })

  it('falls back to the final eight thread-ID code points', () => {
    expect(resolveNtfyThreadLabel(['\n\u0000'], 'thread-12345678'))
      .toBe('未命名会话（12345678）')
  })

  it.each([
    ['Codex 任务完成', 'Codex 任务完成：修复状态同步'],
    ['Codex 任务失败', 'Codex 任务失败：修复状态同步'],
    ['Codex 任务已中断', 'Codex 任务已中断：修复状态同步'],
  ] as const)('composes %s with the label', (prefix, expected) => {
    expect(composeNtfyNotificationTitle(prefix, '修复状态同步')).toBe(expected)
    expect(isValidNtfyNotificationTitle(expected)).toBe(true)
  })

  it.each([
    'Codex unknown：会话',
    'Codex 任务完成：',
    'Codex 任务完成：bad\nname',
    `Codex 任务完成：${'A'.repeat(NTFY_THREAD_LABEL_MAX_LENGTH + 1)}`,
  ])('rejects malformed durable title %j', (title) => {
    expect(isValidNtfyNotificationTitle(title)).toBe(false)
  })

  it.each([
    'Codex 任务完成',
    'Codex 任务失败',
    'Codex 任务已中断',
  ])('accepts legacy durable title %s', (title) => {
    expect(isValidNtfyNotificationTitle(title)).toBe(true)
  })
})
