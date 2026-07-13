import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('external thread runtime read-only wiring', () => {
  it('passes runtime ownership from App to the selected-thread composer and queue', async () => {
    const appSource = await readFile(new URL('../../App.vue', import.meta.url), 'utf8')

    expect(appSource).toContain(':runtime-ownership="selectedThreadRuntimeOwnership"')
    expect(appSource).toContain(':disabled="selectedThreadRuntimeOwnership === \'external\'"')
    expect(appSource).toMatch(/function onEditQueuedMessage\(messageId: string\): void \{\n  if \(selectedThreadRuntimeOwnership\.value === 'external'\) return/u)
  })

  it('makes an externally owned composer read-only while retaining a labelled stop control', async () => {
    const composerSource = await readFile(new URL('./ThreadComposer.vue', import.meta.url), 'utf8')

    expect(composerSource).toContain('runtimeOwnership?: ThreadRuntimeOwnership')
    expect(composerSource).toContain("const isExternallyOwned = computed(() => props.runtimeOwnership === 'external')")
    expect(composerSource).toContain("t('Running in another client')")
    expect(composerSource).toMatch(/function onSubmit\(mode: 'steer' \| 'queue' = 'steer'\): void \{\n  if \(isExternallyOwned\.value\) return/u)
    expect(composerSource).toMatch(/function onInterrupt\(\): void \{\n  if \(isExternallyOwned\.value\) return/u)
    expect(composerSource).toMatch(/function hydrateDraft\(payload: ComposerDraftPayload\): void \{\n  if \(isExternallyOwned\.value\) return/u)
    expect(composerSource).toMatch(/function appendTextToDraft\(text: string\): void \{\n  if \(isExternallyOwned\.value\) return/u)
    expect(composerSource).toMatch(/onTranscript: \(text\) => \{\n    if \(!canApplyThreadUiMutation\(props\.runtimeOwnership\)\) return/u)
    expect(composerSource).toContain('applyExternalRuntimeTakeover(previousOwnership, ownership, {')
    expect(composerSource).toContain('canApplyAttachmentMutation(props.runtimeOwnership, sessionToken, attachmentSessionToken)')
  })

  it('disables every queued-message action and guards drag handlers', async () => {
    const queueSource = await readFile(new URL('./QueuedMessages.vue', import.meta.url), 'utf8')

    expect(queueSource).toContain(':draggable="!disabled"')
    expect(queueSource).toContain(':disabled="disabled"')
    expect(queueSource).not.toContain("$emit('edit'")
    expect(queueSource).not.toContain("$emit('steer'")
    expect(queueSource).not.toContain("$emit('delete'")
    expect(queueSource).toMatch(/function onEdit\(messageId: string\): void \{\n  if \(props\.disabled\) return\n  emit\('edit', messageId\)/u)
    expect(queueSource).toMatch(/function onSteer\(messageId: string\): void \{\n  if \(props\.disabled\) return\n  emit\('steer', messageId\)/u)
    expect(queueSource).toMatch(/function onDelete\(messageId: string\): void \{\n  if \(props\.disabled\) return\n  emit\('delete', messageId\)/u)
    expect(queueSource).toMatch(/function onDragStart\(event: DragEvent, messageId: string\): void \{\n  if \(props\.disabled\) return/u)
    expect(queueSource).toMatch(/function onDragOver\(messageId: string\): void \{\n  if \(props\.disabled\) return/u)
    expect(queueSource).toMatch(/function onDragLeave\(messageId: string\): void \{\n  if \(props\.disabled\) return/u)
    expect(queueSource).toMatch(/function onDrop\(targetId: string\): void \{\n  if \(props\.disabled\) return/u)
  })
})
