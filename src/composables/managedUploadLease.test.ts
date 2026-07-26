import { describe, expect, it, vi } from 'vitest'
import type { FileAttachmentParam } from '../api/codexGateway'
import { createManagedUploadLease } from './managedUploadLease'

const imageUrls = [
  '/codex-local-image?path=%2Ftmp%2Fcodex-web-uploads%2Fupload%2Fphoto.png&uploadHandle=lease-handle',
]
const fileAttachments = [{
  label: 'notes.txt',
  path: '/tmp/codex-web-uploads/upload/notes.txt',
  fsPath: '/tmp/codex-web-uploads/upload/notes.txt',
  uploadHandle: 'file-handle',
}]

async function runPreflight(
  operation: () => Promise<string>,
  cleanup: (imageUrls: string[], fileAttachments: FileAttachmentParam[]) => Promise<boolean>,
): Promise<string> {
  const lease = createManagedUploadLease(imageUrls, fileAttachments, cleanup)
  try {
    return await operation()
  } finally {
    await lease.release()
  }
}

describe('createManagedUploadLease', () => {
  it('releases once when worktree creation fails before ownership transfer', async () => {
    const cleanup = vi.fn().mockResolvedValue(true)

    await expect(runPreflight(
      async () => {
        throw new Error('worktree creation failed')
      },
      cleanup,
    )).rejects.toThrow('worktree creation failed')

    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(cleanup).toHaveBeenCalledWith(imageUrls, fileAttachments)
  })

  it('releases once when projectless directory creation fails before ownership transfer', async () => {
    const cleanup = vi.fn().mockResolvedValue(true)

    await expect(runPreflight(
      async () => {
        throw new Error('projectless directory creation failed')
      },
      cleanup,
    )).rejects.toThrow('projectless directory creation failed')

    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('does not release after explicit ownership transfer', async () => {
    const cleanup = vi.fn().mockResolvedValue(true)

    const lease = createManagedUploadLease(imageUrls, fileAttachments, cleanup)
    lease.transfer()
    await expect((async () => {
        return 'thread-1'
    })()).resolves.toBe('thread-1')
    await lease.release()

    expect(cleanup).not.toHaveBeenCalled()
  })
})
