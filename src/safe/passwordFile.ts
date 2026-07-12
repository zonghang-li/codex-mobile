import { readFile, stat } from 'node:fs/promises'

export type PasswordFileIdentity = {
  uid?: number
}

export async function readSecurePasswordFile(
  path: string,
  identity: PasswordFileIdentity = { uid: process.getuid?.() },
): Promise<string> {
  const info = await stat(path)
  if (!info.isFile()) throw new Error('Password path must be a regular file')
  if (identity.uid !== undefined && info.uid !== identity.uid) {
    throw new Error('Password file must be owned by the current user')
  }
  if ((info.mode & 0o077) !== 0) {
    throw new Error('Password file permissions must be 0600 or stricter')
  }
  const password = (await readFile(path, 'utf8')).trimEnd()
  if (!password) throw new Error('Password file is empty')
  return password
}
