import { describe, expect, it } from 'vitest'
import type { UiMessage } from '../../types/codex'
import {
  deriveUserMessagePresentation,
  parseCodexDelegationInput,
} from './userMessagePresentation'

function userMessage(text: string): UiMessage {
  return {
    id: 'user-1',
    role: 'user',
    text,
  }
}

describe('parseCodexDelegationInput', () => {
  it('extracts only the delegation input body and strips transport tags', () => {
    const raw = [
      '<codex_delegation>',
      '<source_thread_id>019f980e-13bd-75e1-b962-2be0ff2473b7</source_thread_id>',
      '<input>本会话是“跨 LAN 分布式架构续（接力）”。',
      '请接替旧任务继续。</input>',
      '</codex_delegation>',
    ].join('\n')

    expect(parseCodexDelegationInput(raw)).toBe('本会话是“跨 LAN 分布式架构续（接力）”。\n请接替旧任务继续。')
  })

  it('decodes escaped delegation envelopes before extracting the body', () => {
    const escaped = [
      '&lt;codex_delegation&gt;',
      '&lt;source_thread_id&gt;019fb203-95f6-73f1-b452-686043ad5e43&lt;/source_thread_id&gt;',
      '&lt;input&gt;PLAN02A_RESUME',
      'Task2 is superseded where it conflicts...&lt;/input&gt;',
      '&lt;/codex_delegation&gt;',
    ].join('\n')

    expect(parseCodexDelegationInput(escaped)).toBe('PLAN02A_RESUME\nTask2 is superseded where it conflicts...')
  })

  it('returns null for normal user messages', () => {
    expect(parseCodexDelegationInput('继续')).toBeNull()
  })
})

describe('deriveUserMessagePresentation', () => {
  it('collapses long Codex delegation prompts by default', () => {
    const body = '本会话是“跨 LAN 分布式架构续（接力）”。'.repeat(12)
    const presentation = deriveUserMessagePresentation(
      userMessage(`<codex_delegation><source_thread_id>old</source_thread_id><input>${body}</input></codex_delegation>`),
      { expanded: false },
    )

    expect(presentation.isDelegation).toBe(true)
    expect(presentation.label).toBe('Sent by Codex from another chat')
    expect(presentation.isCollapsible).toBe(true)
    expect(presentation.isCollapsed).toBe(true)
    expect(presentation.text).not.toContain('<codex_delegation>')
    expect(presentation.text).not.toContain('<input>')
    expect(presentation.text.length).toBeLessThan(body.length)
  })

  it('shows the full cleaned body after expansion', () => {
    const body = '本会话是“跨 LAN 分布式架构续（接力）”。'.repeat(12)
    const presentation = deriveUserMessagePresentation(
      userMessage(`<codex_delegation><source_thread_id>old</source_thread_id><input>${body}</input></codex_delegation>`),
      { expanded: true },
    )

    expect(presentation.isDelegation).toBe(true)
    expect(presentation.isCollapsible).toBe(true)
    expect(presentation.isCollapsed).toBe(false)
    expect(presentation.text).toBe(body)
  })

  it('does not expose html entities in collapsed escaped delegation bubbles', () => {
    const escaped = [
      '&lt;codex_delegation&gt;',
      '&lt;source_thread_id&gt;old&lt;/source_thread_id&gt;',
      '&lt;input&gt;',
      'PLAN02A_RESUME '.repeat(20),
      '&lt;/input&gt;',
      '&lt;/codex_delegation&gt;',
    ].join('\n')

    const presentation = deriveUserMessagePresentation(userMessage(escaped), { expanded: false })

    expect(presentation.isDelegation).toBe(true)
    expect(presentation.label).toBe('Sent by Codex from another chat')
    expect(presentation.text).not.toContain('&lt;')
    expect(presentation.text).not.toContain('&gt;')
    expect(presentation.text).not.toContain('<codex_delegation>')
    expect(presentation.text).toContain('PLAN02A_RESUME')
  })
})
