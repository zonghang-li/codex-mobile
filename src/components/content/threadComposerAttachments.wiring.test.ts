import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('ThreadComposer ephemeral uploaded-image attachments', () => {
  it('renders uploaded images as removable @filename tokens without an image preview', async () => {
    const source = await readFile(new URL('./ThreadComposer.vue', import.meta.url), 'utf8')
    const globalStyleSource = await readFile(new URL('../../style.css', import.meta.url), 'utf8')

    expect(source).not.toContain('thread-composer-attachment-image')
    expect(source).not.toMatch(/<img[^>]+selectedImages/u)
    expect(source).toContain('@{{ image.name }}')
    expect(source).toContain('@click="removeImage(image.id)"')
    expect(source).not.toContain(':global(.dark) .thread-composer-attachment')
    expect(globalStyleSource).toContain(':root.dark .thread-composer-attachment')
    expect(globalStyleSource).toContain(':root.dark .thread-composer-attachment-remove')
  })

  it('keeps managed identity and send path only in memory and excludes them from draft persistence', async () => {
    const source = await readFile(new URL('./ThreadComposer.vue', import.meta.url), 'utf8')

    expect(source).toMatch(/type SelectedImage = \{[\s\S]*uploadHandle: string[\s\S]*sendPath: string[\s\S]*\}/u)
    expect(source).toMatch(/function getCurrentDraftPayload\(\): ComposerDraftPayload \{[\s\S]*imageUrls: \[\]/u)
    expect(source).toMatch(/function loadPersistedDraftForThread[\s\S]*imageUrls: \[\]/u)
  })

  it('cleans managed images when removed, discarded, or invalidated', async () => {
    const source = await readFile(new URL('./ThreadComposer.vue', import.meta.url), 'utf8')

    expect(source).toMatch(/function removeImage[\s\S]*cleanupUploadedFile\(image\.uploadHandle\)/u)
    expect(source).toMatch(/function clearDraftState[\s\S]*cleanupSelectedImages/u)
    expect(source).toMatch(/function invalidatePendingAttachments[\s\S]*cleanupSelectedImages/u)
  })

  it('keeps App ownership through new-thread preflight and transfers it before state submission', async () => {
    const source = await readFile(new URL('../../App.vue', import.meta.url), 'utf8')

    expect(source).toMatch(/createManagedUploadLease\([\s\S]*createWorktree[\s\S]*createProjectlessThreadDirectory[\s\S]*uploadLease\.transfer\(\)[\s\S]*sendMessageToNewThread[\s\S]*finally[\s\S]*uploadLease\.release\(\)/u)
  })
})
