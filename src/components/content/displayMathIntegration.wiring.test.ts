import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const conversationUrl = new URL('./ThreadConversation.vue', import.meta.url)

describe('ThreadConversation display math integration', () => {
  it('turns scanner math spans into message blocks', async () => {
    const source = await readFile(conversationUrl, 'utf8')
    expect(source).toContain("import { splitDisplayMathSpans } from './displayMath'")
    expect(source).toContain("span.kind === 'math'")
    expect(source).toContain("kind: 'mathBlock'")
  })

  it('lazy-loads KaTeX and invalidates direct and plan caches', async () => {
    const source = await readFile(conversationUrl, 'utf8')
    expect(source).toContain("import('katex')")
    expect(source).toContain("import('katex/dist/katex.min.css')")
    expect(source).toContain('mathRenderVersion.value += 1')
    expect(source).toMatch(/v-memo="\[[^"]*mathRenderVersion/u)
    expect(source).toMatch(/highlightCacheVersion\.value[^\n]*mathRenderVersion\.value/u)
  })

  it('renders direct and plan-card math with an escaped fallback', async () => {
    const source = await readFile(conversationUrl, 'utf8')
    expect(source).toContain("block.kind === 'mathBlock'")
    expect(source).toContain('class="message-math-block"')
    expect(source).toContain('renderDisplayMathInnerAsHtml(block)')
    expect(source).toContain('escapeHtml(block.source)')
  })

  it('loads only after relevant message text appears', async () => {
    const source = await readFile(conversationUrl, 'utf8')
    expect(source).toContain("message.text.includes('\\\\[')")
    expect(source).toContain('void ensureDisplayMathLoaded()')
  })
})
