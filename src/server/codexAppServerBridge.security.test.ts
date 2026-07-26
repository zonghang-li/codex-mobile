import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createManagedUpload,
  deleteManagedUpload,
} from './codexAppServerBridge'

const cleanupRoots: string[] = []

afterEach(async () => {
  await Promise.all(cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Codex bridge security-policy wiring', () => {
  it('checks disabled routes, RPC allowlisting, and terminal input before dispatch', async () => {
    const source = await readFile(new URL('./codexAppServerBridge.ts', import.meta.url), 'utf8')
    expect(source).toContain('securityPolicy.isRouteDisabled')
    expect(source).toContain('securityPolicy.isRpcMethodAllowed')
    expect(source).toContain('securityPolicy.terminalInputEnabled')
    expect(source.indexOf('securityPolicy.isRpcMethodAllowed')).toBeLessThan(source.indexOf('rpcResult = await callRpcWithArchiveRecovery('))
    expect(source.indexOf('securityPolicy.terminalInputEnabled')).toBeLessThan(source.indexOf('terminalManager.write(sessionId, data)'))
  })

  it('deletes only an upload handle issued by the current managed upload protocol', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-managed-upload-test-'))
    cleanupRoots.push(root)
    const upload = await createManagedUpload('photo.png', Buffer.from('image'), root)

    await expect(deleteManagedUpload(upload.uploadHandle)).resolves.toBe(true)
    await expect(lstat(dirname(upload.path))).rejects.toThrow()
    await expect(deleteManagedUpload(upload.uploadHandle)).resolves.toBe(false)
  })

  it.each([
    '/tmp/arbitrary-file',
    '../outside',
    '..%2Foutside',
    'not-issued-by-upload',
  ])('rejects arbitrary or traversing cleanup handle %s', async (uploadHandle) => {
    await expect(deleteManagedUpload(uploadHandle)).resolves.toBe(false)
  })

  it('rejects a registered upload whose directory was replaced with a symlink escape', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-managed-upload-root-'))
    const outside = await mkdtemp(join(tmpdir(), 'codex-managed-upload-outside-'))
    cleanupRoots.push(root, outside)
    const upload = await createManagedUpload('photo.png', Buffer.from('image'), root)
    const uploadDir = dirname(upload.path)
    const outsideFile = join(outside, 'keep.txt')
    await writeFile(outsideFile, 'keep')
    await rm(uploadDir, { recursive: true })
    await mkdir(root, { recursive: true })
    await symlink(outside, uploadDir)

    await expect(deleteManagedUpload(upload.uploadHandle)).resolves.toBe(false)
    await expect(readFile(outsideFile, 'utf8')).resolves.toBe('keep')
  })
})
