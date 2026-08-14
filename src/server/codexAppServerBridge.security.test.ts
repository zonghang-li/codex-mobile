import { lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BackendQueueProcessor,
  appendThreadQueuedMessage,
  createCodexBridgeMiddleware,
  createManagedUpload,
  deleteManagedUpload,
  reapExpiredManagedUploads,
} from './codexAppServerBridge'

const cleanupRoots: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Codex bridge security-policy wiring', () => {
  it('checks disabled routes, RPC allowlisting, and terminal input before dispatch', async () => {
    const source = await readFile(new URL('./codexAppServerBridge.ts', import.meta.url), 'utf8')
    expect(source).toContain('securityPolicy.isRouteDisabled')
    expect(source).toContain('securityPolicy.isRpcMethodAllowed')
    expect(source).toContain('securityPolicy.terminalInputEnabled')
    expect(source.indexOf('securityPolicy.isRpcMethodAllowed')).toBeLessThan(source.indexOf('return callRpcWithArchiveRecovery('))
    expect(source.indexOf('securityPolicy.terminalInputEnabled')).toBeLessThan(source.indexOf('terminalManager.write(sessionId, data)'))
  })

  it('deletes only an upload handle issued by the current managed upload protocol', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-managed-upload-test-'))
    cleanupRoots.push(root)
    const upload = await createManagedUpload('photo.png', Buffer.from('image'), root)

    await expect(deleteManagedUpload(upload.uploadHandle, {
      minimumRetentionMs: 0,
    })).resolves.toBe(true)
    await expect(lstat(dirname(upload.path))).rejects.toThrow()
    await expect(deleteManagedUpload(upload.uploadHandle, {
      minimumRetentionMs: 0,
    })).resolves.toBe(true)
  })

  it('retains a fresh managed upload when cleanup races its first consumer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-managed-upload-retention-'))
    cleanupRoots.push(root)
    const upload = await createManagedUpload('photo.png', Buffer.from('image'), root)

    await expect(deleteManagedUpload(upload.uploadHandle)).resolves.toBe(true)
    await expect(readFile(upload.path, 'utf8')).resolves.toBe('image')
  })

  it('reaps a released managed upload after its minimum retention window', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-managed-upload-release-'))
    cleanupRoots.push(root)
    const upload = await createManagedUpload('photo.png', Buffer.from('image'), root)
    const issuedAtMs = Number.parseInt(upload.uploadHandle.split('.')[1] ?? '', 36)

    await expect(deleteManagedUpload(upload.uploadHandle, {
      nowMs: issuedAtMs,
    })).resolves.toBe(true)
    await expect(reapExpiredManagedUploads({
      uploadRoot: root,
      nowMs: issuedAtMs + (5 * 60 * 1000) + 1,
    })).resolves.toBe(1)
    await expect(lstat(dirname(upload.path))).rejects.toThrow()
  })

  it('does not reap an expired upload referenced by a durable queued message', async () => {
    const originalCodexHome = process.env.CODEX_HOME
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-managed-upload-queue-home-'))
    const root = await mkdtemp(join(tmpdir(), 'codex-managed-upload-queued-'))
    cleanupRoots.push(codexHome, root)
    process.env.CODEX_HOME = codexHome

    try {
      const upload = await createManagedUpload('queued.png', Buffer.from('queued-image'), root)
      await appendThreadQueuedMessage('thread-with-upload', {
        id: 'queued-with-upload',
        text: 'wait safely',
        imageUrls: [`/codex-local-image?path=${encodeURIComponent(upload.path)}&uploadHandle=${encodeURIComponent(upload.uploadHandle)}`],
        skills: [],
        fileAttachments: [],
        collaborationMode: 'default',
        model: 'gpt-test',
        effort: '',
      })
      const old = new Date(Date.now() - (2 * 60 * 60 * 1000))
      await utimes(dirname(upload.path), old, old)

      await expect(reapExpiredManagedUploads({
        uploadRoot: root,
        nowMs: Date.now(),
        ttlMs: 60 * 60 * 1000,
      })).resolves.toBe(0)
      await expect(readFile(upload.path, 'utf8')).resolves.toBe('queued-image')
    } finally {
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = originalCodexHome
    }
  })

  it('rechecks durable queue references immediately before deleting an upload', async () => {
    const originalCodexHome = process.env.CODEX_HOME
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-managed-upload-race-home-'))
    const root = await mkdtemp(join(tmpdir(), 'codex-managed-upload-race-'))
    cleanupRoots.push(codexHome, root)
    process.env.CODEX_HOME = codexHome
    try {
      const upload = await createManagedUpload('raced.png', Buffer.from('queued-during-reap'), root)
      const old = new Date(Date.now() - (2 * 60 * 60 * 1000))
      await utimes(dirname(upload.path), old, old)
      let appended = false

      await expect(reapExpiredManagedUploads({
        uploadRoot: root,
        nowMs: Date.now(),
        ttlMs: 60 * 60 * 1000,
        beforeDeleteCandidate: async () => {
          if (appended) return
          appended = true
          await appendThreadQueuedMessage('thread-raced-upload', {
            id: 'queued-during-reap', text: 'keep file', imageUrls: [], skills: [],
            fileAttachments: [{ label: 'raced.png', path: upload.path, fsPath: upload.path, uploadHandle: upload.uploadHandle }],
            collaborationMode: 'default', model: 'gpt-test', effort: '',
          })
        },
      })).resolves.toBe(0)
      await expect(readFile(upload.path, 'utf8')).resolves.toBe('queued-during-reap')
    } finally {
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = originalCodexHome
    }
  })

  it('does not release durable queued uploads when a processor is disposed', async () => {
    const originalCodexHome = process.env.CODEX_HOME
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-managed-upload-dispose-home-'))
    const root = await mkdtemp(join(tmpdir(), 'codex-managed-upload-dispose-'))
    cleanupRoots.push(codexHome, root)
    process.env.CODEX_HOME = codexHome
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)

    try {
      const upload = await createManagedUpload('queued.png', Buffer.from('durable-image'), root)
      const imageUrl = `/codex-local-image?path=${encodeURIComponent(upload.path)}&uploadHandle=${encodeURIComponent(upload.uploadHandle)}`
      const message = {
        id: 'queued-dispose-upload',
        text: 'survive processor replacement',
        imageUrls: [imageUrl],
        skills: [],
        fileAttachments: [],
        collaborationMode: 'default' as const,
        model: 'gpt-test',
        effort: '' as const,
      }
      await appendThreadQueuedMessage('thread-dispose-upload', message)
      const processor = new BackendQueueProcessor({ onNotification: () => () => undefined } as never)
      processor.rememberRuntimeQueuedMessage('thread-dispose-upload', message)
      vi.mocked(Date.now).mockReturnValue(now + (6 * 60 * 1000))
      processor.dispose()
      await new Promise((resolve) => setTimeout(resolve, 10))

      await expect(readFile(upload.path, 'utf8')).resolves.toBe('durable-image')
    } finally {
      vi.mocked(Date.now).mockRestore()
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = originalCodexHome
    }
  })

  it('fails closed when durable queue state cannot be read before reaping uploads', async () => {
    const originalCodexHome = process.env.CODEX_HOME
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-managed-upload-invalid-home-'))
    const root = await mkdtemp(join(tmpdir(), 'codex-managed-upload-invalid-state-'))
    cleanupRoots.push(codexHome, root)
    process.env.CODEX_HOME = codexHome

    try {
      const upload = await createManagedUpload('queued.png', Buffer.from('keep-image'), root)
      const old = new Date(Date.now() - (2 * 60 * 60 * 1000))
      await utimes(dirname(upload.path), old, old)
      await writeFile(join(codexHome, '.codex-global-state.json'), '{broken', 'utf8')

      await expect(reapExpiredManagedUploads({
        uploadRoot: root,
        nowMs: Date.now(),
        ttlMs: 60 * 60 * 1000,
      })).resolves.toBe(0)
      await expect(readFile(upload.path, 'utf8')).resolves.toBe('keep-image')
    } finally {
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = originalCodexHome
    }
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
    await expect(deleteManagedUpload(upload.uploadHandle, {
      minimumRetentionMs: 0,
    })).resolves.toBe(true)
  })

  it('coalesces concurrent cleanup of the same issued handle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-managed-upload-test-'))
    cleanupRoots.push(root)
    const upload = await createManagedUpload('photo.png', Buffer.from('image'), root)

    await expect(Promise.all([
      deleteManagedUpload(upload.uploadHandle, { minimumRetentionMs: 0 }),
      deleteManagedUpload(upload.uploadHandle, { minimumRetentionMs: 0 }),
    ])).resolves.toEqual([true, true])
  })

  it('recovers cleanup authority from a signed handle after the in-memory registry is lost', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-managed-upload-restart-'))
    cleanupRoots.push(root)
    const upload = await createManagedUpload('restart.png', Buffer.from('image'), root)

    vi.resetModules()
    const restartedBridge = await import('./codexAppServerBridge')

    await expect(restartedBridge.deleteManagedUpload(upload.uploadHandle, {
      uploadRoot: root,
      minimumRetentionMs: 0,
    })).resolves.toBe(true)
    await expect(lstat(dirname(upload.path))).rejects.toThrow()
    await expect(restartedBridge.deleteManagedUpload(upload.uploadHandle, {
      uploadRoot: root,
      minimumRetentionMs: 0,
    })).resolves.toBe(true)
  })

  it('rejects expired or tampered cleanup capabilities without deleting the upload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-managed-upload-expiry-'))
    cleanupRoots.push(root)
    const upload = await createManagedUpload('expiry.png', Buffer.from('image'), root)
    const issuedAtMs = Number.parseInt(upload.uploadHandle.split('.')[1] ?? '', 36)
    const tampered = `${upload.uploadHandle.slice(0, -1)}${upload.uploadHandle.endsWith('A') ? 'B' : 'A'}`

    await expect(deleteManagedUpload(tampered, { uploadRoot: root })).resolves.toBe(false)
    await expect(deleteManagedUpload(upload.uploadHandle, {
      uploadRoot: root,
      nowMs: issuedAtMs + 1_001,
      ttlMs: 1_000,
    })).resolves.toBe(false)
    await expect(lstat(dirname(upload.path))).resolves.toBeDefined()
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

  it('eventually reaps more than 512 expired uploads across repeated bounded batches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-managed-upload-batches-'))
    cleanupRoots.push(root)
    const nowMs = Date.now()
    const expiredDate = new Date(nowMs - 10_000)
    const directories = Array.from({ length: 520 }, (_, index) => join(
      root,
      `upload-00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    ))
    await Promise.all(directories.map(async (directory) => {
      await mkdir(directory)
      await utimes(directory, expiredDate, expiredDate)
    }))

    await expect(reapExpiredManagedUploads({
      uploadRoot: root,
      nowMs,
      ttlMs: 5_000,
      maxEntries: 512,
    })).resolves.toBe(512)
    await expect(reapExpiredManagedUploads({
      uploadRoot: root,
      nowMs,
      ttlMs: 5_000,
      maxEntries: 512,
    })).resolves.toBe(8)
    await expect(Promise.all(directories.map((directory) => lstat(directory).then(
      () => true,
      () => false,
    )))).resolves.not.toContain(true)
  })

  it('periodically reaps uploads that expire after middleware startup and clears its timer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-managed-upload-periodic-'))
    cleanupRoots.push(root)
    const middleware = createCodexBridgeMiddleware({
      managedUploadReaper: {
        uploadRoot: root,
        intervalMs: 10,
        ttlMs: 500,
        maxEntries: 8,
      },
    })
    const first = await createManagedUpload('first.png', Buffer.from('image'), root)
    const firstDirectory = dirname(first.path)
    const expiredDate = new Date(Date.now() - 1_000)
    await utimes(firstDirectory, expiredDate, expiredDate)

    await vi.waitFor(async () => {
      await expect(lstat(firstDirectory)).rejects.toThrow()
    }, { timeout: 1_000, interval: 10 })

    middleware.dispose()
    const second = await createManagedUpload('second.png', Buffer.from('image'), root)
    const secondDirectory = dirname(second.path)
    await utimes(secondDirectory, expiredDate, expiredDate)
    await new Promise((resolve) => setTimeout(resolve, 50))
    await expect(lstat(secondDirectory)).resolves.toBeDefined()
  })
})
