import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withCrossProcessDirectoryLock } from './crossProcessFileLock'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function runLockWorker(root: string, options: { holdMs?: number; staleMs?: number } = {}): Promise<void> {
  const moduleUrl = pathToFileURL(resolve(
    dirname(fileURLToPath(import.meta.url)),
    'crossProcessFileLock.ts',
  )).href
  const script = [
    `import { mkdir, rm } from 'node:fs/promises'`,
    `import { join } from 'node:path'`,
    `import { withCrossProcessDirectoryLock } from ${JSON.stringify(moduleUrl)}`,
    `const root = ${JSON.stringify(root)}`,
    `await withCrossProcessDirectoryLock(root, '.write-lock', { timeoutMs: 5000, staleMs: ${String(options.staleMs ?? 30_000)} }, async () => {`,
    `  const marker = join(root, 'critical-section')`,
    `  await mkdir(marker)`,
    `  await new Promise((resolve) => setTimeout(resolve, ${String(options.holdMs ?? 100)}))`,
    `  await rm(marker, { recursive: true })`,
    `})`,
  ].join('\n')
  return new Promise((resolveWorker, rejectWorker) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '--eval', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', rejectWorker)
    child.once('exit', (code) => {
      if (code === 0) resolveWorker()
      else rejectWorker(new Error(stderr || `lock worker exited ${String(code)}`))
    })
  })
}

describe('cross-process file lock', () => {
  it('does not publish a lock directory before its owner record is complete', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-mobile-cross-process-publish-'))
    cleanup.push(root)
    const lockPath = join(root, '.write-lock')
    let identityStarted!: () => void
    const identityStartedGate = new Promise<void>((resolve) => { identityStarted = resolve })
    let releaseIdentity!: () => void
    const identityGate = new Promise<void>((resolve) => { releaseIdentity = resolve })
    const lockModule = await import('./crossProcessFileLock') as unknown as {
      withCrossProcessDirectoryLock: <T>(
        root: string,
        lockName: string,
        options: {
          timeoutMs: number
          staleMs: number
          readCurrentProcessStartIdentity: () => Promise<string | null>
        },
        callback: () => Promise<T>,
      ) => Promise<T>
    }

    const acquisition = lockModule.withCrossProcessDirectoryLock(root, '.write-lock', {
      timeoutMs: 1_000,
      staleMs: 10,
      readCurrentProcessStartIdentity: async () => {
        identityStarted()
        await identityGate
        return 'test-process-identity'
      },
    }, async () => 'acquired')

    await Promise.race([
      identityStartedGate,
      new Promise((_, reject) => setTimeout(() => reject(new Error('identity hook was not called')), 100)),
    ])
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    releaseIdentity()
    await expect(acquisition).resolves.toBe('acquired')
    expect(await readdir(root)).toEqual([])
  })

  it.each([
    ['win32', 'powershell.exe', '638000000000000000'],
    ['darwin', 'ps', 'Mon Aug 17 12:34:56 2026'],
  ] as const)('reads a portable process-start identity on %s', async (platform, expectedCommand, output) => {
    const lockModule = await import('./crossProcessFileLock') as unknown as {
      readProcessStartIdentityForPlatform?: (
        pid: number,
        platform: NodeJS.Platform,
        runCommand: (command: string, args: readonly string[]) => Promise<string>,
      ) => Promise<string | null>
    }
    const calls: Array<{ command: string; args: readonly string[] }> = []

    expect(lockModule.readProcessStartIdentityForPlatform).toBeTypeOf('function')
    await expect(lockModule.readProcessStartIdentityForPlatform!(42, platform, async (command, args) => {
      calls.push({ command, args })
      return output
    })).resolves.toBe(`${platform}:42:${output}`)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toBe(expectedCommand)
  })

  it('treats a reused Windows PID with a different start identity as dead', async () => {
    const lockModule = await import('./crossProcessFileLock') as unknown as {
      isProcessOwnerIdentityAliveForPlatform?: (
        pid: number,
        expectedIdentity: string | null,
        platform: NodeJS.Platform,
        processAlive: (pid: number) => boolean,
        runCommand: (command: string, args: readonly string[]) => Promise<string>,
      ) => Promise<boolean>
    }

    expect(lockModule.isProcessOwnerIdentityAliveForPlatform).toBeTypeOf('function')
    await expect(lockModule.isProcessOwnerIdentityAliveForPlatform!(
      42,
      'win32:42:old-start',
      'win32',
      () => true,
      async () => 'new-start',
    )).resolves.toBe(false)
  })

  it('serializes independent processes in the same directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-mobile-cross-process-lock-'))
    cleanup.push(root)

    await Promise.all([runLockWorker(root), runLockWorker(root)])

    expect(await readdir(root)).toEqual([])
  })

  it('keeps a live owner beyond staleMs and does not steal its lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-mobile-cross-process-live-lock-'))
    cleanup.push(root)

    await Promise.all([
      runLockWorker(root, { holdMs: 180, staleMs: 40 }),
      new Promise<void>((resolveWorker, rejectWorker) => {
        setTimeout(() => {
          runLockWorker(root, { holdMs: 10, staleMs: 40 }).then(resolveWorker, rejectWorker)
        }, 70)
      }),
    ])

    expect(await readdir(root)).toEqual([])
  })

  it('does not delete a successor lock owned by another token on release', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-mobile-cross-process-owner-token-'))
    cleanup.push(root)
    const lockPath = join(root, '.write-lock')

    await withCrossProcessDirectoryLock(root, '.write-lock', {
      timeoutMs: 1_000,
      staleMs: 30_000,
    }, async () => {
      await rm(lockPath, { recursive: true })
      await mkdir(lockPath)
      await writeFile(join(lockPath, 'owner.json'), JSON.stringify({ token: 'successor' }))
    })

    expect(await readdir(lockPath)).toContain('owner.json')
  })

  it('reclaims a stale lock after its PID is reused by another process identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-mobile-cross-process-reused-pid-'))
    cleanup.push(root)
    const lockPath = join(root, '.write-lock')
    const ownerPath = join(lockPath, 'owner.json')
    await mkdir(lockPath)
    await writeFile(ownerPath, JSON.stringify({
      token: 'crashed-owner',
      pid: process.pid,
      hostname: hostname(),
      processStartIdentity: 'different-process-start',
      updatedAtMs: 1,
    }))
    const staleTime = new Date(Date.now() - 60_000)
    await utimes(ownerPath, staleTime, staleTime)

    await expect(withCrossProcessDirectoryLock(root, '.write-lock', {
      timeoutMs: 100,
      staleMs: 10,
      retryMs: 1,
    }, async () => 'acquired')).resolves.toBe('acquired')
    expect(await readdir(root)).toEqual(['.write-lock.reclaim.sqlite'])
  })

  it('does not steal a stale legacy lock whose PID is still alive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-mobile-cross-process-legacy-pid-'))
    cleanup.push(root)
    const lockPath = join(root, '.write-lock')
    const ownerPath = join(lockPath, 'owner.json')
    await mkdir(lockPath)
    await writeFile(ownerPath, JSON.stringify({
      token: 'legacy-owner',
      pid: process.pid,
      hostname: hostname(),
      updatedAtMs: 1,
    }))
    const staleTime = new Date(Date.now() - 60_000)
    await utimes(ownerPath, staleTime, staleTime)

    await expect(withCrossProcessDirectoryLock(root, '.write-lock', {
      timeoutMs: 30,
      staleMs: 10,
      retryMs: 1,
    }, async () => 'acquired')).rejects.toThrow('Timed out acquiring .write-lock.')
    expect(await readdir(root)).toEqual(['.write-lock'])
  })

  it('does not let a delayed stale reclaimer remove a successor lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-mobile-cross-process-stale-successor-'))
    cleanup.push(root)
    const lockPath = join(root, '.write-lock')
    const ownerPath = join(lockPath, 'owner.json')
    await mkdir(lockPath)
    await writeFile(ownerPath, JSON.stringify({
      token: 'crashed-owner',
      pid: process.pid,
      hostname: hostname(),
      processStartIdentity: 'different-process-start',
      updatedAtMs: 1,
    }))
    const staleTime = new Date(Date.now() - 60_000)
    await utimes(ownerPath, staleTime, staleTime)
    const lockModule = await import('./crossProcessFileLock') as unknown as {
      removeStaleLock?: (
        lockPath: string,
        staleMs: number,
        operations: { beforeReclaimClaim: () => Promise<void> },
      ) => Promise<boolean>
    }
    const claimWaiters: Array<() => void> = []
    const beforeReclaimClaim = () => new Promise<void>((resolve) => { claimWaiters.push(resolve) })

    expect(lockModule.removeStaleLock).toBeTypeOf('function')
    const first = lockModule.removeStaleLock!(lockPath, 10, { beforeReclaimClaim })
    const second = lockModule.removeStaleLock!(lockPath, 10, { beforeReclaimClaim })
    await vi.waitFor(() => expect(claimWaiters).toHaveLength(2))
    claimWaiters[0]!()
    await expect(first).resolves.toBe(true)
    await mkdir(lockPath)
    await writeFile(ownerPath, JSON.stringify({
      token: 'successor-owner',
      pid: process.pid,
      hostname: hostname(),
      processStartIdentity: null,
      updatedAtMs: Date.now(),
    }))
    claimWaiters[1]!()

    await expect(second).resolves.toBe(false)
    await expect(readFile(ownerPath, 'utf8')).resolves.toContain('successor-owner')
  }, 30_000)

  it('recovers a stale lock after an earlier reclaimer crashes with its claim published', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-mobile-cross-process-crashed-reclaimer-'))
    cleanup.push(root)
    const lockPath = join(root, '.write-lock')
    const ownerPath = join(lockPath, 'owner.json')
    const token = 'crashed-owner'
    await mkdir(lockPath)
    await writeFile(ownerPath, JSON.stringify({
      token,
      pid: process.pid,
      hostname: hostname(),
      processStartIdentity: 'different-process-start',
      updatedAtMs: 1,
    }))
    const staleTime = new Date(Date.now() - 60_000)
    await utimes(ownerPath, staleTime, staleTime)
    const claimSuffix = createHash('sha256').update(token).digest('hex').slice(0, 32)
    await link(ownerPath, `${lockPath}.reclaim-${claimSuffix}`)
    const lockModule = await import('./crossProcessFileLock') as unknown as {
      removeStaleLock: (lockPath: string, staleMs: number) => Promise<boolean>
    }

    await expect(lockModule.removeStaleLock(lockPath, 10)).resolves.toBe(true)
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
