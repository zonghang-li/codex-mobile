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
    expect(source).toContain(':href="block.url"')
  })
})
