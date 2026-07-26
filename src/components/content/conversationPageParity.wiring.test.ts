import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(new URL('../../App.vue', import.meta.url), 'utf8')
const conversationSource = readFileSync(new URL('./ThreadConversation.vue', import.meta.url), 'utf8')
const footerSource = readFileSync(new URL('./ConversationRunFooter.vue', import.meta.url), 'utf8')
const composerSource = readFileSync(new URL('./ThreadComposer.vue', import.meta.url), 'utf8')
const globalStyleSource = readFileSync(new URL('../../style.css', import.meta.url), 'utf8')

describe('current conversation page desktop parity wiring', () => {
  it('keeps the active status footer directly between the conversation and composer', () => {
    const selectedThreadTemplate = appSource.slice(
      appSource.indexOf('<div class="content-thread">'),
      appSource.indexOf('</template>', appSource.indexOf('<div class="content-thread">')),
    )

    expect(selectedThreadTemplate).toMatch(
      /<ThreadConversation[\s\S]*<ConversationRunFooter[\s\S]*<ThreadComposer/u,
    )
  })

  it('uses scoped Codex conversation font tokens', () => {
    expect(appSource).toContain('--codex-conversation-font:')
    expect(appSource).toContain('--codex-conversation-mono:')
    expect(conversationSource).toContain('font-family: var(--codex-conversation-font)')
    expect(conversationSource).toContain('font-family: var(--codex-conversation-mono)')
  })

  it('bounds every current-page surface at narrow mobile widths', () => {
    expect(appSource).toMatch(/\.content-root\s*\{[^}]*overflow-x:\s*hidden/su)
    expect(appSource).toMatch(/\.content-grid\s*\{[^}]*min-width:\s*0/su)
    expect(appSource).toMatch(/\.composer-with-queue\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%/su)
    expect(footerSource).toMatch(/\.conversation-run-footer-pill\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%/su)
    expect(footerSource).toMatch(/\.conversation-goal-strip\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%/su)
    expect(footerSource).toMatch(/\.conversation-goal-objective\s*\{[^}]*text-overflow:\s*ellipsis/su)
    expect(composerSource).toMatch(/\.thread-composer-controls\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%/su)
    expect(conversationSource).toMatch(/\.message-code-block\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%/su)
    expect(conversationSource).toMatch(/\.message-file-link\s*\{[^}]*overflow-wrap:\s*anywhere/su)
    expect(conversationSource).toMatch(/\.message-inline-code\s*\{[^}]*overflow-wrap:\s*anywhere/su)
  })

  it('keeps the composer input at the iOS-safe focus size', () => {
    expect(composerSource).toMatch(
      /@media \(max-width: 640px\)[\s\S]*\.thread-composer-input\s*\{[^}]*font-size:\s*16px/su,
    )
  })

  it('keeps the title and model controls usable at 320px', () => {
    expect(composerSource).toMatch(
      /@media \(max-width: 360px\)[\s\S]*\.thread-composer-controls\s*\{[^}]*flex-wrap:\s*wrap/su,
    )
    expect(composerSource).toMatch(
      /@media \(max-width: 360px\)[\s\S]*\.thread-composer-actions\s*\{[^}]*flex-basis:\s*100%/su,
    )
    expect(globalStyleSource).toMatch(
      /@media \(max-width: 360px\)[\s\S]*\.mobile-theme-toggle\s*\{[^}]*display:\s*none/su,
    )
  })
})
