import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const DEFAULT_NTFY_URL_FILE = join(homedir(), '.codex', 'codex-mobile-safe-ntfy-url')

function validateNtfyPublishUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('ntfy publish URL is invalid')
  }

  if (
    url.origin !== 'https://ntfy.sh'
    || url.username
    || url.password
    || url.search
    || url.hash
    || !/^\/[A-Za-z0-9_-]+$/u.test(url.pathname)
  ) {
    throw new Error('ntfy publish URL is invalid')
  }
  return url.href
}

export async function loadNtfyPublishUrl(options: {
  explicitPath?: string
  defaultPath?: string
  uid?: number
} = {}): Promise<string | null> {
  const path = resolve(options.explicitPath ?? options.defaultPath ?? DEFAULT_NTFY_URL_FILE)
  const required = Boolean(options.explicitPath)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => {
    if (!required && error.code === 'ENOENT') return null
    throw new Error('Unable to read ntfy URL file')
  })
  if (!handle) return null
  try {
    const info = await handle.stat().catch(() => {
      throw new Error('Unable to read ntfy URL file')
    })
    if (!info.isFile()) throw new Error('ntfy URL file must be a regular file')
    const uid = options.uid ?? process.getuid?.()
    if (uid !== undefined && info.uid !== uid) throw new Error('ntfy URL file must be owned by the current user')
    if ((info.mode & 0o077) !== 0) throw new Error('ntfy URL file permissions must be 0600 or stricter')
    const value = await handle.readFile('utf8').catch(() => {
      throw new Error('Unable to read ntfy URL file')
    })
    return validateNtfyPublishUrl(value.trim())
  } finally {
    await handle.close().catch(() => undefined)
  }
}
