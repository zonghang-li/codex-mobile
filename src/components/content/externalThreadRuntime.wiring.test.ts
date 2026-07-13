import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('external thread runtime read-only wiring', () => {
  it('passes runtime ownership from App to the selected-thread composer and queue', async () => {
    const appSource = await readFile(new URL('../../App.vue', import.meta.url), 'utf8')

    expect(appSource).toContain(':runtime-ownership="selectedThreadRuntimeOwnership"')
    expect(appSource).toContain(':disabled="selectedThreadRuntimeOwnership === \'external\'"')
  })

  it('makes an externally owned composer read-only while retaining a labelled stop control', async () => {
    const composerSource = await readFile(new URL('./ThreadComposer.vue', import.meta.url), 'utf8')

    expect(composerSource).toContain('runtimeOwnership?: ThreadRuntimeOwnership')
    expect(composerSource).toContain("const isExternallyOwned = computed(() => props.runtimeOwnership === 'external')")
    expect(composerSource).toContain("t('Running in another client')")
    expect(composerSource).toMatch(/function onSubmit[\s\S]*if \(isExternallyOwned\.value\) return/u)
    expect(composerSource).toMatch(/function onInterrupt[\s\S]*if \(isExternallyOwned\.value\) return/u)
  })

  it('disables every queued-message action and guards drag handlers', async () => {
    const queueSource = await readFile(new URL('./QueuedMessages.vue', import.meta.url), 'utf8')

    expect(queueSource).toContain(':draggable="!disabled"')
    expect(queueSource).toContain(':disabled="disabled"')
    expect(queueSource).toMatch(/function onDragStart[\s\S]*if \(props\.disabled\) return/u)
    expect(queueSource).toMatch(/function onDragOver[\s\S]*if \(props\.disabled\) return/u)
    expect(queueSource).toMatch(/function onDrop[\s\S]*if \(props\.disabled\) return/u)
  })
})
