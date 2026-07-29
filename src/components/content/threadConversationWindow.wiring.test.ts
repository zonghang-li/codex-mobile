import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('ThreadConversation render-window wiring', () => {
  it('renders every already-loaded message without a client-side history window', async () => {
    const source = await readFile(new URL('./ThreadConversation.vue', import.meta.url), 'utf8')
    expect(source).toContain('const renderableMessages = computed(() => filterRenderableThreadMessages(')
    expect(source).toContain('const visibleMessages = computed(() => renderableMessages.value.filter(shouldRenderVisibleMessage))')
    expect(source).not.toContain('renderableMessages.value.slice(effectiveRenderWindowStart.value)')
    expect(source).not.toContain('props.messages.slice(effectiveRenderWindowStart.value)')
  })

  it('uses load-more only for persisted server history, not local render windows', async () => {
    const source = await readFile(new URL('./ThreadConversation.vue', import.meta.url), 'utf8')
    expect(source).toContain('const hasMoreAbove = computed(() => props.hasMorePersistedAbove === true)')
    expect(source).not.toContain('earlierThreadRenderWindowStart')
    expect(source).not.toContain('latestThreadRenderWindowStart')
  })
})
