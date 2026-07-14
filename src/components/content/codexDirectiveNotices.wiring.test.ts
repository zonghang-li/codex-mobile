import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('Codex directive notice wiring', () => {
  it('renders directive notices and keeps directive-only messages visible', async () => {
    const noticeSource = await readFile(new URL('./CodexDirectiveNotices.vue', import.meta.url), 'utf8')
    const conversationSource = await readFile(new URL('./ThreadConversation.vue', import.meta.url), 'utf8')
    const styleSource = await readFile(new URL('../../style.css', import.meta.url), 'utf8')

    expect(noticeSource).toContain("defineProps<{ directives: UiCodexDirective[] }>()")
    expect(noticeSource).toContain('codexDirectiveLabel')
    expect(noticeSource).toContain('codexDirectiveHref')
    expect(noticeSource).toContain("directive.kind === 'generic'")
    expect(noticeSource).toContain("directive.kind === 'invalid'")
    expect(noticeSource).toContain('codexDirectiveInvalidReason')
    expect(noticeSource).toContain('directive.attributes')
    expect(noticeSource).toContain('codex-directive-attributes')
    expect(conversationSource).toContain('<CodexDirectiveNotices')
    expect(conversationSource).toContain(':directives="message.directives"')
    expect(conversationSource).toMatch(/message\.text\.length > 0 \|\| .*directives/u)
    expect(styleSource).toMatch(
      /\.codex-directive-attributes\s*\{[^}]*grid-template-columns:\s*fit-content\(40%\)\s+minmax\(0,\s*1fr\)/su,
    )
  })
})
