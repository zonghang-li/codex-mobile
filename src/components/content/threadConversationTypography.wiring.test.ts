import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const conversationSource = readFileSync(
  new URL('./ThreadConversation.vue', import.meta.url),
  'utf8',
)
const globalStyleSource = readFileSync(
  new URL('../../style.css', import.meta.url),
  'utf8',
)
const composerSource = readFileSync(
  new URL('./ThreadComposer.vue', import.meta.url),
  'utf8',
)

describe('mobile Codex typography wiring', () => {
  it('uses the Codex client system font stack globally', () => {
    expect(globalStyleSource).toContain('font-family:')
    expect(globalStyleSource).toContain('-apple-system')
    expect(globalStyleSource).toContain('"SF Pro Text"')
    expect(globalStyleSource).toContain('"PingFang SC"')
    expect(globalStyleSource).toContain('"Segoe UI"')
  })

  it('uses compact readable sizes for conversation and activity rows', () => {
    expect(conversationSource).toContain('@apply m-0 text-[15px] leading-6 whitespace-pre-wrap')
    expect(conversationSource).toContain('@apply m-0 pl-5 text-[15px] leading-6')
    expect(conversationSource).toContain('text-[14px] font-medium leading-[22px]')
    expect(conversationSource).toContain('text-[13px] font-medium leading-5')
  })

  it('keeps minimum widths bounded and the composer at the iOS-safe 16px size', () => {
    expect(conversationSource).toContain('.codex-activity-stack')
    expect(conversationSource).toContain('@apply min-w-0;')
    expect(conversationSource).toContain('@apply min-w-0 flex-1')
    expect(composerSource).toContain('text-base leading-6')
  })
})
