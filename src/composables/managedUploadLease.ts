import { cleanupManagedUploads, type FileAttachmentParam } from '../api/codexGateway'

type CleanupManagedUploads = (
  imageUrls: string[],
  fileAttachments: FileAttachmentParam[],
) => Promise<boolean>

export type ManagedUploadLease = {
  transfer: () => void
  release: () => Promise<boolean>
}

function hasManagedUploadCapability(
  imageUrls: string[],
  fileAttachments: FileAttachmentParam[],
): boolean {
  return imageUrls.some((value) => {
    try {
      const parsed = new URL(value, 'http://localhost')
      return parsed.pathname === '/codex-local-image'
        && Boolean(parsed.searchParams.get('uploadHandle')?.trim())
    } catch {
      return false
    }
  }) || fileAttachments.some((attachment) => Boolean(attachment.uploadHandle?.trim()))
}

export function createManagedUploadLease(
  imageUrls: string[],
  fileAttachments: FileAttachmentParam[],
  cleanup: CleanupManagedUploads = cleanupManagedUploads,
): ManagedUploadLease {
  let ownsCapabilities = hasManagedUploadCapability(imageUrls, fileAttachments)
  return {
    transfer() {
      ownsCapabilities = false
    },
    async release() {
      if (!ownsCapabilities) return true
      ownsCapabilities = false
      return cleanup(imageUrls, fileAttachments)
    },
  }
}
