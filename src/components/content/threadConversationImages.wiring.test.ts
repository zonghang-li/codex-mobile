import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./ThreadConversation.vue', import.meta.url), 'utf8')

describe('ThreadConversation image presentation', () => {
  it('does not special-case assistant image sources away', () => {
    expect(source).toContain("message.messageType === 'imageGeneration'")
    expect(source).toContain("message.messageType === 'imageView'")
    expect(source).toContain('class="message-markdown-image"')
  })

  it('replaces failed non-user images with links', () => {
    expect(source).toContain('isMessageImageFailed(message.id, imageUrl)')
    expect(source).toContain('@error="markMessageImageFailed(message.id, imageUrl)"')
    expect(source).toContain('class="message-image-fallback-link"')
    expect(source).toContain('isMarkdownImageFailed(message.id, blockIndex)')
    expect(source).toContain(':href="safeImageFallbackHref(block.url)"')
  })

  it.each([
    'javascript:',
    'vbscript:',
    'data:text/html',
  ])('keeps failed %s image targets inert', (scheme) => {
    expect(source).toContain("import { safeImageFallbackHref } from './imageUrlPolicy'")
    expect(source).not.toMatch(new RegExp(
      `(?:href|:href)=[\"'](?:${scheme.replace(':', '\\\\:')}|imageUrl|block\\\\.url)`,
      'u',
    ))
    expect(source).toContain('class="message-image-fallback-text"')
  })

  it('handles failed plan explanation and step images through delegated capture', () => {
    expect(source).toMatch(
      /class="plan-card-explanation plan-card-markdown"[\s\S]*@error\.capture="onPlanMarkdownImageError"/u,
    )
    expect(source).toMatch(
      /class="plan-step-text plan-card-markdown"[\s\S]*@error\.capture="onPlanMarkdownImageError"/u,
    )
    expect(source).toContain('function onPlanMarkdownImageError(event: Event): void')
  })
})
