import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const appUrl = new URL('../../App.vue', import.meta.url)
const conversationUrl = new URL('./ThreadConversation.vue', import.meta.url)
const styleUrl = new URL('../../style.css', import.meta.url)
const indexUrl = new URL('../../../index.html', import.meta.url)

describe('mobile route and viewport wiring', () => {
  it('returns inaccessible thread routes to home instead of leaving a broken selection active', async () => {
    const appSource = await readFile(appUrl, 'utf8')

    expect(appSource).toMatch(/if \(result === 'not-found'\) \{\s*await selectThread\(''\)\s*await router\.replace\(\{ name: 'home' \}\)\s*continue\s*\}/u)
  })

  it('prevents page-level horizontal dragging while preserving internal code scrolling', async () => {
    const [indexSource, styleSource, conversationSource] = await Promise.all([
      readFile(indexUrl, 'utf8'),
      readFile(styleUrl, 'utf8'),
      readFile(conversationUrl, 'utf8'),
    ])

    expect(indexSource).toContain('maximum-scale=1')
    expect(indexSource).toContain('viewport-fit=cover')
    expect(styleSource).toMatch(/html,\s*body,\s*#app\s*\{[^}]*overflow-x:\s*hidden[^}]*touch-action:\s*pan-y/su)
    expect(styleSource).toMatch(/body\s*\{[^}]*position:\s*relative/su)
    expect(conversationSource).toMatch(/\.conversation-list\s*\{[^}]*overflow-x-hidden/su)
    expect(conversationSource).toMatch(/\.message-code-block\s*\{[^}]*min-w-0/su)
    expect(conversationSource).toMatch(/\.message-code-block\s*\{[^}]*max-w-full/su)
    expect(conversationSource).toMatch(/\.message-code-pre\s*\{[^}]*overflow-x-auto/su)
  })
})
