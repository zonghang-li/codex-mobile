import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('Codex directive notice wiring', () => {
  it('renders directive notices and keeps directive-only messages visible', async () => {
    const noticeSource = await readFile(new URL('./CodexDirectiveNotices.vue', import.meta.url), 'utf8')
    const conversationSource = await readFile(new URL('./ThreadConversation.vue', import.meta.url), 'utf8')

    expect(noticeSource).toContain("defineProps<{ directives: UiCodexDirective[] }>()")
    expect(noticeSource).toContain('codexDirectiveLabel')
    expect(noticeSource).toContain('codexDirectiveHref')
    expect(conversationSource).toContain('<CodexDirectiveNotices')
    expect(conversationSource).toContain(':directives="message.directives"')
    expect(conversationSource).toMatch(/message\.text\.length > 0 \|\| .*directives/u)
  })
})
