import { lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createManagedUpload,
  deleteManagedUpload,
  reapExpiredManagedUploads,
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

    await rm(uploadDir)
    await mkdir(uploadDir)
    await writeFile(join(uploadDir, 'photo.png'), 'image')
    await expect(deleteManagedUpload(upload.uploadHandle)).resolves.toBe(true)
  })

  it('coalesces concurrent cleanup of the same issued handle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-managed-upload-test-'))
    cleanupRoots.push(root)
    const upload = await createManagedUpload('photo.png', Buffer.from('image'), root)

    await expect(Promise.all([
      deleteManagedUpload(upload.uploadHandle),
      deleteManagedUpload(upload.uploadHandle),
    ])).resolves.toEqual([true, true])
  })

  it('reaps bounded expired managed-upload orphans without following symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-managed-upload-reaper-'))
    const outside = await mkdtemp(join(tmpdir(), 'codex-managed-upload-outside-'))
    cleanupRoots.push(root, outside)
    const uuid = '12345678-1234-4123-8123-123456789abc'
    const expiredUpload = join(root, `upload-${uuid}`)
    const expiredLegacy = join(root, 'f-legacy123')
    const freshUpload = join(root, 'upload-87654321-4321-4321-8321-cba987654321')
    const unrelated = join(root, 'keep-arbitrary')
    const escapedLink = join(root, 'f-escaped')
    await Promise.all([
      mkdir(expiredUpload),
      mkdir(expiredLegacy),
      mkdir(freshUpload),
      mkdir(unrelated),
    ])
    await writeFile(join(outside, 'keep.txt'), 'keep')
    await symlink(outside, escapedLink)
    const nowMs = Date.now()
    const expiredDate = new Date(nowMs - 10_000)
    await Promise.all([
      utimes(expiredUpload, expiredDate, expiredDate),
      utimes(expiredLegacy, expiredDate, expiredDate),
      utimes(unrelated, expiredDate, expiredDate),
    ])

    await expect(reapExpiredManagedUploads({
      uploadRoot: root,
      nowMs,
      ttlMs: 5_000,
      maxEntries: 8,
    })).resolves.toBe(2)
    await expect(lstat(expiredUpload)).rejects.toThrow()
    await expect(lstat(expiredLegacy)).rejects.toThrow()
    await expect(lstat(freshUpload)).resolves.toBeDefined()
    await expect(lstat(unrelated)).resolves.toBeDefined()
    await expect(lstat(escapedLink)).resolves.toBeDefined()
    await expect(readFile(join(outside, 'keep.txt'), 'utf8')).resolves.toBe('keep')
  })
})
