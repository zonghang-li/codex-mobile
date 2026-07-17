import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const conversationUrl = new URL('./ThreadConversation.vue', import.meta.url)

describe('ThreadConversation display math integration', () => {
  it('turns scanner math spans into message blocks', async () => {
    const source = await readFile(conversationUrl, 'utf8')
    expect(source).toContain("import { splitDisplayMathSpans } from './displayMath'")
    expect(source).toContain("import { splitInlineMathSpans } from './inlineMath'")
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
    expect(source).toContain("segment.kind === 'math'")
    expect(source).toContain('class="message-math-block"')
    expect(source).toContain('class="message-inline-math"')
    expect(source).toContain('renderDisplayMathInnerAsHtml(block)')
    expect(source).toContain('renderInlineMathAsHtml(segment)')
    expect(source).toContain('escapeHtml(block.source)')
  })

  it('loads only after relevant message text appears', async () => {
    const source = await readFile(conversationUrl, 'utf8')
    expect(source).toContain("message.text.includes('\\\\[')")
    expect(source).toContain("message.text.includes('\\\\(')")
    expect(source).toContain('void ensureDisplayMathLoaded()')
  })

  it('contains wide formulas and has a decisive dark rule', async () => {
    const [conversation, globalStyle] = await Promise.all([
      readFile(conversationUrl, 'utf8'),
      readFile(new URL('../../style.css', import.meta.url), 'utf8'),
    ])
    expect(conversation).toContain('class="plan-card-explanation plan-card-markdown"')
    expect(globalStyle).toMatch(/\.message-math-block\s*\{[^}]*max-width:\s*100%[^}]*overflow-x:\s*auto/su)
    expect(globalStyle).toMatch(/\.message-inline-math\s*\{[^}]*max-width:\s*100%[^}]*overflow-x:\s*auto/su)
    expect(globalStyle).toContain('-webkit-overflow-scrolling: touch')
    expect(globalStyle).toMatch(/:root\.dark \.message-math-block\s*\{/u)
    expect(globalStyle).toMatch(/:root\.dark \.message-inline-math\s*\{/u)
  })
})
