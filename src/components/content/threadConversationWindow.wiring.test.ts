import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('ThreadConversation render-window wiring', () => {
  it('clamps visible messages and enters manual history mode before expansion', async () => {
    const source = await readFile(new URL('./ThreadConversation.vue', import.meta.url), 'utf8')
    expect(source).toContain('const effectiveRenderWindowStart = computed(() => clampThreadRenderWindowStart(')
    expect(source).toContain('props.messages.slice(effectiveRenderWindowStart.value)')
    expect(source).toMatch(/async function loadMoreAbove[\s\S]*autoFollowOutput\.value = false[\s\S]*earlierThreadRenderWindowStart/u)
  })

  it('restores the bounded latest window only when jumping to latest', async () => {
    const source = await readFile(new URL('./ThreadConversation.vue', import.meta.url), 'utf8')
    expect(source).toMatch(/function jumpToLatest[\s\S]*autoFollowOutput\.value = true[\s\S]*latestThreadRenderWindowStart/u)
  })
})
