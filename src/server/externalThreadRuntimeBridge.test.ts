import { createServer, request as httpRequest } from 'node:http'
import { spawnSync } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { appendFile, chmod, mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, truncate, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ExternalThreadRuntime } from '../types/threadRuntime'
import {
  appendThreadQueuedMessage,
  augmentThreadResultWithExternalRuntime,
  createCodexBridgeMiddleware,
  getThreadListSeenSnapshotCacheMetrics,
  getSessionIndexFileSignature,
  isThreadListCursorFileMetadataValid,
  isArchivedThreadIndexSizeSupported,
  pruneExpiredCachedHttpResponses,
  readThreadListSeenImportedIds,
  readArchivedThreadIdFromFile,
  subscribeThreadQueueRevisions,
  trimCachedHttpResponses,
  writeThreadListSeenImportedIds,
  withThreadListCursorSnapshotWriteLock,
  withThreadStartClaim,
} from './codexAppServerBridge'
import { PERMISSIVE_SECURITY_POLICY } from './securityPolicy'

function fakeProbe(runtime: ExternalThreadRuntime) {
  return {
    registerThread: vi.fn((_threadId: string, _rolloutPath: string): void => undefined),
    inspect: vi.fn(async (
      _threadId: string,
      _excludedPid: number | null,
    ): Promise<ExternalThreadRuntime> => runtime),
    inspectMany: vi.fn(async (
      threadIds: readonly string[],
      _excludedPid: number | null,
    ): Promise<Record<string, ExternalThreadRuntime>> => Object.fromEntries(
      threadIds.map((threadId) => [threadId, runtime]),
    )),
  }
}

function archivedRolloutFileName(threadId: string, timestampOffsetMs = 0, utc = false): string {
  const timestampMs = Number.parseInt(threadId.replace(/-/gu, '').slice(0, 12), 16) + timestampOffsetMs
  const createdAt = new Date(timestampMs)
  const component = (value: number) => String(value).padStart(2, '0')
  const year = utc ? createdAt.getUTCFullYear() : createdAt.getFullYear()
  const month = (utc ? createdAt.getUTCMonth() : createdAt.getMonth()) + 1
  const day = utc ? createdAt.getUTCDate() : createdAt.getDate()
  const hour = utc ? createdAt.getUTCHours() : createdAt.getHours()
  const minute = utc ? createdAt.getUTCMinutes() : createdAt.getMinutes()
  const second = utc ? createdAt.getUTCSeconds() : createdAt.getSeconds()
  return `rollout-${String(year)}-${component(month)}-${component(day)}T${component(hour)}-${component(minute)}-${component(second)}-${threadId}.jsonl`
}

function testZipCrc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function buildStoredProjectZip(entries: Array<{ path: string; data: string; externalAttributes?: number }>): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let localOffset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8')
    const data = Buffer.from(entry.data, 'utf8')
    const crc32 = testZipCrc32(data)
    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc32, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    name.copy(local, 30)
    localParts.push(local, data)

    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc32, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(entry.externalAttributes ?? 0, 38)
    central.writeUInt32LE(localOffset, 42)
    name.copy(central, 46)
    centralParts.push(central)
    localOffset += local.length + data.length
  }
  const centralSize = centralParts.reduce((total, part) => total + part.length, 0)
  const footer = Buffer.alloc(22)
  footer.writeUInt32LE(0x06054b50, 0)
  footer.writeUInt16LE(entries.length, 8)
  footer.writeUInt16LE(entries.length, 10)
  footer.writeUInt32LE(centralSize, 12)
  footer.writeUInt32LE(localOffset, 16)
  return Buffer.concat([...localParts, ...centralParts, footer])
}

function buildOverlappingStoredProjectZip(): Buffer {
  const innerName = Buffer.from('inner.txt')
  const innerData = Buffer.from('inner payload')
  const innerLocal = Buffer.alloc(30 + innerName.length)
  innerLocal.writeUInt32LE(0x04034b50, 0)
  innerLocal.writeUInt16LE(20, 4)
  innerLocal.writeUInt32LE(testZipCrc32(innerData), 14)
  innerLocal.writeUInt32LE(innerData.length, 18)
  innerLocal.writeUInt32LE(innerData.length, 22)
  innerLocal.writeUInt16LE(innerName.length, 26)
  innerName.copy(innerLocal, 30)

  const outerName = Buffer.from('outer.txt')
  const prefix = Buffer.from('x')
  const outerData = Buffer.concat([prefix, innerLocal, innerData])
  const outerLocal = Buffer.alloc(30 + outerName.length)
  outerLocal.writeUInt32LE(0x04034b50, 0)
  outerLocal.writeUInt16LE(20, 4)
  outerLocal.writeUInt32LE(testZipCrc32(outerData), 14)
  outerLocal.writeUInt32LE(outerData.length, 18)
  outerLocal.writeUInt32LE(outerData.length, 22)
  outerLocal.writeUInt16LE(outerName.length, 26)
  outerName.copy(outerLocal, 30)

  const centralEntry = (name: Buffer, data: Buffer, localOffset: number): Buffer => {
    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(testZipCrc32(data), 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(localOffset, 42)
    name.copy(central, 46)
    return central
  }
  const centralOffset = outerLocal.length + outerData.length
  const central = Buffer.concat([
    centralEntry(outerName, outerData, 0),
    centralEntry(innerName, innerData, outerLocal.length + prefix.length),
  ])
  const footer = Buffer.alloc(22)
  footer.writeUInt32LE(0x06054b50, 0)
  footer.writeUInt16LE(2, 8)
  footer.writeUInt16LE(2, 10)
  footer.writeUInt32LE(central.length, 12)
  footer.writeUInt32LE(centralOffset, 16)
  return Buffer.concat([outerLocal, outerData, central, footer])
}

describe('HTTP response cache bounds', () => {
  it('prunes expired entries and trims the oldest cached responses', () => {
    const cache = new Map([
      ['expired', { response: { status: 200, payload: { value: 'expired' } }, expiresAt: 999 }],
      ['oldest', { response: { status: 200, payload: { value: 'oldest' } }, expiresAt: 2_000 }],
      ['newest', { response: { status: 200, payload: { value: 'newest' } }, expiresAt: 2_000 }],
    ])

    pruneExpiredCachedHttpResponses(cache, 1_000)
    expect([...cache.keys()]).toEqual(['oldest', 'newest'])

    trimCachedHttpResponses(cache, 1)
    expect([...cache.keys()]).toEqual(['newest'])
  })
})

describe('archived rollout identity', () => {
  it('reads an archived session identity from a bounded first line beyond 64 KiB', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-mobile-archive-long-meta-'))
    const threadId = '019fd126-4567-7890-a123-456789abcdef'
    const archivedPath = join(root, `rollout-${threadId}.jsonl`)
    await writeFile(archivedPath, `${JSON.stringify({
      type: 'session_meta', payload: { id: threadId, oversized: 'x'.repeat(80 * 1024) },
    })}\n`)

    try {
      await expect(readArchivedThreadIdFromFile(
        archivedPath,
        `rollout-${threadId}.jsonl`,
      )).resolves.toBe(threadId)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a symlink swapped in between path inspection and descriptor opening', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-mobile-archive-open-race-'))
    const threadId = '019fd126-4567-7890-a123-456789abcdef'
    const archivedPath = join(root, `rollout-${threadId}.jsonl`)
    const targetPath = join(root, 'replacement.jsonl')
    const contents = `${JSON.stringify({ type: 'session_meta', payload: { id: threadId } })}\n`
    await writeFile(archivedPath, contents)
    await writeFile(targetPath, contents)

    try {
      await expect(readArchivedThreadIdFromFile(
        archivedPath,
        `rollout-${threadId}.jsonl`,
        async (path, flags) => {
          await rm(path)
          await symlink(targetPath, path)
          return await open(path, flags)
        },
      )).resolves.toBe('')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps every successfully buildable archive index within the cache validation bound', () => {
    expect(isArchivedThreadIndexSizeSupported(1, 4_095)).toBe(true)
    expect(isArchivedThreadIndexSizeSupported(1, 4_096)).toBe(false)
    expect(isArchivedThreadIndexSizeSupported(4_096, 0)).toBe(true)
    expect(isArchivedThreadIndexSizeSupported(4_096, 1)).toBe(false)
  })
})

describe('thread list cursor snapshot serialization', () => {
  it('keeps an older cursor view isolated when a later page extends the same snapshot', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-cursor-view-isolation-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    }))
    const firstIds = Array.from({ length: 40 }, (_, index) => `first-${index}`)
    const firstState = await writeThreadListSeenImportedIds(null, new Set(), firstIds)
    const olderView = await readThreadListSeenImportedIds(firstState)

    await writeThreadListSeenImportedIds(firstState, olderView, ['future-id'])

    expect(olderView.size).toBe(40)
    expect(olderView.has('future-id')).toBe(false)
  })

  it('bounds cached seen-id snapshots by entry count and total ids', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-cursor-cache-bound-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    }))
    for (let snapshot = 0; snapshot < 70; snapshot += 1) {
      await writeThreadListSeenImportedIds(
        null,
        new Set(),
        Array.from({ length: 40 }, (_, index) => `snapshot-${snapshot}-${index}`),
      )
    }

    expect(getThreadListSeenSnapshotCacheMetrics()).toMatchObject({
      entriesAtMostLimit: true,
      idsAtMostLimit: true,
    })
  })

  it('bounds cached seen-id snapshots by estimated decoded bytes', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-cursor-cache-byte-bound-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    for (let snapshot = 0; snapshot < 10; snapshot += 1) {
      await writeThreadListSeenImportedIds(
        null,
        new Set(),
        Array.from(
          { length: 4_000 },
          (_, index) => `snapshot-${snapshot}-${index}-${'x'.repeat(470)}`,
        ),
      )
    }

    expect(getThreadListSeenSnapshotCacheMetrics()).toMatchObject({
      bytesAtMostLimit: true,
    })
  })

  it('fails closed when a cursor snapshot cannot be evicted', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-cursor-prune-failure-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const cursor = await writeThreadListSeenImportedIds(
      null,
      new Set(),
      Array.from({ length: 40 }, (_, index) => `cached-${index}`),
    )
    const snapshotRoot = join(codexHome, 'codex-mobile-cache', 'thread-list-cursor-state')
    const snapshotPath = join(snapshotRoot, `${cursor.seenImportedSnapshotId}.json`)
    const metricsBefore = getThreadListSeenSnapshotCacheMetrics()
    const bridge = await import('./codexAppServerBridge') as unknown as {
      pruneThreadListCursorSnapshots?: (
        root: string,
        incomingBytes: number,
        incomingFiles: number,
        preservedPath: string,
        operations: { removeFile: (path: string) => Promise<void> },
      ) => Promise<void>
    }

    expect(bridge.pruneThreadListCursorSnapshots).toBeTypeOf('function')
    await expect(bridge.pruneThreadListCursorSnapshots!(
      snapshotRoot,
      128 * 1024 * 1024,
      1,
      '',
      { removeFile: async () => { throw new Error('simulated unlink failure') } },
    )).rejects.toThrow('simulated unlink failure')
    await expect(stat(snapshotPath)).resolves.toBeDefined()
    expect(cursor.seenImportedSnapshotId).not.toBe('')
    expect(getThreadListSeenSnapshotCacheMetrics()).toEqual(metricsBefore)
  })

  it('fails closed when cursor snapshot enumeration is unavailable', async () => {
    const snapshotRoot = await mkdtemp(join(tmpdir(), 'codex-mobile-cursor-enumeration-failure-'))
    disposers.push(() => rm(snapshotRoot, { recursive: true, force: true }))
    const bridge = await import('./codexAppServerBridge') as unknown as {
      pruneThreadListCursorSnapshots?: (
        root: string,
        incomingBytes: number,
        incomingFiles: number,
        preservedPath: string,
        operations: { readDirectory: (path: string) => Promise<string[]> },
      ) => Promise<void>
    }

    expect(bridge.pruneThreadListCursorSnapshots).toBeTypeOf('function')
    await expect(bridge.pruneThreadListCursorSnapshots!(
      snapshotRoot,
      1,
      1,
      '',
      { readDirectory: async () => { throw new Error('simulated enumeration failure') } },
    )).rejects.toThrow('simulated enumeration failure')
  })

  it('runs the built-in SQLite fallback without blocking the event loop', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-builtin-sqlite-worker-'))
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const stateDbPath = join(codexHome, 'state.sqlite')
    const bridge = await import('./codexAppServerBridge') as unknown as {
      runBuiltinSqliteQueryCapture?: (
        path: string,
        sql: string,
        json: boolean,
        timeoutMs: number,
      ) => Promise<string>
    }
    let timerFired = false

    expect(bridge.runBuiltinSqliteQueryCapture).toBeTypeOf('function')
    const query = bridge.runBuiltinSqliteQueryCapture!(stateDbPath, [
      'WITH RECURSIVE values_(value) AS (',
      'VALUES(0) UNION ALL SELECT value + 1 FROM values_ WHERE value < 1000000',
      ') SELECT sum(value) AS total FROM values_;',
    ].join(' '), true, 5_000)
    setTimeout(() => { timerFired = true }, 0)
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(timerFired).toBe(true)
    await expect(query).resolves.toContain('500000500000')
  })

  it('terminates a built-in SQLite fallback query at its deadline', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-builtin-sqlite-timeout-'))
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const bridge = await import('./codexAppServerBridge') as unknown as {
      runBuiltinSqliteQueryCapture: (
        path: string,
        sql: string,
        json: boolean,
        timeoutMs: number,
      ) => Promise<string>
    }

    await expect(bridge.runBuiltinSqliteQueryCapture(
      join(codexHome, 'state.sqlite'),
      'WITH RECURSIVE values_(value) AS (VALUES(0) UNION ALL SELECT value + 1 FROM values_) SELECT sum(value) FROM values_;',
      true,
      20,
    )).rejects.toThrow('timed out')
  })

  it('applies a default timeout to the external SQLite executable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-mobile-external-sqlite-timeout-'))
    const shimPath = join(root, 'sqlite3')
    await writeFile(
      shimPath,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then\n  exit 0\nfi\nexec sleep 60\n',
    )
    await chmod(shimPath, 0o755)
    const originalSqliteCommand = process.env.CODEXUI_SQLITE_COMMAND
    process.env.CODEXUI_SQLITE_COMMAND = shimPath
    disposers.push(async () => {
      if (originalSqliteCommand === undefined) delete process.env.CODEXUI_SQLITE_COMMAND
      else process.env.CODEXUI_SQLITE_COMMAND = originalSqliteCommand
      await rm(root, { recursive: true, force: true })
    })
    const bridge = await import('./codexAppServerBridge') as unknown as {
      runSqliteQueryCapture?: (path: string, sql: string) => Promise<string>
    }

    expect(bridge.runSqliteQueryCapture).toBeTypeOf('function')
    await expect(bridge.runSqliteQueryCapture!(join(root, 'state.sqlite'), 'SELECT 1;'))
      .rejects.toThrow('timed out')
  }, 10_000)

  it('keeps active UUID rows visible with more than 4096 archived files', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-large-archive-active-row-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const archivedRoot = join(codexHome, 'archived_sessions', 'bulk')
    await mkdir(archivedRoot, { recursive: true })
    const activeThreadId = '019fd126-4567-7890-a123-456789abcdea'
    expect(spawnSync('sqlite3', [join(codexHome, 'state_5.sqlite'), [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, has_user_event INTEGER, archived INTEGER);',
      `INSERT INTO threads VALUES ('${activeThreadId}', 1, 0);`,
    ].join(' ')], { encoding: 'utf8' }).status).toBe(0)
    for (let index = 0; index < 4_100; index += 1) {
      const suffix = index.toString(16).padStart(12, '0')
      const id = `019fd125-0000-7000-8000-${suffix}`
      await writeFile(
        join(archivedRoot, `rollout-${id}.jsonl`),
        `${JSON.stringify({ type: 'session_meta', payload: { id } })}\n`,
      )
    }
    const bridge = await import('./codexAppServerBridge') as unknown as {
      canonicalizeThreadListResponseForRead: (payload: unknown) => Promise<unknown>
    }

    await expect(bridge.canonicalizeThreadListResponseForRead({
      data: [{ id: activeThreadId, cwd: '/tmp/project', turns: [] }],
    })).resolves.toMatchObject({ data: [{ id: activeThreadId }] })
  }, 30_000)

  it('keeps oversized thread-list metadata queries off argv', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-list-metadata-stdin-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    expect(spawnSync('sqlite3', [join(codexHome, 'state_5.sqlite'),
      'CREATE TABLE threads (id TEXT PRIMARY KEY, has_user_event INTEGER, archived INTEGER);',
    ], { encoding: 'utf8' }).status).toBe(0)
    const threadIds = Array.from(
      { length: 96 },
      (_, index) => `thread-${String(index).padStart(3, '0')}-${'x'.repeat(4_096)}`,
    )
    const bridge = await import('./codexAppServerBridge') as unknown as {
      canonicalizeThreadListResponseForRead: (payload: unknown) => Promise<unknown>
    }

    await expect(bridge.canonicalizeThreadListResponseForRead({
      data: threadIds.map((id) => ({ id, cwd: '/tmp/project', turns: [] })),
    })).resolves.toMatchObject({ data: threadIds.map((id) => ({ id })) })
  })

  it('keeps project import and export SQLite work asynchronous', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-project-sqlite-async-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const bridge = await import('./codexAppServerBridge') as unknown as {
      readStateDbThreadExportMetadata?: (threadIds: readonly string[]) => Promise<Map<string, unknown>>
      registerImportedSessionsInStateDb?: (sessions: unknown[]) => Promise<void>
    }

    expect(bridge.readStateDbThreadExportMetadata).toBeTypeOf('function')
    expect(bridge.registerImportedSessionsInStateDb).toBeTypeOf('function')
    expect(bridge.readStateDbThreadExportMetadata!([])).toBeInstanceOf(Promise)
    expect(bridge.registerImportedSessionsInStateDb!([])).toBeInstanceOf(Promise)
    await bridge.registerImportedSessionsInStateDb!([])
  })

  it('closes the built-in SQLite worker connection before posting its result', async () => {
    const source = await readFile(join(process.cwd(), 'src/server/codexAppServerBridge.ts'), 'utf8')
    expect(source).toContain('database.close()\nparentPort.postMessage(result)')
  })

  it('registers large project imports with bounded SQLite statements kept off argv', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-project-sqlite-import-batches-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const sqlitePath = spawnSync('which', ['sqlite3'], { encoding: 'utf8' }).stdout.trim()
    const shimInputPath = join(codexHome, 'sqlite-input.sql')
    const shimPath = join(codexHome, 'sqlite-bounded.sh')
    await writeFile(shimPath, [
      '#!/bin/sh',
      `if [ "$1" = "--version" ]; then exec '${sqlitePath}' "$@"; fi`,
      `for arg in "$@"; do case "$arg" in *"INSERT"*) exit 96 ;; esac; done`,
      `trap 'rm -f "${shimInputPath}"' EXIT`,
      `tee '${shimInputPath}' >/dev/null`,
      `bytes=$(wc -c < '${shimInputPath}')`,
      `[ "$bytes" -le 102400 ] || exit 97`,
      `exec '${sqlitePath}' "$@" < '${shimInputPath}'`,
      '',
    ].join('\n'))
    await chmod(shimPath, 0o755)
    const originalSqliteCommand = process.env.CODEXUI_SQLITE_COMMAND
    process.env.CODEXUI_SQLITE_COMMAND = shimPath
    disposers.push(() => {
      if (originalSqliteCommand === undefined) delete process.env.CODEXUI_SQLITE_COMMAND
      else process.env.CODEXUI_SQLITE_COMMAND = originalSqliteCommand
    })
    const bridge = await import('./codexAppServerBridge') as unknown as {
      registerImportedSessionsInStateDb: (sessions: Array<Record<string, unknown>>) => Promise<void>
      runBuiltinSqliteQueryCapture: (
        path: string,
        sql: string,
        json: boolean,
        timeoutMs: number,
      ) => Promise<string>
    }
    const sessions = Array.from({ length: 96 }, (_, index) => ({
      id: `imported-${String(index).padStart(4, '0')}`,
      path: join(codexHome, 'sessions', `imported-${String(index).padStart(4, '0')}.jsonl`),
      cwd: '/tmp/imported-project',
      title: index === 0 ? 'x'.repeat(200_000) : `${String(index)}-${'x'.repeat(4_096)}`,
      createdAtMs: 1_700_000_000_000 + index,
      updatedAtMs: 1_700_000_100_000 + index,
      model: 'gpt-test',
      modelProvider: 'openai',
      cliVersion: '1.0.0',
      firstUserMessage: index === 0 ? 'y'.repeat(200_000) : 'Imported message',
    }))

    await bridge.registerImportedSessionsInStateDb(sessions)

    const rows = JSON.parse(await bridge.runBuiltinSqliteQueryCapture(
      join(codexHome, 'state_5.sqlite'),
      'SELECT count(*) AS count FROM threads;',
      true,
      5_000,
    )) as Array<{ count: number }>
    expect(rows).toEqual([{ count: sessions.length }])
  })

  it('rolls back every imported state-db row when a later row fails', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-project-sqlite-import-atomic-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const stateDbPath = join(codexHome, 'state_5.sqlite')
    const bridge = await import('./codexAppServerBridge') as unknown as {
      registerImportedSessionsInStateDb: (sessions: Array<Record<string, unknown>>) => Promise<void>
      runBuiltinSqliteQueryCapture: (
        path: string,
        sql: string,
        json: boolean,
        timeoutMs: number,
      ) => Promise<string>
    }
    await bridge.runBuiltinSqliteQueryCapture(
      stateDbPath,
      "CREATE TABLE threads (id TEXT PRIMARY KEY CHECK (id != 'bad'), title TEXT);",
      false,
      5_000,
    )
    const sessions = Array.from({ length: 65 }, (_, index) => ({
      id: index === 64 ? 'bad' : `atomic-${String(index).padStart(3, '0')}`,
      path: join(codexHome, 'sessions', `atomic-${String(index).padStart(3, '0')}.jsonl`),
      cwd: '/tmp/imported-project',
      title: `Atomic ${String(index)}`,
      createdAtMs: 1_700_000_000_000 + index,
      updatedAtMs: 1_700_000_100_000 + index,
      model: 'gpt-test',
      modelProvider: 'openai',
      cliVersion: '1.0.0',
      firstUserMessage: 'Imported message',
    }))

    await expect(bridge.registerImportedSessionsInStateDb(sessions)).rejects.toThrow()
    const rows = JSON.parse(await bridge.runBuiltinSqliteQueryCapture(
      stateDbPath,
      'SELECT count(*) AS count FROM threads;',
      true,
      5_000,
    )) as Array<{ count: number }>
    expect(rows).toEqual([{ count: 0 }])
  })

  it('reads project export metadata only for requested session IDs', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-project-sqlite-export-batches-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const stateDbPath = join(codexHome, 'state_5.sqlite')
    const bridge = await import('./codexAppServerBridge') as unknown as {
      readStateDbThreadExportMetadata: (threadIds: readonly string[]) => Promise<Map<string, unknown>>
      runBuiltinSqliteQueryCapture: (
        path: string,
        sql: string,
        json: boolean,
        timeoutMs: number,
      ) => Promise<string>
    }
    const projectThreadIds = Array.from({ length: 205 }, (_, index) => `project-thread-${String(index).padStart(3, '0')}`)
    await bridge.runBuiltinSqliteQueryCapture(stateDbPath, [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, preview TEXT, updated_at INTEGER, updated_at_ms INTEGER, archived INTEGER);',
      ...projectThreadIds.map((threadId, index) => (
        `INSERT INTO threads VALUES ('${threadId}', 'Project ${String(index)}', '', 0, ${String(2_000 + index)}, 0);`
      )),
      "INSERT INTO threads VALUES ('unrelated-thread', 'Unrelated', '', 0, 3000, 0);",
    ].join('\n'), false, 5_000)

    const metadata = await bridge.readStateDbThreadExportMetadata(projectThreadIds)

    expect([...metadata.keys()].sort()).toEqual(projectThreadIds)
  })

  it('collects project chat export metadata in bounded batches', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-project-export-bounded-'))
    const projectRoot = join(codexHome, 'project')
    const sessionsRoot = join(codexHome, 'sessions', '2026', '08', '15')
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    await mkdir(projectRoot, { recursive: true })
    await mkdir(sessionsRoot, { recursive: true })
    await Promise.all(Array.from({ length: 205 }, async (_, index) => {
      const id = `export-${String(index).padStart(3, '0')}`
      await writeFile(join(sessionsRoot, `${id}.jsonl`), `${JSON.stringify({
        type: 'session_meta',
        payload: { id, cwd: projectRoot },
      })}\n`)
    }))
    const batchSizes: number[] = []
    const bridge = await import('./codexAppServerBridge') as unknown as {
      collectProjectChatZipEntries?: (
        projectRoot: string,
        operations: {
          readThreadMetadata: (threadIds: readonly string[]) => Promise<Map<string, unknown>>
        },
      ) => Promise<Array<{ path: string }>>
    }

    expect(bridge.collectProjectChatZipEntries).toBeTypeOf('function')
    const entries = await bridge.collectProjectChatZipEntries!(projectRoot, {
      readThreadMetadata: async (threadIds) => {
        batchSizes.push(threadIds.length)
        return new Map()
      },
    })

    expect(Math.max(...batchSizes)).toBeLessThanOrEqual(100)
    expect(batchSizes.reduce((total, size) => total + size, 0)).toBe(205)
    expect(entries.filter((entry) => entry.path.endsWith('.jsonl'))).toHaveLength(205)
  })

  it('exports a session whose first session_meta line exceeds 64 KiB', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-project-export-long-meta-'))
    const projectRoot = join(codexHome, 'project')
    const sessionsRoot = join(codexHome, 'sessions')
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    await mkdir(projectRoot, { recursive: true })
    await mkdir(sessionsRoot, { recursive: true })
    const sessionId = 'export-long-session-meta'
    await writeFile(join(sessionsRoot, `${sessionId}.jsonl`), `${JSON.stringify({
      type: 'session_meta',
      payload: { id: sessionId, cwd: projectRoot, oversized: 'x'.repeat(80 * 1024) },
    })}\n`)
    const bridge = await import('./codexAppServerBridge') as unknown as {
      collectProjectChatZipEntries: (projectRoot: string) => Promise<Array<{ path: string }>>
    }

    const entries = await bridge.collectProjectChatZipEntries(projectRoot)

    expect(entries.some((entry) => entry.path.endsWith(`${sessionId}.jsonl`))).toBe(true)
  })

  it('skips an over-limit session_meta line without reading an unbounded line', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-project-export-meta-limit-'))
    const projectRoot = join(codexHome, 'project')
    const sessionsRoot = join(codexHome, 'sessions')
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    await mkdir(projectRoot, { recursive: true })
    await mkdir(sessionsRoot, { recursive: true })
    const sessionId = 'export-over-limit-session-meta'
    await writeFile(join(sessionsRoot, `${sessionId}.jsonl`), JSON.stringify({
      type: 'session_meta',
      payload: { id: sessionId, cwd: projectRoot, oversized: 'x'.repeat(2 * 1024 * 1024) },
    }))
    const bridge = await import('./codexAppServerBridge') as unknown as {
      collectProjectChatZipEntries: (projectRoot: string) => Promise<Array<{ path: string }>>
    }

    const entries = await bridge.collectProjectChatZipEntries(projectRoot)

    expect(entries.some((entry) => entry.path.endsWith(`${sessionId}.jsonl`))).toBe(false)
  })

  it('counts over-limit session_meta reads against the aggregate scan budget', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-project-export-meta-budget-'))
    const projectRoot = join(codexHome, 'project')
    const sessionsRoot = join(codexHome, 'sessions')
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    await mkdir(projectRoot, { recursive: true })
    await mkdir(sessionsRoot, { recursive: true })
    await Promise.all(Array.from({ length: 256 }, async (_, index) => {
      const sessionPath = join(sessionsRoot, `oversized-${String(index).padStart(3, '0')}.jsonl`)
      await writeFile(sessionPath, '')
      await truncate(sessionPath, (1024 * 1024) + 1)
    }))
    const bridge = await import('./codexAppServerBridge') as unknown as {
      collectProjectChatZipEntries: (projectRoot: string) => Promise<Array<{ path: string }>>
    }

    await expect(bridge.collectProjectChatZipEntries(projectRoot))
      .rejects.toThrow('Project chat export exceeds the session metadata scan limit')
  })

  it('skips a session whose ID exceeds the bounded thread ID format', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-project-export-id-limit-'))
    const projectRoot = join(codexHome, 'project')
    const sessionsRoot = join(codexHome, 'sessions')
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    await mkdir(projectRoot, { recursive: true })
    await mkdir(sessionsRoot, { recursive: true })
    const oversizedId = `thread-${'x'.repeat(512 * 1024)}`
    await writeFile(join(sessionsRoot, 'oversized-id.jsonl'), `${JSON.stringify({
      type: 'session_meta', payload: { id: oversizedId, cwd: projectRoot },
    })}\n`)
    const readThreadMetadata = vi.fn(async (_ids: readonly string[]) => new Map<string, unknown>())
    const readArchivedThreadIds = vi.fn(async (_ids: readonly string[]) => new Set<string>())
    const bridge = await import('./codexAppServerBridge') as unknown as {
      collectProjectChatZipEntries: (
        projectRoot: string,
        operations: { readThreadMetadata: typeof readThreadMetadata; readArchivedThreadIds: typeof readArchivedThreadIds },
      ) => Promise<Array<{ path: string }>>
    }

    const entries = await bridge.collectProjectChatZipEntries(projectRoot, {
      readThreadMetadata,
      readArchivedThreadIds,
    })

    expect(entries.some((entry) => entry.path.endsWith('oversized-id.jsonl'))).toBe(false)
    expect(readThreadMetadata).not.toHaveBeenCalled()
    expect(readArchivedThreadIds).not.toHaveBeenCalled()
  })

  it('excludes archived sessions from project chat exports', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-project-export-archived-'))
    const projectRoot = join(codexHome, 'project')
    const archivedRoot = join(codexHome, 'archived_sessions')
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    await mkdir(projectRoot, { recursive: true })
    await mkdir(archivedRoot, { recursive: true })
    await writeFile(join(archivedRoot, 'archived.jsonl'), `${JSON.stringify({
      type: 'session_meta', payload: { id: 'archived-export', cwd: projectRoot },
    })}\n`)
    const bridge = await import('./codexAppServerBridge') as unknown as {
      collectProjectChatZipEntries: (projectRoot: string) => Promise<Array<{ path: string }>>
    }

    const entries = await bridge.collectProjectChatZipEntries(projectRoot)

    expect(entries.some((entry) => entry.path.endsWith('archived.jsonl'))).toBe(false)
  })

  it('excludes a stale active-directory rollout whose state-db row is archived', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-project-export-stale-archived-'))
    const projectRoot = join(codexHome, 'project')
    const sessionsRoot = join(codexHome, 'sessions')
    const threadId = '019fd140-4567-7890-a123-456789abcdef'
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    await mkdir(projectRoot, { recursive: true })
    await mkdir(sessionsRoot, { recursive: true })
    await writeFile(join(sessionsRoot, `${threadId}.jsonl`), `${JSON.stringify({
      type: 'session_meta', payload: { id: threadId, cwd: projectRoot },
    })}\n`)
    expect(spawnSync('sqlite3', [join(codexHome, 'state_5.sqlite')], {
      input: `CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER); INSERT INTO threads VALUES ('${threadId}', 1);`,
      encoding: 'utf8',
    }).status).toBe(0)
    const bridge = await import('./codexAppServerBridge') as unknown as {
      collectProjectChatZipEntries: (projectRoot: string) => Promise<Array<{ path: string }>>
    }

    const entries = await bridge.collectProjectChatZipEntries(projectRoot)

    expect(entries.some((entry) => entry.path.endsWith(`${threadId}.jsonl`))).toBe(false)
  })

  it('reads one authoritative archive snapshot for a multi-batch project export', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-project-export-archive-snapshot-'))
    const projectRoot = join(codexHome, 'project')
    const sessionsRoot = join(codexHome, 'sessions')
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    await mkdir(projectRoot, { recursive: true })
    await mkdir(sessionsRoot, { recursive: true })
    await Promise.all(Array.from({ length: 205 }, async (_, index) => {
      const id = `export-batch-${String(index).padStart(3, '0')}`
      await writeFile(join(sessionsRoot, `${id}.jsonl`), `${JSON.stringify({
        type: 'session_meta', payload: { id, cwd: projectRoot },
      })}\n`)
    }))
    const readArchivedThreadIds = vi.fn(async (_threadIds: readonly string[]) => new Set<string>())
    const bridge = await import('./codexAppServerBridge') as unknown as {
      collectProjectChatZipEntries: (
        projectRoot: string,
        operations: {
          readThreadMetadata: () => Promise<Map<string, unknown>>
          readArchivedThreadIds: (threadIds: readonly string[]) => Promise<Set<string>>
        },
      ) => Promise<Array<{ path: string }>>
    }

    const entries = await bridge.collectProjectChatZipEntries(projectRoot, {
      readThreadMetadata: async () => new Map<string, unknown>(),
      readArchivedThreadIds,
    })

    expect(entries.filter((entry) => entry.path.endsWith('.jsonl'))).toHaveLength(205)
    expect(readArchivedThreadIds).toHaveBeenCalledTimes(1)
    expect(readArchivedThreadIds.mock.calls[0]?.[0]).toHaveLength(205)
  })

  it('ignores archived session entries from older project ZIP exports', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-project-import-archived-'))
    const destinationParent = join(codexHome, 'destination')
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    await mkdir(destinationParent, { recursive: true })
    const zip = buildStoredProjectZip([
      { path: '.codex-project/manifest.json', data: JSON.stringify({ projectName: 'archived-import' }) },
      {
        path: '.codex-project/chats/archived_sessions/archived.jsonl',
        data: `${JSON.stringify({
          type: 'session_meta', payload: { id: 'archived-import-source', cwd: '/tmp/source' },
        })}\n`,
      },
    ])
    const bridge = await import('./codexAppServerBridge') as unknown as {
      importProjectZip: (buffer: Buffer, parent: string) => Promise<{ importedSessions: number }>
    }

    await expect(bridge.importProjectZip(zip, destinationParent)).resolves.toMatchObject({ importedSessions: 0 })
    await expect(readdir(join(codexHome, 'sessions', 'imported')).catch(() => [])).resolves.toEqual([])
  })

  it('removes project, session, and state-db artifacts when project import fails', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-project-import-rollback-'))
    const destinationParent = join(codexHome, 'destination')
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    await mkdir(destinationParent, { recursive: true })
    const sourceThreadId = '019fd130-4567-7890-a123-456789abcdef'
    const sourceSession = [
      JSON.stringify({
        timestamp: '2026-08-15T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: sourceThreadId, cwd: '/tmp/source-project' },
      }),
      JSON.stringify({
        timestamp: '2026-08-15T00:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'import me' },
      }),
      '',
    ].join('\n')
    const zip = buildStoredProjectZip([
      { path: '.codex-project/manifest.json', data: JSON.stringify({ projectName: 'atomic-import' }) },
      { path: '.codex-project/chats/sessions/source.jsonl', data: sourceSession },
      { path: 'conflict', data: 'file' },
      { path: 'conflict/child.txt', data: 'cannot be created below a file' },
    ])
    const bridge = await import('./codexAppServerBridge') as unknown as {
      importProjectZip?: (buffer: Buffer, parent: string) => Promise<unknown>
      runBuiltinSqliteQueryCapture: (
        path: string,
        sql: string,
        json: boolean,
        timeoutMs: number,
      ) => Promise<string>
    }

    expect(bridge.importProjectZip).toBeTypeOf('function')
    await bridge.runBuiltinSqliteQueryCapture(
      join(codexHome, 'state_5.sqlite'),
      'CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT);',
      false,
      5_000,
    )
    await expect(bridge.importProjectZip!(zip, destinationParent)).rejects.toThrow()
    await expect(stat(join(destinationParent, 'atomic-import'))).rejects.toMatchObject({ code: 'ENOENT' })
    const rows = JSON.parse(await bridge.runBuiltinSqliteQueryCapture(
      join(codexHome, 'state_5.sqlite'),
      'SELECT count(*) AS count FROM threads;',
      true,
      5_000,
    )) as Array<{ count: number }>
    expect(rows).toEqual([{ count: 0 }])
    const importedRoot = join(codexHome, 'sessions', 'imported')
    const importedFiles = await readdir(importedRoot).catch(() => [])
    expect(importedFiles).toEqual([])
  })

  it('atomically claims distinct destinations for concurrent same-name project imports', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-project-import-claim-'))
    const destinationParent = join(codexHome, 'destination')
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    await mkdir(destinationParent, { recursive: true })
    const zip = buildStoredProjectZip([
      { path: '.codex-project/manifest.json', data: JSON.stringify({ projectName: 'same-name' }) },
      { path: 'README.md', data: 'claimed' },
    ])
    const bridge = await import('./codexAppServerBridge') as unknown as {
      importProjectZip: (buffer: Buffer, parent: string) => Promise<{ projectPath: string }>
    }

    const imports = await Promise.all([
      bridge.importProjectZip(zip, destinationParent),
      bridge.importProjectZip(zip, destinationParent),
    ])

    expect(new Set(imports.map((result) => result.projectPath))).toHaveProperty('size', 2)
    await expect(readFile(join(destinationParent, 'same-name', 'README.md'), 'utf8')).resolves.toBe('claimed')
    await expect(readFile(join(destinationParent, 'same-name-2', 'README.md'), 'utf8')).resolves.toBe('claimed')
  })

  it('serializes concurrent project import state mutations across the full rollback window', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-project-import-lock-'))
    const destinationParent = join(codexHome, 'destination')
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    await mkdir(destinationParent, { recursive: true })
    const zip = buildStoredProjectZip([
      { path: '.codex-project/manifest.json', data: JSON.stringify({ projectName: 'locked-import' }) },
      {
        path: '.codex-project/chats/sessions/source.jsonl',
        data: `${JSON.stringify({ type: 'session_meta', payload: { id: 'source', cwd: '/tmp/source' } })}\n`,
      },
    ])
    const bridge = await import('./codexAppServerBridge') as unknown as {
      importProjectZip: (
        buffer: Buffer,
        parent: string,
        operations: { afterGlobalStatePersist: () => Promise<void> },
      ) => Promise<unknown>
    }
    let activeMutations = 0
    let maxActiveMutations = 0
    const operations = {
      afterGlobalStatePersist: async () => {
        activeMutations += 1
        maxActiveMutations = Math.max(maxActiveMutations, activeMutations)
        await new Promise((resolve) => setTimeout(resolve, 50))
        activeMutations -= 1
        throw new Error('simulated serialized import failure')
      },
    }

    const results = await Promise.allSettled([
      bridge.importProjectZip(zip, destinationParent, operations),
      bridge.importProjectZip(zip, destinationParent, operations),
    ])

    expect(results.every((result) => result.status === 'rejected')).toBe(true)
    expect(maxActiveMutations).toBe(1)
    const stateDbPath = join(codexHome, 'state_5.sqlite')
    await expect(stat(stateDbPath)).resolves.toBeDefined()
    expect(spawnSync('sqlite3', [stateDbPath, "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'threads'; SELECT count(*) FROM threads;"], {
      encoding: 'utf8',
    }).stdout.trim().split('\n')).toEqual(['1', '0'])
  })

  it('rejects a project ZIP with corrupted entry data before claiming a destination', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-project-import-corrupt-zip-'))
    const destinationParent = join(codexHome, 'destination')
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    await mkdir(destinationParent, { recursive: true })
    const zip = buildStoredProjectZip([
      { path: '.codex-project/manifest.json', data: JSON.stringify({ projectName: 'corrupt-import' }) },
      { path: 'README.md', data: 'claimed' },
    ])
    const dataOffset = zip.indexOf(Buffer.from('claimed'))
    expect(dataOffset).toBeGreaterThan(0)
    zip[dataOffset] ^= 0xff
    const bridge = await import('./codexAppServerBridge') as unknown as {
      importProjectZip: (buffer: Buffer, parent: string) => Promise<unknown>
    }

    await expect(bridge.importProjectZip(zip, destinationParent)).rejects.toThrow('Invalid project ZIP')
    await expect(readdir(destinationParent)).resolves.toEqual([])
  })

  it('rejects overlapping local ZIP records before claiming a destination', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-project-import-overlap-'))
    const destinationParent = join(codexHome, 'destination')
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    await mkdir(destinationParent, { recursive: true })
    const bridge = await import('./codexAppServerBridge') as unknown as {
      importProjectZip: (buffer: Buffer, parent: string) => Promise<unknown>
    }

    await expect(bridge.importProjectZip(buildOverlappingStoredProjectZip(), destinationParent))
      .rejects.toThrow('Invalid project ZIP')
    await expect(readdir(destinationParent)).resolves.toEqual([])
  })

  it('bounds the number of logical entries in a project ZIP', async () => {
    const bridge = await import('./codexAppServerBridge') as unknown as {
      parseStoredProjectZip?: (buffer: Buffer) => unknown[]
    }
    const zip = buildStoredProjectZip(Array.from({ length: 10_001 }, (_, index) => ({
      path: `entry-${String(index).padStart(5, '0')}`,
      data: '',
    })))

    expect(bridge.parseStoredProjectZip).toBeTypeOf('function')
    expect(() => bridge.parseStoredProjectZip!(zip)).toThrow('too many entries')
  })

  it('applies import-compatible entry and archive byte limits before project ZIP export', async () => {
    const bridge = await import('./codexAppServerBridge') as unknown as {
      assertProjectZipExportBounds?: (
        entries: Array<{ zipPath: string; size: number }>,
      ) => void
    }

    expect(bridge.assertProjectZipExportBounds).toBeTypeOf('function')
    expect(() => bridge.assertProjectZipExportBounds!(Array.from({ length: 10_001 }, (_, index) => ({
      zipPath: `entry-${String(index).padStart(5, '0')}`,
      size: 0,
    })))).toThrow('too many files')
    expect(() => bridge.assertProjectZipExportBounds!([{
      zipPath: 'oversized.bin',
      size: 257 * 1024 * 1024,
    }])).toThrow('exceeds the import limit')
  })

  it('gates descriptor-anchored project ZIP traversal on unsupported platforms', async () => {
    const bridge = await import('./codexAppServerBridge') as unknown as {
      projectZipDescriptorDirectoryPath?: (fd: number, platform: NodeJS.Platform) => string
    }

    expect(bridge.projectZipDescriptorDirectoryPath).toBeTypeOf('function')
    expect(bridge.projectZipDescriptorDirectoryPath!(42, 'linux')).toBe('/proc/self/fd/42')
    expect(bridge.projectZipDescriptorDirectoryPath!(42, 'win32')).toBe('')
  })

  it('closes virtual project ZIP files when preflight bounds reject them', async () => {
    if (process.platform !== 'linux') return
    const root = await mkdtemp(join(tmpdir(), 'codex-mobile-project-export-fd-bound-'))
    disposers.push(() => rm(root, { recursive: true, force: true }))
    const oversizedPath = join(root, 'oversized-session.jsonl')
    await writeFile(oversizedPath, '')
    await truncate(oversizedPath, 257 * 1024 * 1024)
    const bridge = await import('./codexAppServerBridge') as unknown as {
      assertProjectZipCanRoundTrip: (
        root: string,
        virtualEntries: Array<{ path: string; mtime: Date; filePath: string }>,
      ) => Promise<void>
    }
    const openDescriptorsBefore = (await readdir('/proc/self/fd')).length

    for (let attempt = 0; attempt < 16; attempt += 1) {
      await expect(bridge.assertProjectZipCanRoundTrip(root, [{
        path: '.codex-project/chats/sessions/oversized.jsonl',
        mtime: new Date(),
        filePath: oversizedPath,
      }])).rejects.toThrow('exceeds the import limit')
    }

    const openDescriptorsAfter = (await readdir('/proc/self/fd')).length
    expect(openDescriptorsAfter).toBeLessThanOrEqual(openDescriptorsBefore + 2)
  })

  it('excludes the physical reserved chat namespace from a project ZIP export', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-project-export-reserved-'))
    const projectRoot = join(codexHome, 'project')
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    await mkdir(join(projectRoot, '.codex-project', 'chats'), { recursive: true })
    await writeFile(join(projectRoot, '.codex-project', 'chats', 'physical.txt'), 'must not export')
    await writeFile(join(projectRoot, 'README.md'), 'export me')
    const middleware = createCodexBridgeMiddleware()
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/project-zip?cwd=${encodeURIComponent(projectRoot)}`,
    )
    const zip = Buffer.from(await response.arrayBuffer())
    const bridge = await import('./codexAppServerBridge') as unknown as {
      parseStoredProjectZip: (buffer: Buffer) => Array<{ path: string }>
    }

    expect(response.status).toBe(200)
    expect(bridge.parseStoredProjectZip(zip).map((entry) => entry.path)).toEqual(expect.arrayContaining([
      '.codex-project/manifest.json',
      'README.md',
    ]))
    expect(bridge.parseStoredProjectZip(zip).some((entry) => (
      entry.path.startsWith('.codex-project/chats/') && entry.path.endsWith('physical.txt')
    ))).toBe(false)
  })

  it('chunks SQL IN values by count and encoded byte size', async () => {
    const bridge = await import('./codexAppServerBridge') as unknown as {
      chunkSqlInValues?: (
        values: readonly string[],
        maxCount: number,
        maxBytes: number,
      ) => string[][]
    }
    const values = Array.from({ length: 205 }, (_, index) => `thread-${index}-${'x'.repeat(1_000)}`)

    expect(bridge.chunkSqlInValues).toBeTypeOf('function')
    const batches = bridge.chunkSqlInValues!(values, 100, 8 * 1024)

    expect(batches.flat()).toEqual(values)
    expect(batches.every((batch) => batch.length <= 100)).toBe(true)
    expect(batches.every((batch) => Buffer.byteLength(batch.map((value) => `'${value}'`).join(',')) <= 8 * 1024))
      .toBe(true)
  })

  it('honors the DOS directory attribute for paths without a trailing slash', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-project-import-directory-attribute-'))
    const destinationParent = join(codexHome, 'destination')
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    await mkdir(destinationParent, { recursive: true })
    const zip = buildStoredProjectZip([
      { path: '.codex-project/manifest.json', data: JSON.stringify({ projectName: 'directory-attribute' }) },
      { path: 'empty-dir', data: '', externalAttributes: 0x10 },
    ])
    const bridge = await import('./codexAppServerBridge') as unknown as {
      importProjectZip: (buffer: Buffer, parent: string) => Promise<{ projectPath: string }>
    }

    const result = await bridge.importProjectZip(zip, destinationParent)

    await expect(stat(join(result.projectPath, 'empty-dir')).then((value) => value.isDirectory())).resolves.toBe(true)
  })

  it('rejects an oversized project ZIP request from Content-Length before reading its body', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-project-import-body-limit-'))
    const destinationParent = join(codexHome, 'destination')
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    await mkdir(destinationParent, { recursive: true })
    const middleware = createCodexBridgeMiddleware()
    const port = await listenWithMiddleware(middleware)

    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: `/codex-api/project-import?parent=${encodeURIComponent(destinationParent)}`,
        headers: { 'Content-Length': String(1024 * 1024 * 1024) },
      }, (response) => {
        response.resume()
        response.on('end', () => resolve(response.statusCode ?? 0))
      })
      request.on('error', reject)
      request.end()
    })

    expect(status).toBe(413)
    await expect(readdir(destinationParent)).resolves.toEqual([])
  })

  it('rejects a chunked body when accumulated bytes exceed the configured limit', async () => {
    const bridge = await import('./codexAppServerBridge') as unknown as {
      readRawBody?: (
        request: AsyncIterable<Buffer> & { headers: Record<string, string> },
        maxBytes: number,
      ) => Promise<Buffer>
    }
    const request = {
      headers: {},
      async *[Symbol.asyncIterator]() {
        yield Buffer.from('1234')
        yield Buffer.from('5678')
      },
    }

    expect(bridge.readRawBody).toBeTypeOf('function')
    await expect(bridge.readRawBody!(request, 5)).rejects.toMatchObject({
      name: 'RequestBodyTooLargeError',
    })
  })

  it('removes a partially created session file when its write fails', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-project-import-partial-session-'))
    const destinationParent = join(codexHome, 'destination')
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    await mkdir(destinationParent, { recursive: true })
    const zip = buildStoredProjectZip([
      { path: '.codex-project/manifest.json', data: JSON.stringify({ projectName: 'partial-session' }) },
      {
        path: '.codex-project/chats/sessions/source.jsonl',
        data: `${JSON.stringify({ type: 'session_meta', payload: { id: 'source', cwd: '/tmp/source' } })}\n`,
      },
    ])
    const bridge = await import('./codexAppServerBridge') as unknown as {
      importProjectZip: (
        buffer: Buffer,
        parent: string,
        operations: { writeSessionFile: (path: string, contents: string) => Promise<void> },
      ) => Promise<unknown>
    }

    await expect(bridge.importProjectZip(zip, destinationParent, {
      writeSessionFile: async (path) => {
        await writeFile(path, 'partial', 'utf8')
        throw new Error('simulated partial write failure')
      },
    })).rejects.toThrow('simulated partial write failure')
    await expect(stat(join(destinationParent, 'partial-session'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readdir(join(codexHome, 'sessions', 'imported')).catch(() => [])).resolves.toEqual([])
  })

  it('restores title eviction and workspace roots when project import rolls back after global-state commit', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-project-import-global-rollback-'))
    const destinationParent = join(codexHome, 'destination')
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    await mkdir(destinationParent, { recursive: true })
    const titles = Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`existing-${index}`, `Title ${index}`]))
    const originalState = {
      'thread-titles': { titles, order: Object.keys(titles) },
      'electron-saved-workspace-roots': ['/tmp/existing'],
      'electron-workspace-root-labels': { '/tmp/existing': 'Existing' },
      'active-workspace-roots': ['/tmp/existing'],
      'project-order': ['/tmp/existing'],
      untouched: { value: 1 },
    }
    await writeFile(join(codexHome, '.codex-global-state.json'), JSON.stringify(originalState), 'utf8')
    const zip = buildStoredProjectZip([
      { path: '.codex-project/manifest.json', data: JSON.stringify({ projectName: 'global-rollback' }) },
      {
        path: '.codex-project/chats/thread-titles.json',
        data: JSON.stringify({
          titles: { '.codex-project/chats/sessions/source.jsonl': 'Imported title' },
        }),
      },
      {
        path: '.codex-project/chats/sessions/source.jsonl',
        data: [
          JSON.stringify({ type: 'session_meta', payload: { id: 'source', cwd: '/tmp/source' } }),
          JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Imported title' } }),
          '',
        ].join('\n'),
      },
    ])
    const bridge = await import('./codexAppServerBridge') as unknown as {
      importProjectZip: (
        buffer: Buffer,
        parent: string,
        operations: { afterGlobalStatePersist: () => Promise<void> },
      ) => Promise<unknown>
      runBuiltinSqliteQueryCapture: (
        path: string, sql: string, json: boolean, timeoutMs: number,
      ) => Promise<string>
    }

    await bridge.runBuiltinSqliteQueryCapture(
      join(codexHome, 'state_5.sqlite'),
      'CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT);',
      false,
      5_000,
    )

    await expect(bridge.importProjectZip(zip, destinationParent, {
      afterGlobalStatePersist: async () => { throw new Error('simulated post-state failure') },
    })).rejects.toThrow('simulated post-state failure')

    await expect(readFile(join(codexHome, '.codex-global-state.json'), 'utf8').then(JSON.parse))
      .resolves.toEqual(originalState)
    const rows = JSON.parse(await bridge.runBuiltinSqliteQueryCapture(
      join(codexHome, 'state_5.sqlite'),
      'SELECT count(*) AS count FROM threads;',
      true,
      5_000,
    )) as Array<{ count: number }>
    expect(rows).toEqual([{ count: 0 }])
    await expect(readdir(join(codexHome, 'sessions', 'imported')).catch(() => [])).resolves.toEqual([])
    await expect(stat(join(destinationParent, 'global-rollback'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves unrelated global-state updates during project import rollback', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-project-import-concurrent-state-'))
    const destinationParent = join(codexHome, 'destination')
    const globalStatePath = join(codexHome, '.codex-global-state.json')
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    await mkdir(destinationParent, { recursive: true })
    await writeFile(globalStatePath, JSON.stringify({
      'thread-titles': { titles: { existing: 'Existing' }, order: ['existing'] },
      'electron-saved-workspace-roots': ['/tmp/existing'],
      'electron-workspace-root-labels': { '/tmp/existing': 'Existing' },
      'active-workspace-roots': ['/tmp/existing'],
      'project-order': ['/tmp/existing'],
    }), 'utf8')
    const zip = buildStoredProjectZip([
      { path: '.codex-project/manifest.json', data: JSON.stringify({ projectName: 'failed-import' }) },
      {
        path: '.codex-project/chats/sessions/source.jsonl',
        data: [
          JSON.stringify({ type: 'session_meta', payload: { id: 'source', cwd: '/tmp/source' } }),
          JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Imported title' } }),
          '',
        ].join('\n'),
      },
    ])
    const bridge = await import('./codexAppServerBridge') as unknown as {
      importProjectZip: (
        buffer: Buffer,
        parent: string,
        operations: { afterGlobalStatePersist: () => Promise<void> },
      ) => Promise<unknown>
    }

    await expect(bridge.importProjectZip(zip, destinationParent, {
      afterGlobalStatePersist: async () => {
        const current = JSON.parse(await readFile(globalStatePath, 'utf8')) as Record<string, unknown>
        current['thread-titles'] = {
          titles: { ...((current['thread-titles'] as { titles: Record<string, string> }).titles), concurrent: 'Concurrent' },
          order: ['concurrent', ...((current['thread-titles'] as { order: string[] }).order)],
        }
        current['electron-saved-workspace-roots'] = ['/tmp/concurrent', ...current['electron-saved-workspace-roots'] as string[]]
        current['electron-workspace-root-labels'] = {
          ...current['electron-workspace-root-labels'] as Record<string, string>,
          '/tmp/concurrent': 'Concurrent',
        }
        current['active-workspace-roots'] = ['/tmp/concurrent', ...current['active-workspace-roots'] as string[]]
        current['project-order'] = ['/tmp/concurrent', ...current['project-order'] as string[]]
        await writeFile(globalStatePath, JSON.stringify(current), 'utf8')
        throw new Error('simulated concurrent post-state failure')
      },
    })).rejects.toThrow('simulated concurrent post-state failure')

    const restored = JSON.parse(await readFile(globalStatePath, 'utf8')) as Record<string, unknown>
    expect(restored['thread-titles']).toEqual({
      titles: { concurrent: 'Concurrent', existing: 'Existing' },
      order: ['concurrent', 'existing'],
    })
    expect(restored['electron-saved-workspace-roots']).toEqual(['/tmp/concurrent', '/tmp/existing'])
    expect(restored['electron-workspace-root-labels']).toEqual({
      '/tmp/concurrent': 'Concurrent',
      '/tmp/existing': 'Existing',
    })
    expect(restored['active-workspace-roots']).toEqual(['/tmp/concurrent', '/tmp/existing'])
    expect(restored['project-order']).toEqual(['/tmp/concurrent', '/tmp/existing'])
  })

  it('does not restore a workspace root concurrently removed during failed import rollback', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-project-import-workspace-delete-'))
    const destinationParent = join(codexHome, 'destination')
    const globalStatePath = join(codexHome, '.codex-global-state.json')
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    await mkdir(destinationParent, { recursive: true })
    await writeFile(globalStatePath, JSON.stringify({
      'electron-saved-workspace-roots': ['/tmp/existing'],
      'electron-workspace-root-labels': { '/tmp/existing': 'Existing' },
      'active-workspace-roots': ['/tmp/existing'],
      'project-order': ['/tmp/existing'],
    }), 'utf8')
    const zip = buildStoredProjectZip([
      { path: '.codex-project/manifest.json', data: JSON.stringify({ projectName: 'failed-workspace-import' }) },
    ])
    const bridge = await import('./codexAppServerBridge') as unknown as {
      importProjectZip: (
        buffer: Buffer,
        parent: string,
        operations: { afterGlobalStatePersist: () => Promise<void> },
      ) => Promise<unknown>
    }

    await expect(bridge.importProjectZip(zip, destinationParent, {
      afterGlobalStatePersist: async () => {
        const current = JSON.parse(await readFile(globalStatePath, 'utf8')) as Record<string, unknown>
        current['electron-saved-workspace-roots'] = []
        current['electron-workspace-root-labels'] = {}
        current['active-workspace-roots'] = []
        current['project-order'] = []
        await writeFile(globalStatePath, JSON.stringify(current), 'utf8')
        throw new Error('simulated concurrent workspace removal')
      },
    })).rejects.toThrow('simulated concurrent workspace removal')

    const restored = JSON.parse(await readFile(globalStatePath, 'utf8')) as Record<string, unknown>
    expect(restored['electron-saved-workspace-roots']).toEqual([])
    expect(restored['electron-workspace-root-labels']).toEqual({})
    expect(restored['active-workspace-roots']).toEqual([])
    expect(restored['project-order']).toEqual([])
  })

  it('restores a pre-existing projectPath by anchors while preserving a concurrent prefix', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-project-import-existing-workspace-'))
    const destinationParent = join(codexHome, 'destination')
    const projectPath = join(destinationParent, 'existing-workspace')
    const globalStatePath = join(codexHome, '.codex-global-state.json')
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    await mkdir(destinationParent, { recursive: true })
    const originalState = {
      'thread-titles': { titles: {}, order: [] },
      'electron-saved-workspace-roots': ['/tmp/before', projectPath, '/tmp/after'],
      'electron-workspace-root-labels': {
        '/tmp/before': 'Before',
        [projectPath]: 'Original label',
        '/tmp/after': 'After',
      },
      'active-workspace-roots': ['/tmp/before', projectPath, '/tmp/after'],
      'project-order': ['/tmp/before', projectPath, '/tmp/after'],
    }
    await writeFile(globalStatePath, JSON.stringify(originalState), 'utf8')
    const zip = buildStoredProjectZip([
      { path: '.codex-project/manifest.json', data: JSON.stringify({ projectName: 'existing-workspace' }) },
    ])
    const bridge = await import('./codexAppServerBridge') as unknown as {
      importProjectZip: (
        buffer: Buffer,
        parent: string,
        operations: { afterGlobalStatePersist: () => Promise<void> },
      ) => Promise<unknown>
    }

    await expect(bridge.importProjectZip(zip, destinationParent, {
      afterGlobalStatePersist: async () => {
        const current = JSON.parse(await readFile(globalStatePath, 'utf8')) as Record<string, unknown>
        for (const key of [
          'electron-saved-workspace-roots',
          'active-workspace-roots',
          'project-order',
        ]) current[key] = ['/tmp/concurrent', ...current[key] as string[]]
        current['electron-workspace-root-labels'] = {
          ...current['electron-workspace-root-labels'] as Record<string, string>,
          '/tmp/concurrent': 'Concurrent',
        }
        await writeFile(globalStatePath, JSON.stringify(current), 'utf8')
        throw new Error('simulated existing workspace failure')
      },
    })).rejects.toThrow('simulated existing workspace failure')

    await expect(readFile(globalStatePath, 'utf8').then(JSON.parse)).resolves.toEqual({
      ...originalState,
      'electron-saved-workspace-roots': ['/tmp/concurrent', ...originalState['electron-saved-workspace-roots']],
      'electron-workspace-root-labels': {
        ...originalState['electron-workspace-root-labels'],
        '/tmp/concurrent': 'Concurrent',
      },
      'active-workspace-roots': ['/tmp/concurrent', ...originalState['active-workspace-roots']],
      'project-order': ['/tmp/concurrent', ...originalState['project-order']],
    })
  })

  it('caps title rollback when a concurrent update removes the imported title', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-project-import-title-delta-'))
    const destinationParent = join(codexHome, 'destination')
    const globalStatePath = join(codexHome, '.codex-global-state.json')
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    await mkdir(destinationParent, { recursive: true })
    const titles = Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`existing-${index}`, `Title ${index}`]))
    await writeFile(globalStatePath, JSON.stringify({
      'thread-titles': { titles, order: Object.keys(titles) },
    }), 'utf8')
    const zip = buildStoredProjectZip([
      { path: '.codex-project/manifest.json', data: JSON.stringify({ projectName: 'failed-title-import' }) },
      {
        path: '.codex-project/chats/thread-titles.json',
        data: JSON.stringify({
          titles: { '.codex-project/chats/sessions/source.jsonl': 'Imported title' },
        }),
      },
      {
        path: '.codex-project/chats/sessions/source.jsonl',
        data: [
          JSON.stringify({ type: 'session_meta', payload: { id: 'source', cwd: '/tmp/source' } }),
          JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Imported title' } }),
          '',
        ].join('\n'),
      },
    ])
    const bridge = await import('./codexAppServerBridge') as unknown as {
      importProjectZip: (
        buffer: Buffer,
        parent: string,
        operations: { afterGlobalStatePersist: () => Promise<void> },
      ) => Promise<unknown>
    }

    await expect(bridge.importProjectZip(zip, destinationParent, {
      afterGlobalStatePersist: async () => {
        const current = JSON.parse(await readFile(globalStatePath, 'utf8')) as {
          'thread-titles': { titles: Record<string, string>; order: string[] }
        }
        expect(current['thread-titles'].titles['existing-499']).toBeUndefined()
        expect(current['thread-titles'].titles['existing-498']).toBe('Title 498')
        const importedThreadId = current['thread-titles'].order.find((id) => !id.startsWith('existing-'))!
        current['thread-titles'].order = current['thread-titles'].order.filter((id) => id !== importedThreadId)
        delete current['thread-titles'].titles[importedThreadId]
        current['thread-titles'].order.unshift('concurrent')
        current['thread-titles'].titles.concurrent = 'Concurrent'
        await writeFile(globalStatePath, JSON.stringify(current), 'utf8')
        throw new Error('simulated concurrent title update')
      },
    })).rejects.toThrow('simulated concurrent title update')

    const restored = JSON.parse(await readFile(globalStatePath, 'utf8')) as {
      'thread-titles': { titles: Record<string, string>; order: string[] }
    }
    expect(restored['thread-titles'].order).toHaveLength(500)
    expect(restored['thread-titles'].order[0]).toBe('concurrent')
    expect(restored['thread-titles'].titles.concurrent).toBe('Concurrent')
    expect(restored['thread-titles'].titles['existing-499']).toBeUndefined()
    expect(restored['thread-titles'].titles['existing-498']).toBe('Title 498')
  })

  it('preserves a newly created shared schema while removing imported rows on rollback', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-project-import-new-db-rollback-'))
    const destinationParent = join(codexHome, 'destination')
    const stateDbPath = join(codexHome, 'state_5.sqlite')
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    await mkdir(destinationParent, { recursive: true })
    const zip = buildStoredProjectZip([
      { path: '.codex-project/manifest.json', data: JSON.stringify({ projectName: 'new-db-rollback' }) },
      {
        path: '.codex-project/chats/sessions/source.jsonl',
        data: `${JSON.stringify({ type: 'session_meta', payload: { id: 'source', cwd: '/tmp/source' } })}\n`,
      },
    ])
    const bridge = await import('./codexAppServerBridge') as unknown as {
      importProjectZip: (
        buffer: Buffer,
        parent: string,
        operations: { afterGlobalStatePersist: () => Promise<void> },
      ) => Promise<unknown>
    }

    await expect(bridge.importProjectZip(zip, destinationParent, {
      afterGlobalStatePersist: async () => { throw new Error('simulated post-state failure') },
    })).rejects.toThrow('simulated post-state failure')

    await expect(stat(stateDbPath)).resolves.toBeDefined()
    expect(spawnSync('sqlite3', [stateDbPath, "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'threads'; SELECT count(*) FROM threads;"], {
      encoding: 'utf8',
    }).stdout.trim().split('\n')).toEqual(['1', '0'])
  })

  it('bounds state-db rollback statements for large imported ID sets', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-project-import-bounded-rollback-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const ids = Array.from({ length: 205 }, (_, index) => `rollback-${String(index).padStart(3, '0')}`)
    const stateDbPath = join(codexHome, 'state_5.sqlite')
    expect(spawnSync('sqlite3', [stateDbPath], {
      input: [
        'CREATE TABLE threads (id TEXT PRIMARY KEY);',
        ...ids.map((id) => `INSERT INTO threads VALUES ('${id}');`),
      ].join(' '),
      encoding: 'utf8',
    }).status).toBe(0)
    const sqlitePath = spawnSync('which', ['sqlite3'], { encoding: 'utf8' }).stdout.trim()
    const sizesPath = join(codexHome, 'rollback-sizes.log')
    const shimPath = join(codexHome, 'sqlite-rollback-bounded.sh')
    await writeFile(shimPath, [
      '#!/bin/sh',
      'query_file="${TMPDIR:-/tmp}/codex-mobile-rollback-$$"',
      'trap \'rm -f "$query_file"\' EXIT',
      'cat > "$query_file"',
      `if grep -q 'DELETE FROM threads' "$query_file"; then wc -c < "$query_file" >> '${sizesPath}'; fi`,
      `exec '${sqlitePath}' "$@" < "$query_file"`,
      '',
    ].join('\n'))
    await chmod(shimPath, 0o755)
    const originalSqliteCommand = process.env.CODEXUI_SQLITE_COMMAND
    process.env.CODEXUI_SQLITE_COMMAND = shimPath
    disposers.push(() => {
      if (originalSqliteCommand === undefined) delete process.env.CODEXUI_SQLITE_COMMAND
      else process.env.CODEXUI_SQLITE_COMMAND = originalSqliteCommand
    })
    const bridge = await import('./codexAppServerBridge') as unknown as {
      removeImportedSessionsFromStateDb: (ids: readonly string[]) => Promise<void>
      runBuiltinSqliteQueryCapture: (
        path: string, sql: string, json: boolean, timeoutMs: number,
      ) => Promise<string>
    }

    await bridge.removeImportedSessionsFromStateDb(ids)

    const sizes = (await readFile(sizesPath, 'utf8')).trim().split('\n').map(Number)
    expect(sizes).toHaveLength(1)
    expect(Math.max(...sizes)).toBeLessThan(8_192)
    await expect(bridge.runBuiltinSqliteQueryCapture(
      stateDbPath, 'SELECT count(*) AS count FROM threads;', true, 5_000,
    ).then((value) => JSON.parse(value))).resolves.toEqual([{ count: 0 }])
  })

  it('keeps every state-db row when rollback staging fails partway through', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-project-import-atomic-rollback-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const ids = Array.from({ length: 130 }, (_, index) => `atomic-rollback-${String(index).padStart(3, '0')}`)
    const stateDbPath = join(codexHome, 'state_5.sqlite')
    expect(spawnSync('sqlite3', [stateDbPath], {
      input: [
        'CREATE TABLE threads (id TEXT PRIMARY KEY);',
        ...ids.map((id) => `INSERT INTO threads VALUES ('${id}');`),
      ].join(' '),
      encoding: 'utf8',
    }).status).toBe(0)
    const sqlitePath = spawnSync('which', ['sqlite3'], { encoding: 'utf8' }).stdout.trim()
    const countPath = join(codexHome, 'rollback-count')
    const shimPath = join(codexHome, 'sqlite-rollback-atomic.sh')
    await writeFile(shimPath, [
      '#!/bin/sh',
      'query_file="${TMPDIR:-/tmp}/codex-mobile-rollback-atomic-$$"',
      'trap \'rm -f "$query_file"\' EXIT',
      'cat > "$query_file"',
      `if grep -q 'INSERT OR IGNORE INTO codex_mobile_rollback_' "$query_file"; then`,
      `  count=$(cat '${countPath}' 2>/dev/null || printf 0)`,
      `  count=$((count + 1))`,
      `  printf '%s' "$count" > '${countPath}'`,
      `  if [ "$count" -eq 2 ]; then exit 1; fi`,
      'fi',
      `exec '${sqlitePath}' "$@" < "$query_file"`,
      '',
    ].join('\n'))
    await chmod(shimPath, 0o755)
    const originalSqliteCommand = process.env.CODEXUI_SQLITE_COMMAND
    process.env.CODEXUI_SQLITE_COMMAND = shimPath
    disposers.push(() => {
      if (originalSqliteCommand === undefined) delete process.env.CODEXUI_SQLITE_COMMAND
      else process.env.CODEXUI_SQLITE_COMMAND = originalSqliteCommand
    })
    const bridge = await import('./codexAppServerBridge') as unknown as {
      removeImportedSessionsFromStateDb: (ids: readonly string[]) => Promise<void>
      runBuiltinSqliteQueryCapture: (
        path: string, sql: string, json: boolean, timeoutMs: number,
      ) => Promise<string>
    }

    await expect(bridge.removeImportedSessionsFromStateDb(ids)).rejects.toThrow()

    await expect(bridge.runBuiltinSqliteQueryCapture(
      stateDbPath, 'SELECT count(*) AS count FROM threads;', true, 5_000,
    ).then((value) => JSON.parse(value))).resolves.toEqual([{ count: ids.length }])
  })

  it('fails closed when an archive appears during a fresh index scan', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-archive-index-race-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const archivedRoot = join(codexHome, 'archived_sessions')
    await mkdir(archivedRoot)
    const threadId = '019fd126-4567-7890-a123-456789abcdee'
    let injected = false
    const bridge = await import('./codexAppServerBridge') as unknown as {
      readArchivedThreadIndexRecord?: (
        root: string,
        fresh: boolean,
        operations: {
          readDirectory: (path: string) => Promise<Array<{
            name: string
            isDirectory: () => boolean
            isFile: () => boolean
          }>>
        },
      ) => Promise<{ ids: Set<string> }>
    }

    expect(bridge.readArchivedThreadIndexRecord).toBeTypeOf('function')
    await expect(bridge.readArchivedThreadIndexRecord!(archivedRoot, true, {
      readDirectory: async (path) => {
        const entries = await readdir(path, { withFileTypes: true })
        if (!injected) {
          injected = true
          await writeFile(
            join(archivedRoot, archivedRolloutFileName(threadId)),
            `${JSON.stringify({ type: 'session_meta', payload: { id: threadId } })}\n`,
          )
        }
        return entries
      },
    })).rejects.toThrow('Cannot verify archived task state')
  })

  it('revalidates the archive root after scanning child directories', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-archive-index-root-revalidation-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const archivedRoot = join(codexHome, 'archived_sessions')
    const child = join(archivedRoot, 'child')
    await mkdir(child, { recursive: true })
    let injected = false
    const bridge = await import('./codexAppServerBridge') as unknown as {
      readArchivedThreadIndexRecord: (
        root: string,
        fresh: boolean,
        operations: {
          readDirectory: (path: string) => Promise<Array<{
            name: string
            isDirectory: () => boolean
            isFile: () => boolean
          }>>
        },
      ) => Promise<unknown>
    }

    await expect(bridge.readArchivedThreadIndexRecord(archivedRoot, true, {
      readDirectory: async (path) => {
        const entries = await readdir(path, { withFileTypes: true })
        if (path === child && !injected) {
          injected = true
          const id = '019fd126-4567-7890-a123-456789abcdec'
          await writeFile(
            join(archivedRoot, archivedRolloutFileName(id)),
            `${JSON.stringify({ type: 'session_meta', payload: { id } })}\n`,
          )
        }
        return entries
      },
    })).rejects.toThrow('Cannot verify archived task state')
  })

  it('accounts for crash-orphaned cursor snapshot temporary files', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-cursor-temp-prune-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const snapshotRoot = join(codexHome, 'codex-mobile-cache', 'thread-list-cursor-state')
    await mkdir(snapshotRoot, { recursive: true })
    const temporaryName = '00000000-0000-4000-8000-000000000000.json.11111111-1111-4111-8111-111111111111.tmp'
    const temporaryPath = join(snapshotRoot, temporaryName)
    await writeFile(temporaryPath, '')
    await truncate(temporaryPath, 128 * 1024 * 1024)

    await writeThreadListSeenImportedIds(
      null,
      new Set(),
      Array.from({ length: 40 }, (_, index) => `temp-prune-${index}`),
    )

    await expect(stat(temporaryPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(snapshotRoot)).toHaveLength(1)
  })

  it('removes a stale cursor-key temporary file on restart', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-cursor-key-temp-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const cacheRoot = join(codexHome, 'codex-mobile-cache')
    await mkdir(cacheRoot)
    const temporaryPath = join(
      cacheRoot,
      '.thread-list-cursor-key.11111111-1111-4111-8111-111111111111.tmp',
    )
    await writeFile(temporaryPath, 'orphan', { mode: 0o600 })
    const staleTime = new Date(Date.now() - 10 * 60_000)
    await utimes(temporaryPath, staleTime, staleTime)

    await writeThreadListSeenImportedIds(
      null,
      new Set(),
      Array.from({ length: 40 }, (_, index) => `key-temp-${index}`),
    )

    await expect(stat(temporaryPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('distinguishes same-size same-mtime session-index replacements', () => {
    const first = getSessionIndexFileSignature({
      mtimeMs: 1,
      ctimeMs: 2,
      size: 3,
      ino: 4,
      dev: 5,
    })
    const replacement = getSessionIndexFileSignature({
      mtimeMs: 1,
      ctimeMs: 6,
      size: 3,
      ino: 7,
      dev: 5,
    })

    expect(replacement).not.toBe(first)
  })

  it('serializes concurrent snapshot writers for the same cache root', async () => {
    let active = 0
    let maximumActive = 0
    const calls = Array.from({ length: 32 }, (_, index) => (
      withThreadListCursorSnapshotWriteLock('/tmp/cursor-snapshot-lock-test', async () => {
        active += 1
        maximumActive = Math.max(maximumActive, active)
        await new Promise((resolve) => setTimeout(resolve, index % 2))
        active -= 1
      })
    ))

    await Promise.all(calls)
    expect(maximumActive).toBe(1)
  })

  it('holds a filesystem lock while mutating cursor snapshots', async () => {
    const snapshotRoot = await mkdtemp(join(tmpdir(), 'codex-mobile-cursor-lock-'))
    disposers.push(() => rm(snapshotRoot, { recursive: true, force: true }))
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let entered!: () => void
    const enteredGate = new Promise<void>((resolve) => { entered = resolve })
    const mutation = withThreadListCursorSnapshotWriteLock(snapshotRoot, async () => {
      entered()
      await gate
    })

    await enteredGate
    expect(await readdir(snapshotRoot)).toContain('.write-lock')
    release()
    await mutation
    expect(await readdir(snapshotRoot)).not.toContain('.write-lock')
  })
})

describe('external thread runtime bridge augmentation', () => {
  it('canonicalizes a stale interrupted CLI turn as the single running projection', async () => {
    const probe = fakeProbe({
      state: 'running',
      turnId: 'turn-cli',
      interruptible: false,
      source: 'external-session-writer',
    })
    const payload = {
      thread: {
        id: 'thread-cli',
        path: '/home/user/.codex/sessions/rollout-thread-cli.jsonl',
        status: { type: 'notLoaded' },
        turns: [{
          id: 'turn-cli',
          status: 'interrupted',
          items: [{ id: 'agent-existing', type: 'agentMessage', text: 'existing output' }],
        }],
      },
    }

    await expect(augmentThreadResultWithExternalRuntime(
      'thread/read',
      payload,
      probe,
      4242,
    )).resolves.toEqual({
      thread: {
        ...payload.thread,
        turns: [{
          id: 'turn-cli',
          status: 'inProgress',
          items: [{ id: 'agent-existing', type: 'agentMessage', text: 'existing output' }],
        }],
        externalRuntime: {
          state: 'running',
          turnId: 'turn-cli',
          interruptible: false,
          source: 'external-session-writer',
        },
      },
    })
    expect(payload.thread.turns[0]?.status).toBe('interrupted')
  })

  it('attaches external runtime to an idle thread without mutating the sanitized response', async () => {
    const probe = fakeProbe({
      state: 'running',
      turnId: 'turn-external',
      interruptible: false,
      source: 'external-session-writer',
    })
    const thread = {
      id: 'thread-1',
      path: '/home/user/.codex/sessions/rollout-thread-1.jsonl',
      status: { type: 'idle' },
      turns: [{ id: 'turn-complete', status: 'completed' }],
    }
    const payload = { thread }

    const result = await augmentThreadResultWithExternalRuntime(
      'thread/read',
      payload,
      probe,
      4242,
    ) as { thread: Record<string, unknown> }

    expect(result).not.toBe(payload)
    expect(result.thread).not.toBe(thread)
    expect(payload).toEqual({ thread })
    expect(result.thread.externalRuntime).toEqual({
      state: 'running',
      turnId: 'turn-external',
      interruptible: false,
      source: 'external-session-writer',
    })
    expect(result.thread.status).toEqual({ type: 'idle' })
    expect(probe.registerThread).toHaveBeenCalledWith(
      'thread-1',
      '/home/user/.codex/sessions/rollout-thread-1.jsonl',
    )
    expect(probe.inspect).toHaveBeenCalledWith('thread-1', 4242)
  })

  it('lets a confirmed external writer override an active app-server status', async () => {
    const probe = fakeProbe({
      state: 'running',
      turnId: 'turn-external',
      interruptible: false,
      source: 'external-session-writer',
    })
    const payload = {
      thread: {
        id: 'thread-1',
        path: '/home/user/.codex/sessions/rollout-thread-1.jsonl',
        status: { type: 'active' },
        turns: [{ id: 'turn-local', status: 'inProgress' }],
      },
    }

    await expect(augmentThreadResultWithExternalRuntime(
      'thread/resume',
      payload,
      probe,
      4242,
    )).resolves.toEqual({
      thread: {
        ...payload.thread,
        externalRuntime: {
          state: 'running',
          turnId: 'turn-external',
          interruptible: false,
          source: 'external-session-writer',
        },
      },
    })
    expect(probe.registerThread).toHaveBeenCalledOnce()
    expect(probe.inspect).toHaveBeenCalledWith('thread-1', 4242)
  })

  it('attaches unknown writer evidence to an active thread so clients fail closed', async () => {
    const probe = fakeProbe({ state: 'unknown' })
    const payload = {
      thread: {
        id: 'thread-unknown',
        path: '/home/user/.codex/sessions/rollout-thread-unknown.jsonl',
        status: { type: 'active' },
        turns: [{ id: 'turn-observed', status: 'inProgress' }],
      },
    }

    await expect(augmentThreadResultWithExternalRuntime(
      'thread/read',
      payload,
      probe,
      4242,
    )).resolves.toEqual({
      thread: {
        ...payload.thread,
        externalRuntime: { state: 'unknown' },
      },
    })
    expect(probe.inspect).toHaveBeenCalledWith('thread-unknown', 4242)
  })

  it('preserves local app-server ownership on ordinary thread reads after refresh', async () => {
    const probe = fakeProbe({
      state: 'running',
      turnId: 'turn-external-stale',
      interruptible: false,
      source: 'external-session-writer',
    })
    const localRuntimeLedger = {
      getRunning: vi.fn((threadId: string) => ({ threadId, turnId: 'turn-local-mobile' })),
    }
    const payload = {
      thread: {
        id: 'thread-local-refresh',
        path: '/home/user/.codex/sessions/rollout-thread-local-refresh.jsonl',
        status: { type: 'active' },
        turns: [{ id: 'turn-stale', status: 'completed' }],
      },
    }

    await expect(augmentThreadResultWithExternalRuntime(
      'thread/read',
      payload,
      probe,
      4242,
      localRuntimeLedger,
    )).resolves.toEqual({
      thread: {
        ...payload.thread,
        externalRuntime: {
          state: 'running',
          turnId: 'turn-local-mobile',
          interruptible: true,
          source: 'local-app-server',
        },
      },
    })
    expect(probe.inspect).toHaveBeenCalledWith('thread-local-refresh', 4242)
    expect(localRuntimeLedger.getRunning).toHaveBeenCalledWith('thread-local-refresh')
  })

  it('attaches batch runtime observations to thread-list rows', async () => {
    const probe = fakeProbe({ state: 'idle' })
    probe.inspectMany.mockResolvedValue({
      'thread-a': {
        state: 'running',
        turnId: 'turn-external',
        interruptible: false,
        source: 'external-session-writer',
      },
      'thread-b': { state: 'idle' },
    })
    const payload = {
      data: [
        { id: 'thread-a', path: '/sessions/a.jsonl' },
        { id: 'thread-b', path: '/sessions/b.jsonl' },
        { id: '', path: '/sessions/invalid.jsonl' },
      ],
    }

    await expect(augmentThreadResultWithExternalRuntime(
      'thread/list', payload, probe, 4242,
    )).resolves.toEqual({
      data: [
        {
          id: 'thread-a',
          path: '/sessions/a.jsonl',
          externalRuntime: {
            state: 'running',
            turnId: 'turn-external',
            interruptible: false,
            source: 'external-session-writer',
          },
        },
        { id: 'thread-b', path: '/sessions/b.jsonl', externalRuntime: { state: 'idle' } },
        { id: '', path: '/sessions/invalid.jsonl' },
      ],
    })
    expect(probe.registerThread.mock.calls).toEqual([
      ['thread-a', '/sessions/a.jsonl'],
      ['thread-b', '/sessions/b.jsonl'],
    ])
    expect(probe.inspect).not.toHaveBeenCalled()
    expect(probe.inspectMany).toHaveBeenCalledWith(['thread-a', 'thread-b'], 4242)
  })
})

const disposers: Array<() => void | Promise<void>> = []
const originalCodexHome = process.env.CODEX_HOME
let isolatedCodexHome = ''

beforeAll(async () => {
  isolatedCodexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-runtime-bridge-test-home-'))
  process.env.CODEX_HOME = isolatedCodexHome
})

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  vi.restoreAllMocks()
})

afterAll(async () => {
  if (isolatedCodexHome) await rm(isolatedCodexHome, { recursive: true, force: true })
  isolatedCodexHome = ''
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodexHome
})

function sharedBridgeForTest() {
  const shared = (globalThis as typeof globalThis & {
    __codexRemoteSharedBridge__: {
      localRuntimeLedger: {
        record: (notification: { method: string; params: unknown }) => void
      }
      runtimeProbe: {
        inspect: (threadId: string, excludedPid: number | null) => Promise<ExternalThreadRuntime>
        inspectMany: (
          threadIds: readonly string[],
          excludedPid: number | null,
        ) => Promise<Record<string, ExternalThreadRuntime>>
        interrupt: (
          threadId: string,
          turnId: string,
          excludedPid: number | null,
        ) => Promise<{ interrupted: boolean; reason?: string }>
        inspectWriterEvidence: (threadId: string, excludedPid: number | null) => Promise<boolean | null>
        inspectWriterEvidenceSnapshot: (
          threadId: string,
          excludedPid: number | null,
        ) => Promise<{
          writers: string[]
          rollout?: { path: string; dev: string; ino: string; size: number }
        } | null>
        inspectUnexpectedLifecycleSince: (
          threadId: string,
          baseline: { writers: string[] },
          expectedTurnId: string,
        ) => Promise<boolean | null>
      }
      appServer: {
        getPid: () => number | null
        invalidateThreadListRpcCache: () => void
      }
    }
  }).__codexRemoteSharedBridge__
  if (!vi.isMockFunction(shared.runtimeProbe.inspectWriterEvidence)) {
    vi.spyOn(shared.runtimeProbe, 'inspectWriterEvidence').mockResolvedValue(false)
  }
  if (!vi.isMockFunction(shared.runtimeProbe.inspectWriterEvidenceSnapshot)) {
    vi.spyOn(shared.runtimeProbe, 'inspectWriterEvidenceSnapshot').mockImplementation(async (threadId, excludedPid) => {
      const evidence = await shared.runtimeProbe.inspectWriterEvidence(threadId, excludedPid)
      return evidence === null ? null : { writers: evidence ? ['legacy-writer-evidence'] : [] }
    })
  }
  return shared
}

function storePassiveThreadSnapshot(threadId: string, path: string, turns: unknown[] = []): void {
  const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
    appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
      storeThreadReadSnapshot: (id: string, snapshot: unknown) => void
    }
  }
  shared.appServer.storeThreadReadSnapshot(threadId, {
    thread: { id: threadId, path, turns },
  })
}

async function listenWithMiddleware(middleware: ReturnType<typeof createCodexBridgeMiddleware>) {
  const server = createServer((req, res) => {
    void middleware(req, res, () => {
      res.statusCode = 404
      res.end()
    })
  })
  disposers.push(() => {
    middleware.dispose()
    server.close()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

describe('GET /codex-api/thread-turn-page native pagination', () => {
  it('keeps a native cursor in the native pagination domain when a local rollout appears', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-native-cursor-domain-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (method, params) => {
      if (method !== 'thread/turns/list') throw new Error(`unexpected RPC ${method}`)
      const cursor = (params as { cursor?: string | null }).cursor ?? null
      return cursor === null
        ? { data: [{ id: 'turn-native-new', status: 'completed', items: [] }], nextCursor: 'native-older' }
        : { data: [{ id: 'turn-native-old', status: 'completed', items: [] }], nextCursor: null }
    })
    const port = await listenWithMiddleware(middleware)

    const firstResponse = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-turn-page?threadId=thread-native-domain&limit=3`,
    )
    const firstPayload = await firstResponse.json() as { nextCursor?: string | null }
    expect(firstPayload.nextCursor).toBe('native-older')

    const sessionsDir = join(codexHome, 'sessions')
    await mkdir(sessionsDir, { recursive: true })
    await writeFile(join(sessionsDir, 'rollout-thread-native-domain.jsonl'), [
      JSON.stringify({ type: 'session_meta', payload: { id: 'thread-native-domain' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-local' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-local' } }),
      '',
    ].join('\n'))

    const secondResponse = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-turn-page?threadId=thread-native-domain&cursor=native-older&limit=3`,
    )
    const secondPayload = await secondResponse.json() as {
      result?: { thread?: { turns?: Array<{ id?: string }> } }
    }

    expect(secondResponse.status).toBe(200)
    expect(secondPayload.result?.thread?.turns?.map((turn) => turn.id)).toEqual(['turn-native-old'])
    expect(rpc).toHaveBeenLastCalledWith('thread/turns/list', expect.objectContaining({
      threadId: 'thread-native-domain',
      cursor: 'native-older',
    }))
  })

  it('uses thread/turns/list without materializing full thread history', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (method, params) => {
      if (method === 'thread/read' && (params as { includeTurns?: boolean }).includeTurns === true) {
        throw new Error('full history read forbidden')
      }
      if (method === 'thread/turns/list') {
        return {
          data: [
            {
              id: 'turn-5',
              status: 'inProgress',
              items: [
                { id: 'reasoning-5', type: 'reasoning', summary: ['live'], content: [] },
                { id: 'message-5', type: 'agentMessage', text: 'latest' },
              ],
            },
            {
              id: 'turn-4',
              status: 'completed',
              items: [
                { id: 'reasoning-4', type: 'reasoning', summary: ['old'], content: [] },
                { id: 'message-4', type: 'agentMessage', text: 'older' },
              ],
            },
          ],
          nextCursor: 'older-page',
          backwardsCursor: 'newer-page',
        }
      }
      throw new Error(`unexpected RPC ${method}`)
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-turn-page?threadId=thread-1&limit=5`,
    )
    const payload = await response.json() as {
      result?: { thread?: { turns?: Array<{ id?: string; items?: Array<{ id?: string }> }> } }
      nextCursor?: string | null
      hasMoreOlder?: boolean
    }

    expect(response.status).toBe(200)
    expect(rpc).toHaveBeenCalledWith('thread/turns/list', {
      threadId: 'thread-1',
      cursor: null,
      limit: 5,
      sortDirection: 'desc',
      itemsView: 'full',
    })
    expect(rpc).not.toHaveBeenCalledWith('thread/read', expect.objectContaining({
      includeTurns: true,
    }))
    expect(payload.nextCursor).toBe('older-page')
    expect(payload.hasMoreOlder).toBe(true)
    expect(payload.result?.thread?.turns?.map((turn) => turn.id)).toEqual(['turn-4', 'turn-5'])
    expect(payload.result?.thread?.turns?.[0]?.items?.map((item) => item.id)).toEqual(['message-4'])
    expect(payload.result?.thread?.turns?.[1]?.items?.map((item) => item.id)).toEqual([
      'reasoning-5',
      'message-5',
    ])
  })

  it('limits native historical turn summaries instead of returning every assistant segment', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/turns/list') {
        return {
          data: [
            {
              id: 'turn-history',
              status: 'completed',
              items: [
                {
                  id: 'user-history',
                  type: 'userMessage',
                  content: [{ type: 'text', text: 'old prompt' }],
                },
                ...Array.from({ length: 20 }, (_, index) => ({
                  id: `agent-history-${index}`,
                  type: 'agentMessage',
                  text: `old assistant segment ${index}`,
                })),
              ],
            },
          ],
          nextCursor: null,
          backwardsCursor: null,
        }
      }
      throw new Error(`unexpected RPC ${method}`)
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-turn-page?threadId=thread-1&limit=3`,
    )
    const payload = await response.json() as {
      result?: { thread?: { turns?: Array<{ id?: string; items?: Array<{ id?: string }> }> } }
    }

    expect(response.status).toBe(200)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(payload.result?.thread?.turns?.[0]?.items?.map((item) => item.id)).toEqual([
      'user-history',
      'agent-history-12',
      'agent-history-13',
      'agent-history-14',
      'agent-history-15',
      'agent-history-16',
      'agent-history-17',
      'agent-history-18',
      'agent-history-19',
    ])
  })

  it('compacts a running active turn out of cold turn pages when activeTurnId is known', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    const activeItems = Array.from({ length: 130 }, (_, index) => ({
      id: `active-${index}`,
      type: 'agentMessage',
      text: `stale active output ${index}`,
    }))
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (method, params) => {
      if (method === 'thread/turns/list') {
        expect(params).toMatchObject({
          threadId: 'thread-1',
          cursor: null,
          limit: 3,
          sortDirection: 'desc',
          itemsView: 'full',
        })
        return {
          data: [
            {
              id: 'turn-live',
              status: 'interrupted',
              items: activeItems,
            },
            {
              id: 'turn-old',
              status: 'completed',
              items: [
                {
                  id: 'delegation-old',
                  type: 'userMessage',
                  content: [{
                    type: 'text',
                    text: '<codex_delegation>\n<input>visible native handoff</input>\n</codex_delegation>',
                  }],
                },
                {
                  id: 'user-old',
                  type: 'userMessage',
                  content: [{ type: 'text', text: 'old prompt' }],
                },
                { id: 'reasoning-old', type: 'reasoning', summary: ['old'], content: [] },
                {
                  id: 'command-old',
                  type: 'commandExecution',
                  command: 'printf stale',
                  aggregatedOutput: 'stale command output',
                },
                {
                  id: 'progress-old',
                  type: 'agentMessage',
                  phase: 'commentary',
                  text: 'old commentary progress',
                },
                {
                  id: 'message-old',
                  type: 'agentMessage',
                  phase: 'final',
                  text: 'old visible text',
                },
              ],
            },
          ],
          nextCursor: 'older-page',
          backwardsCursor: null,
        }
      }
      throw new Error(`unexpected RPC ${method}`)
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-turn-page?threadId=thread-1&activeTurnId=turn-live&limit=3`,
    )
    const payload = await response.json() as {
      result?: {
        thread?: {
          turns?: Array<{
            id?: string
            status?: string
            items?: Array<{ id?: string; type?: string; text?: string }>
            rawItemCompression?: {
              originalItemCount?: number
              retainedItemCount?: number
              omittedItemCount?: number
            }
          }>
        }
      }
    }
    const turns = payload.result?.thread?.turns ?? []
    const activeTurn = turns.find((turn) => turn.id === 'turn-live')
    const oldTurn = turns.find((turn) => turn.id === 'turn-old')

    expect(response.status).toBe(200)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(oldTurn?.items?.map((item) => item.id)).toEqual(['delegation-old', 'user-old', 'progress-old', 'message-old'])
    expect(JSON.stringify(payload)).toContain('codex_delegation')
    expect(JSON.stringify(payload)).toContain('visible native handoff')
    expect(activeTurn).toMatchObject({
      status: 'inProgress',
      items: [],
      rawItemCompression: {
        originalItemCount: 130,
        retainedItemCount: 0,
        omittedItemCount: 130,
      },
    })
    expect(JSON.stringify(payload)).not.toContain('stale active output')
    expect(JSON.stringify(payload)).not.toContain('stale command output')
  })

  it('recovers newest local rollout turns when the native turn page is empty', async () => {
    const dir = join(process.env.CODEX_HOME ?? isolatedCodexHome, 'sessions')
    await mkdir(dir, { recursive: true })
    const rolloutPath = join(dir, 'thread-recovered.jsonl')
    const lines = [
      { type: 'session_meta', payload: { id: 'thread-recovered' } },
      {
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-old' },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'msg-user-old',
          role: 'user',
          content: [{ type: 'input_text', text: 'old prompt' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'msg-assistant-old',
          role: 'assistant',
          phase: 'commentary',
          content: [{ type: 'output_text', text: 'old visible progress' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'msg-subagent-hidden',
          role: 'user',
          content: [{ type: 'input_text', text: '<subagent_notification>\n{"status":{"completed":"hidden"}}' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'msg-goal-context-hidden',
          role: 'user',
          content: [{
            type: 'input_text',
            text: '<codex_internal_context source="goal">\nDo not render this internal goal context.\n</codex_internal_context>',
          }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'msg-encoded-goal-context-hidden',
          role: 'user',
          content: [{
            type: 'input_text',
            text: '&lt;codex_internal_context source="goal"&gt;\nDo not render this encoded internal goal context.\n&lt;/codex_internal_context&gt;',
          }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'msg-ordinary-similar-prefix',
          role: 'user',
          content: [{
            type: 'input_text',
            text: '<codex_internal_contextual source="user">visible ordinary text</codex_internal_contextual>',
          }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'msg-delegation-visible',
          role: 'user',
          content: [{ type: 'input_text', text: '<codex_delegation>\n<input>visible handoff</input>\n</codex_delegation>' }],
        },
      },
      {
        type: 'event_msg',
        payload: { type: 'turn_aborted', turn_id: 'turn-old' },
      },
      {
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-active' },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'msg-user-active',
          role: 'user',
          content: [{ type: 'input_text', text: 'continue' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'msg-assistant-active',
          role: 'assistant',
          phase: 'commentary',
          content: [{ type: 'output_text', text: 'active text served by text page' }],
        },
      },
    ]
    await writeFile(rolloutPath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (method, params) => {
      if (method === 'thread/turns/list') {
        return {
          data: [],
          nextCursor: null,
          backwardsCursor: null,
        }
      }
      throw new Error(`unexpected RPC ${method}`)
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-turn-page?threadId=thread-recovered&activeTurnId=turn-active&limit=3`,
    )
    const payload = await response.json() as {
      result?: {
        thread?: {
          turns?: Array<{
            id?: string
            status?: string
            items?: Array<{ id?: string; type?: string; text?: string; content?: Array<{ text?: string }> }>
          }>
        }
      }
    }
    const turns = payload.result?.thread?.turns ?? []

    expect(response.status).toBe(200)
    expect(rpc).not.toHaveBeenCalledWith('thread/read', expect.anything())
    expect(turns.map((turn) => turn.id)).toEqual(['turn-old', 'turn-active'])
    expect(turns[0]?.items?.map((item) => item.id)).toEqual([
      'msg-user-old',
      'msg-assistant-old',
      'msg-ordinary-similar-prefix',
      'msg-delegation-visible',
    ])
    expect(turns[0]?.items?.map((item) => item.text)).toContain('old visible progress')
    expect(turns[0]?.items?.find((item) => item.id === 'msg-ordinary-similar-prefix')?.content?.[0]?.text)
      .toBe('<codex_internal_contextual source="user">visible ordinary text</codex_internal_contextual>')
    expect(turns[0]?.items?.find((item) => item.id === 'msg-delegation-visible')?.content?.[0]?.text)
      .toBe('<codex_delegation>\n<input>visible handoff</input>\n</codex_delegation>')
    expect(turns[1]).toMatchObject({
      id: 'turn-active',
      status: 'inProgress',
      items: [],
    })
    expect(JSON.stringify(payload)).not.toContain('subagent_notification')
    expect(JSON.stringify(payload)).not.toContain('codex_internal_context source')
    expect(JSON.stringify(payload)).not.toContain('Do not render this internal goal context')
    expect(JSON.stringify(payload)).not.toContain('Do not render this encoded internal goal context')
    expect(JSON.stringify(payload)).toContain('codex_delegation')
    expect(JSON.stringify(payload)).toContain('visible handoff')
    expect(JSON.stringify(payload)).not.toContain('active text served by text page')
  })

  it('keeps older recovered local rollout turns reachable with a fallback cursor', async () => {
    const dir = join(process.env.CODEX_HOME ?? isolatedCodexHome, 'sessions')
    await mkdir(dir, { recursive: true })
    const rolloutPath = join(dir, 'thread-recovered-cursor.jsonl')
    const lines = [
      { type: 'session_meta', payload: { id: 'thread-recovered-cursor' } },
      ...Array.from({ length: 5 }, (_, index) => {
        const turnNumber = index + 1
        return [
          {
            type: 'event_msg',
            payload: { type: 'task_started', turn_id: `turn-${turnNumber}` },
          },
          {
            type: 'response_item',
            payload: {
              type: 'message',
              id: `msg-user-${turnNumber}`,
              role: 'user',
              content: [{ type: 'input_text', text: `prompt ${turnNumber}` }],
            },
          },
          {
            type: 'response_item',
            payload: {
              type: 'message',
              id: `msg-assistant-${turnNumber}`,
              role: 'assistant',
              phase: 'final',
              content: [{ type: 'output_text', text: `answer ${turnNumber}` }],
            },
          },
          {
            type: 'event_msg',
            payload: { type: 'task_complete', turn_id: `turn-${turnNumber}` },
          },
        ]
      }).flat(),
    ]
    await writeFile(rolloutPath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (method, params) => {
      if (method === 'thread/turns/list') {
        return {
          data: [],
          nextCursor: null,
          backwardsCursor: null,
        }
      }
      throw new Error(`unexpected RPC ${method}`)
    })
    const port = await listenWithMiddleware(middleware)

    const firstResponse = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-turn-page?threadId=thread-recovered-cursor&limit=3`,
    )
    const firstPayload = await firstResponse.json() as {
      result?: { thread?: { turns?: Array<{ id?: string }> } }
      nextCursor?: string | null
      hasMoreOlder?: boolean
    }

    expect(firstResponse.status).toBe(200)
    expect(firstPayload.result?.thread?.turns?.map((turn) => turn.id)).toEqual(['turn-3', 'turn-4', 'turn-5'])
    expect(firstPayload.nextCursor).toEqual(expect.stringMatching(/^local-rollout-turns:/u))
    expect(firstPayload.hasMoreOlder).toBe(true)

    const secondResponse = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-turn-page?threadId=thread-recovered-cursor&cursor=${encodeURIComponent(firstPayload.nextCursor ?? '')}&limit=3`,
    )
    const secondPayload = await secondResponse.json() as {
      result?: { thread?: { turns?: Array<{ id?: string }> } }
      nextCursor?: string | null
      hasMoreOlder?: boolean
    }

    expect(secondResponse.status).toBe(200)
    expect(secondPayload.result?.thread?.turns?.map((turn) => turn.id)).toEqual(['turn-1', 'turn-2'])
    expect(secondPayload.nextCursor).toBeNull()
    expect(secondPayload.hasMoreOlder).toBe(false)
    expect(rpc).not.toHaveBeenCalledWith('thread/turns/list', expect.objectContaining({
      cursor: firstPayload.nextCursor,
    }))
    expect(rpc).not.toHaveBeenCalledWith('thread/read', expect.anything())
  })

  it('compacts recovered in-progress rollout turns even when activeTurnId is unknown', async () => {
    const dir = join(process.env.CODEX_HOME ?? isolatedCodexHome, 'sessions')
    await mkdir(dir, { recursive: true })
    const rolloutPath = join(dir, 'thread-recovered-active.jsonl')
    const lines = [
      { type: 'session_meta', payload: { id: 'thread-recovered-active' } },
      {
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-old' },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'msg-user-old',
          role: 'user',
          content: [{ type: 'input_text', text: 'old prompt' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'msg-assistant-old',
          role: 'assistant',
          phase: 'final',
          content: [{ type: 'output_text', text: 'old final' }],
        },
      },
      {
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'turn-old' },
      },
      {
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-active' },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'msg-user-active',
          role: 'user',
          content: [{ type: 'input_text', text: 'continue' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'msg-assistant-active',
          role: 'assistant',
          phase: 'commentary',
          content: [{ type: 'output_text', text: 'active text must stay on text page' }],
        },
      },
    ]
    await writeFile(rolloutPath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (method, params) => {
      if (method === 'thread/turns/list') {
        return {
          data: [],
          nextCursor: null,
          backwardsCursor: null,
        }
      }
      throw new Error(`unexpected RPC ${method}`)
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-turn-page?threadId=thread-recovered-active&limit=3`,
    )
    const payload = await response.json() as {
      result?: {
        thread?: {
          turns?: Array<{
            id?: string
            status?: string
            items?: Array<{ id?: string }>
          }>
        }
      }
    }
    const turns = payload.result?.thread?.turns ?? []

    expect(response.status).toBe(200)
    expect(turns.map((turn) => turn.id)).toEqual(['turn-old', 'turn-active'])
    expect(turns[1]).toMatchObject({
      id: 'turn-active',
      status: 'inProgress',
      items: [],
    })
    expect(JSON.stringify(payload)).not.toContain('active text must stay on text page')
    expect(rpc).not.toHaveBeenCalledWith('thread/read', expect.anything())
  })

  it('uses the active state-db rollout path for a non-UUID passive turn page', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-state-rollout-turn-page-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
    const threadId = 'state-db-non-uuid-thread'
    const rolloutDir = join(codexHome, 'unusual-rollout-location')
    const rolloutPath = join(rolloutDir, 'conversation.jsonl')
    await mkdir(rolloutDir)
    await writeFile(rolloutPath, [
      { type: 'session_meta', payload: { id: threadId, cwd: '/tmp/state-db-project' } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-state-db' } },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'msg-state-db-user',
          role: 'user',
          content: [{ type: 'input_text', text: 'state db prompt' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'msg-state-db-assistant',
          role: 'assistant',
          phase: 'final',
          content: [{ type: 'output_text', text: 'state db answer' }],
        },
      },
      '',
    ].map((line) => typeof line === 'string' ? line : JSON.stringify(line)).join('\n'))
    expect(spawnSync('sqlite3', [join(codexHome, 'state_5.sqlite')], {
      input: [
        'CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, model_provider TEXT, cwd TEXT, title TEXT, cli_version TEXT, first_user_message TEXT, archived INTEGER);',
        `INSERT INTO threads VALUES ('${threadId}', '${rolloutPath}', 1, 2, 'cli', 'openai', '/tmp/state-db-project', 'State DB thread', '', 'State DB thread', 0);`,
      ].join(' '),
      encoding: 'utf8',
    }).status).toBe(0)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockRejectedValue(new Error('Method not found: thread/turns/list'))
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-turn-page?threadId=${threadId}&limit=5`,
    )
    const payload = await response.json() as {
      result?: { thread?: { turns?: Array<{ id?: string }> } }
    }

    expect(response.status).toBe(200)
    expect(payload.result?.thread?.turns?.map((turn) => turn.id)).toEqual(['turn-state-db'])
    const textResponse = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-text-page?threadId=${threadId}&turnId=turn-state-db&limit=5`,
    )
    const textBody = await textResponse.text()
    expect(textResponse.status, textBody).toBe(200)
    expect(textBody).toContain('state db answer')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('returns unsupported pagination without suggesting an ownership-changing fallback', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockRejectedValue(new Error('Method not found: thread/turns/list'))
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-turn-page?threadId=thread-legacy&limit=5`,
    )
    const payload = await response.json() as { fallback?: string }

    expect(response.status).toBe(501)
    expect(payload.fallback).toBeUndefined()
  })
})

describe('GET /codex-api/thread-summary', () => {
  it('returns state-db metadata without calling the app server', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-passive-thread-summary-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const stateDbPath = join(codexHome, 'state_5.sqlite')
    expect(spawnSync('sqlite3', [stateDbPath], {
      input: [
        'CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, model_provider TEXT, cwd TEXT, title TEXT, cli_version TEXT, first_user_message TEXT, archived INTEGER);',
        "INSERT INTO threads VALUES ('pinned-summary', '/tmp/sessions/pinned.jsonl', 1, 2, 'cli', 'openai', '/tmp/project', 'Pinned summary', '', 'Pinned summary', 0);",
      ].join(' '),
      encoding: 'utf8',
    }).status).toBe(0)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc')
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-summary?threadId=pinned-summary`,
    )
    const payload = await response.json() as {
      result?: { thread?: { id?: string; cwd?: string; preview?: string } }
    }

    expect(response.status).toBe(200)
    expect(payload.result?.thread).toMatchObject({
      id: 'pinned-summary',
      cwd: '/tmp/project',
      preview: 'Pinned summary',
    })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('treats an inconclusive passive lookup as retryable instead of authoritative absence', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-passive-thread-summary-missing-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const port = await listenWithMiddleware(createCodexBridgeMiddleware())

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-summary?threadId=possibly-older-thread`,
    )

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Thread metadata lookup was inconclusive',
      retryable: true,
    })
  })

  it('fails closed when the thread becomes archived while reading its summary', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-passive-thread-summary-race-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const stateDbPath = join(codexHome, 'state_5.sqlite')
    expect(spawnSync('sqlite3', [stateDbPath], {
      input: [
        'CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, model_provider TEXT, cwd TEXT, title TEXT, cli_version TEXT, first_user_message TEXT, archived INTEGER);',
        "INSERT INTO threads VALUES ('summary-race', '/tmp/sessions/summary-race.jsonl', 1, 2, 'cli', 'openai', '/tmp/project', 'Summary race', '', 'Summary race', 0);",
      ].join(' '),
      encoding: 'utf8',
    }).status).toBe(0)
    const sqlitePath = spawnSync('which', ['sqlite3'], { encoding: 'utf8' }).stdout.trim()
    const shimPath = join(codexHome, 'sqlite-summary-race')
    await writeFile(shimPath, [
      '#!/bin/sh',
      'query_file="${TMPDIR:-/tmp}/codex-mobile-summary-race-$$"',
      'output_file="${TMPDIR:-/tmp}/codex-mobile-summary-race-output-$$"',
      'trap \'rm -f "$query_file" "$output_file"\' EXIT',
      'cat > "$query_file"',
      `'${sqlitePath}' "$@" < "$query_file" > "$output_file"`,
      'status=$?',
      'cat "$output_file"',
      'if grep -q "SELECT id, rollout_path" "$query_file"; then',
      `  '${sqlitePath}' '${stateDbPath}' "UPDATE threads SET archived = 1 WHERE id = 'summary-race';"`,
      'fi',
      'exit "$status"',
      '',
    ].join('\n'))
    await chmod(shimPath, 0o755)
    const originalSqliteCommand = process.env.CODEXUI_SQLITE_COMMAND
    process.env.CODEXUI_SQLITE_COMMAND = shimPath
    disposers.push(() => {
      if (originalSqliteCommand === undefined) delete process.env.CODEXUI_SQLITE_COMMAND
      else process.env.CODEXUI_SQLITE_COMMAND = originalSqliteCommand
    })
    const port = await listenWithMiddleware(createCodexBridgeMiddleware())

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-summary?threadId=summary-race`,
    )

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Cannot operate on an archived task.',
    })
  })

  it('bounds warm archive-index validation by the archive deadline', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-archive-index-deadline-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const archivedRoot = join(codexHome, 'archived_sessions')
    await mkdir(archivedRoot)
    await Promise.all(Array.from({ length: 128 }, (_, index) => (
      mkdir(join(archivedRoot, `directory-${String(index).padStart(3, '0')}`))
    )))
    const port = await listenWithMiddleware(createCodexBridgeMiddleware())
    const url = `http://127.0.0.1:${port}/codex-api/thread-summary?threadId=deadline-probe`

    expect((await fetch(url)).status).toBe(503)
    let now = 1_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      now += 250
      return now
    })
    const response = await fetch(url)
    nowSpy.mockRestore()

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Cannot verify archived task state.',
    })
  })
})

describe('GET /codex-api/thread-text-page', () => {
  async function createRolloutFixture(): Promise<{
    sessionPath: string
    cleanup: () => void
  }> {
    const directory = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-text-page-'))
    const rows = [
      {
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-active' },
      },
      {
        type: 'response_item',
        payload: {
          type: 'reasoning',
          id: 'reason-1',
          summary: [{ type: 'summary_text', text: 'First thought' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          arguments: '{"cmd":"pnpm test","secret":"raw function arguments must not escape"}',
          call_id: 'call-1',
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call-1',
          output: 'raw function output must not escape',
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          id: 'agent-1',
          content: [{ type: 'output_text', text: 'First update' }],
        },
      },
      {
        type: 'event_msg',
        payload: { type: 'context_compacted' },
      },
      {
        type: 'response_item',
        payload: {
          type: 'reasoning',
          id: 'reason-2',
          summary: [{ type: 'summary_text', text: 'Second thought' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          id: 'agent-2',
          content: [{ type: 'output_text', text: 'Second update' }],
        },
      },
    ]
    const sessionPath = join(directory, 'rollout.jsonl')
    await writeFile(
      sessionPath,
      `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
      'utf8',
    )
    return {
      sessionPath,
      cleanup: () => {
        void rm(directory, { recursive: true, force: true })
      },
    }
  }

  function stubThreadRead(sessionPath: string) {
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        storeThreadReadSnapshot: (threadId: string, snapshot: unknown) => void
      }
    }
    shared.appServer.storeThreadReadSnapshot('thread-1', {
      thread: { id: 'thread-1', path: sessionPath, turns: [] },
    })
    return vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockRejectedValue(new Error('passive thread/read forbidden'))
  }

  function stubActiveRuntime(turnId = 'turn-active') {
    const shared = sharedBridgeForTest()
    return vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running',
      turnId,
      interruptible: false,
      source: 'external-session-writer',
    })
  }

  it('pages projected active-turn text from the trusted thread rollout', async () => {
    const fixture = await createRolloutFixture()
    disposers.push(fixture.cleanup)
    const middleware = createCodexBridgeMiddleware()
    const rpc = stubThreadRead(fixture.sessionPath)
    stubActiveRuntime()
    const port = await listenWithMiddleware(middleware)

    const firstResponse = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-text-page?threadId=thread-1&turnId=turn-active&limit=2`,
    )
    const firstBody = await firstResponse.json() as {
      items: Array<{ id: string; type: string }>
      nextOlderCursor: string | null
      hasMoreOlder: boolean
    }

    expect(firstResponse.status).toBe(200)
    expect(rpc).not.toHaveBeenCalled()
    expect(firstBody.items.map((item) => item.type)).toEqual([
      'reasoning',
      'agentMessage',
    ])
    expect(firstBody.items.map((item) => item.id)).toEqual([
      'reason-2',
      'agent-2',
    ])
    expect(firstBody.hasMoreOlder).toBe(true)

    const secondResponse = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-text-page?threadId=thread-1&turnId=turn-active&limit=2&cursor=${encodeURIComponent(firstBody.nextOlderCursor ?? '')}`,
    )
    const secondBody = await secondResponse.json() as {
      items: Array<{ id: string; type: string; text?: string }>
      nextOlderCursor: string | null
      hasMoreOlder: boolean
    }
    expect(secondResponse.status).toBe(200)
    expect(secondBody.items.map((item) => item.type)).toEqual(['agentMessage', 'contextCompaction'])
    expect(secondBody.items.map((item) => item.id)).toEqual([
      'agent-1',
      expect.stringMatching(/^rollout:contextCompaction:\d+$/u),
    ])
    expect(secondBody.items[1]?.text).toBe('Context automatically compacted')
    expect(secondBody.hasMoreOlder).toBe(true)

    const thirdResponse = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-text-page?threadId=thread-1&turnId=turn-active&limit=2&cursor=${encodeURIComponent(secondBody.nextOlderCursor ?? '')}`,
    )
    const thirdBody = await thirdResponse.json() as {
      items: Array<{ id: string }>
      hasMoreOlder: boolean
    }
    expect(thirdResponse.status).toBe(200)
    expect(thirdBody.items.map((item) => item.id)).toEqual(['reason-1'])
    expect(thirdBody.hasMoreOlder).toBe(false)

    const serialized = JSON.stringify([firstBody, secondBody, thirdBody])
    expect(serialized).not.toContain('raw function arguments')
    expect(serialized).not.toContain('raw function output')
  })

  it('deduplicates concurrent active text-page requests for the same tail signature', async () => {
    const fixture = await createRolloutFixture()
    disposers.push(fixture.cleanup)
    const middleware = createCodexBridgeMiddleware()
    const rpc = stubThreadRead(fixture.sessionPath)
    const shared = sharedBridgeForTest()
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return {
        state: 'running',
        turnId: 'turn-active',
        interruptible: false,
        source: 'external-session-writer',
      }
    })
    const port = await listenWithMiddleware(middleware)
    const url = `http://127.0.0.1:${port}/codex-api/thread-text-page?threadId=thread-1&turnId=turn-active&limit=2&knownTailSignature=stale&afterSessionOrder=0`

    const [first, second] = await Promise.all([
      fetch(url),
      fetch(url),
    ])
    const firstBody = await first.json()
    const secondBody = await second.json()

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(firstBody).toEqual(secondBody)
    expect(rpc).not.toHaveBeenCalled()
    expect(inspect).toHaveBeenCalledTimes(1)
  })

  it('uses a cached thread snapshot path without retrying thread/read', async () => {
    const fixture = await createRolloutFixture()
    disposers.push(fixture.cleanup)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
        storeThreadReadSnapshot: (threadId: string, snapshot: unknown) => void
      }
    }
    shared.appServer.storeThreadReadSnapshot('thread-1', {
      thread: {
        id: 'thread-1',
        path: fixture.sessionPath,
        turns: [],
      },
    })
    const rpc = vi.spyOn(shared.appServer, 'rpc').mockRejectedValue(new Error('thread/read should not be called'))
    stubActiveRuntime()
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-text-page?threadId=thread-1&turnId=turn-active&limit=1`,
    )
    const body = await response.json() as { items?: Array<{ id: string }> }

    expect(response.status).toBe(200)
    expect(body.items?.map((item) => item.id)).toEqual(['agent-2'])
    expect(rpc).not.toHaveBeenCalled()
  })

  it('finds the local rollout path for active text without retrying thread/read', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-text-page-local-path-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => {
      void rm(codexHome, { recursive: true, force: true }).catch(() => undefined)
    })
    const threadId = '019faabf-f76e-7fe0-a38f-3f12d03ecaf7'
    const sessionDir = join(codexHome, 'sessions', '2026', '07', '29')
    await mkdir(sessionDir, { recursive: true })
    const sessionPath = join(sessionDir, `rollout-test-${threadId}.jsonl`)
    await writeFile(sessionPath, [
      JSON.stringify({ type: 'session_meta', payload: { id: threadId } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-active' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          id: 'agent-local',
          content: [{ type: 'output_text', text: 'Local path update' }],
        },
      }),
      '',
    ].join('\n'), 'utf8')

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    const rpc = vi.spyOn(shared.appServer, 'rpc').mockRejectedValue(new Error('thread/read should not be called'))
    stubActiveRuntime()
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-text-page?threadId=${threadId}&turnId=turn-active&limit=1`,
    )
    const body = await response.json() as { items?: Array<{ id: string }> }

    expect(response.status).toBe(200)
    expect(body.items?.map((item) => item.id)).toEqual(['agent-local'])
    expect(rpc).not.toHaveBeenCalled()
  })

  it('keeps serving active text from a quiet local rollout without retrying thread/read', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-text-page-quiet-local-path-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => {
      void rm(codexHome, { recursive: true, force: true }).catch(() => undefined)
    })
    const threadId = '019faabf-f76e-7fe0-a38f-3f12d03ecaf7'
    const sessionDir = join(codexHome, 'sessions', '2026', '07', '29')
    await mkdir(sessionDir, { recursive: true })
    const sessionPath = join(sessionDir, `rollout-test-${threadId}.jsonl`)
    await writeFile(sessionPath, [
      JSON.stringify({ type: 'session_meta', payload: { id: threadId } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-active' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          id: 'agent-quiet-local',
          content: [{ type: 'output_text', text: 'Quiet local path update' }],
        },
      }),
      '',
    ].join('\n'), 'utf8')
    const quietTime = new Date(Date.now() - (9 * 60 * 1000))
    await utimes(sessionPath, quietTime, quietTime)

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    const rpc = vi.spyOn(shared.appServer, 'rpc').mockRejectedValue(new Error('thread/read should not be called'))
    stubActiveRuntime()
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-text-page?threadId=${threadId}&turnId=turn-active&limit=1`,
    )
    const body = await response.json() as { items?: Array<{ id: string }> }

    expect(response.status).toBe(200)
    expect(body.items?.map((item) => item.id)).toEqual(['agent-quiet-local'])
    expect(rpc).not.toHaveBeenCalled()
  })

  it('returns unavailable active text without materializing a missing rollout', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-text-page-missing-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => {
      void rm(codexHome, { recursive: true, force: true }).catch(() => undefined)
    })
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    const rpc = vi.spyOn(shared.appServer, 'rpc').mockRejectedValue(new Error('passive thread/read forbidden'))
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      'http://127.0.0.1:' + String(port) + '/codex-api/thread-text-page?threadId=missing-thread&turnId=turn-active',
    )

    expect(response.status).toBe(404)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('returns 400 when threadId or turnId is missing', async () => {
    const middleware = createCodexBridgeMiddleware()
    const port = await listenWithMiddleware(middleware)

    const missingThread = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-text-page?turnId=turn-active`,
    )
    const missingTurn = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-text-page?threadId=thread-1`,
    )

    expect(missingThread.status).toBe(400)
    expect(missingTurn.status).toBe(400)
  })

  it('does not materialize another thread for a mismatched cursor', async () => {
    const fixture = await createRolloutFixture()
    disposers.push(fixture.cleanup)
    const middleware = createCodexBridgeMiddleware()
    stubThreadRead(fixture.sessionPath)
    stubActiveRuntime()
    const port = await listenWithMiddleware(middleware)
    const firstResponse = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-text-page?threadId=thread-1&turnId=turn-active&limit=1`,
    )
    const firstBody = await firstResponse.json() as { nextOlderCursor: string }

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-text-page?threadId=thread-2&turnId=turn-active&cursor=${encodeURIComponent(firstBody.nextOlderCursor)}`,
    )

    expect(response.status).toBe(404)
  })

  it('returns 404 when the trusted rollout file is missing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-mobile-missing-rollout-'))
    disposers.push(() => {
      void rm(directory, { recursive: true, force: true })
    })
    const middleware = createCodexBridgeMiddleware()
    stubThreadRead(join(directory, 'missing.jsonl'))
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-text-page?threadId=thread-1&turnId=turn-active`,
    )

    expect(response.status).toBe(404)
  })

  it('returns 409 when a cursor rollout snapshot has been truncated', async () => {
    const fixture = await createRolloutFixture()
    disposers.push(fixture.cleanup)
    const middleware = createCodexBridgeMiddleware()
    stubThreadRead(fixture.sessionPath)
    stubActiveRuntime()
    const port = await listenWithMiddleware(middleware)
    const firstResponse = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-text-page?threadId=thread-1&turnId=turn-active&limit=1`,
    )
    const firstBody = await firstResponse.json() as { nextOlderCursor: string }
    await truncate(fixture.sessionPath, 8)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-text-page?threadId=thread-1&turnId=turn-active&cursor=${encodeURIComponent(firstBody.nextOlderCursor)}`,
    )

    expect(response.status).toBe(409)
  })

  it('rejects a requested turn that is not the trusted active runtime turn', async () => {
    const fixture = await createRolloutFixture()
    disposers.push(fixture.cleanup)
    const middleware = createCodexBridgeMiddleware()
    stubThreadRead(fixture.sessionPath)
    stubActiveRuntime('turn-active')
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-text-page?threadId=thread-1&turnId=turn-stale`,
    )
    const body = await response.text()

    expect(response.status).toBe(409)
    expect(body).not.toContain('agent-1')
    expect(body).not.toContain('agent-2')
  })

  it('serves active text when runtime writer discovery is temporarily unavailable', async () => {
    const fixture = await createRolloutFixture()
    disposers.push(fixture.cleanup)
    const middleware = createCodexBridgeMiddleware()
    stubThreadRead(fixture.sessionPath)
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'idle',
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-text-page?threadId=thread-1&turnId=turn-active&limit=2`,
    )
    const body = await response.json() as {
      items?: Array<{ id: string; type: string }>
    }

    expect(response.status).toBe(200)
    expect(body.items?.map((item) => item.id)).toEqual(['reason-2', 'agent-2'])
  })

  it('rejects a forged active-turn cursor whose offset points into an older turn', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-mobile-forged-text-cursor-'))
    disposers.push(() => {
      void rm(directory, { recursive: true, force: true })
    })
    const rows = [
      {
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-old' },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          id: 'agent-old-1',
          content: [{ type: 'output_text', text: 'First old update' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          id: 'agent-old-2',
          content: [{ type: 'output_text', text: 'Second old update' }],
        },
      },
      {
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'turn-old' },
      },
      {
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-active' },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          id: 'agent-active',
          content: [{ type: 'output_text', text: 'Active update' }],
        },
      },
    ]
    const serializedRows = rows.map((row) => JSON.stringify(row))
    const sessionPath = join(directory, 'rollout.jsonl')
    const rollout = `${serializedRows.join('\n')}\n`
    await writeFile(sessionPath, rollout, 'utf8')
    const forgedCursor = Buffer.from(JSON.stringify({
      v: 1,
      threadId: 'thread-1',
      turnId: 'turn-active',
      beforeOffset: Buffer.byteLength(`${serializedRows.slice(0, 3).join('\n')}\n`, 'utf8'),
      snapshotEndOffset: Buffer.byteLength(rollout, 'utf8'),
    }), 'utf8').toString('base64url')
    const middleware = createCodexBridgeMiddleware()
    stubThreadRead(sessionPath)
    stubActiveRuntime()
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-text-page?threadId=thread-1&turnId=turn-active&limit=1&cursor=${encodeURIComponent(forgedCursor)}`,
    )
    const body = await response.text()

    expect(response.status).toBe(400)
    expect(body).not.toContain('agent-old-1')
    expect(body).not.toContain('agent-old-2')
  })

  it('does not preflight the full active turn before returning a trusted newest page', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-mobile-trusted-text-page-'))
    disposers.push(() => {
      void rm(directory, { recursive: true, force: true })
    })
    const rows = [
      {
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-active' },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          id: 'agent-oversized-older',
          content: [{ type: 'output_text', text: 'x'.repeat((1024 * 1024) + 64) }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          id: 'agent-previous',
          content: [{ type: 'output_text', text: 'Previous update' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          id: 'agent-latest',
          content: [{ type: 'output_text', text: 'Latest update' }],
        },
      },
    ]
    const sessionPath = join(directory, 'rollout.jsonl')
    await writeFile(
      sessionPath,
      `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
      'utf8',
    )
    const middleware = createCodexBridgeMiddleware()
    stubThreadRead(sessionPath)
    stubActiveRuntime()
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-text-page?threadId=thread-1&turnId=turn-active&limit=1`,
    )
    const body = await response.json() as {
      items: Array<{ id: string }>
      hasMoreOlder: boolean
    }

    expect(response.status).toBe(200)
    expect(body.items.map((item) => item.id)).toEqual(['agent-latest'])
    expect(body.hasMoreOlder).toBe(true)
  })

  it('freezes the rollout snapshot before active-turn authorization', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-mobile-text-page-race-'))
    disposers.push(() => {
      void rm(directory, { recursive: true, force: true })
    })
    const sessionPath = join(directory, 'rollout.jsonl')
    await writeFile(sessionPath, [
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-a' },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          id: 'agent-a',
          content: [{ type: 'output_text', text: 'Authorized update' }],
        },
      }),
      '',
    ].join('\n'), 'utf8')
    const middleware = createCodexBridgeMiddleware()
    stubThreadRead(sessionPath)
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.runtimeProbe, 'inspect').mockImplementation(async () => {
      await appendFile(sessionPath, [
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'task_started', turn_id: 'turn-b' },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            id: 'agent-b-1',
            content: [{ type: 'output_text', text: 'First unauthorized update' }],
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            id: 'agent-b-2',
            content: [{ type: 'output_text', text: 'Second unauthorized update' }],
          },
        }),
        '',
      ].join('\n'), 'utf8')
      return {
        state: 'running',
        turnId: 'turn-a',
        interruptible: false,
        source: 'external-session-writer',
      }
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-text-page?threadId=thread-1&turnId=turn-a&limit=1`,
    )
    const body = await response.json() as {
      items: Array<{ id: string }>
      hasMoreOlder: boolean
    }

    expect(response.status).toBe(200)
    expect(body.items.map((item) => item.id)).toEqual(['agent-a'])
    expect(body.hasMoreOlder).toBe(false)
  })
})

describe('POST /codex-api/rpc guarded resume', () => {
  it('serves cached first-page thread/list RPC data without waiting for runtime state', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-list-cache-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    }))
    await writeFile(join(codexHome, 'session_index.jsonl'), '{"id":"thread-cached","updated_at":"2026-07-27T00:00:00.000Z"}\n')

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({
      data: [
        {
          id: 'thread-cached',
          path: join(codexHome, 'sessions', 'thread-cached.jsonl'),
          status: { type: 'idle' },
          externalRuntime: {
            state: 'running',
            turnId: 'turn-stale-runtime',
            interruptible: false,
            source: 'external-session-writer',
          },
          turns: [{ id: 'turn-heavy', items: [{ id: 'item-heavy' }] }],
          items: [{ id: 'top-item-heavy' }],
          messages: [{ id: 'message-heavy' }],
          conversation: { turns: [] },
          transcript: [{ id: 'transcript-heavy' }],
        },
      ],
      nextCursor: null,
    })
    const inspectMany = vi.spyOn(shared.runtimeProbe, 'inspectMany')
      .mockResolvedValueOnce({})
      .mockImplementation(() => new Promise(() => {}))
    const port = await listenWithMiddleware(middleware)
    const body = JSON.stringify({
      method: 'thread/list',
      params: {
        archived: false,
        limit: 5,
        sortKey: 'updated_at',
        modelProviders: [],
        cursor: null,
      },
    })

    const first = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    const controller = new AbortController()
    const second = await Promise.race([
      fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      }),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 50)),
    ])

    if (second === 'timeout') {
      controller.abort()
    }

    expect(first.status).toBe(200)
    const firstPayload = await first.json() as {
      result?: { data?: Array<Record<string, unknown>> }
    }
    expect(firstPayload.result?.data?.[0]).toMatchObject({
      id: 'thread-cached',
      path: join(codexHome, 'sessions', 'thread-cached.jsonl'),
      status: { type: 'idle' },
    })
    expect(firstPayload.result?.data?.[0]).not.toHaveProperty('turns')
    expect(firstPayload.result?.data?.[0]).not.toHaveProperty('items')
    expect(firstPayload.result?.data?.[0]).not.toHaveProperty('messages')
    expect(firstPayload.result?.data?.[0]).not.toHaveProperty('conversation')
    expect(firstPayload.result?.data?.[0]).not.toHaveProperty('transcript')
    expect(firstPayload.result?.data?.[0]).not.toHaveProperty('externalRuntime')
    const cacheFiles = await readdir(join(codexHome, 'codex-mobile-cache'))
    const persistedCache = JSON.parse(await readFile(
      join(codexHome, 'codex-mobile-cache', cacheFiles[0]!),
      'utf8',
    )) as { result?: { data?: Array<Record<string, unknown>> } }
    expect(persistedCache.result?.data?.[0]).not.toHaveProperty('turns')
    expect(persistedCache.result?.data?.[0]).not.toHaveProperty('items')
    expect(persistedCache.result?.data?.[0]).not.toHaveProperty('messages')
    expect(persistedCache.result?.data?.[0]).not.toHaveProperty('conversation')
    expect(persistedCache.result?.data?.[0]).not.toHaveProperty('transcript')
    expect(persistedCache.result?.data?.[0]).not.toHaveProperty('externalRuntime')
    expect(second).not.toBe('timeout')
    expect(second).toHaveProperty('status', 200)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(inspectMany).not.toHaveBeenCalled()
  })

  it('serves a lightweight session-index first page when cold thread/list has no persisted cache', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-list-session-index-fallback-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    }))
    await writeFile(join(codexHome, 'session_index.jsonl'), [
      { id: 'thread-1', thread_name: 'Oldest', updated_at: '2026-07-27T00:00:00.000Z' },
      { id: 'thread-2', thread_name: 'Second', updated_at: '2026-07-28T02:00:00.000Z' },
      { id: 'thread-3', thread_name: 'Third', updated_at: '2026-07-28T03:00:00.000Z' },
      { id: 'thread-4', thread_name: 'Fourth', updated_at: '2026-07-28T04:00:00.000Z' },
      { id: 'thread-5', thread_name: 'Fifth', updated_at: '2026-07-28T05:00:00.000Z' },
      { id: 'thread-6', thread_name: 'Newest', updated_at: '2026-07-28T06:00:00.000Z' },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8')

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    let resolveRpc!: (value: unknown) => void
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(() => new Promise((resolve) => {
      resolveRpc = resolve
    }))
    vi.spyOn(shared.runtimeProbe, 'inspectMany').mockResolvedValue({})
    const port = await listenWithMiddleware(middleware)

    const responseOrTimeout = await Promise.race([
      fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'thread/list',
          params: {
            archived: false,
            limit: 5,
            sortKey: 'updated_at',
            modelProviders: [],
            cursor: null,
          },
        }),
      }),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 50)),
    ])

    expect(responseOrTimeout).not.toBe('timeout')
    const response = responseOrTimeout as Response
    expect(response.status).toBe(200)
    const payload = await response.json() as {
      result?: { data?: Array<{ id?: string; title?: string; turns?: unknown[] }>; nextCursor?: string | null }
    }
    expect(payload.result?.data?.map((row) => row.id)).toEqual([
      'thread-6',
      'thread-5',
      'thread-4',
      'thread-3',
      'thread-2',
    ])
    expect(payload.result?.data?.[0]).toMatchObject({
      title: 'Newest',
      cwd: '',
      preview: '',
    })
    expect(payload.result?.data?.[0]).not.toHaveProperty('turns')
    expect(payload.result?.nextCursor).toEqual(expect.any(String))
    expect(payload.result?.nextCursor?.length).toBeLessThan(512)

    await appendFile(
      join(codexHome, 'session_index.jsonl'),
      `${JSON.stringify({
        id: 'thread-new-head',
        thread_name: 'Inserted after page one',
        updated_at: '2026-07-28T07:00:00.000Z',
      })}\n`,
      'utf8',
    )

    const secondPage = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/list',
        params: {
          archived: false,
          limit: 5,
          sortKey: 'updated_at',
          modelProviders: [],
          cursor: payload.result?.nextCursor,
        },
      }),
    })
    expect(secondPage.status).toBe(200)
    const secondPayload = await secondPage.json() as {
      result?: { data?: Array<Record<string, unknown>>; nextCursor?: string | null }
    }
    expect(secondPayload.result?.data?.map((row) => row.id)).toEqual(['thread-1'])
    expect(secondPayload.result?.data?.[0]).not.toHaveProperty('turns')
    expect(secondPayload.result?.data?.[0]).not.toHaveProperty('items')
    expect(secondPayload.result?.data?.[0]).not.toHaveProperty('messages')
    expect(secondPayload.result?.data?.[0]).not.toHaveProperty('transcript')
    expect(secondPayload.result?.nextCursor ?? null).toBe(null)

    const replayedCursor = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/list',
        params: {
          archived: false,
          limit: 5,
          sortKey: 'updated_at',
          modelProviders: [],
          cursor: payload.result?.nextCursor,
        },
      }),
    })
    expect(replayedCursor.status).toBe(200)
    const replayedPayload = await replayedCursor.json() as {
      result?: { data?: Array<{ id?: string }>; nextCursor?: string | null }
    }
    expect(replayedPayload.result?.data?.map((row) => row.id)).toEqual(['thread-1'])
    expect(replayedPayload.result?.nextCursor ?? null).toBe(null)

    const legacyCursor = `codex-mobile-list:${Buffer.from(JSON.stringify({
      kind: 'session-index',
      beforeUpdatedAtMs: 1,
      beforeId: 'thread-legacy-boundary',
    }), 'utf8').toString('base64url')}`
    const legacyResponse = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/list',
        params: {
          archived: false,
          limit: 5,
          sortKey: 'updated_at',
          modelProviders: [],
          cursor: legacyCursor,
        },
      }),
    })
    expect(legacyResponse.status).toBe(400)

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(rpc).toHaveBeenCalledTimes(1)
    resolveRpc({ data: [], nextCursor: null })
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  it('merges session-index threads missing from an incomplete state database', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-list-incomplete-state-db-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    }))
    await writeFile(join(codexHome, 'session_index.jsonl'), [
      { id: 'thread-state-only', thread_name: 'State row', updated_at: '2026-07-28T05:00:00.000Z' },
      { id: 'thread-index-only', thread_name: 'Index row', updated_at: '2026-07-28T06:00:00.000Z' },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n')
    const stateDbPath = join(codexHome, 'state_5.sqlite')
    expect(spawnSync('sqlite3', [stateDbPath], {
      input: [
        'CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, model_provider TEXT, cwd TEXT, title TEXT, cli_version TEXT, first_user_message TEXT, archived INTEGER);',
        "INSERT INTO threads VALUES ('thread-state-only', '/tmp/sessions/thread-state-only.jsonl', 1, 5, 'cli', 'openai', '/tmp/project', 'State row', '', 'State row', 0);",
      ].join(' '),
      encoding: 'utf8',
    }).status).toBe(0)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    let resolveRpc!: (value: unknown) => void
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(() => new Promise((resolve) => { resolveRpc = resolve }))
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/list',
        params: { archived: false, limit: 5, sortKey: 'updated_at', modelProviders: [], cursor: null },
      }),
    })
    const payload = await response.json() as { result?: { data?: Array<{ id?: string }> } }

    expect(response.status).toBe(200)
    expect(payload.result?.data?.map((entry) => entry.id)).toEqual([
      'thread-index-only',
      'thread-state-only',
    ])
    await vi.waitFor(() => expect(resolveRpc).toBeTypeOf('function'))
    resolveRpc({ data: [], nextCursor: null })
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  it('merges active state-db-only threads into a nonempty session-index page', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-list-state-only-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    }))
    await writeFile(join(codexHome, 'session_index.jsonl'), `${JSON.stringify({
      id: 'thread-index-only',
      thread_name: 'Index only',
      updated_at: '2026-07-28T05:00:00.000Z',
    })}\n`)
    const stateDbPath = join(codexHome, 'state_5.sqlite')
    expect(spawnSync('sqlite3', [stateDbPath], {
      input: [
        'CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, model_provider TEXT, cwd TEXT, title TEXT, cli_version TEXT, first_user_message TEXT, archived INTEGER);',
        "INSERT INTO threads VALUES ('thread-state-only', '/tmp/sessions/thread-state-only.jsonl', 1, 1785218400, 'cli', 'openai', '/tmp/project', 'State only', '', 'State only', 0);",
      ].join(' '),
      encoding: 'utf8',
    }).status).toBe(0)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({ data: [], nextCursor: null })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/list',
        params: { archived: false, limit: 5, sortKey: 'updated_at', modelProviders: [], cursor: null },
      }),
    })
    const payload = await response.json() as { result?: { data?: Array<{ id?: string }> } }

    expect(response.status).toBe(200)
    expect(payload.result?.data?.map((entry) => entry.id)).toEqual([
      'thread-state-only',
      'thread-index-only',
    ])
  })

  it('does not advance another thread-list source when the initial state-db scan fails', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-list-state-scan-failure-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    expect(spawnSync('sqlite3', [join(codexHome, 'state_5.sqlite'), [
      'CREATE TABLE thread_source (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, model_provider TEXT, title TEXT, cli_version TEXT, first_user_message TEXT, archived INTEGER);',
      "INSERT INTO thread_source VALUES ('state-row-that-must-not-be-skipped', '/tmp/sessions/state-row-that-must-not-be-skipped.jsonl', 1, 200, 'cli', 'openai', 'State row', '', 'State row', 0);",
      "CREATE VIEW threads AS SELECT id, rollout_path, created_at, updated_at, source, model_provider, json_extract('invalid', '$') AS cwd, title, cli_version, first_user_message, archived FROM thread_source;",
    ].join(' ')], { encoding: 'utf8' }).status).toBe(0)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({
      data: [{ id: 'native-row-that-must-not-advance', updatedAt: 100 }],
      nextCursor: 'native-next',
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/list',
        params: {
          archived: false,
          limit: 5,
          sortKey: 'updated_at',
          modelProviders: [],
          cursor: null,
          __codexMobileForceFresh: true,
        },
      }),
    })

    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Unable to read imported thread list from state database.',
    })
  })

  it('does not skip a state-db-only row behind a bounded scan continuation', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-list-mixed-boundary-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
    await writeFile(join(codexHome, 'session_index.jsonl'), `${JSON.stringify({
      id: 'mixed-index-old',
      thread_name: 'Mixed index old',
      updated_at: new Date(1_000).toISOString(),
    })}\n`)
    const stateDbPath = join(codexHome, 'state_5.sqlite')
    const skippedRows = Array.from({ length: 404 }, (_, index) => (
      `INSERT INTO threads VALUES ('invalid-${String(index).padStart(3, '0')}', '/tmp/sessions/invalid-${String(index).padStart(3, '0')}.jsonl', 1, ${1_000 - index}, 'cli', 'openai', '', '', '', '', 0);`
    ))
    expect(spawnSync('sqlite3', [stateDbPath], {
      input: [
        'BEGIN;',
        'CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, model_provider TEXT, cwd TEXT, title TEXT, cli_version TEXT, first_user_message TEXT, archived INTEGER);',
        ...skippedRows,
        "INSERT INTO threads VALUES ('mixed-state-visible', '/tmp/sessions/mixed-state-visible.jsonl', 1, 595, 'cli', 'openai', '/tmp/project', 'Mixed state visible', '', 'Mixed state visible', 0);",
        'COMMIT;',
      ].join(' '),
      encoding: 'utf8',
    }).status).toBe(0)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({ data: [], nextCursor: null })
    const port = await listenWithMiddleware(middleware)
    let cursor: string | null = null
    const seenIds: string[] = []

    for (let page = 0; page < 3; page += 1) {
      const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'thread/list',
          params: { archived: false, limit: 1, sortKey: 'updated_at', modelProviders: [], cursor },
        }),
      })
      const payload = await response.json() as {
        result?: { data?: Array<{ id?: string }>; nextCursor?: string | null }
      }
      expect(response.status).toBe(200)
      seenIds.push(...(payload.result?.data ?? []).map((entry) => entry.id ?? ''))
      cursor = payload.result?.nextCursor ?? null
      if (!cursor) break
    }

    expect(seenIds).toEqual(['mixed-index-old', 'mixed-state-visible'])
  })

  it('uses the built-in SQLite fallback when no sqlite3 executable is discoverable', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-list-builtin-sqlite-'))
    process.env.CODEX_HOME = codexHome
    const originalPath = process.env.PATH
    const originalHome = process.env.HOME
    const originalSqliteCommand = process.env.CODEXUI_SQLITE_COMMAND
    disposers.push(() => {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
      if (originalHome === undefined) delete process.env.HOME
      else process.env.HOME = originalHome
      if (originalSqliteCommand === undefined) delete process.env.CODEXUI_SQLITE_COMMAND
      else process.env.CODEXUI_SQLITE_COMMAND = originalSqliteCommand
      return rm(codexHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })
    const stateDbPath = join(codexHome, 'state_5.sqlite')
    expect(spawnSync('sqlite3', [stateDbPath, [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, model_provider TEXT, cwd TEXT, title TEXT, cli_version TEXT, first_user_message TEXT, archived INTEGER);',
      "INSERT INTO threads VALUES ('builtin-sqlite-thread', '/tmp/sessions/builtin-sqlite-thread.jsonl', 1, 2, 'cli', 'openai', '/tmp/project', 'Built-in SQLite', '', 'Built-in SQLite', 0);",
    ].join(' ')], { encoding: 'utf8' }).status).toBe(0)
    const emptyPath = join(codexHome, 'empty-path')
    await mkdir(emptyPath)
    process.env.PATH = emptyPath
    process.env.HOME = codexHome
    delete process.env.CODEXUI_SQLITE_COMMAND
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({ data: [], nextCursor: null })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/list',
        params: { archived: false, limit: 5, sortKey: 'updated_at', modelProviders: [], cursor: null },
      }),
    })
    const payload = await response.json() as { result?: { data?: Array<{ id?: string }> } }

    expect(response.status).toBe(200)
    expect(payload.result?.data?.map((entry) => entry.id)).toContain('builtin-sqlite-thread')
  })

  it('continues across bounded archive-check chunks without returning an empty page', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-list-bounded-archive-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    }))
    const entries = Array.from({ length: 1_200 }, (_, index) => ({
      id: `bounded-thread-${index}`,
      thread_name: `Bounded ${index}`,
      updated_at: new Date((index + 1) * 1_000).toISOString(),
    }))
    await writeFile(
      join(codexHome, 'session_index.jsonl'),
      entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
    )
    const stateDbPath = join(codexHome, 'state_5.sqlite')
    const inserts = entries.map((entry, index) => (
      `INSERT INTO threads VALUES ('${entry.id}', '/tmp/sessions/${entry.id}.jsonl', 1, ${index + 1}, 'cli', 'openai', '/tmp/project', '', '', '', ${index >= 100 ? 1 : 0});`
    ))
    expect(spawnSync('sqlite3', [stateDbPath], {
      input: [
        'BEGIN;',
        'CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, model_provider TEXT, cwd TEXT, title TEXT, cli_version TEXT, first_user_message TEXT, archived INTEGER);',
        ...inserts,
        'COMMIT;',
      ].join(' '),
      encoding: 'utf8',
    }).status).toBe(0)

    const shimDir = join(codexHome, 'miniconda3', 'bin')
    const emptyPathDir = join(codexHome, 'systemd-path')
    const callLog = join(codexHome, 'sqlite-calls.log')
    const sqlitePath = spawnSync('which', ['sqlite3'], { encoding: 'utf8' }).stdout.trim()
    expect(sqlitePath).not.toBe('')
    await mkdir(shimDir, { recursive: true })
    await mkdir(emptyPathDir)
    await writeFile(
      join(shimDir, 'sqlite3'),
      `#!/bin/sh\nprintf 'call\\n' >> '${callLog}'\nexec '${sqlitePath}' "$@"\n`,
    )
    await chmod(join(shimDir, 'sqlite3'), 0o755)
    const originalPath = process.env.PATH
    const originalHome = process.env.HOME
    const originalSqliteCommand = process.env.CODEXUI_SQLITE_COMMAND
    process.env.PATH = emptyPathDir
    process.env.HOME = codexHome
    delete process.env.CODEXUI_SQLITE_COMMAND
    disposers.push(() => {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
      if (originalHome === undefined) delete process.env.HOME
      else process.env.HOME = originalHome
      if (originalSqliteCommand === undefined) delete process.env.CODEXUI_SQLITE_COMMAND
      else process.env.CODEXUI_SQLITE_COMMAND = originalSqliteCommand
    })

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    let resolveRpc!: (value: unknown) => void
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(() => new Promise((resolve) => { resolveRpc = resolve }))
    const port = await listenWithMiddleware(middleware)
    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/list',
        params: { archived: false, limit: 5, sortKey: 'updated_at', modelProviders: [], cursor: null },
      }),
    })
    const payload = await response.json() as {
      error?: string
      result?: { data?: Array<{ id?: string }>; nextCursor?: string | null }
    }

    expect(response.status).toBe(200)
    expect(payload.result?.data?.map((entry) => entry.id)).toEqual([
      'bounded-thread-99',
      'bounded-thread-98',
      'bounded-thread-97',
      'bounded-thread-96',
      'bounded-thread-95',
    ])
    expect(payload.result?.nextCursor).toEqual(expect.any(String))
    const sqliteCalls = (await readFile(callLog, 'utf8')).trim().split('\n')
    expect(sqliteCalls.length).toBeLessThanOrEqual(4)

    const secondPage = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/list',
        params: {
          archived: false,
          limit: 5,
          sortKey: 'updated_at',
          modelProviders: [],
          cursor: payload.result?.nextCursor,
        },
      }),
    })
    const secondPayload = await secondPage.json() as { result?: { data?: Array<{ id?: string }> } }
    expect(secondPage.status).toBe(200)
    expect(secondPayload.result?.data?.map((entry) => entry.id)).toEqual([
      'bounded-thread-94',
      'bounded-thread-93',
      'bounded-thread-92',
      'bounded-thread-91',
      'bounded-thread-90',
    ])
    await vi.waitFor(() => expect(resolveRpc).toBeTypeOf('function'))
    resolveRpc({ data: [], nextCursor: null })
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  it('continues session-index pagination across bounded file windows', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-list-bounded-window-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
    const oldEntry = JSON.stringify({
      id: 'bounded-window-old',
      thread_name: 'Bounded window old',
      updated_at: '2026-01-01T00:00:00.000Z',
    })
    const recentEntries = Array.from({ length: 5 }, (_, index) => JSON.stringify({
      id: `bounded-window-recent-${index}`,
      thread_name: `Bounded window recent ${index}`,
      updated_at: new Date(Date.UTC(2026, 7, 1, 0, index)).toISOString(),
    }))
    await writeFile(join(codexHome, 'session_index.jsonl'), [
      oldEntry,
      'x'.repeat((17 * 1024 * 1024) + 1),
      ...recentEntries,
      '',
    ].join('\n'))
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    let resolveRpc!: (value: unknown) => void
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(() => new Promise((resolve) => { resolveRpc = resolve }))
    const port = await listenWithMiddleware(middleware)
    let cursor: string | null = null
    const seenIds: string[] = []

    for (let page = 0; page < 4 && !seenIds.includes('bounded-window-old'); page += 1) {
      const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'thread/list',
          params: { archived: false, limit: 5, sortKey: 'updated_at', modelProviders: [], cursor },
        }),
      })
      const payload = await response.json() as {
        result?: { data?: Array<{ id?: string }>; nextCursor?: string | null }
      }
      expect(response.status).toBe(200)
      seenIds.push(...(payload.result?.data ?? []).map((entry) => entry.id ?? ''))
      cursor = payload.result?.nextCursor ?? null
      if (!cursor) break
    }

    expect(seenIds).toContain('bounded-window-old')
    await vi.waitFor(() => expect(resolveRpc).toBeTypeOf('function'))
    resolveRpc({ data: [], nextCursor: null })
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  it('keeps a complete record when the bounded window starts exactly at its line boundary', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-list-exact-window-boundary-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
    const target = JSON.stringify({
      id: 'exact-window-boundary',
      thread_name: 'Exact window boundary',
      updated_at: '2026-08-01T00:00:00.000Z',
    }) + '\n'
    const windowBytes = 16 * 1024 * 1024
    const trailing = `${'x'.repeat(windowBytes - Buffer.byteLength(target) - 1)}\n`
    await writeFile(
      join(codexHome, 'session_index.jsonl'),
      `ignored-prefix\n${target}${trailing}`,
    )
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({ data: [], nextCursor: null })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/list',
        params: { archived: false, limit: 5, sortKey: 'updated_at', modelProviders: [], cursor: null },
      }),
    })
    const payload = await response.json() as { result?: { data?: Array<{ id?: string }> } }

    expect(response.status).toBe(200)
    expect(payload.result?.data?.map((entry) => entry.id)).toContain('exact-window-boundary')
  })

  it('bounds session-index identifiers and titles before response and cursor encoding', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-list-index-fields-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
    await writeFile(join(codexHome, 'session_index.jsonl'), [
      JSON.stringify({
        id: 'i'.repeat(513),
        thread_name: 'invalid oversized id',
        updated_at: '2026-08-02T00:00:00.000Z',
      }),
      JSON.stringify({
        id: 'bounded-index-fields',
        thread_name: 'T'.repeat(16 * 1024 * 1024 - 1024),
        updated_at: '2026-08-01T00:00:00.000Z',
      }),
      '',
    ].join('\n'))
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({ data: [], nextCursor: null })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/list',
        params: { archived: false, limit: 1, sortKey: 'updated_at', modelProviders: [], cursor: null },
      }),
    })
    const payload = await response.json() as {
      result?: { data?: Array<{ id?: string; title?: string }>; nextCursor?: string | null }
    }

    expect(response.status).toBe(200)
    expect(payload.result?.data?.map((entry) => entry.id)).toEqual(['bounded-index-fields'])
    expect(payload.result?.data?.[0]?.title?.length).toBeLessThanOrEqual(515)
    expect(JSON.stringify(payload).length).toBeLessThan(4_000)
    expect(payload.result?.nextCursor).toBeNull()
  })

  it('invalidates a cached session-index window after same-size same-mtime replacement', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-list-index-replacement-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
    const indexPath = join(codexHome, 'session_index.jsonl')
    const original = JSON.stringify({ id: 'index-old', thread_name: 'Old title', updated_at: '2026-08-01T00:00:00.000Z' }) + '\n'
    const replacement = JSON.stringify({ id: 'index-new', thread_name: 'New title', updated_at: '2026-08-01T00:00:00.000Z' }) + '\n'
    expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(original))
    await writeFile(indexPath, original)
    const originalStats = await stat(indexPath)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({ data: [], nextCursor: null })
    const port = await listenWithMiddleware(middleware)
    const list = async (limit: number) => {
      const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'thread/list',
          params: { archived: false, limit, sortKey: 'updated_at', modelProviders: [], cursor: null },
        }),
      })
      return await response.json() as { result?: { data?: Array<{ id?: string }> } }
    }

    expect((await list(1)).result?.data?.map((entry) => entry.id)).toEqual(['index-old'])
    await writeFile(indexPath, replacement)
    await utimes(indexPath, originalStats.atime, originalStats.mtime)

    expect((await list(2)).result?.data?.map((entry) => entry.id)).toEqual(['index-new'])
  })

  it('does not return an older duplicate after crossing a session-index window', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-list-window-dedup-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const oldEntries = [
      JSON.stringify({ id: 'window-duplicate', thread_name: 'Old duplicate', updated_at: '2025-01-02T00:00:00.000Z' }),
      JSON.stringify({ id: 'window-old-only', thread_name: 'Old only', updated_at: '2025-01-01T00:00:00.000Z' }),
    ]
    const recentEntries = [
      JSON.stringify({ id: 'window-duplicate', thread_name: 'New duplicate', updated_at: '2026-08-01T00:05:00.000Z' }),
      ...Array.from({ length: 5 }, (_, index) => JSON.stringify({
        id: `window-recent-${index}`,
        thread_name: `Recent ${index}`,
        updated_at: new Date(Date.UTC(2026, 7, 1, 0, index)).toISOString(),
      })),
    ]
    await writeFile(join(codexHome, 'session_index.jsonl'), [
      ...oldEntries,
      'x'.repeat((17 * 1024 * 1024) + 1),
      ...recentEntries,
      '',
    ].join('\n'))
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({ data: [], nextCursor: null })
    const port = await listenWithMiddleware(middleware)
    let cursor: string | null = null
    const seenIds: string[] = []

    for (let page = 0; page < 6; page += 1) {
      const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'thread/list',
          params: { archived: false, limit: 3, sortKey: 'updated_at', modelProviders: [], cursor },
        }),
      })
      const payload = await response.json() as {
        result?: { data?: Array<{ id?: string }>; nextCursor?: string | null }
      }
      expect(response.status).toBe(200)
      seenIds.push(...(payload.result?.data ?? []).map((entry) => entry.id ?? ''))
      cursor = payload.result?.nextCursor ?? null
      if (!cursor) break
    }

    expect(seenIds).toContain('window-old-only')
    expect(seenIds.filter((id) => id === 'window-duplicate')).toHaveLength(1)
  })

  it('keeps byte-accurate pagination when a window starts inside UTF-8 text', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-list-window-utf8-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const oldEntry = JSON.stringify({
      id: 'utf8-window-old',
      thread_name: 'UTF-8 old',
      updated_at: '2025-01-01T00:00:00.000Z',
    })
    let recentEntry = JSON.stringify({
      id: 'utf8-window-recent',
      thread_name: 'UTF-8 recent',
      updated_at: '2026-01-01T00:00:00.000Z',
    })
    const hugeLine = 'é'.repeat((8 * 1024 * 1024) + 256)
    const boundaryOffset = (): number => {
      const contents = [oldEntry, hugeLine, recentEntry, ''].join('\n')
      return Buffer.byteLength(contents) - (16 * 1024 * 1024) - Buffer.byteLength(`${oldEntry}\n`)
    }
    if (boundaryOffset() % 2 === 0) {
      recentEntry = recentEntry.replace('UTF-8 recent', 'UTF-8 recentx')
    }
    expect(boundaryOffset() % 2).toBe(1)
    await writeFile(join(codexHome, 'session_index.jsonl'), [oldEntry, hugeLine, recentEntry, ''].join('\n'))
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({ data: [], nextCursor: null })
    const port = await listenWithMiddleware(middleware)
    let cursor: string | null = null
    const seenIds: string[] = []

    for (let page = 0; page < 6; page += 1) {
      const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'thread/list',
          params: { archived: false, limit: 1, sortKey: 'updated_at', modelProviders: [], cursor },
        }),
      })
      const payload = await response.json() as {
        result?: { data?: Array<{ id?: string }>; nextCursor?: string | null }
      }
      expect(response.status).toBe(200)
      seenIds.push(...(payload.result?.data ?? []).map((entry) => entry.id ?? ''))
      cursor = payload.result?.nextCursor ?? null
      if (!cursor) break
    }

    expect(seenIds).toEqual(['utf8-window-recent', 'utf8-window-old'])
  })

  it('bounds total archive classification work for an all-archived index window', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-list-archive-budget-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
    const entries = Array.from({ length: 10_000 }, (_, index) => ({
      id: `archive-budget-${String(index).padStart(5, '0')}`,
      thread_name: `Archive budget ${index}`,
      updated_at: new Date((index + 1) * 1_000).toISOString(),
    }))
    await writeFile(
      join(codexHome, 'session_index.jsonl'),
      entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
    )
    const stateDbPath = join(codexHome, 'state_5.sqlite')
    expect(spawnSync('sqlite3', [stateDbPath], {
      input: [
        'BEGIN;',
        'CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER);',
        ...entries.map((entry) => `INSERT INTO threads VALUES ('${entry.id}', 1);`),
        'COMMIT;',
      ].join(' '),
      encoding: 'utf8',
    }).status).toBe(0)
    const shimDir = join(codexHome, 'sqlite-shim')
    const callLog = join(codexHome, 'sqlite-calls.log')
    const sqlitePath = spawnSync('which', ['sqlite3'], { encoding: 'utf8' }).stdout.trim()
    await mkdir(shimDir)
    await writeFile(join(shimDir, 'sqlite3'), `#!/bin/sh\nprintf 'call\\n' >> '${callLog}'\nexec '${sqlitePath}' "$@"\n`)
    await chmod(join(shimDir, 'sqlite3'), 0o755)
    const originalSqliteCommand = process.env.CODEXUI_SQLITE_COMMAND
    process.env.CODEXUI_SQLITE_COMMAND = join(shimDir, 'sqlite3')
    disposers.push(() => {
      if (originalSqliteCommand === undefined) delete process.env.CODEXUI_SQLITE_COMMAND
      else process.env.CODEXUI_SQLITE_COMMAND = originalSqliteCommand
    })
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({ data: [], nextCursor: null })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/list',
        params: { archived: false, limit: 5, sortKey: 'updated_at', modelProviders: [], cursor: null },
      }),
    })
    const payload = await response.json() as { result?: { data?: unknown[]; nextCursor?: string | null } }
    const calls = (await readFile(callLog, 'utf8')).trim().split('\n')

    expect(response.status).toBe(200)
    expect(payload.result?.data).toEqual([])
    expect(payload.result?.nextCursor).toEqual(expect.any(String))
    expect(calls.length).toBeLessThanOrEqual(4)
  })

  it('bounds archive classification input for a large cold session-index page', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-list-bounded-candidates-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    }))
    const entries = Array.from({ length: 20_000 }, (_, index) => ({
      id: `large-index-thread-${String(index).padStart(5, '0')}`,
      thread_name: `Large ${index}`,
      updated_at: new Date((index + 1) * 1_000).toISOString(),
    }))
    await writeFile(
      join(codexHome, 'session_index.jsonl'),
      entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
    )
    expect(spawnSync('sqlite3', [join(codexHome, 'state_5.sqlite'),
      'CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER);',
    ], { encoding: 'utf8' }).status).toBe(0)
    const shimDir = join(codexHome, 'miniconda3', 'bin')
    const querySizeLog = join(codexHome, 'sqlite-query-sizes.log')
    const sqlitePath = spawnSync('which', ['sqlite3'], { encoding: 'utf8' }).stdout.trim()
    expect(sqlitePath).not.toBe('')
    await mkdir(shimDir, { recursive: true })
    await writeFile(join(shimDir, 'sqlite3'), [
      '#!/bin/sh',
      'query_file="${TMPDIR:-/tmp}/codex-mobile-sql-$$"',
      'trap \'rm -f "$query_file"\' EXIT',
      'cat > "$query_file"',
      `wc -c < "$query_file" >> '${querySizeLog}'`,
      `exec '${sqlitePath}' "$@" < "$query_file"`,
      '',
    ].join('\n'))
    await chmod(join(shimDir, 'sqlite3'), 0o755)
    const originalSqliteCommand = process.env.CODEXUI_SQLITE_COMMAND
    process.env.CODEXUI_SQLITE_COMMAND = join(shimDir, 'sqlite3')
    disposers.push(() => {
      if (originalSqliteCommand === undefined) delete process.env.CODEXUI_SQLITE_COMMAND
      else process.env.CODEXUI_SQLITE_COMMAND = originalSqliteCommand
    })
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({ data: [], nextCursor: null })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/list',
        params: { archived: false, limit: 5, sortKey: 'updated_at', modelProviders: [], cursor: null },
      }),
    })
    expect(response.status).toBe(200)
    const querySizes = (await readFile(querySizeLog, 'utf8'))
      .trim().split('\n').map((value) => Number(value))
    expect(Math.max(...querySizes)).toBeLessThan(100_000)
  })

  it('keeps real state-db list SQL bounded after a large seen-id cursor snapshot', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-list-bounded-seen-sql-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
    const entries = Array.from({ length: 400 }, (_, index) => ({
      id: `bounded-seen-${String(index).padStart(4, '0')}-${'x'.repeat(320)}`,
      thread_name: `Bounded seen ${index}`,
      updated_at: new Date((index + 1) * 1_000).toISOString(),
    }))
    await writeFile(
      join(codexHome, 'session_index.jsonl'),
      entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
    )
    const stateDbPath = join(codexHome, 'state_5.sqlite')
    expect(spawnSync('sqlite3', [stateDbPath, [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, model_provider TEXT, cwd TEXT, title TEXT, cli_version TEXT, first_user_message TEXT, archived INTEGER, has_user_event INTEGER);',
    ].join(' ')], { encoding: 'utf8' }).status).toBe(0)
    const shimDir = join(codexHome, 'sqlite-shim')
    const querySizeLog = join(codexHome, 'sqlite-list-query-sizes.log')
    const sqlitePath = spawnSync('which', ['sqlite3'], { encoding: 'utf8' }).stdout.trim()
    await mkdir(shimDir)
    await writeFile(join(shimDir, 'sqlite3'), [
      '#!/bin/sh',
      'query_file="${TMPDIR:-/tmp}/codex-mobile-sql-$$"',
      'trap \'rm -f "$query_file"\' EXIT',
      'cat > "$query_file"',
      `if grep -q 'ORDER BY updated_at DESC, id DESC' "$query_file"; then wc -c < "$query_file" >> '${querySizeLog}'; fi`,
      `exec '${sqlitePath}' "$@" < "$query_file"`,
      '',
    ].join('\n'))
    await chmod(join(shimDir, 'sqlite3'), 0o755)
    const originalSqliteCommand = process.env.CODEXUI_SQLITE_COMMAND
    process.env.CODEXUI_SQLITE_COMMAND = join(shimDir, 'sqlite3')
    disposers.push(() => {
      if (originalSqliteCommand === undefined) delete process.env.CODEXUI_SQLITE_COMMAND
      else process.env.CODEXUI_SQLITE_COMMAND = originalSqliteCommand
    })
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({ data: [], nextCursor: null })
    const port = await listenWithMiddleware(middleware)

    let cursor: string | null = null
    let pageCount = 0
    let maximumPageElapsedMs = 0
    do {
      const startedAt = performance.now()
      const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'thread/list',
          params: { archived: false, limit: 5, sortKey: 'updated_at', modelProviders: [], cursor },
        }),
      })
      maximumPageElapsedMs = Math.max(maximumPageElapsedMs, performance.now() - startedAt)
      expect(response.status).toBe(200)
      const payload = await response.json() as { result?: { data?: unknown[]; nextCursor?: string | null } }
      expect(payload.result?.data?.length).toBeLessThanOrEqual(5)
      cursor = payload.result?.nextCursor ?? null
      pageCount += 1
    } while (cursor && pageCount < 100)

    const querySizes = (await readFile(querySizeLog, 'utf8')).trim().split('\n').map(Number)
    expect(pageCount).toBeGreaterThan(64)
    expect(cursor).toBeNull()
    expect(Math.max(...querySizes)).toBeLessThan(40_000)
    expect(maximumPageElapsedMs).toBeLessThan(1_000)
  }, 30_000)

  it('uses bounded state-db metadata with cwd for a cold first page', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-list-state-db-cold-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    }))
    await writeFile(join(codexHome, 'session_index.jsonl'), Array.from({ length: 12 }, (_, index) => JSON.stringify({
      id: `thread-${index}`,
      thread_name: `Index ${index}`,
      updated_at: new Date((index + 1) * 1_000).toISOString(),
    })).join('\n') + '\n')
    const stateDbPath = join(codexHome, 'state_5.sqlite')
    const oversizedTitle = 'T'.repeat(2_000_000)
    const inserts = Array.from({ length: 12 }, (_, index) => {
      const title = index === 11 ? oversizedTitle : `State ${index}`
      return `INSERT INTO threads VALUES ('thread-${index}', '/tmp/sessions/thread-${index}.jsonl', 1, ${index + 1}, 'cli', 'openai', '/home/zonghangli/Desktop/prima.cpp', '${title}', '', 'State ${index}', 0);`
    })
    expect(spawnSync('sqlite3', [stateDbPath], { input: [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, model_provider TEXT, cwd TEXT, title TEXT, cli_version TEXT, first_user_message TEXT, archived INTEGER);',
      ...inserts,
    ].join(' '), encoding: 'utf8' }).status).toBe(0)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    let resolveRpc!: (value: unknown) => void
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(() => new Promise((resolve) => { resolveRpc = resolve }))
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/list',
        params: { archived: false, limit: 5, sortKey: 'updated_at', modelProviders: [], cursor: null },
      }),
    })
    const payload = await response.json() as {
      result?: { data?: Array<Record<string, unknown>>; nextCursor?: string | null }
    }

    expect(response.status).toBe(200)
    expect(payload.result?.data).toHaveLength(5)
    expect(payload.result?.data?.map((row) => row.id)).toEqual([
      'thread-11', 'thread-10', 'thread-9', 'thread-8', 'thread-7',
    ])
    expect(payload.result?.data?.every((row) => row.cwd === '/home/zonghangli/Desktop/prima.cpp')).toBe(true)
    expect(payload.result?.data?.every((row) => !('turns' in row))).toBe(true)
    expect(String(payload.result?.data?.[0]?.preview ?? '').length).toBeLessThanOrEqual(512)
    expect(JSON.stringify(payload).length).toBeLessThan(10_000)
    expect(payload.result?.nextCursor).toEqual(expect.any(String))
    await vi.waitFor(() => expect(resolveRpc).toBeTypeOf('function'))
    resolveRpc({ data: [], nextCursor: null })
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    rpc.mockResolvedValue({ data: [], nextCursor: null })

    const refreshedResponse = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/list',
        params: { archived: false, limit: 5, sortKey: 'updated_at', modelProviders: [], cursor: null },
      }),
    })
    const refreshedPayload = await refreshedResponse.json() as {
      result?: { data?: Array<Record<string, unknown>> }
    }
    expect(refreshedResponse.status).toBe(200)
    expect(refreshedPayload.result?.data?.map((row) => row.id)).toEqual([
      'thread-11', 'thread-10', 'thread-9', 'thread-8', 'thread-7',
    ])
    expect(refreshedPayload.result?.data?.every((row) => (
      !('turns' in row)
      && !('items' in row)
      && !('messages' in row)
      && !('transcript' in row)
      && !('externalRuntime' in row)
    ))).toBe(true)
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(2))
  })

  it('queries archive metadata only once for a cold native first page', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-list-native-query-count-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const stateDbPath = join(codexHome, 'state_5.sqlite')
    expect(spawnSync('sqlite3', [stateDbPath, [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, model_provider TEXT, cwd TEXT, title TEXT, cli_version TEXT, first_user_message TEXT, archived INTEGER, has_user_event INTEGER);',
      "INSERT INTO threads VALUES ('native-cold', '/tmp/not-a-session.jsonl', 1, 1, 'cli', 'openai', '/tmp/project', 'Native cold', '', 'Native cold', 0, 1);",
    ].join(' ')], { encoding: 'utf8' }).status).toBe(0)
    const sqlitePath = spawnSync('which', ['sqlite3'], { encoding: 'utf8' }).stdout.trim()
    const callLog = join(codexHome, 'sqlite-calls.log')
    const shimPath = join(codexHome, 'sqlite-log.sh')
    await writeFile(shimPath, [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> '${callLog}'`,
      `if [ "$1" = "--version" ]; then exec '${sqlitePath}' "$@"; fi`,
      `tee -a '${callLog}' | '${sqlitePath}' "$@"`,
      '',
    ].join('\n'))
    await chmod(shimPath, 0o755)
    const originalSqliteCommand = process.env.CODEXUI_SQLITE_COMMAND
    process.env.CODEXUI_SQLITE_COMMAND = shimPath
    disposers.push(() => {
      if (originalSqliteCommand === undefined) delete process.env.CODEXUI_SQLITE_COMMAND
      else process.env.CODEXUI_SQLITE_COMMAND = originalSqliteCommand
    })
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({
      data: [{ id: 'native-cold', cwd: '/tmp/project', updatedAt: 1 }],
      nextCursor: null,
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/list',
        params: { archived: false, limit: 5, sortKey: 'updated_at', modelProviders: [], cursor: null },
      }),
    })

    expect(response.status).toBe(200)
    const archiveQueries = (await readFile(callLog, 'utf8')).split(/\r?\n/u).filter((line) => (
      line.includes('SELECT id, has_user_event, archived')
      || line.includes('SELECT id, archived FROM threads WHERE id IN')
    ))
    expect(archiveQueries).toHaveLength(1)
  })

  it('serves cached first-page thread/list RPC data while refreshing when mobile requests a fresh page', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-list-force-fresh-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => {
      void rm(codexHome, { recursive: true, force: true })
    })
    await writeFile(join(codexHome, 'session_index.jsonl'), '{"id":"thread-fresh","updated_at":"2026-07-27T00:01:00.000Z"}\n')

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc')
      .mockResolvedValueOnce({
        data: [
          {
            id: 'thread-cached',
            path: join(codexHome, 'sessions', 'thread-cached.jsonl'),
            status: { type: 'idle' },
          },
        ],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: 'thread-fresh',
            path: join(codexHome, 'sessions', 'thread-fresh.jsonl'),
            status: { type: 'idle' },
          },
        ],
        nextCursor: null,
      })
    vi.spyOn(shared.runtimeProbe, 'inspectMany').mockResolvedValue({})
    const port = await listenWithMiddleware(middleware)
    const baseParams = {
      archived: false,
      limit: 5,
      sortKey: 'updated_at',
      modelProviders: [],
      cursor: null,
    }

    const first = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/list',
        params: baseParams,
      }),
    })
    const fresh = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/list',
        params: {
          ...baseParams,
          __codexMobileForceFresh: true,
        },
      }),
    })

    expect(first.status).toBe(200)
    expect(fresh.status).toBe(200)
    const payload = await fresh.json() as {
      result?: { data?: Array<{ id?: string }> }
    }
    expect(payload.result?.data?.[0]?.id).toBe('thread-cached')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(rpc.mock.calls[1]?.[1]).toEqual(baseParams)
  })

  it('serves a persisted first-page thread/list snapshot when the cold app-server list is slow', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-list-persisted-cache-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => {
      void rm(codexHome, { recursive: true, force: true })
    })
    await writeFile(join(codexHome, 'session_index.jsonl'), '{"id":"thread-cached","updated_at":"2026-07-27T00:00:00.000Z"}\n')

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const staleResult = {
      data: [
        {
          id: 'thread-stale',
          path: join(codexHome, 'sessions', 'thread-stale.jsonl'),
          status: { type: 'idle' },
        },
      ],
      nextCursor: null,
    }
    const freshDeferred: { resolve?: (value: unknown) => void } = {}
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc')
      .mockResolvedValueOnce(staleResult)
      .mockImplementationOnce(() => new Promise((resolve) => {
        freshDeferred.resolve = resolve
      }))
    const inspectMany = vi.spyOn(shared.runtimeProbe, 'inspectMany')
      .mockImplementation(() => new Promise(() => {}))
    const port = await listenWithMiddleware(middleware)
    const body = JSON.stringify({
      method: 'thread/list',
      params: {
        archived: false,
        limit: 5,
        sortKey: 'updated_at',
        modelProviders: [],
        cursor: null,
      },
    })

    const warm = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    expect(warm.status).toBe(200)
    shared.appServer.invalidateThreadListRpcCache()

    const controller = new AbortController()
    const coldResponse = await Promise.race([
      fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      }),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 100)),
    ])

    if (coldResponse === 'timeout') {
      controller.abort()
      freshDeferred.resolve?.({ data: [], nextCursor: null })
    }

    expect(coldResponse).not.toBe('timeout')
    expect(coldResponse).toHaveProperty('status', 200)
    const payload = await (coldResponse as Response).json() as {
      result?: {
        data?: Array<{
          id?: string
          externalRuntime?: { state?: string; turnId?: string }
        }>
      }
    }
    expect(payload.result?.data?.[0]?.id).toBe('thread-stale')
    expect(payload.result?.data?.[0]?.externalRuntime).toBeUndefined()
    expect(rpc.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(inspectMany).not.toHaveBeenCalled()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(rpc).toHaveBeenCalledTimes(2)

    freshDeferred.resolve?.({
      data: [
        {
          id: 'thread-fresh',
          path: join(codexHome, 'sessions', 'thread-fresh.jsonl'),
          status: { type: 'idle' },
        },
      ],
      nextCursor: null,
    })
  })

  it('rejects a persisted first-page snapshot after the session index changes', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-list-signature-cache-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => {
      void rm(codexHome, { recursive: true, force: true })
    })
    const sessionIndexPath = join(codexHome, 'session_index.jsonl')
    await writeFile(sessionIndexPath, '{"id":"thread-cached","thread_name":"Cached","updated_at":"2026-07-27T00:00:00.000Z"}\n')

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc')
      .mockResolvedValueOnce({
        data: [{ id: 'thread-stale', path: join(codexHome, 'sessions', 'thread-stale.jsonl') }],
        nextCursor: null,
      })
      .mockResolvedValueOnce({ data: [], nextCursor: null })
    vi.spyOn(shared.runtimeProbe, 'inspectMany').mockResolvedValue({})
    const port = await listenWithMiddleware(middleware)
    const body = JSON.stringify({
      method: 'thread/list',
      params: { archived: false, limit: 5, sortKey: 'updated_at', modelProviders: [], cursor: null },
    })

    const warm = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    })
    expect(warm.status).toBe(200)
    shared.appServer.invalidateThreadListRpcCache()
    await appendFile(
      sessionIndexPath,
      '{"id":"thread-unarchived","thread_name":"Unarchived","updated_at":"2026-07-28T00:00:00.000Z"}\n',
    )

    const cold = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    })
    const payload = await cold.json() as { result?: { data?: Array<{ id?: string }> } }

    expect(cold.status).toBe(200)
    expect(payload.result?.data?.[0]?.id).toBe('thread-unarchived')
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(2))
  })

  it('invalidates persisted thread/list data and filters the exact archived state-db row', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-list-archive-signature-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    }))
    await writeFile(join(codexHome, 'session_index.jsonl'), [
      { id: 'thread-active-cache', thread_name: 'Active', updated_at: '2026-07-28T00:00:00.000Z' },
      { id: 'thread-archive-cache', thread_name: 'Archive me', updated_at: '2026-07-29T00:00:00.000Z' },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n')
    const stateDbPath = join(codexHome, 'state_5.sqlite')
    expect(spawnSync('sqlite3', [stateDbPath, [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER);',
      "INSERT INTO threads VALUES ('thread-active-cache', 0), ('thread-archive-cache', 0);",
    ].join(' ')], { encoding: 'utf8' }).status).toBe(0)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    const listResult = {
      data: [{ id: 'thread-archive-cache' }, { id: 'thread-active-cache' }],
      nextCursor: null,
    }
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue(listResult)
    const port = await listenWithMiddleware(middleware)
    const body = JSON.stringify({
      method: 'thread/list',
      params: { archived: false, limit: 5, sortKey: 'updated_at', modelProviders: [], cursor: null },
    })
    expect((await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    })).status).toBe(200)
    shared.appServer.invalidateThreadListRpcCache()
    expect(spawnSync('sqlite3', [stateDbPath,
      "UPDATE threads SET archived = 1 WHERE id = 'thread-archive-cache';",
    ], { encoding: 'utf8' }).status).toBe(0)
    const future = new Date(Date.now() + 2_000)
    await utimes(stateDbPath, future, future)

    const cold = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    })
    const payload = await cold.json() as { result?: { data?: Array<{ id?: string }> } }

    expect(payload.result?.data?.map((row) => row.id)).toEqual(['thread-active-cache'])
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(2))
    await vi.waitFor(async () => {
      const cacheFiles = await readdir(join(codexHome, 'codex-mobile-cache'))
      const persisted = JSON.parse(await readFile(
        join(codexHome, 'codex-mobile-cache', cacheFiles[0]!),
        'utf8',
      )) as { result?: { data?: Array<{ id?: string }> } }
      expect(persisted.result?.data?.map((row) => row.id)).toEqual(['thread-active-cache'])
    })
  })

  it('keeps a five-row native first page bounded and metadata-only when state-db imports exist', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-list-import-limit-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    }))
    const stateDbPath = join(codexHome, 'state_5.sqlite')
    const inserts = Array.from({ length: 10 }, (_, index) => (
      `INSERT INTO threads VALUES ('import-${index}', '/tmp/sessions/import-${index}.jsonl', 1, ${index + 1}, 'cli', 'openai', '/tmp/project', 'Import ${index}', '', 'Import ${index}', 0);`
    ))
    expect(spawnSync('sqlite3', [stateDbPath, [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, model_provider TEXT, cwd TEXT, title TEXT, cli_version TEXT, first_user_message TEXT, archived INTEGER);',
      ...inserts,
    ].join(' ')], { encoding: 'utf8' }).status).toBe(0)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (_method, params) => (
      (params as { cursor?: string | null }).cursor === 'native-next'
        ? { data: [], nextCursor: null }
        : {
            data: Array.from({ length: 5 }, (_, index) => ({
              id: index === 0 ? 'import-9' : `native-${index}`,
              updatedAt: 100 - index,
            })),
            nextCursor: 'native-next',
          }
    ))
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/list',
        params: { archived: false, limit: 5, sortKey: 'updated_at', modelProviders: [], cursor: null },
      }),
    })
    const payload = await response.json() as {
      result?: { data?: Array<Record<string, unknown>>; nextCursor?: string | null }
    }

    expect(payload.result?.data).toHaveLength(5)
    expect(payload.result?.data?.every((row) => !('turns' in row))).toBe(true)
    expect(payload.result?.nextCursor).toEqual(expect.any(String))

    const terminal = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/list',
        params: {
          archived: false,
          limit: 5,
          sortKey: 'updated_at',
          modelProviders: [],
          cursor: payload.result?.nextCursor,
        },
      }),
    })
    const terminalPayload = await terminal.json() as {
      result?: { data?: Array<Record<string, unknown>>; nextCursor?: string | null }
    }
    expect(terminalPayload.result?.data?.some((row) => String(row.id).startsWith('import-'))).toBe(true)
    expect(terminalPayload.result?.data?.length).toBeLessThanOrEqual(5)

    const importedIds = [...(payload.result?.data ?? []), ...(terminalPayload.result?.data ?? [])]
      .map((row) => String(row.id))
      .filter((id) => id.startsWith('import-'))
    let cursor = terminalPayload.result?.nextCursor ?? null
    while (cursor) {
      const page = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'thread/list',
          params: { archived: false, limit: 5, sortKey: 'updated_at', modelProviders: [], cursor },
        }),
      })
      const pagePayload = await page.json() as {
        result?: { data?: Array<Record<string, unknown>>; nextCursor?: string | null }
      }
      expect(page.status).toBe(200)
      expect(pagePayload.result?.data?.length).toBeLessThanOrEqual(5)
      expect(pagePayload.result?.data?.every((row) => !('turns' in row))).toBe(true)
      importedIds.push(...(pagePayload.result?.data ?? []).map((row) => String(row.id)))
      cursor = pagePayload.result?.nextCursor ?? null
    }
    expect(importedIds.sort()).toEqual(Array.from({ length: 10 }, (_, index) => `import-${index}`).sort())
  })

  it('globally orders interleaved state-db imports without dropping displaced native rows', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-list-global-order-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    }))
    const stateDbPath = join(codexHome, 'state_5.sqlite')
    expect(spawnSync('sqlite3', [stateDbPath, [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, model_provider TEXT, cwd TEXT, title TEXT, cli_version TEXT, first_user_message TEXT, archived INTEGER);',
      "INSERT INTO threads VALUES ('cross-source-overlap', '/tmp/sessions/cross-source-overlap.jsonl', 1, 96, 'cli', 'openai', '/tmp/project', 'Cross overlap', '', 'Cross overlap', 0);",
      "INSERT INTO threads VALUES ('import-95', '/tmp/sessions/import-95.jsonl', 1, 95, 'cli', 'openai', '/tmp/project', 'Import 95', '', 'Import 95', 0);",
      "INSERT INTO threads VALUES ('import-75', '/tmp/sessions/import-75.jsonl', 1, 75, 'cli', 'openai', '/tmp/project', 'Import 75', '', 'Import 75', 0);",
    ].join(' ')], { encoding: 'utf8' }).status).toBe(0)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (_method, params) => (
      (params as { cursor?: string | null }).cursor === 'native-next'
        ? {
            data: [
              { id: 'native-80', updatedAt: 80 },
              { id: 'cross-source-overlap', updatedAt: 60 },
              { id: 'native-70', updatedAt: 70 },
            ],
            nextCursor: null,
          }
        : {
            data: [
              { id: 'native-100', updatedAt: 100 },
              { id: 'native-90', updatedAt: 90 },
            ],
            nextCursor: 'native-next',
          }
    ))
    const port = await listenWithMiddleware(middleware)
    const ids: string[] = []
    let cursor: string | null = 'native-start'
    let pageCount = 0
    do {
      const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'thread/list',
          params: {
            archived: false,
            limit: 2,
            sortKey: 'updated_at',
            modelProviders: [],
            cursor,
            __codexMobileForceFresh: true,
          },
        }),
      })
      expect(response.status).toBe(200)
      const payload = await response.json() as {
        result?: { data?: Array<{ id?: string }>; nextCursor?: string | null }
      }
      expect(payload.result?.data?.length).toBeLessThanOrEqual(2)
      ids.push(...(payload.result?.data ?? []).map((row) => row.id ?? ''))
      cursor = payload.result?.nextCursor ?? null
      pageCount += 1
      expect(pageCount).toBeLessThan(10)
    } while (cursor)

    expect(ids).toEqual([
      'native-100',
      'cross-source-overlap',
      'import-95',
      'native-90',
      'native-80',
      'import-75',
      'native-70',
    ])
    expect(ids.filter((id) => id === 'cross-source-overlap')).toHaveLength(1)
  })

  it('replays a native state-db overlap when a newer state-only row displaces it', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-list-overlap-replay-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
    const stateDbPath = join(codexHome, 'state_5.sqlite')
    expect(spawnSync('sqlite3', [stateDbPath], {
      input: [
        'CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, model_provider TEXT, cwd TEXT, title TEXT, cli_version TEXT, first_user_message TEXT, archived INTEGER);',
        "INSERT INTO threads VALUES ('native-b', '/tmp/sessions/native-b.jsonl', 1, 90, 'cli', 'openai', '/tmp/project', 'Native B', '', 'Native B', 0);",
        "INSERT INTO threads VALUES ('state-x', '/tmp/sessions/state-x.jsonl', 1, 95, 'cli', 'openai', '/tmp/project', 'State X', '', 'State X', 0);",
      ].join(' '),
      encoding: 'utf8',
    }).status).toBe(0)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({
      data: [
        { id: 'native-a', updatedAt: 100 },
        { id: 'native-b', updatedAt: 90 },
      ],
      nextCursor: null,
    })
    const port = await listenWithMiddleware(middleware)
    const ids: string[] = []
    let cursor: string | null = 'native-start'
    let pages = 0
    do {
      const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'thread/list',
          params: {
            archived: false,
            limit: 2,
            sortKey: 'updated_at',
            modelProviders: [],
            cursor,
            __codexMobileForceFresh: true,
          },
        }),
      })
      expect(response.status).toBe(200)
      const payload = await response.json() as {
        result?: { data?: Array<{ id?: string }>; nextCursor?: string | null }
      }
      ids.push(...(payload.result?.data ?? []).map((row) => row.id ?? ''))
      cursor = payload.result?.nextCursor ?? null
      pages += 1
      expect(pages).toBeLessThan(5)
    } while (cursor)

    expect(ids).toEqual(['native-a', 'state-x', 'native-b'])
  })

  it('does not advance an imported scan past rows that are older than the replayed native page', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-list-scan-replay-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
    const importedRows = Array.from({ length: 468 }, (_, index) => ({
      id: `scan-import-${String(index).padStart(3, '0')}`,
      updatedAt: 1_000 - index,
    }))
    const stateDbPath = join(codexHome, 'state_5.sqlite')
    expect(spawnSync('sqlite3', [stateDbPath], {
      input: [
        'CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, model_provider TEXT, cwd TEXT, title TEXT, cli_version TEXT, first_user_message TEXT, archived INTEGER);',
        ...importedRows.map((row) => `INSERT INTO threads VALUES ('${row.id}', '/tmp/sessions/${row.id}.jsonl', 1, ${row.updatedAt}, 'cli', 'openai', '/tmp/project', '${row.id}', '', '${row.id}', 0);`),
      ].join(' '),
      encoding: 'utf8',
    }).status).toBe(0)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (_method, params) => (
      (params as { cursor?: string | null }).cursor === 'native-next'
        ? { data: [], nextCursor: null }
        : { data: [{ id: 'native-boundary', updatedAt: 600 }], nextCursor: 'native-next' }
    ))
    const port = await listenWithMiddleware(middleware)
    const ids: string[] = []
    let cursor: string | null = 'native-start'
    let pages = 0
    do {
      const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'thread/list',
          params: {
            archived: false,
            limit: 100,
            sortKey: 'updated_at',
            modelProviders: [],
            cursor,
            __codexMobileForceFresh: true,
          },
        }),
      })
      expect(response.status).toBe(200)
      const payload = await response.json() as {
        result?: { data?: Array<{ id?: string }>; nextCursor?: string | null }
      }
      ids.push(...(payload.result?.data ?? []).map((row) => row.id ?? ''))
      cursor = payload.result?.nextCursor ?? null
      pages += 1
      expect(pages).toBeLessThan(20)
    } while (cursor)

    expect(ids).toHaveLength(importedRows.length + 1)
    expect(new Set(ids)).toHaveProperty('size', ids.length)
    expect(ids).toContain('native-boundary')
    expect(ids).toContain(importedRows.at(-1)!.id)
  }, 30_000)

  it('preserves global ordering across a capped imported scan while replaying the native page', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-list-capped-global-order-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
    const importedRows = Array.from({ length: 468 }, (_, index) => ({
      id: `capped-import-${String(index).padStart(3, '0')}`,
      updatedAt: 2_000 - index,
    }))
    const nativeRows = Array.from({ length: 100 }, (_, index) => ({
      id: `capped-native-${String(index).padStart(3, '0')}`,
      updatedAt: 1_000 - index,
    }))
    const stateDbPath = join(codexHome, 'state_5.sqlite')
    expect(spawnSync('sqlite3', [stateDbPath], {
      input: [
        'CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, model_provider TEXT, cwd TEXT, title TEXT, cli_version TEXT, first_user_message TEXT, archived INTEGER);',
        ...importedRows.map((row) => `INSERT INTO threads VALUES ('${row.id}', '/tmp/sessions/${row.id}.jsonl', 1, ${row.updatedAt}, 'cli', 'openai', '/tmp/project', '${row.id}', '', '${row.id}', 0);`),
      ].join(' '),
      encoding: 'utf8',
    }).status).toBe(0)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (_method, params) => (
      (params as { cursor?: string | null }).cursor === 'native-next'
        ? { data: [], nextCursor: null }
        : { data: nativeRows, nextCursor: 'native-next' }
    ))
    const port = await listenWithMiddleware(middleware)
    const rows: Array<{ id: string; updatedAt: number }> = []
    let cursor: string | null = 'native-start'
    let pages = 0
    do {
      const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'thread/list',
          params: {
            archived: false,
            limit: 100,
            sortKey: 'updated_at',
            modelProviders: [],
            cursor,
            __codexMobileForceFresh: true,
          },
        }),
      })
      expect(response.status).toBe(200)
      const payload = await response.json() as {
        result?: { data?: Array<{ id?: string; updatedAt?: number }>; nextCursor?: string | null }
      }
      rows.push(...(payload.result?.data ?? []).map((row) => ({
        id: row.id ?? '',
        updatedAt: row.updatedAt ?? 0,
      })))
      cursor = payload.result?.nextCursor ?? null
      pages += 1
      expect(pages).toBeLessThan(20)
    } while (cursor)

    expect(rows).toHaveLength(importedRows.length + nativeRows.length)
    expect(new Set(rows.map((row) => row.id))).toHaveProperty('size', rows.length)
    expect(rows.every((row, index) => index === 0 || rows[index - 1]!.updatedAt >= row.updatedAt)).toBe(true)
  }, 30_000)

  it('passes large imported-id exclusions to sqlite over stdin instead of argv', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-list-import-stdin-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const stateDbPath = join(codexHome, 'state_5.sqlite')
    const overlapRows = Array.from({ length: 40 }, (_, index) => ({
      id: `stdin-overlap-${String(index).padStart(2, '0')}`,
      updatedAt: 1_000 - index,
    }))
    expect(spawnSync('sqlite3', [stateDbPath, [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, model_provider TEXT, cwd TEXT, title TEXT, cli_version TEXT, first_user_message TEXT, archived INTEGER, has_user_event INTEGER);',
      ...overlapRows.map((row) => `INSERT INTO threads VALUES ('${row.id}', '/tmp/sessions/${row.id}.jsonl', 1, ${row.updatedAt}, 'cli', 'openai', '/tmp/project', '${row.id}', '', '${row.id}', 0, 1);`),
      "INSERT INTO threads VALUES ('stdin-remainder', '/tmp/sessions/stdin-remainder.jsonl', 1, 1, 'cli', 'openai', '/tmp/project', 'stdin-remainder', '', 'stdin-remainder', 0, 1);",
    ].join(' ')], { encoding: 'utf8' }).status).toBe(0)
    const sqlitePath = spawnSync('which', ['sqlite3'], { encoding: 'utf8' }).stdout.trim()
    const shimPath = join(codexHome, 'sqlite-reject-not-in-argv.sh')
    await writeFile(shimPath, [
      '#!/bin/sh',
      'case "$3" in',
      '  *"NOT IN"*) exit 97 ;;',
      'esac',
      `exec '${sqlitePath}' "$@"`,
      '',
    ].join('\n'))
    await chmod(shimPath, 0o755)
    const originalSqliteCommand = process.env.CODEXUI_SQLITE_COMMAND
    process.env.CODEXUI_SQLITE_COMMAND = shimPath
    disposers.push(() => {
      if (originalSqliteCommand === undefined) delete process.env.CODEXUI_SQLITE_COMMAND
      else process.env.CODEXUI_SQLITE_COMMAND = originalSqliteCommand
    })
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (_method, params) => (
      (params as { cursor?: string | null }).cursor
        ? { data: [], nextCursor: null }
        : { data: overlapRows, nextCursor: 'native-next' }
    ))
    const port = await listenWithMiddleware(middleware)
    const requestPage = async (cursor: string | null) => {
      const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'thread/list',
          params: { archived: false, limit: 40, sortKey: 'updated_at', modelProviders: [], cursor },
        }),
      })
      return { response, payload: await response.json() as {
        result?: { data?: Array<{ id?: string }>; nextCursor?: string | null }
      } }
    }

    const first = await requestPage(null)
    expect(first.response.status).toBe(200)
    expect(first.payload.result?.nextCursor).toEqual(expect.any(String))
    const second = await requestPage(first.payload.result?.nextCursor ?? null)

    expect(second.response.status).toBe(200)
    expect(second.payload.result?.data?.map((row) => row.id)).toEqual(['stdin-remainder'])
  })

  it('paginates more than 200 state-db imports across a new middleware instance', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-list-import-restart-'))
    process.env.CODEX_HOME = codexHome
    const stateDbPath = join(codexHome, 'state_5.sqlite')
    const inserts = Array.from({ length: 205 }, (_, index) => (
      `INSERT INTO threads VALUES ('bulk-${String(index).padStart(3, '0')}', '/tmp/sessions/bulk-${index}.jsonl', 1, ${index + 1}, 'cli', 'openai', '/tmp/project', 'Bulk ${index}', '', 'Bulk ${index}', 0);`
    ))
    expect(spawnSync('sqlite3', [stateDbPath, [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, model_provider TEXT, cwd TEXT, title TEXT, cli_version TEXT, first_user_message TEXT, archived INTEGER);',
      ...inserts,
    ].join(' ')], { encoding: 'utf8' }).status).toBe(0)

    const firstMiddleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({ data: [], nextCursor: null })
    const firstPort = await listenWithMiddleware(firstMiddleware)
    const first = await fetch(`http://127.0.0.1:${firstPort}/codex-api/rpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/list',
        params: { archived: false, limit: 100, sortKey: 'updated_at', modelProviders: [], cursor: null },
      }),
    })
    expect(first.status).toBe(200)
    const firstPayload = await first.json() as {
      result?: { data?: Array<Record<string, unknown>>; nextCursor?: string | null }
    }
    expect(firstPayload.result?.data).toHaveLength(100)
    expect(firstPayload.result?.nextCursor).toEqual(expect.any(String))

    const secondMiddleware = createCodexBridgeMiddleware()
    const secondPort = await listenWithMiddleware(secondMiddleware)
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const allRows = [...(firstPayload.result?.data ?? [])]
    let cursor = firstPayload.result?.nextCursor ?? null
    while (cursor) {
      const page = await fetch(`http://127.0.0.1:${secondPort}/codex-api/rpc`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'thread/list',
          params: { archived: false, limit: 100, sortKey: 'updated_at', modelProviders: [], cursor },
        }),
      })
      expect(page.status).toBe(200)
      const payload = await page.json() as {
        result?: { data?: Array<Record<string, unknown>>; nextCursor?: string | null }
      }
      expect(payload.result?.data?.length).toBeLessThanOrEqual(100)
      allRows.push(...(payload.result?.data ?? []))
      cursor = payload.result?.nextCursor ?? null
    }

    expect(allRows).toHaveLength(205)
    expect(new Set(allRows.map((row) => row.id))).toHaveProperty('size', 205)
    expect(allRows.every((row) => !('turns' in row))).toBe(true)
    expect(allRows.every((row) => !('items' in row))).toBe(true)
    expect(allRows.every((row) => !('messages' in row))).toBe(true)
    expect(allRows.every((row) => !('transcript' in row))).toBe(true)
    expect(rpc).toHaveBeenCalledTimes(1)
  }, 30_000)

  it('filters stale-active archived state-db imports across cursor pages', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-list-stale-archive-import-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const stateDbPath = join(codexHome, 'state_5.sqlite')
    const archivedId = 'stale-active-import-archived'
    expect(spawnSync('sqlite3', [stateDbPath, [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, model_provider TEXT, cwd TEXT, title TEXT, cli_version TEXT, first_user_message TEXT, archived INTEGER);',
      "INSERT INTO threads VALUES ('active-import-new', '/tmp/sessions/active-new.jsonl', 1, 30, 'cli', 'openai', '/tmp/project', 'Active new', '', 'Active new', 0);",
      `INSERT INTO threads VALUES ('${archivedId}', '/tmp/sessions/archived.jsonl', 1, 20, 'cli', 'openai', '/tmp/project', 'Archived stale active', '', 'Archived stale active', 0);`,
      "INSERT INTO threads VALUES ('active-import-old', '/tmp/sessions/active-old.jsonl', 1, 10, 'cli', 'openai', '/tmp/project', 'Active old', '', 'Active old', 0);",
    ].join(' ')], { encoding: 'utf8' }).status).toBe(0)
    const archivedDir = join(codexHome, 'archived_sessions', 'imports')
    await mkdir(archivedDir, { recursive: true })
    await writeFile(join(archivedDir, `rollout-${archivedId}.jsonl`), `${JSON.stringify({
      type: 'session_meta', payload: { id: archivedId },
    })}\n`)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({ data: [], nextCursor: null })
    const port = await listenWithMiddleware(middleware)
    const ids: string[] = []
    let cursor: string | null = null
    do {
      const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'thread/list',
          params: { archived: false, limit: 1, sortKey: 'updated_at', modelProviders: [], cursor },
        }),
      })
      expect(response.status).toBe(200)
      const payload = await response.json() as {
        result?: { data?: Array<{ id?: string }>; nextCursor?: string | null }
      }
      ids.push(...(payload.result?.data ?? []).map((row) => row.id ?? ''))
      cursor = payload.result?.nextCursor ?? null
    } while (cursor)

    expect(ids).toEqual(['active-import-new', 'active-import-old'])
  })

  it('does not re-emit a state-db overlap after more than 64 cursor IDs', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-list-long-overlap-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    }))
    const rows = Array.from({ length: 80 }, (_, index) => ({
      id: index === 0 ? 'long-overlap' : `long-index-${String(index).padStart(2, '0')}`,
      updatedAt: 2_000 - index,
    }))
    await writeFile(join(codexHome, 'session_index.jsonl'), `${rows.slice().reverse().map((row) => JSON.stringify({
      id: row.id,
      thread_name: row.id,
      updated_at: new Date(row.updatedAt * 1_000).toISOString(),
    })).join('\n')}\n`)
    const stateDbPath = join(codexHome, 'state_5.sqlite')
    expect(spawnSync('sqlite3', [stateDbPath, [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, model_provider TEXT, cwd TEXT, title TEXT, cli_version TEXT, first_user_message TEXT, archived INTEGER);',
      "INSERT INTO threads VALUES ('long-overlap', '/tmp/sessions/long-overlap.jsonl', 1, 1, 'cli', 'openai', '/tmp/project', 'long-overlap', '', 'long-overlap', 0);",
      "INSERT INTO threads VALUES ('state-only-tail', '/tmp/sessions/state-only-tail.jsonl', 1, 0, 'cli', 'openai', '/tmp/project', 'state-only-tail', '', 'state-only-tail', 0);",
    ].join(' ')], { encoding: 'utf8' }).status).toBe(0)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    let resolveRpc!: (value: unknown) => void
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(() => new Promise((resolve) => { resolveRpc = resolve }))
    const port = await listenWithMiddleware(middleware)
    const ids: string[] = []
    let cursor: string | null = null
    do {
      const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'thread/list',
          params: { archived: false, limit: 5, sortKey: 'updated_at', modelProviders: [], cursor },
        }),
      })
      expect(response.status).toBe(200)
      const payload = await response.json() as {
        result?: { data?: Array<{ id?: string }>; nextCursor?: string | null }
      }
      ids.push(...(payload.result?.data ?? []).map((row) => row.id ?? ''))
      cursor = payload.result?.nextCursor ?? null
    } while (cursor)

    expect(ids.filter((id) => id === 'long-overlap')).toHaveLength(1)
    expect(ids).toContain('state-only-tail')
    await vi.waitFor(() => expect(resolveRpc).toBeTypeOf('function'))
    resolveRpc({ data: [], nextCursor: null })
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  it('paginates more than 200 native rows that overlap state-db metadata', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-list-native-overlap-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const stateDbPath = join(codexHome, 'state_5.sqlite')
    const rows = Array.from({ length: 205 }, (_, index) => ({
      id: `overlap-${String(index).padStart(3, '0')}`,
      updatedAt: 1_000 - index,
    }))
    const inserts = rows.map((row) => (
      `INSERT INTO threads VALUES ('${row.id}', '/tmp/sessions/${row.id}.jsonl', 1, ${row.updatedAt}, 'cli', 'openai', '/tmp/project', '${row.id}', '', '${row.id}', 0);`
    ))
    expect(spawnSync('sqlite3', [stateDbPath, [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, model_provider TEXT, cwd TEXT, title TEXT, cli_version TEXT, first_user_message TEXT, archived INTEGER);',
      ...inserts,
    ].join(' ')], { encoding: 'utf8' }).status).toBe(0)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (_method, params) => {
      const cursor = (params as { cursor?: string | null }).cursor
      const offset = cursor ? Number.parseInt(cursor.replace('native-', ''), 10) : 0
      const data = rows.slice(offset, offset + 100)
      const nextOffset = offset + data.length
      return { data, nextCursor: nextOffset < rows.length ? `native-${nextOffset}` : null }
    })
    const port = await listenWithMiddleware(middleware)
    const allRows: Array<Record<string, unknown>> = []
    let cursor: string | null = null
    do {
      const page = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'thread/list',
          params: {
            archived: false, limit: 100, sortKey: 'updated_at', modelProviders: [], cursor,
            __codexMobileForceFresh: true,
          },
        }),
      })
      expect(page.status).toBe(200)
      const payload = await page.json() as {
        result?: { data?: Array<Record<string, unknown>>; nextCursor?: string | null }
      }
      allRows.push(...(payload.result?.data ?? []))
      cursor = payload.result?.nextCursor ?? null
    } while (cursor)

    expect(allRows).toHaveLength(205)
    expect(new Set(allRows.map((row) => row.id))).toHaveProperty('size', 205)
  })

  it('authenticates persisted imported-id snapshots referenced by list cursors', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-list-snapshot-auth-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const rows = Array.from({ length: 65 }, (_, index) => ({
      id: `snapshot-${String(index).padStart(3, '0')}`,
      updatedAt: 1_000 - index,
    }))
    expect(spawnSync('sqlite3', [join(codexHome, 'state_5.sqlite'), [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, model_provider TEXT, cwd TEXT, title TEXT, cli_version TEXT, first_user_message TEXT, archived INTEGER);',
      ...rows.map((row) => `INSERT INTO threads VALUES ('${row.id}', '/tmp/sessions/${row.id}.jsonl', 1, ${row.updatedAt}, 'cli', 'openai', '/tmp/project', '${row.id}', '', '${row.id}', 0);`),
    ].join(' ')], { encoding: 'utf8' }).status).toBe(0)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (_method, params) => {
      const cursor = (params as { cursor?: string | null }).cursor
      const offset = cursor ? Number.parseInt(cursor.replace('native-', ''), 10) : 0
      const data = rows.slice(offset, offset + 32)
      const nextOffset = offset + data.length
      return { data, nextCursor: nextOffset < rows.length ? `native-${nextOffset}` : null }
    })
    const port = await listenWithMiddleware(middleware)
    const first = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/list',
        params: {
          archived: false, limit: 32, sortKey: 'updated_at', modelProviders: [], cursor: null,
          __codexMobileForceFresh: true,
        },
      }),
    })
    const firstPayload = await first.json() as { result?: { nextCursor?: string | null } }
    expect({ status: first.status, cursor: firstPayload.result?.nextCursor }).toEqual({
      status: 200,
      cursor: expect.any(String),
    })
    const second = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/list',
        params: {
          archived: false, limit: 32, sortKey: 'updated_at', modelProviders: [],
          cursor: firstPayload.result?.nextCursor,
        },
      }),
    })
    const secondPayload = await second.json() as { result?: { nextCursor?: string | null } }
    expect({ status: second.status, cursor: secondPayload.result?.nextCursor }).toEqual({
      status: 200,
      cursor: expect.any(String),
    })
    const snapshotRoot = join(codexHome, 'codex-mobile-cache', 'thread-list-cursor-state')
    const snapshotFiles = await readdir(snapshotRoot)
    expect(snapshotFiles).toHaveLength(1)
    await writeFile(join(snapshotRoot, snapshotFiles[0]!), JSON.stringify(['attacker-controlled-id']))

    const third = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/list',
        params: {
          archived: false, limit: 32, sortKey: 'updated_at', modelProviders: [],
          cursor: secondPayload.result?.nextCursor,
        },
      }),
    })

    expect(third.status).toBe(400)
  }, 20_000)

  it('does not persist unreachable imported-id snapshots for terminal list pages', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-list-terminal-snapshot-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    expect(spawnSync('sqlite3', [join(codexHome, 'state_5.sqlite'), [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, model_provider TEXT, cwd TEXT, title TEXT, cli_version TEXT, first_user_message TEXT, archived INTEGER);',
      "INSERT INTO threads VALUES ('terminal-overlap', '/tmp/terminal.jsonl', 1, 1, 'cli', 'openai', '/tmp/project', 'Terminal', '', 'Terminal', 0);",
    ].join(' ')], { encoding: 'utf8' }).status).toBe(0)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({ data: [{ id: 'terminal-overlap', updatedAt: 1 }], nextCursor: null })
    const port = await listenWithMiddleware(middleware)
    for (let index = 0; index < 5; index += 1) {
      const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'thread/list',
          params: {
            archived: false, limit: 100, sortKey: 'updated_at', modelProviders: [], cursor: null,
            __codexMobileForceFresh: true,
          },
        }),
      })
      expect(response.status).toBe(200)
    }
    const snapshotRoot = join(codexHome, 'codex-mobile-cache', 'thread-list-cursor-state')
    await expect(readdir(snapshotRoot).catch(() => [])).resolves.toEqual([])
  })

  it('accepts synthesized Windows permission bits while retaining POSIX private-mode checks', () => {
    const metadata = { isFile: true, isSymbolicLink: false, mode: 0o100666, uid: 1_000 }

    expect(isThreadListCursorFileMetadataValid(metadata, 'win32', 1_000)).toBe(true)
    expect(isThreadListCursorFileMetadataValid(metadata, 'linux', 1_000)).toBe(false)
  })

  it('falls back to a persisted first-page thread/list snapshot when a forced fresh list is slow', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-list-force-fallback-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => {
      void rm(codexHome, { recursive: true, force: true })
    })
    await writeFile(join(codexHome, 'session_index.jsonl'), '{"id":"thread-cached","updated_at":"2026-07-27T00:00:00.000Z"}\n')

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const staleResult = {
      data: [
        {
          id: 'thread-stale',
          path: join(codexHome, 'sessions', 'thread-stale.jsonl'),
          status: { type: 'idle' },
        },
      ],
      nextCursor: null,
    }
    const freshDeferred: { resolve?: (value: unknown) => void } = {}
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc')
      .mockResolvedValueOnce(staleResult)
      .mockImplementationOnce(() => new Promise((resolve) => {
        freshDeferred.resolve = resolve
      }))
    vi.spyOn(shared.runtimeProbe, 'inspectMany').mockResolvedValue({})
    const port = await listenWithMiddleware(middleware)
    const baseParams = {
      archived: false,
      limit: 5,
      sortKey: 'updated_at',
      modelProviders: [],
      cursor: null,
    }
    const warm = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/list',
        params: baseParams,
      }),
    })
    expect(warm.status).toBe(200)
    shared.appServer.invalidateThreadListRpcCache()

    const controller = new AbortController()
    const forcedResponse = await Promise.race([
      fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'thread/list',
          params: {
            ...baseParams,
            __codexMobileForceFresh: true,
          },
        }),
        signal: controller.signal,
      }),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 100)),
    ])

    if (forcedResponse === 'timeout') {
      controller.abort()
      freshDeferred.resolve?.({ data: [], nextCursor: null })
    }

    expect(forcedResponse).not.toBe('timeout')
    expect(forcedResponse).toHaveProperty('status', 200)
    const payload = await (forcedResponse as Response).json() as {
      result?: { data?: Array<{ id?: string }> }
    }
    expect(payload.result?.data?.[0]?.id).toBe('thread-stale')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(rpc).toHaveBeenCalledTimes(2)
    freshDeferred.resolve?.({ data: [], nextCursor: null })
  })

  it('prewarms the first-page thread/list cache after middleware startup', async () => {
    const previousCodexHome = process.env.CODEX_HOME
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-list-prewarm-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(async () => {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
      await rm(codexHome, { recursive: true, force: true })
    })
    await writeFile(join(codexHome, 'session_index.jsonl'), '{"id":"thread-prewarm","updated_at":"2026-07-27T00:00:00.000Z"}\n')
    expect(spawnSync('sqlite3', [join(codexHome, 'state_5.sqlite'), [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, model_provider TEXT, cwd TEXT, title TEXT, cli_version TEXT, first_user_message TEXT, archived INTEGER);',
      `INSERT INTO threads VALUES ('thread-prewarm-imported', '${join(codexHome, 'sessions', 'imported.jsonl')}', 1, 2, 'cli', 'openai', '/tmp/project', 'Imported prewarm', '1', 'Imported prewarm', 0);`,
    ].join(' ')], { encoding: 'utf8' }).status).toBe(0)

    const middleware = createCodexBridgeMiddleware({ prewarmThreadListCache: true })
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({
      data: [
        {
          id: 'thread-prewarm',
          path: join(codexHome, 'sessions', 'thread-prewarm.jsonl'),
          status: { type: 'idle' },
        },
      ],
      nextCursor: null,
    })
    vi.spyOn(shared.runtimeProbe, 'inspectMany').mockResolvedValue({})
    await listenWithMiddleware(middleware)

    await vi.waitFor(async () => {
      expect(await readdir(join(codexHome, 'codex-mobile-cache'))).toEqual(expect.arrayContaining([
        expect.stringMatching(/\.json$/u),
      ]))
    })
    expect(rpc).toHaveBeenCalledWith('thread/list', {
      archived: false,
      limit: 5,
      sortKey: 'updated_at',
      modelProviders: [],
      cursor: null,
    })
    const cacheFiles = await readdir(join(codexHome, 'codex-mobile-cache'))
    const persisted = JSON.parse(await readFile(
      join(codexHome, 'codex-mobile-cache', cacheFiles.find((name) => name.endsWith('.json'))!),
      'utf8',
    )) as { result?: { data?: Array<{ id?: string }> } }
    expect(persisted.result?.data?.map((row) => row.id)).toContain('thread-prewarm-imported')
  })

  it('degrades thread/resume to thread/read while another process owns the task', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running',
      turnId: 'turn-external',
      interruptible: false,
      source: 'external-session-writer',
    })
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({
      thread: {
        id: 'thread-external',
        path: '/home/user/.codex/sessions/rollout-thread-external.jsonl',
        status: { type: 'idle' },
        turns: [],
      },
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/resume',
        params: { threadId: 'thread-external' },
      }),
    })

    expect(response.status).toBe(200)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('thread/read', {
      threadId: 'thread-external',
      includeTurns: true,
    })
    await expect(response.json()).resolves.toMatchObject({
      result: {
        thread: {
          id: 'thread-external',
          externalRuntime: { state: 'running', source: 'external-session-writer' },
        },
      },
    })
  })

  it('degrades an active thread/resume to thread/read when another process owns the writer', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running',
      turnId: 'turn-external',
      interruptible: false,
      source: 'external-session-writer',
    })
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({
      thread: {
        id: 'thread-active-external',
        path: '/home/user/.codex/sessions/rollout-thread-active-external.jsonl',
        status: { type: 'active' },
        turns: [{ id: 'turn-external', status: 'inProgress' }],
      },
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/resume',
        params: { threadId: 'thread-active-external' },
      }),
    })

    expect(response.status).toBe(200)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('thread/read', {
      threadId: 'thread-active-external',
      includeTurns: true,
    })
    expect(inspect).toHaveBeenCalledWith('thread-active-external', 4242)
  })

  it('does not resume when writer ownership is unknown', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'unknown',
    })
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({
      thread: {
        id: 'thread-unknown-writer',
        path: '/home/user/.codex/sessions/rollout-thread-unknown-writer.jsonl',
        status: { type: 'idle' },
        turns: [],
      },
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/resume',
        params: { threadId: 'thread-unknown-writer' },
      }),
    })

    expect(response.status).toBe(200)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('thread/read', {
      threadId: 'thread-unknown-writer',
      includeTurns: true,
    })
    expect(inspect).toHaveBeenCalledWith('thread-unknown-writer', 4242)
  })
})

describe('POST /codex-api/rpc guarded user turns', () => {
  it('routes goal mutation through the controlled endpoint while raw RPC stays forbidden', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({ state: 'idle' })
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/read') return {
        thread: { id: 'thread-goal-route', path: '/home/user/.codex/sessions/goal.jsonl', turns: [] },
      }
      if (method === 'thread/goal/set') return {
        goal: { objective: 'finish', status: 'active', updatedAt: 1, timeUsedSeconds: 0, tokensUsed: 0 },
      }
      return {}
    })
    const port = await listenWithMiddleware(middleware)

    const controlled = await fetch(`http://127.0.0.1:${port}/codex-api/thread-goal-set`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId: 'thread-goal-route', objective: 'finish', status: 'active' }),
    })
    const raw = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'thread/goal/set', params: { threadId: 'thread-goal-route' } }),
    })

    expect(controlled.status).toBe(200)
    expect(raw.status).toBe(403)
    expect(rpc).toHaveBeenCalledWith('thread/goal/set', {
      threadId: 'thread-goal-route', objective: 'finish', status: 'active',
    })
  })

  it('does not archive until the interrupted local writer is actually idle', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-archive-quiescence-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const sqlite = spawnSync('sqlite3', [join(codexHome, 'state_5.sqlite'), [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER);',
      "INSERT INTO threads (id, archived) VALUES ('thread-still-running', 0);",
    ].join(' ')], { encoding: 'utf8' })
    expect(sqlite.status).toBe(0)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    shared.localRuntimeLedger.record({
      method: 'turn/started',
      params: { threadId: 'thread-still-running', turn: { id: 'turn-still-running' } },
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running', turnId: 'turn-still-running', interruptible: false, source: 'external-session-writer',
    })
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (method) => method === 'thread/read'
      ? { thread: { id: 'thread-still-running', path: '/tmp/still-running.jsonl', turns: [] } }
      : {})
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-stop-and-archive`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId: 'thread-still-running' }),
    })
    shared.localRuntimeLedger.record({
      method: 'turn/completed',
      params: { threadId: 'thread-still-running', turn: { id: 'turn-still-running' } },
    })

    expect(response.status).toBe(409)
    expect(rpc).toHaveBeenCalledWith('turn/interrupt', {
      threadId: 'thread-still-running', turnId: 'turn-still-running',
    })
    expect(rpc).not.toHaveBeenCalledWith('thread/goal/clear', expect.anything())
    expect(rpc).not.toHaveBeenCalledWith('thread/archive', expect.anything())
  })

  it('rechecks writer ownership inside the final controlled archive call', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-archive-final-guard-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    expect(spawnSync('sqlite3', [join(codexHome, 'state_5.sqlite'), [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER);',
      "INSERT INTO threads VALUES ('thread-final-archive-guard', 0);",
    ].join(' ')], { encoding: 'utf8' }).status).toBe(0)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.runtimeProbe, 'inspect')
      .mockResolvedValueOnce({ state: 'idle' })
      .mockResolvedValueOnce({
        state: 'running', turnId: 'turn-foreign-late', interruptible: false, source: 'external-session-writer',
      })
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (method) => method === 'thread/read'
      ? { thread: { id: 'thread-final-archive-guard', path: '/tmp/final-archive-guard.jsonl', turns: [] } }
      : {})
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-stop-and-archive`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId: 'thread-final-archive-guard' }),
    })

    expect(response.status).toBe(409)
    expect(rpc).not.toHaveBeenCalledWith('thread/goal/clear', expect.anything())
    expect(rpc).not.toHaveBeenCalledWith('thread/archive', expect.anything())
  })

  it.each(['NULL', '2', "'corrupt'"])('fails closed for invalid archived state %s', async (archivedValue) => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-invalid-archive-state-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const threadId = '019fc67c-7c0c-7fc2-881f-e8dfd8edf372'
    expect(spawnSync('sqlite3', [join(codexHome, 'state_5.sqlite'), [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, archived);',
      `INSERT INTO threads VALUES ('${threadId}', ${archivedValue});`,
    ].join(' ')], { encoding: 'utf8' }).status).toBe(0)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({ thread: { id: threadId, turns: [] } })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'thread/read', params: { threadId } }),
    })

    expect(response.status).toBe(409)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('fails closed when thread/list metadata contains an invalid archived value', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-invalid-list-archive-state-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const threadId = '019fc67c-7c0c-7fc2-881f-e8dfd8edf373'
    expect(spawnSync('sqlite3', [join(codexHome, 'state_5.sqlite'), [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, archived);',
      `INSERT INTO threads VALUES ('${threadId}', 2);`,
    ].join(' ')], { encoding: 'utf8' }).status).toBe(0)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({
      data: [{ id: threadId, title: 'must not leak', cwd: '/tmp/project' }],
      nextCursor: null,
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/list',
        params: { archived: false, limit: 5, sortKey: 'updated_at', modelProviders: [], cursor: null },
      }),
    })

    expect(response.status).toBe(409)
  })

  it('filters a missing state-db row when its exact session is archived on disk', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-missing-list-archive-state-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const archivedThreadId = '019fd122-4567-7890-a123-456789abcdef'
    const activeThreadId = 'thread-present-db-active'
    const archivedDir = join(codexHome, 'archived_sessions')
    await mkdir(archivedDir, { recursive: true })
    await writeFile(
      join(archivedDir, archivedRolloutFileName(archivedThreadId, 0, true)),
      `${JSON.stringify({ type: 'session_meta', payload: { id: archivedThreadId } })}\n`,
    )
    expect(spawnSync('sqlite3', [join(codexHome, 'state_5.sqlite'), [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER);',
      `INSERT INTO threads VALUES ('${activeThreadId}', 0);`,
    ].join(' ')], { encoding: 'utf8' }).status).toBe(0)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({
      data: [
        { id: archivedThreadId, cwd: '/tmp/project' },
        { id: activeThreadId, cwd: '/tmp/project' },
      ],
      nextCursor: null,
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/list',
        params: { archived: false, limit: 5, sortKey: 'updated_at', modelProviders: [], cursor: null },
      }),
    })
    const payload = await response.json() as { result?: { data?: Array<{ id?: string }> } }

    expect(response.status).toBe(200)
    expect(payload.result?.data?.map((entry) => entry.id)).toEqual([activeThreadId])
  })

  it('filters an archived UUID stored outside its timestamp-derived path', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-arbitrary-uuid-archive-state-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const threadId = '550e8400-e29b-41d4-a716-446655440000'
    const archivedDir = join(codexHome, 'archived_sessions', 'imports', '2026')
    await mkdir(archivedDir, { recursive: true })
    await writeFile(
      join(archivedDir, `rollout-2026-01-01T00-00-00-${threadId}.jsonl`),
      `${JSON.stringify({ type: 'session_meta', payload: { id: threadId } })}\n`,
    )
    expect(spawnSync('sqlite3', [join(codexHome, 'state_5.sqlite'),
      'CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER);',
    ], { encoding: 'utf8' }).status).toBe(0)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({ data: [{ id: threadId, cwd: '/tmp/project' }], nextCursor: null })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/list',
        params: { archived: false, limit: 5, sortKey: 'updated_at', modelProviders: [], cursor: null },
      }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ result: { data: [] } })
  })

  it('filters an archived UUID whose rollout filename no longer contains the UUID', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-renamed-uuid-archive-state-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const threadId = '550e8400-e29b-41d4-a716-446655440001'
    const archivedDir = join(codexHome, 'archived_sessions', 'renamed')
    await mkdir(archivedDir, { recursive: true })
    await writeFile(
      join(archivedDir, 'archived-rollout.jsonl'),
      `${JSON.stringify({ type: 'session_meta', payload: { id: threadId } })}\n`,
    )
    expect(spawnSync('sqlite3', [join(codexHome, 'state_5.sqlite'), [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER);',
      `INSERT INTO threads VALUES ('${threadId}', 0);`,
    ].join(' ')], { encoding: 'utf8' }).status).toBe(0)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({ data: [{ id: threadId, cwd: '/tmp/project' }], nextCursor: null })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/list',
        params: { archived: false, limit: 5, sortKey: 'updated_at', modelProviders: [], cursor: null },
      }),
    })

    const responsePayload = await response.json()
    expect(response.status, JSON.stringify(responsePayload)).toBe(200)
    expect(responsePayload).toMatchObject({ result: { data: [] } })
  })

  it('fails closed for a renamed archived UUID exposed through a jsonl symlink', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-symlink-uuid-archive-state-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const threadId = '550e8400-e29b-41d4-a716-446655440002'
    const archivedDir = join(codexHome, 'archived_sessions')
    const targetPath = join(codexHome, 'renamed-archive-target.jsonl')
    await mkdir(archivedDir, { recursive: true })
    await writeFile(targetPath, `${JSON.stringify({ type: 'session_meta', payload: { id: threadId } })}\n`)
    await symlink(targetPath, join(archivedDir, 'renamed-archive.jsonl'))
    expect(spawnSync('sqlite3', [join(codexHome, 'state_5.sqlite'), [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER);',
      `INSERT INTO threads VALUES ('${threadId}', 0);`,
    ].join(' ')], { encoding: 'utf8' }).status).toBe(0)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({ data: [{ id: threadId, cwd: '/tmp/project' }], nextCursor: null })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/list',
        params: { archived: false, limit: 5, sortKey: 'updated_at', modelProviders: [], cursor: null },
      }),
    })

    expect(response.status).toBe(409)
  })

  it('invalidates a warm list cache after a nested archive file is added', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-nested-archive-list-cache-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    }))
    const threadId = 'nested-archive-list-cache-thread'
    const archivedDir = join(codexHome, 'archived_sessions', 'existing', 'nested')
    await mkdir(archivedDir, { recursive: true })
    await writeFile(join(codexHome, 'session_index.jsonl'), `${JSON.stringify({
      id: threadId,
      thread_name: 'Nested archive cache',
      updated_at: '2026-07-28T06:00:00.000Z',
    })}\n`)
    expect(spawnSync('sqlite3', [join(codexHome, 'state_5.sqlite'), [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER);',
      `INSERT INTO threads VALUES ('${threadId}', 0);`,
    ].join(' ')], { encoding: 'utf8' }).status).toBe(0)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({ data: [{ id: threadId, cwd: '/tmp/project' }], nextCursor: null })
    const port = await listenWithMiddleware(middleware)
    const body = JSON.stringify({
      method: 'thread/list',
      params: { archived: false, limit: 5, sortKey: 'updated_at', modelProviders: [], cursor: null },
    })
    const first = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    })
    await expect(first.json()).resolves.toMatchObject({ result: { data: [{ id: threadId }] } })
    await vi.waitFor(async () => {
      expect(await readdir(join(codexHome, 'codex-mobile-cache'))).toEqual(expect.arrayContaining([
        expect.stringMatching(/^thread-list-.*\.json$/u),
      ]))
    })
    await writeFile(join(archivedDir, `rollout-${threadId}.jsonl`), `${JSON.stringify({
      type: 'session_meta', payload: { id: threadId },
    })}\n`)
    shared.appServer.invalidateThreadListRpcCache()

    const second = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    })

    expect(second.status).toBe(200)
    await expect(second.json()).resolves.toMatchObject({ result: { data: [] } })
  })

  it('invalidates a warm archive index after a non-UUID file is replaced in place', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-replaced-archive-file-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
    const archivedDir = join(codexHome, 'archived_sessions', 'imports')
    const archivedFile = join(archivedDir, 'imported.jsonl')
    await mkdir(archivedDir, { recursive: true })
    await writeFile(archivedFile, `${JSON.stringify({
      type: 'session_meta', payload: { id: 'archive-old-id' },
    })}\n`)
    await writeFile(join(codexHome, 'session_index.jsonl'), [
      { id: 'archive-old-id', thread_name: 'Old archived id', updated_at: '2026-07-28T06:00:00.000Z' },
      { id: 'archive-new-id', thread_name: 'New archived id', updated_at: '2026-07-28T05:00:00.000Z' },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n')
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({ data: [], nextCursor: null })
    const port = await listenWithMiddleware(middleware)
    const body = JSON.stringify({
      method: 'thread/list',
      params: { archived: false, limit: 5, sortKey: 'updated_at', modelProviders: [], cursor: null },
    })

    const first = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    })
    await expect(first.json()).resolves.toMatchObject({
      result: { data: [{ id: 'archive-new-id' }] },
    })

    await writeFile(archivedFile, `${JSON.stringify({
      type: 'session_meta', payload: { id: 'archive-new-id' },
    })}\n`)

    const second = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    })
    await expect(second.json()).resolves.toMatchObject({
      result: { data: [{ id: 'archive-old-id' }] },
    })
  })

  it('invalidates a warm archive index after a UUID file is replaced in place', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-replaced-uuid-archive-file-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
    const threadId = '019fd126-4567-7890-a123-456789abcdef'
    const activeThreadId = 'active-beside-replaced-uuid-archive'
    const archivedDir = join(codexHome, 'archived_sessions')
    const archivedFile = join(archivedDir, archivedRolloutFileName(threadId))
    await mkdir(archivedDir, { recursive: true })
    await writeFile(archivedFile, `${JSON.stringify({
      type: 'session_meta', payload: { id: threadId },
    })}\n`)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({ data: [{ id: activeThreadId, cwd: '/tmp/project' }], nextCursor: null })
    const port = await listenWithMiddleware(middleware)
    const body = JSON.stringify({
      method: 'thread/list',
      params: { archived: false, limit: 5, sortKey: 'updated_at', modelProviders: [], cursor: null },
    })

    const first = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    })
    await expect(first.json()).resolves.toMatchObject({
      result: { data: [{ id: activeThreadId }] },
    })

    await writeFile(archivedFile, `${JSON.stringify({
      type: 'session_meta', payload: { id: activeThreadId },
    })}\n`)

    const second = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    })
    expect(second.status).toBe(409)
  })

  it('treats an archived rollout as authoritative when the state-db row is stale active', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-stale-active-archive-state-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const threadId = '019fd124-4567-7890-a123-456789abcdef'
    const archivedDir = join(codexHome, 'archived_sessions')
    await mkdir(archivedDir, { recursive: true })
    await writeFile(join(archivedDir, archivedRolloutFileName(threadId)), `${JSON.stringify({
      type: 'session_meta', payload: { id: threadId },
    })}\n`)
    expect(spawnSync('sqlite3', [join(codexHome, 'state_5.sqlite'), [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER);',
      `INSERT INTO threads VALUES ('${threadId}', 0);`,
    ].join(' ')], { encoding: 'utf8' }).status).toBe(0)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({ data: [{ id: threadId, cwd: '/tmp/project' }], nextCursor: null })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/list',
        params: { archived: false, limit: 5, sortKey: 'updated_at', modelProviders: [], cursor: null },
      }),
    })

    const responsePayload = await response.json()
    expect(response.status, JSON.stringify(responsePayload)).toBe(200)
    expect(responsePayload).toMatchObject({ result: { data: [] } })
  })

  it.each([
    ['missing session identity', '{}\n'],
    ['mismatched session identity', `${JSON.stringify({
      type: 'session_meta', payload: { id: '019fd124-4567-7890-a123-456789abcdee' },
    })}\n`],
  ])('fails closed for a UUID-named archived rollout with %s', async (_label, archivedContents) => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-unidentified-uuid-archive-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const threadId = '019fd124-4567-7890-a123-456789abcdef'
    const activeThreadId = 'active-beside-unidentified-uuid-archive'
    const archivedDir = join(codexHome, 'archived_sessions')
    await mkdir(archivedDir, { recursive: true })
    await writeFile(join(archivedDir, archivedRolloutFileName(threadId)), archivedContents)
    expect(spawnSync('sqlite3', [join(codexHome, 'state_5.sqlite'), [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER);',
      `INSERT INTO threads VALUES ('${activeThreadId}', 0);`,
    ].join(' ')], { encoding: 'utf8' }).status).toBe(0)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({ data: [{ id: activeThreadId, cwd: '/tmp/project' }], nextCursor: null })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/list',
        params: {
          archived: false, limit: 5, sortKey: 'updated_at', modelProviders: [], cursor: null,
          __codexMobileForceFresh: true,
        },
      }),
    })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Cannot verify archived task state.',
    })
  })

  it('fails closed when a UUID exact miss cannot be checked against the archive tree', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-active-uuid-fast-archive-check-'))
    process.env.CODEX_HOME = codexHome
    const unreadableDir = join(codexHome, 'archived_sessions', 'unrelated')
    disposers.push(async () => {
      await chmod(unreadableDir, 0o700).catch(() => {})
      await rm(codexHome, { recursive: true, force: true })
    })
    const threadId = '019fd125-4567-7890-a123-456789abcdef'
    await mkdir(unreadableDir, { recursive: true })
    await writeFile(join(unreadableDir, 'unrelated.jsonl'), '{}\n')
    await chmod(unreadableDir, 0o000)
    expect(spawnSync('sqlite3', [join(codexHome, 'state_5.sqlite'), [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER);',
      `INSERT INTO threads VALUES ('${threadId}', 0);`,
    ].join(' ')], { encoding: 'utf8' }).status).toBe(0)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({ data: [{ id: threadId, cwd: '/tmp/project' }], nextCursor: null })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/list',
        params: { archived: false, limit: 5, sortKey: 'updated_at', modelProviders: [], cursor: null },
      }),
    })
    const payload = await response.json() as { result?: { data?: Array<{ id?: string }> } }

    expect(response.status).toBe(409)
    expect(payload.result).toBeUndefined()
  })

  it('filters an imported non-UUID archive whose state-db row is missing', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-imported-archive-state-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const archivedThreadId = 'imported-thread-without-uuid'
    const archivedDir = join(codexHome, 'archived_sessions', 'imported')
    await mkdir(archivedDir, { recursive: true })
    await writeFile(join(archivedDir, `000001-${archivedThreadId}.jsonl`), `${JSON.stringify({
      type: 'session_meta', payload: { id: archivedThreadId },
    })}\n`)
    expect(spawnSync('sqlite3', [join(codexHome, 'state_5.sqlite'),
      'CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER);',
    ], { encoding: 'utf8' }).status).toBe(0)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({
      data: [{ id: archivedThreadId, cwd: '/tmp/project' }],
      nextCursor: null,
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/list',
        params: {
          archived: false, limit: 5, sortKey: 'updated_at', modelProviders: [], cursor: null,
          __codexMobileForceFresh: true,
        },
      }),
    })
    const payload = await response.json() as { result?: { data?: unknown[] } }

    expect(response.status).toBe(200)
    expect(payload.result?.data).toEqual([])
  })

  it.each([
    ['missing session identity', '{}\n'],
    ['session identity beyond the inspection prefix', `${'x'.repeat((64 * 1024) + 1)}\n${JSON.stringify({
      type: 'session_meta', payload: { id: 'archive-identity-after-prefix' },
    })}\n`],
  ])('fails closed for an archived rollout with %s', async (_label, archivedContents) => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-unidentified-archive-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const threadId = 'active-beside-unidentified-archive'
    const archivedDir = join(codexHome, 'archived_sessions', 'imports')
    await mkdir(archivedDir, { recursive: true })
    await writeFile(join(archivedDir, 'rollout-unidentified.jsonl'), archivedContents)
    expect(spawnSync('sqlite3', [join(codexHome, 'state_5.sqlite'), [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER);',
      `INSERT INTO threads VALUES ('${threadId}', 0);`,
    ].join(' ')], { encoding: 'utf8' }).status).toBe(0)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({ data: [{ id: threadId, cwd: '/tmp/project' }], nextCursor: null })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/list',
        params: {
          archived: false, limit: 5, sortKey: 'updated_at', modelProviders: [], cursor: null,
          __codexMobileForceFresh: true,
        },
      }),
    })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Cannot verify archived task state.',
    })
  })

  it('does not classify a non-UUID thread by an unrelated archived filename suffix', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-archive-suffix-collision-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const archivedDir = join(codexHome, 'archived_sessions', 'imported')
    await mkdir(archivedDir, { recursive: true })
    await writeFile(join(archivedDir, '000001-foo-child.jsonl'), `${JSON.stringify({
      type: 'session_meta', payload: { id: 'foo-child' },
    })}\n`)
    expect(spawnSync('sqlite3', [join(codexHome, 'state_5.sqlite'),
      'CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER);',
    ], { encoding: 'utf8' }).status).toBe(0)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({ data: [{ id: 'child', cwd: '/tmp/project' }], nextCursor: null })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/list',
        params: {
          archived: false, limit: 5, sortKey: 'updated_at', modelProviders: [], cursor: null,
          __codexMobileForceFresh: true,
        },
      }),
    })
    const payload = await response.json() as { result?: { data?: Array<{ id?: string }> } }

    expect(response.status).toBe(200)
    expect(payload.result?.data?.map((row) => row.id)).toEqual(['child'])
  })

  it('bypasses a warm archive index for a fresh nested non-UUID mutation check', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-archive-index-fresh-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const threadId = 'nested-archive-after-warm-cache'
    const archivedDir = join(codexHome, 'archived_sessions', 'existing', 'nested')
    await mkdir(archivedDir, { recursive: true })
    expect(spawnSync('sqlite3', [join(codexHome, 'state_5.sqlite'), [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER);',
      `INSERT INTO threads VALUES ('${threadId}', 0);`,
    ].join(' ')], { encoding: 'utf8' }).status).toBe(0)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({ data: [{ id: threadId, cwd: '/tmp/project' }], nextCursor: null })
    const port = await listenWithMiddleware(middleware)
    const listBody = JSON.stringify({
      method: 'thread/list',
      params: { archived: false, limit: 5, sortKey: 'updated_at', modelProviders: [], cursor: null },
    })

    expect((await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: listBody,
    })).status).toBe(200)
    await writeFile(join(archivedDir, `rollout-${threadId}.jsonl`), `${JSON.stringify({
      type: 'session_meta', payload: { id: threadId },
    })}\n`)

    const append = await fetch(`http://127.0.0.1:${port}/codex-api/thread-queue-state`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        threadId,
        message: {
          id: 'must-not-queue', text: 'archived', imageUrls: [], skills: [], fileAttachments: [],
          collaborationMode: 'default', model: '', effort: '',
        },
      }),
    })

    expect(append.status).toBe(409)
  })

  it('resolves an active non-UUID rollout by exact session_meta id', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-active-rollout-exact-id-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const sessionsDir = join(codexHome, 'sessions')
    await mkdir(sessionsDir, { recursive: true })
    const exactPath = join(sessionsDir, 'rollout-000001-child.jsonl')
    const collisionPath = join(sessionsDir, 'rollout-000002-foo-child.jsonl')
    const rollout = (id: string, text: string) => [
      { type: 'session_meta', payload: { id } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: `turn-${id}` } },
      { type: 'response_item', payload: { type: 'message', id: `agent-${id}`, role: 'assistant', content: [{ type: 'output_text', text }] } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: `turn-${id}` } },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n'
    await writeFile(exactPath, rollout('child', 'exact child text'))
    await writeFile(collisionPath, rollout('foo-child', 'wrong collision text'))
    const future = new Date(Date.now() + 2_000)
    await utimes(collisionPath, future, future)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({ data: [], nextCursor: null, backwardsCursor: null })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-turn-page?threadId=child&limit=3`,
    )
    const payload = await response.text()

    expect(response.status).toBe(200)
    expect(payload).toContain('exact child text')
    expect(payload).not.toContain('wrong collision text')
  })

  it('finds an exact archived UUID without recursively reading unrelated archive directories', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-targeted-archive-lookup-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(async () => {
      await chmod(join(codexHome, 'archived_sessions', 'unrelated'), 0o700).catch(() => {})
      await rm(codexHome, { recursive: true, force: true })
    })
    const threadId = '019fd123-4567-7890-a123-456789abcdef'
    const archivedRoot = join(codexHome, 'archived_sessions')
    await mkdir(join(archivedRoot, 'unrelated'), { recursive: true })
    await writeFile(
      join(archivedRoot, archivedRolloutFileName(threadId, 1_000)),
      `${JSON.stringify({ type: 'session_meta', payload: { id: threadId } })}\n`,
    )
    await chmod(join(archivedRoot, 'unrelated'), 0o000)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({
      data: [{ id: threadId, cwd: '/tmp/project' }],
      nextCursor: null,
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/list',
        params: { archived: false, limit: 5, sortKey: 'updated_at', modelProviders: [], cursor: null },
      }),
    })
    const payload = await response.json() as { result?: { data?: unknown[] } }

    expect(response.status).toBe(200)
    expect(payload.result?.data).toEqual([])
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('rejects queue append for an exact state-db archived thread', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-queue-archived-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const sqlite = spawnSync('sqlite3', [join(codexHome, 'state_5.sqlite'), [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER);',
      "INSERT INTO threads (id, archived) VALUES ('thread-archived-queue', 1);",
    ].join(' ')], { encoding: 'utf8' })
    expect(sqlite.status).toBe(0)
    const middleware = createCodexBridgeMiddleware()
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-queue-state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        threadId: 'thread-archived-queue',
        message: {
          id: 'queued-archived', text: 'must not queue', imageUrls: [], skills: [], fileAttachments: [],
          collaborationMode: 'default', model: '', effort: '',
        },
      }),
    })

    expect(response.status).toBe(409)
  })

  it('rejects queue receipt lookup for an archived thread', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-queue-receipt-archived-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    expect(spawnSync('sqlite3', [join(codexHome, 'state_5.sqlite'), [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER);',
      "INSERT INTO threads VALUES ('thread-archived-receipt', 1);",
    ].join(' ')], { encoding: 'utf8' }).status).toBe(0)
    const middleware = createCodexBridgeMiddleware()
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-queue-receipt?threadId=thread-archived-receipt&messageId=queued-1`,
    )

    expect(response.status).toBe(409)
  })

  it('rejects queue replacement for archived threads and prunes stale archived queue rows on read', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-queue-replace-archived-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const threadId = 'thread-archived-queue-replace'
    expect(spawnSync('sqlite3', [join(codexHome, 'state_5.sqlite'), [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER);',
      `INSERT INTO threads VALUES ('${threadId}', 1);`,
    ].join(' ')], { encoding: 'utf8' }).status).toBe(0)
    await appendThreadQueuedMessage(threadId, {
      id: 'stale-archived', text: 'must be pruned', imageUrls: [], skills: [], fileAttachments: [],
      collaborationMode: 'default', model: '', effort: '',
    })
    const middleware = createCodexBridgeMiddleware()
    const port = await listenWithMiddleware(middleware)

    const staleRead = await fetch(`http://127.0.0.1:${port}/codex-api/thread-queue-state`)
    expect(staleRead.status).toBe(200)
    await expect(staleRead.json()).resolves.toMatchObject({ data: {} })

    const replacement = await fetch(`http://127.0.0.1:${port}/codex-api/thread-queue-state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        queueState: {
          [threadId]: [{
            id: 'replacement-archived', text: 'must be rejected', imageUrls: [], skills: [], fileAttachments: [],
            collaborationMode: 'default', model: '', effort: '',
          }],
        },
        baseRevision: 1,
      }),
    })
    expect(replacement.status).toBe(409)
  })

  it('does not return a queued row archived while the queue snapshot is being classified', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-queue-read-archive-race-'))
    process.env.CODEX_HOME = codexHome
    const originalSqliteCommand = process.env.CODEXUI_SQLITE_COMMAND
    disposers.push(() => {
      if (originalSqliteCommand === undefined) delete process.env.CODEXUI_SQLITE_COMMAND
      else process.env.CODEXUI_SQLITE_COMMAND = originalSqliteCommand
      return rm(codexHome, { recursive: true, force: true })
    })
    const threadId = 'thread-queue-read-archive-race'
    const stateDbPath = join(codexHome, 'state_5.sqlite')
    expect(spawnSync('sqlite3', [stateDbPath, [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER);',
      `INSERT INTO threads VALUES ('${threadId}', 0);`,
    ].join(' ')], { encoding: 'utf8' }).status).toBe(0)
    await appendThreadQueuedMessage(threadId, {
      id: 'queued-before-archive', text: 'must not reappear', imageUrls: [], skills: [], fileAttachments: [],
      collaborationMode: 'default', model: '', effort: '',
    })
    const sqlitePath = spawnSync('which', ['sqlite3'], { encoding: 'utf8' }).stdout.trim()
    const markerPath = join(codexHome, 'archive-triggered')
    const callLogPath = join(codexHome, 'sqlite-call-log')
    const shimPath = join(codexHome, 'sqlite-archive-after-read.sh')
    await writeFile(shimPath, [
      '#!/bin/sh',
      `if [ "$1" = "--version" ]; then exec '${sqlitePath}' "$@"; fi`,
      `printf 'call\\n' >> '${callLogPath}'`,
      `output=$('${sqlitePath}' "$@")`,
      'status=$?',
      'printf "%s" "$output"',
      `if [ $status -eq 0 ] && [ ! -e '${markerPath}' ]; then`,
      `  touch '${markerPath}'`,
      `  '${sqlitePath}' '${stateDbPath}' "UPDATE threads SET archived = 1 WHERE id = '${threadId}';"`,
      'fi',
      'exit $status',
      '',
    ].join('\n'))
    await chmod(shimPath, 0o755)
    process.env.CODEXUI_SQLITE_COMMAND = shimPath
    const middleware = createCodexBridgeMiddleware()
    middleware.dispose()
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-queue-state`)
    const payload = await response.json() as { data?: Record<string, unknown> }
    const archivedValue = spawnSync(sqlitePath, [stateDbPath,
      `SELECT archived FROM threads WHERE id = '${threadId}';`,
    ], { encoding: 'utf8' }).stdout.trim()
    const sqliteCalls = (await readFile(callLogPath, 'utf8')).trim().split(/\\r?\\n/u).length

    expect(response.status).toBe(200)
    expect(archivedValue).toBe('1')
    expect(sqliteCalls).toBeGreaterThanOrEqual(1)
    expect(payload.data?.[threadId]).toBeUndefined()
  })

  it.each([
    ['PUT', 'replace'],
    ['PATCH', 'reorder'],
    ['POST', 'append'],
  ] as const)('rejects queue %s when the thread is archived immediately after %s commit', async (method, _operation) => {
    const codexHome = await mkdtemp(join(tmpdir(), `codex-mobile-queue-${method.toLowerCase()}-archive-race-`))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const threadId = `thread-queue-${method.toLowerCase()}-archive-race`
    const stateDbPath = join(codexHome, 'state_5.sqlite')
    expect(spawnSync('sqlite3', [stateDbPath, [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER);',
      `INSERT INTO threads VALUES ('${threadId}', 0);`,
    ].join(' ')], { encoding: 'utf8' }).status).toBe(0)
    let baseRevision = 0
    if (method === 'PATCH') {
      baseRevision = await appendThreadQueuedMessage(threadId, {
        id: 'queued-first', text: 'first', imageUrls: [], skills: [], fileAttachments: [],
        collaborationMode: 'default', model: '', effort: '', dependencyWaitUntil: Date.now() + 60_000,
      })
      baseRevision = await appendThreadQueuedMessage(threadId, {
        id: 'queued-second', text: 'second', imageUrls: [], skills: [], fileAttachments: [],
        collaborationMode: 'default', model: '', effort: '', dependencyWaitUntil: Date.now() + 60_000,
      })
    }
    let archiveStatus: number | null = null
    let archived = false
    const unsubscribe = subscribeThreadQueueRevisions((event) => {
      if (archived || !event.threadIds.includes(threadId)) return
      archived = true
      archiveStatus = spawnSync('sqlite3', [stateDbPath,
        `UPDATE threads SET archived = 1 WHERE id = '${threadId}';`,
      ], { encoding: 'utf8' }).status
    })
    disposers.push(unsubscribe)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (_method, params) => ({
      thread: {
        id: (params as { threadId?: string }).threadId,
        path: join(codexHome, 'sessions', `${threadId}.jsonl`),
        turns: [],
      },
    }))
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({ state: 'idle' })
    vi.spyOn(shared.runtimeProbe, 'inspectWriterEvidence').mockResolvedValue(false)
    const port = await listenWithMiddleware(middleware)
    const initialQueue = await (await fetch(`http://127.0.0.1:${port}/codex-api/thread-queue-state`)).json() as {
      revision?: number
    }
    baseRevision = initialQueue.revision ?? baseRevision
    const body = method === 'PUT'
      ? {
          queueState: {
            [threadId]: [{
              id: 'queued-replacement', text: 'replacement', imageUrls: [], skills: [], fileAttachments: [],
              collaborationMode: 'default', model: '', effort: '',
            }],
          },
          baseRevision,
        }
      : method === 'PATCH'
        ? { threadId, operation: 'reorder', orderedMessageIds: ['queued-second', 'queued-first'], baseRevision }
        : {
            threadId,
            message: {
              id: 'queued-append', text: 'append', imageUrls: [], skills: [], fileAttachments: [],
              collaborationMode: 'default', model: '', effort: '',
            },
          }

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-queue-state`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const responsePayload = await response.json() as { error?: string }
    const queue = await (await fetch(`http://127.0.0.1:${port}/codex-api/thread-queue-state`)).json() as {
      data?: Record<string, unknown>
    }

    expect({ archiveStatus, status: response.status }).toEqual({
      archiveStatus: 0,
      status: 409,
    })
    expect(responsePayload.error).toContain('archived task')
    expect(queue.data?.[threadId]).toBeUndefined()
  })

  it('preserves active queues when archive state becomes unavailable after replacement commit', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-queue-replace-state-unavailable-'))
    process.env.CODEX_HOME = codexHome
    const originalSqliteCommand = process.env.CODEXUI_SQLITE_COMMAND
    disposers.push(() => {
      if (originalSqliteCommand === undefined) delete process.env.CODEXUI_SQLITE_COMMAND
      else process.env.CODEXUI_SQLITE_COMMAND = originalSqliteCommand
      return rm(codexHome, { recursive: true, force: true })
    })
    const firstThreadId = 'thread-queue-state-unavailable-first'
    const secondThreadId = 'thread-queue-state-unavailable-second'
    const stateDbPath = join(codexHome, 'state_5.sqlite')
    expect(spawnSync('sqlite3', [stateDbPath, [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER);',
      `INSERT INTO threads VALUES ('${firstThreadId}', 0);`,
      `INSERT INTO threads VALUES ('${secondThreadId}', 0);`,
    ].join(' ')], { encoding: 'utf8' }).status).toBe(0)
    await appendThreadQueuedMessage(firstThreadId, {
      id: 'queued-existing-first', text: 'existing first', imageUrls: [], skills: [], fileAttachments: [],
      collaborationMode: 'default', model: '', effort: '', dependencyWaitUntil: Date.now() + 60_000,
    })
    await appendThreadQueuedMessage(secondThreadId, {
      id: 'queued-existing-second', text: 'existing second', imageUrls: [], skills: [], fileAttachments: [],
      collaborationMode: 'default', model: '', effort: '', dependencyWaitUntil: Date.now() + 60_000,
    })
    const failingSqlitePath = join(codexHome, 'sqlite-state-unavailable.sh')
    await writeFile(failingSqlitePath, [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "3.0.0"; exit 0; fi',
      'exit 1',
      '',
    ].join('\n'))
    await chmod(failingSqlitePath, 0o755)
    let switchedToFailure = false
    const unsubscribe = subscribeThreadQueueRevisions((event) => {
      if (switchedToFailure || !event.threadIds.includes(firstThreadId)) return
      switchedToFailure = true
      process.env.CODEXUI_SQLITE_COMMAND = failingSqlitePath
    })
    disposers.push(unsubscribe)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    const scheduleAllQueuedThreads = vi.spyOn(
      (shared as unknown as { backendQueueProcessor: { scheduleAllQueuedThreads(delayMs?: number): Promise<void> } })
        .backendQueueProcessor,
      'scheduleAllQueuedThreads',
    ).mockResolvedValue()
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (_method, params) => ({
      thread: {
        id: (params as { threadId?: string }).threadId,
        path: join(codexHome, 'sessions', `${String((params as { threadId?: string }).threadId)}.jsonl`),
        turns: [],
      },
    }))
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({ state: 'idle' })
    vi.spyOn(shared.runtimeProbe, 'inspectWriterEvidence').mockResolvedValue(false)
    const port = await listenWithMiddleware(middleware)
    const initialQueue = await (await fetch(`http://127.0.0.1:${port}/codex-api/thread-queue-state`)).json() as {
      revision?: number
    }

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-queue-state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        queueState: {
          [firstThreadId]: [{
            id: 'queued-replacement-first', text: 'replacement first', imageUrls: [], skills: [], fileAttachments: [],
            collaborationMode: 'default', model: '', effort: '', dependencyWaitUntil: Date.now() + 60_000,
          }],
          [secondThreadId]: [{
            id: 'queued-replacement-second', text: 'replacement second', imageUrls: [], skills: [], fileAttachments: [],
            collaborationMode: 'default', model: '', effort: '', dependencyWaitUntil: Date.now() + 60_000,
          }],
        },
        baseRevision: initialQueue.revision,
      }),
    })
    delete process.env.CODEXUI_SQLITE_COMMAND
    const queue = await (await fetch(`http://127.0.0.1:${port}/codex-api/thread-queue-state`)).json() as {
      data?: Record<string, Array<{ id?: string }>>
    }

    const responsePayload = await response.json() as { committedRevision?: number }
    expect({ switchedToFailure, status: response.status }).toEqual({ switchedToFailure: true, status: 409 })
    expect(responsePayload.committedRevision).toBeGreaterThan(initialQueue.revision ?? 0)
    expect(queue.data?.[firstThreadId]?.map((message) => message.id)).toEqual(['queued-replacement-first'])
    expect(queue.data?.[secondThreadId]?.map((message) => message.id)).toEqual(['queued-replacement-second'])
    expect(scheduleAllQueuedThreads).toHaveBeenCalled()
  })

  it('preserves managed-upload transfer intent after an ambiguous committed removal', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-queue-remove-transfer-unavailable-'))
    process.env.CODEX_HOME = codexHome
    const originalSqliteCommand = process.env.CODEXUI_SQLITE_COMMAND
    disposers.push(() => {
      if (originalSqliteCommand === undefined) delete process.env.CODEXUI_SQLITE_COMMAND
      else process.env.CODEXUI_SQLITE_COMMAND = originalSqliteCommand
      return rm(codexHome, { recursive: true, force: true })
    })
    const threadId = 'thread-remove-transfer-unavailable'
    expect(spawnSync('sqlite3', [join(codexHome, 'state_5.sqlite'), [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER);',
      `INSERT INTO threads VALUES ('${threadId}', 0);`,
    ].join(' ')], { encoding: 'utf8' }).status).toBe(0)
    await appendThreadQueuedMessage(threadId, {
      id: 'queued-managed-transfer', text: 'move attachment',
      imageUrls: ['/codex-local-image?path=%2Ftmp%2Fmanaged.png&uploadHandle=managed-transfer'],
      skills: [], fileAttachments: [], collaborationMode: 'default', model: '', effort: '',
      dependencyWaitUntil: Date.now() + 60_000,
    })
    const failingSqlitePath = join(codexHome, 'sqlite-remove-transfer-unavailable.sh')
    await writeFile(failingSqlitePath, [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "3.0.0"; exit 0; fi',
      'exit 1',
      '',
    ].join('\n'))
    await chmod(failingSqlitePath, 0o755)
    let switchedToFailure = false
    const unsubscribe = subscribeThreadQueueRevisions((event) => {
      if (switchedToFailure || !event.threadIds.includes(threadId)) return
      switchedToFailure = true
      process.env.CODEXUI_SQLITE_COMMAND = failingSqlitePath
    })
    disposers.push(unsubscribe)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({
      thread: { id: threadId, path: join(codexHome, 'sessions', `${threadId}.jsonl`), turns: [] },
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({ state: 'idle' })
    vi.spyOn(shared.runtimeProbe, 'inspectWriterEvidence').mockResolvedValue(false)
    const forgetRuntimeQueuedMessage = vi.spyOn((shared as unknown as {
      backendQueueProcessor: {
        forgetRuntimeQueuedMessage(
          threadId: string,
          messageId: string,
          transferManagedUploads: boolean,
          message: unknown,
        ): void
      }
    }).backendQueueProcessor, 'forgetRuntimeQueuedMessage').mockImplementation(() => undefined)
    const port = await listenWithMiddleware(middleware)
    const initial = await (await fetch(`http://127.0.0.1:${port}/codex-api/thread-queue-state`)).json() as {
      revision?: number
    }

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-queue-state`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        threadId,
        operation: 'remove',
        messageId: 'queued-managed-transfer',
        baseRevision: initial.revision,
        transferManagedUploads: true,
      }),
    })
    const responsePayload = await response.json() as { error?: string }

    expect({ switchedToFailure, status: response.status, error: responsePayload.error }).toEqual({
      switchedToFailure: true,
      status: 409,
      error: 'Cannot verify archived task state.',
    })
    expect(forgetRuntimeQueuedMessage).toHaveBeenCalledWith(
      threadId,
      'queued-managed-transfer',
      true,
      expect.objectContaining({ id: 'queued-managed-transfer' }),
    )
  })

  it('blocks archived threads before runtime and transcript helper endpoints touch caches or probes', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-archived-helper-routes-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const threadId = 'thread-archived-helper-routes'
    expect(spawnSync('sqlite3', [join(codexHome, 'state_5.sqlite'), [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER);',
      `INSERT INTO threads VALUES ('${threadId}', 1);`,
    ].join(' ')], { encoding: 'utf8' }).status).toBe(0)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc')
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect')
    const interrupt = vi.spyOn(shared.runtimeProbe, 'interrupt')
    const port = await listenWithMiddleware(middleware)

    const requests = [
      fetch(`http://127.0.0.1:${port}/codex-api/thread-runtime-state?threadId=${threadId}`),
      fetch(`http://127.0.0.1:${port}/codex-api/thread-summary?threadId=${threadId}`),
      fetch(`http://127.0.0.1:${port}/codex-api/thread-turn-page?threadId=${threadId}`),
      fetch(`http://127.0.0.1:${port}/codex-api/thread-text-page?threadId=${threadId}&turnId=turn-1`),
      fetch(`http://127.0.0.1:${port}/codex-api/thread-stream-events?threadId=${threadId}`),
      fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=${threadId}`),
      fetch(`http://127.0.0.1:${port}/codex-api/thread-runtime-interrupt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId, turnId: 'turn-1' }),
      }),
    ]
    const responses = await Promise.all(requests)

    expect(responses.map((response) => response.status)).toEqual([409, 409, 409, 409, 409, 409, 409])
    expect(rpc).not.toHaveBeenCalled()
    expect(inspect).not.toHaveBeenCalled()
    expect(interrupt).not.toHaveBeenCalled()
  })

  it('polls a CLI thread missing from state-db without attaching it through thread/read', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-passive-cli-runtime-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    await mkdir(join(codexHome, 'archived_sessions'), { recursive: true })
    expect(spawnSync('sqlite3', [join(codexHome, 'state_5.sqlite'),
      'CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER);',
    ], { encoding: 'utf8' }).status).toBe(0)
    const threadId = 'cli-thread-missing-from-state-db'
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({
      thread: { id: threadId, path: join(codexHome, 'sessions', `${threadId}.jsonl`) },
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({ state: 'idle' })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-runtime-state?threadId=${threadId}`)

    expect(response.status).toBe(200)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('returns exact archived markers from runtime batches without probing those threads', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-archived-runtime-batch-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const archivedThreadId = 'thread-runtime-batch-archived'
    const activeThreadId = 'thread-runtime-batch-active'
    expect(spawnSync('sqlite3', [join(codexHome, 'state_5.sqlite'), [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER);',
      `INSERT INTO threads VALUES ('${archivedThreadId}', 1);`,
      `INSERT INTO threads VALUES ('${activeThreadId}', 0);`,
    ].join(' ')], { encoding: 'utf8' }).status).toBe(0)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    const inspectMany = vi.spyOn(shared.runtimeProbe, 'inspectMany').mockResolvedValue({
      [activeThreadId]: { state: 'idle' },
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-runtime-states`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadIds: [archivedThreadId, activeThreadId] }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      states: {
        [archivedThreadId]: { state: 'archived' },
        [activeThreadId]: { state: 'idle' },
      },
    })
    expect(inspectMany).toHaveBeenCalledWith([activeThreadId], null)
  })

  it('does not return or cache helper data when archive lands during the request', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-helper-archive-race-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const runtimeThreadId = 'thread-runtime-archive-race'
    const liveThreadId = 'thread-live-archive-race'
    const stateDbPath = join(codexHome, 'state_5.sqlite')
    expect(spawnSync('sqlite3', [stateDbPath, [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER);',
      `INSERT INTO threads VALUES ('${runtimeThreadId}', 0);`,
      `INSERT INTO threads VALUES ('${liveThreadId}', 0);`,
    ].join(' ')], { encoding: 'utf8' }).status).toBe(0)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.runtimeProbe, 'inspect').mockImplementation(async (threadId) => {
      if (threadId === runtimeThreadId || threadId === liveThreadId) {
        expect(spawnSync('sqlite3', [stateDbPath,
          `UPDATE threads SET archived = 1 WHERE id = '${threadId}';`,
        ], { encoding: 'utf8' }).status).toBe(0)
      }
      return { state: 'idle' }
    })
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (method, params) => {
      const threadId = (params as { threadId?: string })?.threadId
      if (method === 'thread/read' && threadId === liveThreadId) {
        throw new Error('passive thread/read forbidden')
      }
      if (method === 'thread/turns/list') return { data: [], nextCursor: null }
      return { thread: { id: threadId, path: '', turns: [] } }
    })
    const port = await listenWithMiddleware(middleware)

    const runtime = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-runtime-state?threadId=${runtimeThreadId}`,
    )
    const live = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=${liveThreadId}`,
    )
    const liveAgain = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=${liveThreadId}`,
    )

    expect([runtime.status, live.status, liveAgain.status]).toEqual([409, 409, 409])
  })

  it('rejects revisionless and stale exact queue mutations without changing the queue', async () => {
    const threadId = '019fc67c-7c0c-7fc2-881f-e8dfd8edf371'
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-queue-patch-cas-'))
    process.env.CODEX_HOME = codexHome
    await appendThreadQueuedMessage(threadId, {
      id: 'queued-cas', text: 'keep me', imageUrls: [], skills: [], fileAttachments: [],
      collaborationMode: 'default', model: '', effort: '',
    })
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({
      thread: { id: threadId, path: join(codexHome, 'sessions', `${threadId}.jsonl`), turns: [] },
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({ state: 'idle' })
    vi.spyOn(shared.runtimeProbe, 'inspectWriterEvidence').mockResolvedValue(false)
    const port = await listenWithMiddleware(middleware)
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))

    const revisionless = await fetch(`http://127.0.0.1:${port}/codex-api/thread-queue-state`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId, operation: 'remove', messageId: 'queued-cas' }),
    })
    expect(revisionless.status).toBe(400)

    const stale = await fetch(`http://127.0.0.1:${port}/codex-api/thread-queue-state`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        threadId, operation: 'reorder', orderedMessageIds: ['queued-cas'], baseRevision: 0,
      }),
    })
    expect(stale.status).toBe(409)

    const queue = await (await fetch(`http://127.0.0.1:${port}/codex-api/thread-queue-state`)).json() as {
      data?: Record<string, Array<{ id: string }>>
    }
    expect(queue.data?.[threadId]?.map((message) => message.id)).toEqual(['queued-cas'])
  })

  it('rejects automation queueing after its thread is archived', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-automation-archived-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const stateDbPath = join(codexHome, 'state_5.sqlite')
    expect(spawnSync('sqlite3', [stateDbPath, [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER);',
      "INSERT INTO threads VALUES ('thread-automation-archived', 0);",
    ].join(' ')], { encoding: 'utf8' }).status).toBe(0)
    const middleware = createCodexBridgeMiddleware()
    const port = await listenWithMiddleware(middleware)
    const saved = await fetch(`http://127.0.0.1:${port}/codex-api/thread-automation`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        threadId: 'thread-automation-archived', id: 'automation-1', name: 'Heartbeat',
        prompt: 'continue', rrule: 'FREQ=DAILY', status: 'ACTIVE',
      }),
    })
    expect(saved.status).toBe(200)
    const savedPayload = await saved.json() as { data?: { id?: string } }
    expect(savedPayload.data?.id).toBeTruthy()
    expect(spawnSync('sqlite3', [stateDbPath,
      "UPDATE threads SET archived = 1 WHERE id = 'thread-automation-archived';",
    ], { encoding: 'utf8' }).status).toBe(0)

    const run = await fetch(`http://127.0.0.1:${port}/codex-api/thread-automation/run`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId: 'thread-automation-archived', automationId: savedPayload.data?.id }),
    })

    expect(run.status).toBe(409)
    const queue = await (await fetch(`http://127.0.0.1:${port}/codex-api/thread-queue-state`)).json() as {
      data?: Record<string, unknown>
    }
    expect(queue.data?.['thread-automation-archived']).toBeUndefined()
  })

  it('refreshes the search index and removes an exact state-db archived thread', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-search-archived-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const stateDbPath = join(codexHome, 'state_5.sqlite')
    expect(spawnSync('sqlite3', [stateDbPath, [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER);',
      "INSERT INTO threads VALUES ('thread-search-archived', 0);",
    ].join(' ')], { encoding: 'utf8' }).status).toBe(0)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/list') return {
        data: [{ id: 'thread-search-archived', name: 'Unique searchable phrase', preview: '' }],
        nextCursor: null,
      }
      if (method === 'thread/read') return {
        thread: { id: 'thread-search-archived', turns: [] },
      }
      return {}
    })
    const port = await listenWithMiddleware(middleware)
    const search = () => fetch(`http://127.0.0.1:${port}/codex-api/thread-search`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'Unique searchable phrase' }),
    }).then((response) => response.json() as Promise<{ data?: { threadIds?: string[] } }>)
    await expect(search()).resolves.toMatchObject({ data: { threadIds: ['thread-search-archived'] } })
    expect(spawnSync('sqlite3', [stateDbPath,
      "UPDATE threads SET archived = 1 WHERE id = 'thread-search-archived';",
    ], { encoding: 'utf8' }).status).toBe(0)
    const future = new Date(Date.now() + 2_000)
    await utimes(stateDbPath, future, future)

    await expect(search()).resolves.toMatchObject({ data: { threadIds: [] } })
    expect(rpc.mock.calls.some(([method]) => method === 'thread/read')).toBe(false)
  })

  it('checks only the requested state-db thread when the database is large', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-large-state-db-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const stateDbPath = join(codexHome, 'state_5.sqlite')
    const sqlite = spawnSync('sqlite3', [stateDbPath, [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER);',
      'WITH RECURSIVE seq(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM seq WHERE x < 15000)',
      "INSERT INTO threads (id, archived) SELECT printf('thread-%06d-%090d', x, x), 0 FROM seq;",
      "INSERT INTO threads (id, archived) VALUES ('thread-active-target', 0);",
    ].join(' ')], { encoding: 'utf8' })
    expect(sqlite.status).toBe(0)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockResolvedValue({ thread: { id: 'thread-active-target', turns: [] } })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'thread/read', params: { threadId: 'thread-active-target' } }),
    })

    expect(response.status).toBe(200)
    expect(rpc).toHaveBeenCalledWith('thread/read', { threadId: 'thread-active-target' })
  })

  it('serializes queue append with the per-thread lifecycle claim', async () => {
    const threadId = 'thread-queue-archive-race'
    let release!: () => void
    const held = withThreadStartClaim(threadId, async () => (
      new Promise<void>((resolve) => { release = resolve })
    ))
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const middleware = createCodexBridgeMiddleware()
    const port = await listenWithMiddleware(middleware)
    try {
      let settled = false
      const responsePromise = fetch(`http://127.0.0.1:${port}/codex-api/thread-queue-state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threadId,
          message: {
            id: 'queued-race', text: 'must not cross archive', imageUrls: [], skills: [], fileAttachments: [],
            collaborationMode: 'default', model: '', effort: '',
          },
        }),
      }).then((response) => {
        settled = true
        return response
      })
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(settled).toBe(false)
      release()
      const response = await responsePromise
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({ revision: expect.any(Number) })
      const queue = await (await fetch(`http://127.0.0.1:${port}/codex-api/thread-queue-state`)).json() as {
        data?: Record<string, Array<{ id: string }>>
      }
      expect(queue.data?.[threadId]?.map((message) => message.id)).toEqual(['queued-race'])
    } finally {
      if (release) release()
      await held
    }
  })

  it('serializes queue replacement with archival and rechecks state after acquiring claims', async () => {
    const threadId = '019fd125-4567-7890-a123-456789abcdef'
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-queue-replace-archive-race-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const stateDbPath = join(codexHome, 'state_5.sqlite')
    expect(spawnSync('sqlite3', [stateDbPath, [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER);',
      `INSERT INTO threads VALUES ('${threadId}', 0);`,
    ].join(' ')], { encoding: 'utf8' }).status).toBe(0)
    let release!: () => void
    const held = withThreadStartClaim(threadId, async () => (
      new Promise<void>((resolve) => { release = resolve })
    ))
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const middleware = createCodexBridgeMiddleware()
    const port = await listenWithMiddleware(middleware)
    try {
      let settled = false
      const replacement = fetch(`http://127.0.0.1:${port}/codex-api/thread-queue-state`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          queueState: {
            [threadId]: [{
              id: 'queued-race-replacement', text: 'must not cross archive', imageUrls: [], skills: [], fileAttachments: [],
              collaborationMode: 'default', model: '', effort: '',
            }],
          },
          baseRevision: 0,
        }),
      }).then((response) => {
        settled = true
        return response
      })
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(settled).toBe(false)
      expect(spawnSync('sqlite3', [stateDbPath,
        `UPDATE threads SET archived = 1 WHERE id = '${threadId}';`,
      ], { encoding: 'utf8' }).status).toBe(0)
      const future = new Date(Date.now() + 2_000)
      await utimes(stateDbPath, future, future)
      release()

      expect((await replacement).status).toBe(409)
      const queue = await (await fetch(`http://127.0.0.1:${port}/codex-api/thread-queue-state`)).json() as {
        data?: Record<string, unknown>
      }
      expect(queue.data?.[threadId]).toBeUndefined()
    } finally {
      if (release) release()
      await held
    }
  })

  it('blocks only the exact state-db archived thread without affecting an active neighbor', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-rpc-archived-exact-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const stateDbPath = join(codexHome, 'state_5.sqlite')
    const sqlite = spawnSync('sqlite3', [stateDbPath, [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER);',
      "INSERT INTO threads (id, archived) VALUES ('thread-archived', 1);",
      "INSERT INTO threads (id, archived) VALUES ('thread-active', 0);",
    ].join(' ')], { encoding: 'utf8' })
    expect(sqlite.status).toBe(0)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (_method, params) => ({
      thread: { id: (params as { threadId?: string }).threadId, turns: [] },
    }))
    const port = await listenWithMiddleware(middleware)
    const read = (threadId: string) => fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'thread/read', params: { threadId } }),
    })

    const archivedResponse = await read('thread-archived')
    const activeResponse = await read('thread-active')

    expect(archivedResponse.status).toBe(409)
    expect(activeResponse.status).toBe(200)
    expect(rpc).not.toHaveBeenCalledWith('thread/read', { threadId: 'thread-archived' })
    expect(rpc).toHaveBeenCalledWith('thread/read', { threadId: 'thread-active' })
  })

  it('discards a thread/read response when the thread is archived during the RPC', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-rpc-archive-during-read-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const stateDbPath = join(codexHome, 'state_5.sqlite')
    expect(spawnSync('sqlite3', [stateDbPath, [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER);',
      "INSERT INTO threads (id, archived) VALUES ('thread-racing-archive', 0);",
    ].join(' ')], { encoding: 'utf8' }).status).toBe(0)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/read') {
        expect(spawnSync('sqlite3', [stateDbPath,
          "UPDATE threads SET archived = 1 WHERE id = 'thread-racing-archive';",
        ], { encoding: 'utf8' }).status).toBe(0)
      }
      return { thread: { id: 'thread-racing-archive', turns: [] } }
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'thread/read', params: { threadId: 'thread-racing-archive' } }),
    })

    expect(response.status).toBe(409)
    expect(rpc).toHaveBeenCalledWith('thread/read', { threadId: 'thread-racing-archive' })
  })

  it.each([
    'thread/fork',
    'thread/rollback',
    'thread/name/set',
    'thread/start-turn',
    'turn/interrupt',
  ])('returns 409 without dispatching %s while a direct CLI owns the thread', async (method) => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (calledMethod) => {
      if (calledMethod === 'thread/read') {
        return {
          thread: {
            id: 'thread-cli-owned',
            path: '/home/user/.codex/sessions/rollout-thread-cli-owned.jsonl',
            status: { type: 'idle' },
            turns: [],
          },
        }
      }
      return { ok: true }
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running',
      turnId: 'turn-cli',
      interruptible: false,
      source: 'external-session-writer',
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, params: { threadId: 'thread-cli-owned' } }),
    })

    expect(response.status).toBe(409)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('thread/read', {
      threadId: 'thread-cli-owned',
      includeTurns: true,
    })
    expect(rpc).not.toHaveBeenCalledWith(method, expect.anything())
  })

  it.each([
    'thread/archive',
    'thread/unarchive',
    'thread/goal/set',
    'thread/goal/clear',
  ])('rejects forbidden raw lifecycle RPC %s without dispatch', async (method) => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc')
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, params: { threadId: 'thread-forbidden' } }),
    })

    expect(response.status).toBe(403)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('returns 409 when a cross-process turn-start claim already exists', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-rpc-start-conflict-'))
    process.env.CODEX_HOME = codexHome
    let release!: () => void
    const held = withThreadStartClaim('thread-start-conflict-http', async () => (
      new Promise<void>((resolve) => { release = resolve })
    ))
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const middleware = createCodexBridgeMiddleware()
    const port = await listenWithMiddleware(middleware)
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    try {
      const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'turn/start',
          params: { threadId: 'thread-start-conflict-http', input: [{ type: 'text', text: 'loser' }] },
        }),
      })
      expect(response.status).toBe(409)
    } finally {
      release()
      await held
    }
  })

  it('augments an empty thread/read fallback with current external ownership', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
        storeThreadReadSnapshot: (threadId: string, snapshot: unknown) => void
      }
    }
    shared.appServer.storeThreadReadSnapshot('thread-empty-fallback', {
      thread: {
        id: 'thread-empty-fallback',
        path: '/tmp/thread-empty-fallback.jsonl',
        status: { type: 'idle' },
        turns: [{ id: 'turn-cli', status: 'interrupted', items: [] }],
      },
    })
    vi.spyOn(shared.appServer, 'rpc').mockRejectedValue(new Error(
      'failed to read thread: failed to read rollout /tmp/thread-empty-fallback.jsonl: rollout at /tmp/thread-empty-fallback.jsonl is empty',
    ))
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running', turnId: 'turn-cli', interruptible: false, source: 'external-session-writer',
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'thread/read', params: { threadId: 'thread-empty-fallback' } }),
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      result: {
        thread: {
          id: 'thread-empty-fallback',
          status: { type: 'idle' },
          externalRuntime: {
            state: 'running', turnId: 'turn-cli', interruptible: false, source: 'external-session-writer',
          },
        },
      },
    })
  })
  it.each([
    ['running', {
      state: 'running' as const,
      turnId: 'turn-desktop',
      interruptible: false as const,
      source: 'external-session-writer' as const,
    }],
    ['unknown', { state: 'unknown' as const }],
  ])('blocks turn/start when the immediate writer probe is %s', async (_label, runtime) => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue(runtime)
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/read') {
        return {
          thread: {
            id: 'thread-existing',
            path: '/home/user/.codex/sessions/rollout-thread-existing.jsonl',
            status: { type: 'idle' },
            turns: [],
          },
        }
      }
      if (method === 'turn/start') return { turn: { id: 'turn-raced' } }
      return {}
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'turn/start',
        params: { threadId: 'thread-existing', input: [{ type: 'text', text: 'race' }] },
      }),
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining('writer ownership is not idle'),
      turnStartDelivery: 'not_started',
    })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('thread/read', {
      threadId: 'thread-existing',
      includeTurns: true,
    })
    expect(inspect).toHaveBeenCalledWith('thread-existing', 4242)
    expect(rpc).not.toHaveBeenCalledWith('turn/start', expect.anything())
  })

  it('blocks explicit external steer turn/start when another writer owns the task', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running',
      turnId: 'turn-desktop',
      interruptible: true,
      source: 'external-session-writer',
    })
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/read') {
        return {
          thread: {
            id: 'thread-existing',
            path: '/home/user/.codex/sessions/rollout-thread-existing.jsonl',
            status: { type: 'idle' },
            turns: [],
          },
        }
      }
      if (method === 'turn/start') return { turn: { id: 'turn-steered' } }
      return {}
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'turn/start',
        params: {
          threadId: 'thread-existing',
          input: [{ type: 'text', text: 'steer' }],
          __codexMobileExternalSteer: true,
        },
      }),
    })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('writer ownership is not idle'),
    })
    expect(inspect).toHaveBeenCalledWith('thread-existing', 4242)
    expect(rpc).not.toHaveBeenCalledWith('turn/start', expect.anything())
  })

  it('blocks an old external-steer marker regardless of payload shape', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running',
      turnId: 'turn-desktop',
      interruptible: true,
      source: 'external-session-writer',
    })
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/read') {
        return {
          thread: {
            id: 'thread-existing',
            path: '/home/user/.codex/sessions/rollout-thread-existing.jsonl',
            status: { type: 'idle' },
            turns: [],
          },
        }
      }
      return {}
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'turn/start',
        params: {
          threadId: 'thread-existing',
          input: [{ type: 'text', text: 'steer' }],
          attachments: [{ label: 'file', path: '/tmp/file', fsPath: '/tmp/file' }],
          __codexMobileExternalSteer: true,
        },
      }),
    })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('writer ownership is not idle'),
    })
    expect(inspect).toHaveBeenCalledWith('thread-existing', null)
    expect(rpc).not.toHaveBeenCalledWith('turn/start', expect.anything())
  })

  it('allows the first turn only after a materialized rollout has an explicit idle probe', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({ state: 'idle' })
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/start') {
        return { thread: { id: 'thread-new', path: '/home/user/.codex/sessions/rollout-thread-new.jsonl' } }
      }
      if (method === 'thread/read') {
        return {
          thread: {
            id: 'thread-new',
            path: '/home/user/.codex/sessions/rollout-thread-new.jsonl',
            status: { type: 'idle' },
            turns: [],
          },
        }
      }
      if (method === 'turn/start') return { turn: { id: 'turn-first' } }
      return {}
    })
    const port = await listenWithMiddleware(middleware)

    const startResponse = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'thread/start', params: { cwd: '/tmp/project' } }),
    })
    expect(startResponse.status).toBe(200)

    const turnResponse = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'turn/start',
        params: { threadId: 'thread-new', input: [{ type: 'text', text: 'first' }] },
      }),
    })

    expect(turnResponse.status).toBe(200)
    await expect(turnResponse.json()).resolves.toMatchObject({
      result: { turn: { id: 'turn-first' } },
    })
    expect(inspect).toHaveBeenCalledWith('thread-new', 4242)
    expect(rpc.mock.calls.map(([method]) => method)).toEqual([
      'thread/start',
      'thread/read',
      'turn/start',
      'thread/read',
    ])
    expect(rpc).toHaveBeenCalledWith('turn/start', expect.objectContaining({ threadId: 'thread-new' }))
  })

  it('preserves first-turn resume recovery when a newly created thread is not materialized yet', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect')
    let turnStartCalls = 0
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/start') return { thread: { id: 'thread-new-recovery' } }
      if (method === 'thread/read') throw new Error('thread not found: thread-new-recovery')
      if (method === 'turn/start') {
        turnStartCalls += 1
        if (turnStartCalls === 1) throw new Error('thread not found: thread-new-recovery')
        return { turn: { id: 'turn-first-recovered' } }
      }
      if (method === 'thread/resume') return { thread: { id: 'thread-new-recovery', turns: [] } }
      throw new Error(`unexpected method ${method}`)
    })
    const port = await listenWithMiddleware(middleware)

    await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'thread/start', params: { cwd: '/tmp/project' } }),
    })
    const turnResponse = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'turn/start',
        params: { threadId: 'thread-new-recovery', input: [{ type: 'text', text: 'first' }] },
      }),
    })

    expect(turnResponse.status).toBe(200)
    await expect(turnResponse.json()).resolves.toMatchObject({
      result: { turn: { id: 'turn-first-recovered' } },
    })
    expect(rpc.mock.calls.map(([method]) => method)).toEqual([
      'thread/start',
      'thread/read',
      'turn/start',
      'thread/read',
      'thread/resume',
      'turn/start',
      'thread/read',
    ])
    expect(inspect).not.toHaveBeenCalled()
  })

  it('allows a locally created first turn when thread/read reports exact pending materialization', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect')
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/start') return { thread: { id: 'thread-pending-materialization' } }
      if (method === 'thread/read') {
        throw new Error(
          'thread thread-pending-materialization is not materialized yet; includeTurns is unavailable before first user message',
        )
      }
      if (method === 'turn/start') return { turn: { id: 'turn-first-materialized' } }
      throw new Error(`unexpected method ${method}`)
    })
    const port = await listenWithMiddleware(middleware)

    const startResponse = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'thread/start', params: { cwd: '/tmp/project' } }),
    })
    expect(startResponse.status).toBe(200)

    const turnResponse = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'turn/start',
        params: {
          threadId: 'thread-pending-materialization',
          input: [{ type: 'text', text: 'first' }],
        },
      }),
    })

    expect(turnResponse.status).toBe(200)
    await expect(turnResponse.json()).resolves.toMatchObject({
      result: { turn: { id: 'turn-first-materialized' } },
    })
    expect(rpc.mock.calls.map(([method]) => method)).toEqual([
      'thread/start',
      'thread/read',
      'turn/start',
      'thread/read',
    ])
    expect(inspect).not.toHaveBeenCalled()
  })

  it('fails closed on pending materialization without a local first-turn capability', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect')
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/read') {
        throw new Error(
          'thread thread-existing-pending is not materialized yet; includeTurns is unavailable before first user message',
        )
      }
      if (method === 'turn/start') return { turn: { id: 'turn-competing' } }
      throw new Error(`unexpected method ${method}`)
    })
    const port = await listenWithMiddleware(middleware)

    const turnResponse = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'turn/start',
        params: {
          threadId: 'thread-existing-pending',
          input: [{ type: 'text', text: 'ordinary' }],
        },
      }),
    })

    expect(turnResponse.status).toBe(409)
    expect(await turnResponse.json()).toMatchObject({
      error: expect.stringContaining('writer ownership is not idle'),
    })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('thread/read', {
      threadId: 'thread-existing-pending',
      includeTurns: true,
    })
    expect(rpc).not.toHaveBeenCalledWith('turn/start', expect.anything())
    expect(inspect).not.toHaveBeenCalled()
  })

  it.each([
    ['running', {
      state: 'running' as const,
      turnId: 'turn-desktop-first-takeover',
      interruptible: false as const,
      source: 'external-session-writer' as const,
    }],
    ['unknown', { state: 'unknown' as const }],
  ])('blocks a materialized %s writer takeover before the locally created first turn', async (_label, runtime) => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue(runtime)
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/start') return { thread: { id: 'thread-first-takeover' } }
      if (method === 'thread/read') {
        return {
          thread: {
            id: 'thread-first-takeover',
            path: '/home/user/.codex/sessions/rollout-thread-first-takeover.jsonl',
            status: { type: 'active' },
            turns: [{ id: 'turn-desktop-first-takeover', status: 'inProgress' }],
          },
        }
      }
      if (method === 'turn/start') return { turn: { id: 'turn-competing' } }
      return {}
    })
    const port = await listenWithMiddleware(middleware)

    const startResponse = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'thread/start', params: { cwd: '/tmp/project' } }),
    })
    expect(startResponse.status).toBe(200)

    const turnResponse = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'turn/start',
        params: { threadId: 'thread-first-takeover', input: [{ type: 'text', text: 'first' }] },
      }),
    })

    expect(turnResponse.status).toBe(409)
    expect(await turnResponse.json()).toMatchObject({
      error: expect.stringContaining('writer ownership is not idle'),
    })
    expect(inspect).toHaveBeenCalledWith('thread-first-takeover', 4242)
    expect(rpc).not.toHaveBeenCalledWith('turn/start', expect.anything())
  })

  it('rechecks ownership and blocks a writer takeover after an earlier idle UI read', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect')
      .mockResolvedValueOnce({ state: 'idle' })
      .mockResolvedValueOnce({
        state: 'running',
        turnId: 'turn-desktop-takeover',
        interruptible: false,
        source: 'external-session-writer',
      })
    vi.spyOn(shared.runtimeProbe, 'inspectWriterEvidence').mockResolvedValue(false)
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/read') {
        return {
          thread: {
            id: 'thread-takeover',
            path: '/home/user/.codex/sessions/rollout-thread-takeover.jsonl',
            status: { type: 'idle' },
            turns: [],
          },
        }
      }
      if (method === 'turn/start') return { turn: { id: 'turn-raced' } }
      return {}
    })
    const port = await listenWithMiddleware(middleware)

    const readResponse = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/read',
        params: { threadId: 'thread-takeover', includeTurns: true },
      }),
    })
    expect(readResponse.status).toBe(200)
    await expect(readResponse.json()).resolves.toMatchObject({
      result: { thread: { externalRuntime: { state: 'idle' } } },
    })

    const turnResponse = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'turn/start',
        params: { threadId: 'thread-takeover', input: [{ type: 'text', text: 'race' }] },
      }),
    })

    expect(turnResponse.status).toBe(409)
    expect(inspect).toHaveBeenCalledTimes(2)
    expect(rpc).not.toHaveBeenCalledWith('turn/start', expect.anything())
  })

  it('interrupts its exact turn when a direct writer appears after the final pre-start probe', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect')
      .mockResolvedValueOnce({ state: 'idle' })
      .mockResolvedValueOnce({
        state: 'running',
        turnId: 'turn-cli-late',
        interruptible: false,
        source: 'external-session-writer',
      })
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/read') return {
        thread: { id: 'thread-late-race', path: '/home/user/.codex/sessions/late.jsonl', turns: [] },
      }
      if (method === 'turn/start') return { turn: { id: 'turn-mobile-losing' } }
      if (method === 'turn/interrupt') return {}
      return {}
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'turn/start',
        params: { threadId: 'thread-late-race', input: [{ type: 'text', text: 'race' }] },
      }),
    })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ turnStartDelivery: 'started' })
    expect(rpc).toHaveBeenCalledWith('turn/interrupt', {
      threadId: 'thread-late-race',
      turnId: 'turn-mobile-losing',
    })
    expect(inspect).toHaveBeenCalledTimes(2)
  })

  it('does not interrupt the mobile turn when the post-start probe observes that exact turn', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect')
      .mockResolvedValueOnce({ state: 'idle' })
      .mockResolvedValueOnce({
        state: 'running',
        turnId: 'turn-mobile-owned',
        interruptible: false,
        source: 'external-session-writer',
      })
    vi.spyOn(shared.runtimeProbe, 'inspectWriterEvidence').mockResolvedValue(false)
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/read') return {
        thread: { id: 'thread-mobile-owned', path: '/home/user/.codex/sessions/mobile.jsonl', turns: [] },
      }
      if (method === 'turn/start') return { turn: { id: 'turn-mobile-owned' } }
      return {}
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'turn/start',
        params: { threadId: 'thread-mobile-owned', input: [{ type: 'text', text: 'continue' }] },
      }),
    })

    expect(response.status).toBe(200)
    expect(rpc).not.toHaveBeenCalledWith('turn/interrupt', expect.anything())
    expect(inspect).toHaveBeenCalledTimes(2)
  })

  it('interrupts a matching mobile turn when a foreign writable descriptor appears after start', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.runtimeProbe, 'inspect')
      .mockResolvedValueOnce({ state: 'idle' })
      .mockResolvedValueOnce({
        state: 'running', turnId: 'turn-mobile-contended', interruptible: false, source: 'external-session-writer',
      })
    vi.mocked(shared.runtimeProbe.inspectWriterEvidence).mockResolvedValue(true)
    vi.mocked(shared.runtimeProbe.inspectWriterEvidenceSnapshot)
      .mockResolvedValueOnce({ writers: [] })
      .mockResolvedValueOnce({ writers: ['foreign-writer-after-start'] })
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/read') return {
        thread: { id: 'thread-mobile-contended', path: '/tmp/mobile-contended.jsonl', turns: [] },
      }
      if (method === 'turn/start') return { turn: { id: 'turn-mobile-contended' } }
      return {}
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'turn/start',
        params: { threadId: 'thread-mobile-contended', input: [{ type: 'text', text: 'race' }] },
      }),
    })

    expect(response.status).toBe(409)
    expect(rpc).toHaveBeenCalledWith('turn/interrupt', {
      threadId: 'thread-mobile-contended', turnId: 'turn-mobile-contended',
    })
  })

  it('interrupts a mobile turn when a foreign turn starts and closes between writer scans', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.runtimeProbe, 'inspect')
      .mockResolvedValueOnce({ state: 'idle' })
      .mockResolvedValueOnce({ state: 'idle' })
    vi.mocked(shared.runtimeProbe.inspectWriterEvidenceSnapshot).mockResolvedValue({
      writers: [],
      rollout: { path: '/tmp/transient-writer.jsonl', dev: '8', ino: '9', size: 100 },
    })
    vi.spyOn(shared.runtimeProbe, 'inspectUnexpectedLifecycleSince').mockResolvedValue(true)
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/read') return {
        thread: { id: 'thread-transient-writer', path: '/tmp/transient-writer.jsonl', turns: [] },
      }
      if (method === 'turn/start') return { turn: { id: 'turn-mobile-transient' } }
      return {}
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'turn/start',
        params: { threadId: 'thread-transient-writer', input: [{ type: 'text', text: 'race' }] },
      }),
    })

    expect(response.status).toBe(409)
    expect(rpc).toHaveBeenCalledWith('turn/interrupt', {
      threadId: 'thread-transient-writer', turnId: 'turn-mobile-transient',
    })
  })

  it('does not repeat writer evidence scanning after runtime already confirms a writer', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running',
      turnId: 'turn-cli-confirmed',
      interruptible: false,
      source: 'external-session-writer',
    })
    const inspectWriterEvidence = vi.spyOn(shared.runtimeProbe, 'inspectWriterEvidence')
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (method) => method === 'thread/read'
      ? { thread: { id: 'thread-cli-confirmed', path: '/home/user/.codex/sessions/confirmed.jsonl', turns: [] } }
      : {})
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'turn/start',
        params: { threadId: 'thread-cli-confirmed', input: [{ type: 'text', text: 'must queue' }] },
      }),
    })

    expect(response.status).toBe(409)
    expect(inspectWriterEvidence).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalledWith('turn/start', expect.anything())
  })

  it('allows a new turn after the CLI turn is terminal even if its writable descriptor remains open', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    let started = false
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({ state: 'idle' })
    vi.spyOn(shared.runtimeProbe, 'inspectWriterEvidence').mockResolvedValue(true)
    Object.assign(shared.runtimeProbe, {
      inspectWriterEvidenceSnapshot: vi.fn(async () => ({ writers: ['stale-cli:1:rollout:42'] })),
    })
    const rpc = vi.spyOn(shared.appServer as unknown as {
      rpc(method: string, params: unknown): Promise<unknown>
    }, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/read') {
        return {
          thread: {
            id: 'thread-idle-cli',
            path: '/home/user/.codex/sessions/idle-cli.jsonl',
            turns: started
              ? [{ id: 'turn-mobile-next', status: 'inProgress', items: [] }]
              : [{ id: 'turn-cli-complete', status: 'completed', items: [] }],
          },
        }
      }
      if (method === 'turn/start') {
        started = true
        return { turn: { id: 'turn-mobile-next' } }
      }
      return {}
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'turn/start',
        params: { threadId: 'thread-idle-cli', input: [{ type: 'text', text: 'must queue' }] },
      }),
    })

    expect(response.status).toBe(200)
    expect(rpc).toHaveBeenCalledWith('turn/start', expect.objectContaining({ threadId: 'thread-idle-cli' }))
    expect(rpc).not.toHaveBeenCalledWith('turn/interrupt', expect.anything())
  })
})

describe('dynamic tool server requests', () => {
  it('fails an unsupported request owned by the current app-server without listing it as pending', () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    const appServer = shared.appServer as unknown as {
      handleServerRequest(requestId: number, method: string, params: unknown): void
      listPendingServerRequests(): unknown[]
      sendServerRequestReply(requestId: number, reply: unknown): void
    }
    const reply = vi.spyOn(appServer, 'sendServerRequestReply').mockImplementation(() => undefined)
    disposers.push(() => middleware.dispose())

    appServer.handleServerRequest(77, 'item/tool/call', {
      threadId: 'thread-local',
      toolName: 'codex_app/list_threads',
      arguments: [],
    })

    expect(appServer.listPendingServerRequests()).toEqual([])
    expect(reply).toHaveBeenCalledWith(77, {
      error: {
        code: -32601,
        message: 'Dynamic tool calls are not supported by codex-mobile.',
      },
    })
  })
})

describe('GET /codex-api/thread-runtime-state', () => {

  it('returns a successful runtime payload and excludes the mobile child PID', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running',
      turnId: 'turn-external',
      interruptible: false,
      source: 'external-session-writer',
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-runtime-state?threadId=thread-1`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      state: 'running',
      turnId: 'turn-external',
      interruptible: false,
      source: 'external-session-writer',
    })
    expect(inspect).toHaveBeenCalledWith('thread-1', 4242)
  })

  it('prefers local app-server runtime evidence for single-thread polling', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({ state: 'idle' })
    shared.localRuntimeLedger.record({
      method: 'turn/started',
      params: { threadId: 'thread-local-single', turn: { id: 'turn-local-single' } },
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-runtime-state?threadId=thread-local-single`,
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      state: 'running',
      turnId: 'turn-local-single',
      interruptible: true,
      source: 'local-app-server',
    })
  })

  it('applies route security policy before invoking the runtime handler', async () => {
    const isRouteDisabled = vi.fn(() => true)
    const middleware = createCodexBridgeMiddleware({
      securityPolicy: { ...PERMISSIVE_SECURITY_POLICY, isRouteDisabled, backgroundIntegrationsEnabled: false },
    })
    const shared = sharedBridgeForTest()
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect')
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-runtime-state?threadId=thread-1`)

    expect(response.status).toBe(403)
    expect(isRouteDisabled).toHaveBeenCalledWith('GET', '/codex-api/thread-runtime-state')
    expect(inspect).not.toHaveBeenCalled()
  })

  it('rejects a missing threadId inside the bridge middleware', async () => {
    const middleware = createCodexBridgeMiddleware()
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-runtime-state`)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Missing threadId' })
  })
})

describe('GET /codex-api/thread-live-state external runtime parity', () => {
  it('refreshes a recent non-interruptible batch runtime observation for the first live-state projection', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-runtime-cache-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-runtime-cache.jsonl')
    await writeFile(rolloutPath, '{"type":"session_meta"}\n')

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.appServer, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/turns/list') {
        return {
          data: [{ id: 'turn-complete', status: 'completed', items: [] }],
          nextCursor: null,
          backwardsCursor: null,
        }
      }
      return {
        thread: {
          id: 'thread-runtime-cache',
          path: rolloutPath,
          turns: [],
        },
      }
    })
    const inspectMany = vi.spyOn(shared.runtimeProbe, 'inspectMany').mockResolvedValue({
      'thread-runtime-cache': {
        state: 'running',
        turnId: 'turn-external',
        interruptible: false,
        source: 'external-session-writer',
      },
    })
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running',
      turnId: 'turn-external',
      interruptible: false,
      source: 'external-session-writer',
    })
    const port = await listenWithMiddleware(middleware)

    const runtimeResponse = await fetch(`http://127.0.0.1:${port}/codex-api/thread-runtime-states`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadIds: ['thread-runtime-cache'] }),
    })
    expect(runtimeResponse.status).toBe(200)

    const liveResponse = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-runtime-cache`)

    expect(liveResponse.status).toBe(200)
    await expect(liveResponse.json()).resolves.toMatchObject({
      isInProgress: true,
      externalRuntime: {
        state: 'running',
        turnId: 'turn-external',
        interruptible: false,
        source: 'external-session-writer',
      },
    })
    expect(inspectMany).toHaveBeenCalledTimes(1)
    expect(inspect).toHaveBeenCalledWith('thread-runtime-cache', 4242)
  })

  it('upgrades a recent non-interruptible batch runtime observation when live-state confirms an interruptible writer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-runtime-cache-upgrade-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-runtime-cache-upgrade.jsonl')
    await writeFile(rolloutPath, '{"type":"session_meta"}\n')

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.appServer, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/turns/list') {
        return {
          data: [{ id: 'turn-complete', status: 'completed', items: [] }],
          nextCursor: null,
          backwardsCursor: null,
        }
      }
      return {
        thread: {
          id: 'thread-runtime-cache-upgrade',
          path: rolloutPath,
          turns: [],
        },
      }
    })
    const inspectMany = vi.spyOn(shared.runtimeProbe, 'inspectMany').mockResolvedValue({
      'thread-runtime-cache-upgrade': {
        state: 'running',
        turnId: 'turn-external',
        interruptible: false,
        source: 'external-session-writer',
      },
    })
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running',
      turnId: 'turn-external',
      interruptible: true,
      source: 'external-session-writer',
      cwd: '/tmp/codex-mobile-runtime-worktree',
    })
    const port = await listenWithMiddleware(middleware)

    const runtimeResponse = await fetch(`http://127.0.0.1:${port}/codex-api/thread-runtime-states`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadIds: ['thread-runtime-cache-upgrade'] }),
    })
    expect(runtimeResponse.status).toBe(200)

    const liveResponse = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-runtime-cache-upgrade`)

    expect(liveResponse.status).toBe(200)
    await expect(liveResponse.json()).resolves.toMatchObject({
      isInProgress: true,
      externalRuntime: {
        state: 'running',
        turnId: 'turn-external',
        interruptible: true,
        source: 'external-session-writer',
        cwd: '/tmp/codex-mobile-runtime-worktree',
      },
    })
    expect(inspectMany).toHaveBeenCalledTimes(1)
    expect(inspect).toHaveBeenCalledWith('thread-runtime-cache-upgrade', 4242)
  })

  it('uses a fresh running writer snapshot as a fallback when runtime inspection is idle', async () => {
    const liveStateDir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-snapshot-first-'))
    const previousLiveStateDir = process.env.CODEX_MOBILE_LIVE_STATE_DIR
    process.env.CODEX_MOBILE_LIVE_STATE_DIR = liveStateDir
    const rolloutPath = join(liveStateDir, 'thread-snapshot-first.jsonl')
    try {
      await writeFile(rolloutPath, '{"type":"session_meta"}\n')
      await writeFile(join(liveStateDir, 'thread-snapshot-first.json'), JSON.stringify({
        schemaVersion: 1,
        threadId: 'thread-snapshot-first',
        activeTurnId: 'turn-external',
        revision: 2,
        generatedAt: new Date(Date.now() - 500).toISOString(),
        expiresAt: new Date(Date.now() + 30000).toISOString(),
        source: 'desktop-writer',
        state: 'running',
        footer: null,
        timeline: [],
        pendingRequest: null,
        sidebar: { indicator: 'running' },
      }), 'utf8')

      const middleware = createCodexBridgeMiddleware()
      const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
        appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
          rpc: (method: string, params: unknown) => Promise<unknown>
        }
      }
      vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
      vi.spyOn(shared.appServer, 'rpc').mockImplementation(async (method) => {
        if (method === 'thread/turns/list') {
          return {
            data: [{ id: 'turn-complete', status: 'completed', items: [] }],
            nextCursor: null,
            backwardsCursor: null,
          }
        }
        return {
          thread: {
            id: 'thread-snapshot-first',
            path: rolloutPath,
            turns: [],
          },
        }
      })
      const inspect = vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({ state: 'idle' })
      const port = await listenWithMiddleware(middleware)

      const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-snapshot-first`)

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        isInProgress: true,
        externalRuntime: {
          state: 'running',
          turnId: 'turn-external',
          interruptible: false,
          source: 'external-session-writer',
        },
        liveAuthority: 'writer-snapshot',
        liveSnapshot: { activeTurnId: 'turn-external', footer: null },
      })
      expect(inspect).toHaveBeenCalledWith('thread-snapshot-first', 4242)
    } finally {
      if (previousLiveStateDir === undefined) {
        delete process.env.CODEX_MOBILE_LIVE_STATE_DIR
      } else {
        process.env.CODEX_MOBILE_LIVE_STATE_DIR = previousLiveStateDir
      }
      await rm(liveStateDir, { recursive: true, force: true })
    }
  })

  it('keeps external live-state interruptible when fd runtime inspection confirms a writer', async () => {
    const liveStateDir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-snapshot-interruptible-'))
    const previousLiveStateDir = process.env.CODEX_MOBILE_LIVE_STATE_DIR
    process.env.CODEX_MOBILE_LIVE_STATE_DIR = liveStateDir
    const rolloutPath = join(liveStateDir, 'thread-snapshot-interruptible.jsonl')
    try {
      await writeFile(rolloutPath, '{"type":"session_meta"}\n')
      await writeFile(join(liveStateDir, 'thread-snapshot-interruptible.json'), JSON.stringify({
        schemaVersion: 1,
        threadId: 'thread-snapshot-interruptible',
        activeTurnId: 'turn-external',
        revision: 2,
        generatedAt: new Date(Date.now() - 500).toISOString(),
        expiresAt: new Date(Date.now() + 30000).toISOString(),
        source: 'desktop-writer',
        state: 'running',
        footer: null,
        timeline: [],
        pendingRequest: null,
        sidebar: { indicator: 'running' },
      }), 'utf8')

      const middleware = createCodexBridgeMiddleware()
      const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
        appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
          rpc: (method: string, params: unknown) => Promise<unknown>
        }
      }
      vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
      vi.spyOn(shared.appServer, 'rpc').mockImplementation(async (method) => {
        if (method === 'thread/turns/list') {
          return {
            data: [{ id: 'turn-complete', status: 'completed', items: [] }],
            nextCursor: null,
            backwardsCursor: null,
          }
        }
        return {
          thread: {
            id: 'thread-snapshot-interruptible',
            path: rolloutPath,
            turns: [],
          },
        }
      })
      const inspect = vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
        state: 'running',
        turnId: 'turn-external',
        interruptible: true,
        source: 'external-session-writer',
      })
      const port = await listenWithMiddleware(middleware)

      const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-snapshot-interruptible`)

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        isInProgress: true,
        externalRuntime: {
          state: 'running',
          turnId: 'turn-external',
          interruptible: true,
          source: 'external-session-writer',
        },
        liveAuthority: 'writer-snapshot',
        liveSnapshot: { activeTurnId: 'turn-external', footer: null },
      })
      expect(inspect).toHaveBeenCalledWith('thread-snapshot-interruptible', 4242)
    } finally {
      if (previousLiveStateDir === undefined) {
        delete process.env.CODEX_MOBILE_LIVE_STATE_DIR
      } else {
        process.env.CODEX_MOBILE_LIVE_STATE_DIR = previousLiveStateDir
      }
      await rm(liveStateDir, { recursive: true, force: true })
    }
  })

  it('returns a fresh writer snapshot as authoritative for an externally running task without footer stats', async () => {
    const liveStateDir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-'))
    const previousLiveStateDir = process.env.CODEX_MOBILE_LIVE_STATE_DIR
    process.env.CODEX_MOBILE_LIVE_STATE_DIR = liveStateDir
    try {
      await writeFile(join(liveStateDir, 'thread-external.json'), JSON.stringify({
        schemaVersion: 1,
        threadId: 'thread-external',
        activeTurnId: 'turn-external',
        revision: 3,
        generatedAt: new Date(Date.now() - 1000).toISOString(),
        expiresAt: new Date(Date.now() + 30000).toISOString(),
        source: 'desktop-writer',
        state: 'running',
        footer: {
          stepCurrent: 2,
          stepTotal: 6,
          completedPercent: 33.3333,
          fileCount: 29,
          additions: 5485,
          deletions: 417,
          label: 'Step 2 / 6 · 29 files changed +5485 -417',
        },
        timeline: [],
        pendingRequest: null,
        sidebar: { indicator: 'running' },
      }), 'utf8')
      const middleware = createCodexBridgeMiddleware()
      const shared = sharedBridgeForTest()
      vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
      vi.spyOn(shared.appServer as unknown as {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }, 'rpc').mockResolvedValue({
        thread: {
          id: 'thread-external',
          path: join(liveStateDir, 'thread-external.jsonl'),
          turns: [{
            id: 'turn-external',
            status: 'interrupted',
            items: [{
              id: 'old-plan',
              type: 'plan',
              text: '- [x] old\n- [~] stale\n- [ ] stale\n- [ ] stale\n- [ ] stale',
            }],
          }],
        },
      })
      vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
        state: 'running',
        turnId: 'turn-external',
        interruptible: false,
        source: 'external-session-writer',
      })
      const port = await listenWithMiddleware(middleware)

      const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-external`)

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        isInProgress: true,
        liveAuthority: 'writer-snapshot',
        liveSnapshot: {
          activeTurnId: 'turn-external',
          footer: null,
        },
      })
    } finally {
      if (previousLiveStateDir === undefined) {
        delete process.env.CODEX_MOBILE_LIVE_STATE_DIR
      } else {
        process.env.CODEX_MOBILE_LIVE_STATE_DIR = previousLiveStateDir
      }
      await rm(liveStateDir, { recursive: true, force: true })
    }
  })

  it('does not change the running projection for writer footer-only stat updates', async () => {
    const liveStateDir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-footer-slim-'))
    const previousLiveStateDir = process.env.CODEX_MOBILE_LIVE_STATE_DIR
    process.env.CODEX_MOBILE_LIVE_STATE_DIR = liveStateDir
    const snapshotPath = join(liveStateDir, 'thread-footer-slim.json')
    const rolloutPath = join(liveStateDir, 'thread-footer-slim.jsonl')
    try {
      await writeFile(rolloutPath, '{"type":"session_meta"}\n')
      await writeFile(snapshotPath, JSON.stringify({
        schemaVersion: 1,
        threadId: 'thread-footer-slim',
        activeTurnId: 'turn-external',
        revision: 1,
        generatedAt: new Date(Date.now() - 1000).toISOString(),
        expiresAt: new Date(Date.now() + 30000).toISOString(),
        source: 'desktop-writer',
        state: 'running',
        footer: {
          stepCurrent: 1,
          stepTotal: 5,
          completedPercent: 20,
          fileCount: 5,
          additions: 10,
          deletions: 2,
          label: 'Step 1 / 5 · 5 files changed +10 -2',
        },
        timeline: [],
        pendingRequest: null,
        sidebar: { indicator: 'running' },
      }), 'utf8')
      const middleware = createCodexBridgeMiddleware()
      const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
        appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
          rpc: (method: string, params: unknown) => Promise<unknown>
        }
      }
      vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
      vi.spyOn(shared.appServer, 'rpc').mockImplementation(async (method) => {
        if (method === 'thread/turns/list') {
          return {
            data: [{ id: 'turn-complete', status: 'completed', items: [] }],
            nextCursor: null,
            backwardsCursor: null,
          }
        }
        return {
          thread: {
            id: 'thread-footer-slim',
            path: rolloutPath,
            turns: [],
          },
        }
      })
      vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
        state: 'running',
        turnId: 'turn-external',
        interruptible: false,
        source: 'external-session-writer',
      })
      const port = await listenWithMiddleware(middleware)

      const first = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-footer-slim`)
      const firstPayload = await first.json() as { projectionKey?: string; liveSnapshot?: { footer?: unknown } }
      expect(firstPayload.projectionKey).toEqual(expect.any(String))
      expect(firstPayload.liveSnapshot?.footer).toBeNull()

      await writeFile(snapshotPath, JSON.stringify({
        schemaVersion: 1,
        threadId: 'thread-footer-slim',
        activeTurnId: 'turn-external',
        revision: 2,
        generatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30000).toISOString(),
        source: 'desktop-writer',
        state: 'running',
        footer: {
          stepCurrent: 3,
          stepTotal: 5,
          completedPercent: 60,
          fileCount: 24,
          additions: 2597,
          deletions: 24,
          label: 'Step 3 / 5 · 24 files changed +2597 -24',
        },
        timeline: [],
        pendingRequest: null,
        sidebar: { indicator: 'running' },
      }), 'utf8')

      const second = await fetch(
        `http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-footer-slim&knownProjectionKey=${encodeURIComponent(firstPayload.projectionKey ?? '')}`,
      )
      await expect(second.json()).resolves.toMatchObject({
        notModified: true,
        projectionKey: firstPayload.projectionKey,
        liveSnapshot: { footer: null },
      })
    } finally {
      if (previousLiveStateDir === undefined) {
        delete process.env.CODEX_MOBILE_LIVE_STATE_DIR
      } else {
        process.env.CODEX_MOBILE_LIVE_STATE_DIR = previousLiveStateDir
      }
      await rm(liveStateDir, { recursive: true, force: true })
    }
  })

  it('marks external running live state as missing instead of authorizing stale thread/read footer data', async () => {
    const liveStateDir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-missing-'))
    const previousLiveStateDir = process.env.CODEX_MOBILE_LIVE_STATE_DIR
    process.env.CODEX_MOBILE_LIVE_STATE_DIR = liveStateDir
    try {
      const middleware = createCodexBridgeMiddleware()
      const shared = sharedBridgeForTest()
      vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
      vi.spyOn(shared.appServer as unknown as {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }, 'rpc').mockResolvedValue({
        thread: {
          id: 'thread-external',
          turns: [{
            id: 'turn-external',
            status: 'interrupted',
            items: [{
              id: 'stale-plan',
              type: 'plan',
              text: '- [x] old\n- [~] stale\n- [ ] stale\n- [ ] stale\n- [ ] stale',
            }],
          }],
        },
      })
      vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
        state: 'running',
        turnId: 'turn-external',
        interruptible: false,
        source: 'external-session-writer',
      })
      const port = await listenWithMiddleware(middleware)

      const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-external`)

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        isInProgress: true,
        liveAuthority: 'missing',
        liveSnapshot: null,
      })
    } finally {
      if (previousLiveStateDir === undefined) {
        delete process.env.CODEX_MOBILE_LIVE_STATE_DIR
      } else {
        process.env.CODEX_MOBILE_LIVE_STATE_DIR = previousLiveStateDir
      }
      await rm(liveStateDir, { recursive: true, force: true })
    }
  })

  it('preserves external running state from the last snapshot without retrying live thread/read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-read-failure-'))
    const previousLiveStateDir = process.env.CODEX_MOBILE_LIVE_STATE_DIR
    process.env.CODEX_MOBILE_LIVE_STATE_DIR = dir
    try {
      const rolloutPath = join(dir, 'thread-read-failure.jsonl')
      await writeFile(rolloutPath, '{"type":"session_meta"}\n')

      const middleware = createCodexBridgeMiddleware()
      const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
        appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
          rpc: (method: string, params: unknown) => Promise<unknown>
          storeThreadReadSnapshot: (threadId: string, snapshot: unknown) => void
        }
      }
      shared.appServer.storeThreadReadSnapshot('thread-read-failure', {
        threadTurnStartIndex: 4,
        thread: {
          id: 'thread-read-failure',
          path: rolloutPath,
          turns: [{
            id: 'turn-external',
            status: 'interrupted',
            items: [{ id: 'old-message', type: 'agentMessage', text: 'stale but useful' }],
          }],
        },
      })
      vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
      const rpc = vi.spyOn(shared.appServer, 'rpc').mockRejectedValue(new Error('thread/read failed in test'))
      vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
        state: 'running',
        turnId: 'turn-external',
        interruptible: false,
        source: 'external-session-writer',
      })
      const port = await listenWithMiddleware(middleware)

      const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-read-failure`)

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        threadId: 'thread-read-failure',
        isInProgress: true,
        externalRuntime: {
          state: 'running',
          turnId: 'turn-external',
          interruptible: false,
          source: 'external-session-writer',
        },
        liveAuthority: 'missing',
        liveSnapshot: null,
        liveStateError: null,
      })
      expect(rpc).not.toHaveBeenCalled()
    } finally {
      if (previousLiveStateDir === undefined) {
        delete process.env.CODEX_MOBILE_LIVE_STATE_DIR
      } else {
        process.env.CODEX_MOBILE_LIVE_STATE_DIR = previousLiveStateDir
      }
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('marks a stale idle thread read as in progress when an external writer is active', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.appServer, 'rpc').mockResolvedValue({
      thread: {
        id: 'thread-external',
        path: '/sessions/thread-external.jsonl',
        turns: [{ id: 'turn-complete', status: 'completed', items: [] }],
      },
    })
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running',
      turnId: 'turn-external',
      interruptible: false,
      source: 'external-session-writer',
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-external`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      threadId: 'thread-external',
      isInProgress: true,
      externalRuntime: {
        state: 'running',
        turnId: 'turn-external',
        interruptible: false,
        source: 'external-session-writer',
      },
    })
    expect(inspect).toHaveBeenCalledWith('thread-external', 4242)
    expect(shared.appServer.rpc).not.toHaveBeenCalledWith('thread/read', expect.anything())
  })

  it('does not keep an orphaned local in-progress turn locked when no writer is alive', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-orphaned-local-turn-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-orphaned.jsonl')
    await writeFile(rolloutPath, '{"type":"session_meta"}\n')

    const middleware = createCodexBridgeMiddleware()
    storePassiveThreadSnapshot('thread-orphaned', rolloutPath, [{
      id: 'turn-orphaned',
      status: 'inProgress',
      items: [{ id: 'message-1', type: 'agentMessage', text: 'work was interrupted by backend restart' }],
    }])
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.appServer, 'rpc').mockResolvedValue({
      thread: {
        id: 'thread-orphaned',
        path: rolloutPath,
        turns: [{
          id: 'turn-orphaned',
          status: 'inProgress',
          items: [{ id: 'message-1', type: 'agentMessage', text: 'work was interrupted by backend restart' }],
        }],
      },
    })
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({ state: 'idle' })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-orphaned`)
    const payload = await response.json() as {
      isInProgress?: boolean
      externalRuntime?: { state?: string }
      liveAuthority?: string
      liveSnapshot?: unknown
      conversationState?: { turns?: Array<{ id?: string; status?: string }> }
    }

    expect(response.status).toBe(200)
    expect(payload).toMatchObject({
      isInProgress: false,
      externalRuntime: { state: 'idle' },
      liveAuthority: 'persisted',
      liveSnapshot: null,
    })
    expect(payload.conversationState?.turns ?? []).toEqual([])
    expect(inspect).toHaveBeenCalledWith('thread-orphaned', 4242)
  })

  it('does not serve a cached idle live-state while an external writer is active', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.appServer, 'rpc').mockResolvedValue({
      thread: {
        id: 'thread-cached',
        path: '/sessions/thread-cached.jsonl',
        turns: [{ id: 'turn-complete', status: 'completed', items: [] }],
      },
    })
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect')
    inspect.mockResolvedValue({ state: 'idle' })
    inspect.mockResolvedValueOnce({
      state: 'running',
      turnId: 'turn-external',
      interruptible: false,
      source: 'external-session-writer',
    })
    const port = await listenWithMiddleware(middleware)

    const first = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-cached`)
    await expect(first.json()).resolves.toMatchObject({
      isInProgress: true,
      externalRuntime: {
        state: 'running',
        turnId: 'turn-external',
        interruptible: false,
        source: 'external-session-writer',
      },
    })

    const second = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-cached`)

    await expect(second.json()).resolves.toMatchObject({
      isInProgress: false,
      externalRuntime: { state: 'idle' },
    })
    expect(inspect).toHaveBeenCalledTimes(2)
  })

  it('reuses a cached running live-state when the external session file has not changed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-running.jsonl')
    await writeFile(rolloutPath, '{"type":"session_meta"}\n')

    const middleware = createCodexBridgeMiddleware()
    storePassiveThreadSnapshot('thread-running', rolloutPath)
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const rpc = vi.spyOn(shared.appServer, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/turns/list') {
        return {
          data: [{ id: 'turn-complete', status: 'completed', items: [] }],
          nextCursor: null,
          backwardsCursor: null,
        }
      }
      return {
        thread: {
          id: 'thread-running',
          path: rolloutPath,
          turns: [],
        },
      }
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running',
      turnId: 'turn-external',
      interruptible: false,
      source: 'external-session-writer',
    })
    const port = await listenWithMiddleware(middleware)

    const first = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-running`)
    await expect(first.json()).resolves.toMatchObject({ isInProgress: true })

    const second = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-running`)
    await expect(second.json()).resolves.toMatchObject({ isInProgress: true })

    expect(rpc).not.toHaveBeenCalled()
  })

  it('returns a lightweight not-modified live-state when the projection key matches', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-not-modified-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-not-modified.jsonl')
    await writeFile(rolloutPath, '{"type":"session_meta"}\n')

    const middleware = createCodexBridgeMiddleware()
    storePassiveThreadSnapshot('thread-not-modified', rolloutPath)
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const rpc = vi.spyOn(shared.appServer, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/turns/list') {
        return {
          data: [{
            id: 'turn-complete',
            status: 'completed',
            items: [{
              id: 'large-item',
              type: 'agentMessage',
              text: 'x'.repeat(128_000),
            }],
          }],
          nextCursor: null,
          backwardsCursor: null,
        }
      }
      return {
        thread: {
          id: 'thread-not-modified',
          path: rolloutPath,
          turns: [],
        },
      }
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running',
      turnId: 'turn-external',
      interruptible: false,
      source: 'external-session-writer',
    })
    const port = await listenWithMiddleware(middleware)

    const first = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-not-modified`)
    const firstPayload = await first.json() as {
      projectionKey?: string
      conversationState?: unknown
    }

    expect(firstPayload.projectionKey).toEqual(expect.any(String))
    expect(firstPayload.conversationState).toEqual(expect.objectContaining({
      turns: expect.any(Array),
    }))

    const second = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-not-modified&knownProjectionKey=${encodeURIComponent(firstPayload.projectionKey ?? '')}`,
    )
    const secondPayload = await second.json() as {
      notModified?: boolean
      projectionKey?: string
      conversationState?: unknown
      isInProgress?: boolean
      liveAuthority?: string
      liveSnapshot?: unknown
    }

    expect(secondPayload).toMatchObject({
      notModified: true,
      projectionKey: firstPayload.projectionKey,
      isInProgress: true,
      liveAuthority: 'missing',
      liveSnapshot: null,
    })
    expect(secondPayload).not.toHaveProperty('conversationState')
    expect(JSON.stringify(secondPayload).length).toBeLessThan(2048)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('compresses running active-turn text and prompt bulk out of the initial live-state projection', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-active-text-compressed-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-active-text-compressed.jsonl')
    await writeFile(rolloutPath, '{"type":"session_meta"}\n')

    const middleware = createCodexBridgeMiddleware()
    storePassiveThreadSnapshot('thread-active-text-compressed', rolloutPath)
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.appServer, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/turns/list') {
        return {
          data: [{
            id: 'turn-external',
            status: 'inProgress',
            items: [
              {
                id: 'user-active',
                type: 'userMessage',
                content: [{ type: 'text', text: `Continue ${'x'.repeat(8192)}` }],
              },
              ...Array.from({ length: 50 }, (_, index) => ({
                id: `agent-${index}`,
                type: 'agentMessage',
                text: `active output ${index}`,
              })),
            ],
          }],
          nextCursor: null,
          backwardsCursor: null,
        }
      }
      return {
        thread: {
          id: 'thread-active-text-compressed',
          path: rolloutPath,
          turns: [],
        },
      }
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running',
      turnId: 'turn-external',
      interruptible: false,
      source: 'external-session-writer',
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-active-text-compressed`,
    )
    const payload = await response.json() as {
      activeTurnId?: string
      conversationState?: {
        turns?: Array<{
          id?: string
          items?: Array<{ id?: string; type?: string }>
          rawItemCompression?: {
            originalItemCount?: number
            retainedItemCount?: number
            omittedItemCount?: number
          }
        }>
      }
    }
    const activeTurn = payload.conversationState?.turns?.find((turn) => turn.id === 'turn-external')

    expect(response.status).toBe(200)
    expect(payload.activeTurnId).toBe('turn-external')
    expect(activeTurn?.items).toEqual([])
    expect(activeTurn?.rawItemCompression).toEqual({
      originalItemCount: 1,
      retainedItemCount: 0,
      omittedItemCount: 1,
    })
    expect(JSON.stringify(payload)).not.toContain('user-active')
    expect(JSON.stringify(payload)).not.toContain('Continue')
    expect(JSON.stringify(payload)).not.toContain('active output')
    expect(JSON.stringify(payload).length).toBeLessThan(3072)
  })

  it('deduplicates concurrent running live-state projections for the same known key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-concurrent-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-concurrent.jsonl')
    await writeFile(rolloutPath, '{"type":"session_meta"}\n')

    const middleware = createCodexBridgeMiddleware()
    storePassiveThreadSnapshot('thread-concurrent', rolloutPath)
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const rpc = vi.spyOn(shared.appServer, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/turns/list') {
        await new Promise((resolve) => setTimeout(resolve, 20))
        return {
          data: [{
            id: 'turn-external',
            status: 'inProgress',
            items: [{
              id: 'agent-heavy',
              type: 'agentMessage',
              text: 'x'.repeat(128_000),
            }],
          }],
          nextCursor: null,
          backwardsCursor: null,
        }
      }
      return {
        thread: {
          id: 'thread-concurrent',
          path: rolloutPath,
          turns: [],
        },
      }
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running',
      turnId: 'turn-external',
      interruptible: false,
      source: 'external-session-writer',
    })
    const port = await listenWithMiddleware(middleware)

    const [first, second] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-concurrent&knownProjectionKey=stale`),
      fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-concurrent&knownProjectionKey=stale`),
    ])
    const firstPayload = await first.json() as { projectionKey?: string; isInProgress?: boolean }
    const secondPayload = await second.json() as { projectionKey?: string; isInProgress?: boolean }

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(firstPayload).toMatchObject({ isInProgress: true })
    expect(secondPayload).toMatchObject({ isInProgress: true, projectionKey: firstPayload.projectionKey })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('returns a lightweight not-modified cached idle live-state when the projection key matches', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-idle-not-modified-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-idle-not-modified.jsonl')
    await writeFile(rolloutPath, '{"type":"session_meta"}\n')

    const middleware = createCodexBridgeMiddleware()
    storePassiveThreadSnapshot('thread-idle-not-modified', rolloutPath)
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const rpc = vi.spyOn(shared.appServer, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/turns/list') {
        return {
          data: [{
            id: 'turn-complete',
            status: 'interrupted',
            items: [{
              id: 'large-idle-item',
              type: 'agentMessage',
              text: 'x'.repeat(128_000),
            }],
          }],
          nextCursor: null,
          backwardsCursor: null,
        }
      }
      return {
        thread: {
          id: 'thread-idle-not-modified',
          path: rolloutPath,
          turns: [],
        },
      }
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({ state: 'unknown' })
    const port = await listenWithMiddleware(middleware)

    const first = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-idle-not-modified`)
    const firstPayload = await first.json() as {
      projectionKey?: string
      conversationState?: unknown
      isInProgress?: boolean
    }

    expect(firstPayload).toMatchObject({
      projectionKey: expect.any(String),
      isInProgress: false,
      conversationState: expect.objectContaining({ turns: expect.any(Array) }),
    })

    const second = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-idle-not-modified&knownProjectionKey=${encodeURIComponent(firstPayload.projectionKey ?? '')}`,
    )
    const secondPayload = await second.json() as {
      notModified?: boolean
      projectionKey?: string
      conversationState?: unknown
      isInProgress?: boolean
    }

    expect(secondPayload).toMatchObject({
      notModified: true,
      projectionKey: firstPayload.projectionKey,
      isInProgress: false,
    })
    expect(secondPayload).not.toHaveProperty('conversationState')
    expect(JSON.stringify(secondPayload).length).toBeLessThan(2048)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('rechecks a known non-interruptible running projection before reusing it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-known-running-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-known-running.jsonl')
    await writeFile(rolloutPath, '{"type":"session_meta"}\n')

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.appServer, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/turns/list') {
        return {
          data: [{ id: 'turn-complete', status: 'completed', items: [] }],
          nextCursor: null,
          backwardsCursor: null,
        }
      }
      return {
        thread: {
          id: 'thread-known-running',
          path: rolloutPath,
          turns: [],
        },
      }
    })
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running',
      turnId: 'turn-external',
      interruptible: false,
      source: 'external-session-writer',
    })
    const port = await listenWithMiddleware(middleware)

    const first = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-known-running`)
    const firstPayload = await first.json() as { projectionKey?: string }

    const second = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-known-running&knownProjectionKey=${encodeURIComponent(firstPayload.projectionKey ?? '')}`,
    )
    await expect(second.json()).resolves.toMatchObject({
      notModified: true,
      projectionKey: firstPayload.projectionKey,
      isInProgress: true,
    })
    expect(inspect).toHaveBeenCalledTimes(2)
  })

  it('upgrades a known non-interruptible running projection when the next live-state probe confirms a writer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-known-running-upgrade-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-known-running-upgrade.jsonl')
    await writeFile(rolloutPath, '{"type":"session_meta"}\n')

    const middleware = createCodexBridgeMiddleware()
    storePassiveThreadSnapshot('thread-known-running-upgrade', rolloutPath)
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.appServer, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/turns/list') {
        return {
          data: [{ id: 'turn-complete', status: 'completed', items: [] }],
          nextCursor: null,
          backwardsCursor: null,
        }
      }
      return {
        thread: {
          id: 'thread-known-running-upgrade',
          path: rolloutPath,
          turns: [],
        },
      }
    })
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect')
      .mockResolvedValueOnce({
        state: 'running',
        turnId: 'turn-external',
        interruptible: false,
        source: 'external-session-writer',
      })
      .mockResolvedValueOnce({
        state: 'running',
        turnId: 'turn-external',
        interruptible: true,
        source: 'external-session-writer',
        cwd: '/tmp/codex-mobile-runtime-worktree',
      })
    const port = await listenWithMiddleware(middleware)

    const first = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-known-running-upgrade`)
    const firstPayload = await first.json() as {
      projectionKey?: string
      externalRuntime?: { interruptible?: boolean }
    }
    expect(firstPayload.projectionKey).toEqual(expect.any(String))
    expect(firstPayload.externalRuntime?.interruptible).toBe(false)

    const second = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-known-running-upgrade&knownProjectionKey=${encodeURIComponent(firstPayload.projectionKey ?? '')}`,
    )
    const secondPayload = await second.json() as {
      notModified?: boolean
      projectionKey?: string
      externalRuntime?: { interruptible?: boolean; cwd?: string }
      conversationState?: unknown
    }

    expect(second.status).toBe(200)
    expect(secondPayload).toMatchObject({
      notModified: true,
      externalRuntime: {
        interruptible: true,
        cwd: '/tmp/codex-mobile-runtime-worktree',
      },
    })
    expect(secondPayload.projectionKey).toEqual(expect.any(String))
    expect(secondPayload.projectionKey).not.toBe(firstPayload.projectionKey)
    expect(secondPayload).not.toHaveProperty('conversationState')
    expect(inspect).toHaveBeenCalledTimes(2)
  })

  it('rechecks a known interruptible external running projection before reusing it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-known-running-interruptible-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-known-running-interruptible.jsonl')
    await writeFile(rolloutPath, '{"type":"session_meta"}\n')

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.appServer, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/turns/list') {
        return {
          data: [{ id: 'turn-complete', status: 'completed', items: [] }],
          nextCursor: null,
          backwardsCursor: null,
        }
      }
      return {
        thread: {
          id: 'thread-known-running-interruptible',
          path: rolloutPath,
          turns: [],
        },
      }
    })
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect')
    inspect.mockResolvedValueOnce({
      state: 'running',
      turnId: 'turn-external',
      interruptible: true,
      source: 'external-session-writer',
      cwd: '/tmp/codex-mobile-runtime-worktree',
    })
    inspect.mockResolvedValueOnce({ state: 'unknown' })
    const port = await listenWithMiddleware(middleware)

    const first = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-known-running-interruptible`)
    const firstPayload = await first.json() as { projectionKey?: string }
    expect(firstPayload.projectionKey).toEqual(expect.any(String))

    const second = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-known-running-interruptible&knownProjectionKey=${encodeURIComponent(firstPayload.projectionKey ?? '')}`,
    )
    const secondPayload = await second.json() as {
      isInProgress?: boolean
      externalRuntime?: { state?: string }
    }

    expect(second.status).toBe(200)
    expect(secondPayload).toMatchObject({
      isInProgress: false,
      externalRuntime: { state: 'unknown' },
    })
  })

  it('rechecks a cached external running projection when runtime cwd is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-known-running-cwd-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-known-running-cwd.jsonl')
    await writeFile(rolloutPath, '{"type":"session_meta"}\n')

    const middleware = createCodexBridgeMiddleware()
    storePassiveThreadSnapshot('thread-known-running-cwd', rolloutPath)
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.appServer, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/turns/list') {
        return {
          data: [{ id: 'turn-complete', status: 'completed', items: [] }],
          nextCursor: null,
          backwardsCursor: null,
        }
      }
      return {
        thread: {
          id: 'thread-known-running-cwd',
          path: rolloutPath,
          turns: [],
        },
      }
    })
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect')
      .mockResolvedValueOnce({
        state: 'running',
        turnId: 'turn-external',
        interruptible: true,
        source: 'external-session-writer',
      })
      .mockResolvedValueOnce({
        state: 'running',
        turnId: 'turn-external',
        interruptible: true,
        source: 'external-session-writer',
        cwd: '/tmp/codex-mobile-runtime-worktree',
      })
    const port = await listenWithMiddleware(middleware)

    const first = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-known-running-cwd`)
    const firstPayload = await first.json() as {
      projectionKey?: string
      externalRuntime?: { cwd?: string }
    }
    expect(firstPayload.projectionKey).toEqual(expect.any(String))
    expect(firstPayload.externalRuntime?.cwd).toBeUndefined()

    const second = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-known-running-cwd&knownProjectionKey=${encodeURIComponent(firstPayload.projectionKey ?? '')}`,
    )
    const secondPayload = await second.json() as {
      notModified?: boolean
      projectionKey?: string
      externalRuntime?: { cwd?: string }
      conversationState?: unknown
    }

    expect(secondPayload).toMatchObject({
      notModified: true,
      externalRuntime: {
        cwd: '/tmp/codex-mobile-runtime-worktree',
      },
    })
    expect(secondPayload.projectionKey).toEqual(expect.any(String))
    expect(secondPayload.projectionKey).not.toBe(firstPayload.projectionKey)
    expect(secondPayload).not.toHaveProperty('conversationState')
    expect(inspect).toHaveBeenCalledTimes(2)
  })

  it('prefers a local app-server live-state runtime over a stale desktop writer snapshot', async () => {
    const liveStateDir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-local-over-snapshot-'))
    const previousLiveStateDir = process.env.CODEX_MOBILE_LIVE_STATE_DIR
    process.env.CODEX_MOBILE_LIVE_STATE_DIR = liveStateDir
    const rolloutPath = join(liveStateDir, 'thread-local-over-snapshot.jsonl')
    try {
      await writeFile(rolloutPath, '{"type":"session_meta"}\n')
      await writeFile(join(liveStateDir, 'thread-local-over-snapshot.json'), JSON.stringify({
        schemaVersion: 1,
        threadId: 'thread-local-over-snapshot',
        activeTurnId: 'turn-external-stale',
        revision: 3,
        generatedAt: new Date(Date.now() - 1000).toISOString(),
        expiresAt: new Date(Date.now() + 30000).toISOString(),
        source: 'desktop-writer',
        state: 'running',
        footer: null,
        timeline: [],
        pendingRequest: null,
        sidebar: { indicator: 'running' },
      }), 'utf8')

      const middleware = createCodexBridgeMiddleware()
      const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
        appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
          rpc: (method: string, params: unknown) => Promise<unknown>
        }
      }
      vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
      vi.spyOn(shared.appServer, 'rpc').mockImplementation(async (method) => {
        if (method === 'thread/turns/list') {
          return {
            data: [{
              id: 'turn-local-current',
              status: 'inProgress',
              items: [{ id: 'agent-local-current', type: 'agentMessage', text: 'local active text' }],
            }],
            nextCursor: null,
            backwardsCursor: null,
          }
        }
        return {
          thread: {
            id: 'thread-local-over-snapshot',
            path: rolloutPath,
            turns: [],
          },
        }
      })
      vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({ state: 'idle' })
      shared.localRuntimeLedger.record({
        method: 'turn/started',
        params: {
          threadId: 'thread-local-over-snapshot',
          turn: { id: 'turn-local-current' },
        },
      })
      const port = await listenWithMiddleware(middleware)

      const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-local-over-snapshot`)
      const payload = await response.json() as {
        isInProgress?: boolean
        activeTurnId?: string
        externalRuntime?: { state?: string; turnId?: string; interruptible?: boolean; source?: string }
        liveAuthority?: string
        liveSnapshot?: unknown
        conversationState?: { turns?: Array<{ id?: string; items?: unknown[] }> }
      }

      expect(response.status).toBe(200)
      expect(payload).toMatchObject({
        isInProgress: true,
        activeTurnId: 'turn-local-current',
        externalRuntime: {
          state: 'running',
          turnId: 'turn-local-current',
          interruptible: true,
          source: 'local-app-server',
        },
        liveAuthority: 'local-stream',
        liveSnapshot: null,
      })
      expect(payload.conversationState?.turns?.[0]?.items).toEqual([])
    } finally {
      if (previousLiveStateDir === undefined) {
        delete process.env.CODEX_MOBILE_LIVE_STATE_DIR
      } else {
        process.env.CODEX_MOBILE_LIVE_STATE_DIR = previousLiveStateDir
      }
      await rm(liveStateDir, { recursive: true, force: true })
    }
  })

  it('prefers a local app-server live-state runtime over a known external running projection cache', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-local-over-cache-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-local-over-cache.jsonl')
    await writeFile(rolloutPath, '{"type":"session_meta"}\n')

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    let localStarted = false
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.appServer, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/turns/list') {
        return {
          data: [localStarted
            ? {
                id: 'turn-local-current',
                status: 'inProgress',
                items: [{ id: 'agent-local-current', type: 'agentMessage', text: 'local active text' }],
              }
            : { id: 'turn-external', status: 'inProgress', items: [] }],
          nextCursor: null,
          backwardsCursor: null,
        }
      }
      return {
        thread: {
          id: 'thread-local-over-cache',
          path: rolloutPath,
          turns: [],
        },
      }
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running',
      turnId: 'turn-external',
      interruptible: true,
      source: 'external-session-writer',
      cwd: '/tmp/codex-mobile-runtime-worktree',
    })
    const port = await listenWithMiddleware(middleware)

    const first = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-local-over-cache`)
    const firstPayload = await first.json() as { projectionKey?: string }
    expect(firstPayload.projectionKey).toEqual(expect.any(String))

    localStarted = true
    shared.localRuntimeLedger.record({
      method: 'turn/started',
      params: {
        threadId: 'thread-local-over-cache',
        turn: { id: 'turn-local-current' },
      },
    })

    const second = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-local-over-cache&knownProjectionKey=${encodeURIComponent(firstPayload.projectionKey ?? '')}`,
    )
    const payload = await second.json() as {
      isInProgress?: boolean
      activeTurnId?: string
      externalRuntime?: { state?: string; turnId?: string; interruptible?: boolean; source?: string }
      liveAuthority?: string
      liveSnapshot?: unknown
    }

    expect(second.status).toBe(200)
    expect(payload).toMatchObject({
      isInProgress: true,
      activeTurnId: 'turn-local-current',
      externalRuntime: {
        state: 'running',
        turnId: 'turn-local-current',
        interruptible: true,
        source: 'local-app-server',
      },
      liveAuthority: 'local-stream',
      liveSnapshot: null,
    })
  })

  it('keeps a known running projection unchanged when the rollout only appends hidden records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-hidden-append-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-hidden-append.jsonl')
    await writeFile(rolloutPath, '{"type":"session_meta"}\n')

    const middleware = createCodexBridgeMiddleware()
    storePassiveThreadSnapshot('thread-hidden-append', rolloutPath)
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const rpc = vi.spyOn(shared.appServer, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/turns/list') {
        return {
          data: [{ id: 'turn-complete', status: 'completed', items: [] }],
          nextCursor: null,
          backwardsCursor: null,
        }
      }
      return {
        thread: {
          id: 'thread-hidden-append',
          path: rolloutPath,
          turns: [],
        },
      }
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running',
      turnId: 'turn-external',
      interruptible: false,
      source: 'external-session-writer',
    })
    const port = await listenWithMiddleware(middleware)

    const first = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-hidden-append`)
    const firstPayload = await first.json() as { projectionKey?: string }
    expect(firstPayload.projectionKey).toEqual(expect.any(String))

    await appendFile(rolloutPath, `${JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'call-hidden',
        arguments: JSON.stringify({ cmd: 'large hidden command' }),
      },
    })}\n`, 'utf8')

    const second = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-hidden-append&knownProjectionKey=${encodeURIComponent(firstPayload.projectionKey ?? '')}`,
    )
    const secondPayload = await second.json() as {
      notModified?: boolean
      projectionKey?: string
      conversationState?: unknown
    }

    expect(secondPayload).toMatchObject({
      notModified: true,
      projectionKey: firstPayload.projectionKey,
    })
    expect(secondPayload).not.toHaveProperty('conversationState')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('changes a known running projection when the rollout appends visible active text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-visible-append-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-visible-append.jsonl')
    await writeFile(rolloutPath, '{"type":"session_meta"}\n')

    const middleware = createCodexBridgeMiddleware()
    storePassiveThreadSnapshot('thread-visible-append', rolloutPath)
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const rpc = vi.spyOn(shared.appServer, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/turns/list') {
        return {
          data: [{ id: 'turn-complete', status: 'completed', items: [] }],
          nextCursor: null,
          backwardsCursor: null,
        }
      }
      return {
        thread: {
          id: 'thread-visible-append',
          path: rolloutPath,
          turns: [],
        },
      }
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running',
      turnId: 'turn-external',
      interruptible: false,
      source: 'external-session-writer',
    })
    const port = await listenWithMiddleware(middleware)

    const first = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-visible-append`)
    const firstPayload = await first.json() as { projectionKey?: string }
    expect(firstPayload.projectionKey).toEqual(expect.any(String))

    await appendFile(rolloutPath, `${JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        id: 'visible-message-after-projection',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Visible active text after the previous projection.' }],
      },
    })}\n`, 'utf8')

    const second = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-visible-append&knownProjectionKey=${encodeURIComponent(firstPayload.projectionKey ?? '')}`,
    )
    const secondPayload = await second.json() as {
      notModified?: boolean
      projectionKey?: string
      conversationState?: unknown
    }

    expect(secondPayload).toMatchObject({
      notModified: true,
    })
    expect(secondPayload.projectionKey).toEqual(expect.any(String))
    expect(secondPayload.projectionKey).not.toBe(firstPayload.projectionKey)
    expect(secondPayload).not.toHaveProperty('conversationState')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('changes a known running projection when visible text appends after a user anchor', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-anchor-append-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-anchor-append.jsonl')
    await writeFile(rolloutPath, [
      JSON.stringify({ type: 'session_meta' }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-external' },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'user-anchor',
          role: 'user',
          content: [{ type: 'input_text', text: '继续' }],
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'visible-message-before-projection',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Visible active text before the projection.' }],
        },
      }),
      '',
    ].join('\n'), 'utf8')

    const middleware = createCodexBridgeMiddleware()
    storePassiveThreadSnapshot('thread-anchor-append', rolloutPath)
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const rpc = vi.spyOn(shared.appServer, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/turns/list') {
        return {
          data: [{ id: 'turn-complete', status: 'completed', items: [] }],
          nextCursor: null,
          backwardsCursor: null,
        }
      }
      return {
        thread: {
          id: 'thread-anchor-append',
          path: rolloutPath,
          turns: [],
        },
      }
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running',
      turnId: 'turn-external',
      interruptible: false,
      source: 'external-session-writer',
    })
    const port = await listenWithMiddleware(middleware)

    const first = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-anchor-append`)
    const firstPayload = await first.json() as { projectionKey?: string }
    expect(firstPayload.projectionKey).toEqual(expect.any(String))

    await appendFile(rolloutPath, `${JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        id: 'visible-message-after-projection',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Visible active text after the previous projection.' }],
      },
    })}\n`, 'utf8')

    const second = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-anchor-append&knownProjectionKey=${encodeURIComponent(firstPayload.projectionKey ?? '')}`,
    )
    const secondPayload = await second.json() as {
      notModified?: boolean
      projectionKey?: string
      conversationState?: unknown
    }

    expect(secondPayload).toMatchObject({
      notModified: true,
    })
    expect(secondPayload.projectionKey).toEqual(expect.any(String))
    expect(secondPayload.projectionKey).not.toBe(firstPayload.projectionKey)
    expect(secondPayload).not.toHaveProperty('conversationState')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('returns a full live-state when the known projection key is stale', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-stale-key-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-stale-key.jsonl')
    await writeFile(rolloutPath, '{"type":"session_meta"}\n')

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.appServer, 'rpc').mockResolvedValue({
      thread: {
        id: 'thread-stale-key',
        path: rolloutPath,
        turns: [{ id: 'turn-complete', status: 'completed', items: [] }],
      },
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running',
      turnId: 'turn-external',
      interruptible: false,
      source: 'external-session-writer',
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-stale-key&knownProjectionKey=stale`,
    )
    const payload = await response.json() as {
      notModified?: boolean
      projectionKey?: string
      conversationState?: unknown
    }

    expect(payload.notModified).not.toBe(true)
    expect(payload.projectionKey).toEqual(expect.any(String))
    expect(payload.conversationState).toEqual(expect.objectContaining({
      turns: expect.any(Array),
    }))
  })

  it('does not reuse cached writer authority after the external runtime becomes idle', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-cache-authority-'))
    const previousLiveStateDir = process.env.CODEX_MOBILE_LIVE_STATE_DIR
    process.env.CODEX_MOBILE_LIVE_STATE_DIR = dir
    disposers.push(() => {
      if (previousLiveStateDir === undefined) {
        delete process.env.CODEX_MOBILE_LIVE_STATE_DIR
      } else {
        process.env.CODEX_MOBILE_LIVE_STATE_DIR = previousLiveStateDir
      }
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-cache-authority.jsonl')
    await writeFile(rolloutPath, '{"type":"session_meta"}\n')
    await writeFile(join(dir, 'thread-cache-authority.json'), JSON.stringify({
      schemaVersion: 1,
      threadId: 'thread-cache-authority',
      activeTurnId: 'turn-external',
      revision: 7,
      generatedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 30000).toISOString(),
      source: 'desktop-writer',
      state: 'running',
      footer: {
        stepCurrent: 2,
        stepTotal: 6,
        completedPercent: 33.3333,
        fileCount: 29,
        additions: 5485,
        deletions: 417,
        label: 'Step 2 / 6 · 29 files changed +5485 -417',
      },
      timeline: [],
      pendingRequest: null,
      sidebar: { indicator: 'running' },
    }), 'utf8')

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.appServer, 'rpc').mockResolvedValue({
      thread: {
        id: 'thread-cache-authority',
        path: rolloutPath,
        turns: [{ id: 'turn-complete', status: 'completed', items: [] }],
      },
    })
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect')
    inspect.mockResolvedValue({ state: 'idle' })
    const port = await listenWithMiddleware(middleware)

    const first = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-cache-authority`)
    await expect(first.json()).resolves.toMatchObject({
      isInProgress: true,
      liveAuthority: 'writer-snapshot',
      liveSnapshot: { activeTurnId: 'turn-external' },
    })

    const second = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-cache-authority`)
    await expect(second.json()).resolves.toMatchObject({
      isInProgress: false,
      externalRuntime: { state: 'idle' },
      liveAuthority: 'persisted',
      liveSnapshot: null,
    })
    expect(inspect).toHaveBeenCalledTimes(2)
  })

  it('uses the last snapshot when a cached idle projection becomes externally running', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-cache-idle-to-running-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-idle-to-running.jsonl')
    await writeFile(rolloutPath, `${JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-external' },
    })}\n`, 'utf8')

    const middleware = createCodexBridgeMiddleware()
    storePassiveThreadSnapshot('thread-idle-to-running', rolloutPath)
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const rpc = vi.spyOn(shared.appServer, 'rpc').mockImplementation(async (method) => {
      if (method === 'thread/turns/list') {
        return {
          data: [{ id: 'turn-external', status: 'interrupted', items: [] }],
          nextCursor: null,
          backwardsCursor: null,
        }
      }
      return {
        thread: {
          id: 'thread-idle-to-running',
          path: rolloutPath,
          turns: [],
        },
      }
    })
    const inspect = vi.spyOn(shared.runtimeProbe, 'inspect')
    inspect.mockResolvedValueOnce({ state: 'unknown' })
    inspect.mockResolvedValueOnce({
      state: 'running',
      turnId: 'turn-external',
      interruptible: false,
      source: 'external-session-writer',
    })
    const port = await listenWithMiddleware(middleware)

    const first = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-idle-to-running`)
    await expect(first.json()).resolves.toMatchObject({
      isInProgress: true,
      externalRuntime: { state: 'unknown' },
    })
    expect(rpc).not.toHaveBeenCalled()

    const second = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-idle-to-running`)
    await expect(second.json()).resolves.toMatchObject({
      isInProgress: true,
      externalRuntime: {
        state: 'running',
        turnId: 'turn-external',
        source: 'external-session-writer',
      },
      conversationState: {
        turns: [{ id: 'turn-external' }],
      },
    })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('uses a local rollout path for known-key live-state without retrying thread/read', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-local-path-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => {
      void rm(codexHome, { recursive: true, force: true }).catch(() => undefined)
    })
    const threadId = '019faabf-f76e-7fe0-a38f-3f12d03ecaf7'
    const turnId = '019faac4-37bc-7601-bf0a-7149ce84cabb'
    const sessionDir = join(codexHome, 'sessions', '2026', '07', '29')
    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(sessionDir, `rollout-test-${threadId}.jsonl`), [
      JSON.stringify({ type: 'session_meta', payload: { id: threadId, oversized: 'x'.repeat(80 * 1024) } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          id: 'agent-local-live-state',
          content: [{ type: 'output_text', text: 'Local live state update' }],
        },
      }),
      '',
    ].join('\n'), 'utf8')

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const rpc = vi.spyOn(shared.appServer, 'rpc').mockRejectedValue(new Error('thread/read should not be called'))
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running',
      turnId,
      interruptible: false,
      source: 'external-session-writer',
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=${threadId}&knownProjectionKey=stale`,
    )
    const body = await response.json() as {
      notModified?: boolean
      isInProgress?: boolean
      externalRuntime?: { state?: string; turnId?: string }
      conversationState?: unknown
    }

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      notModified: true,
      isInProgress: true,
      externalRuntime: {
        state: 'running',
        turnId,
      },
    })
    expect(body).not.toHaveProperty('conversationState')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('reads cwd from a bounded long session_meta line in session-index fallback metadata', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-session-index-long-meta-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const threadId = '019faabf-f76e-7fe0-a38f-3f12d03ecaf8'
    const cwd = '/tmp/long-session-meta-project'
    const sessionDir = join(codexHome, 'sessions', '2026', '07', '29')
    const sessionPath = join(sessionDir, `rollout-test-${threadId}.jsonl`)
    await mkdir(sessionDir, { recursive: true })
    await writeFile(sessionPath, `${JSON.stringify({
      type: 'session_meta', payload: { id: threadId, cwd, oversized: 'x'.repeat(80 * 1024) },
    })}\n`, 'utf8')
    const bridge = await import('./codexAppServerBridge') as unknown as {
      readSessionIndexFallbackRolloutMetadata?: (id: string) => Promise<{ path: string; cwd: string }>
    }

    expect(bridge.readSessionIndexFallbackRolloutMetadata).toBeTypeOf('function')
    await expect(bridge.readSessionIndexFallbackRolloutMetadata!(threadId)).resolves.toEqual({
      path: sessionPath,
      cwd,
    })
  })

  it('returns a passive local projection without calling app-server turn APIs', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    const turns = Array.from({ length: 12 }, (_unused, index) => ({
      id: `turn-${index}`,
      status: index === 11 ? 'inProgress' : 'completed',
      items: [
        {
          id: `reasoning-${index}`,
          type: 'reasoning',
          summary: [`thinking ${index}`],
          content: [],
        },
        {
          id: `item-${index}`,
          type: 'agentMessage',
          text: `message ${index}`,
        },
      ],
    }))
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const rpc = vi.spyOn(shared.appServer, 'rpc').mockImplementation(async (method, params) => {
      if (method === 'thread/read') {
        expect(params).toEqual({
          threadId: 'thread-windowed',
          includeTurns: false,
        })
        return {
          thread: {
            id: 'thread-windowed',
            path: '/sessions/thread-windowed.jsonl',
            turns: [],
          },
        }
      }
      if (method === 'thread/turns/list') {
        expect(params).toEqual({
          threadId: 'thread-windowed',
          cursor: null,
          limit: 3,
          sortDirection: 'desc',
          itemsView: 'full',
        })
        return {
          data: turns.slice(-3).reverse(),
          nextCursor: 'opaque-older',
          backwardsCursor: null,
        }
      }
      throw new Error(`Unexpected RPC method: ${method}`)
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({
      state: 'running',
      turnId: 'turn-11',
      interruptible: false,
      source: 'external-session-writer',
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-windowed`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      threadId: 'thread-windowed',
      threadTurnStartIndex: 0,
      hasMoreOlder: false,
      olderCursor: null,
      conversationState: {
        turns: expect.arrayContaining([
          expect.objectContaining({
            id: 'turn-11',
            items: [],
            rawItemCompression: {
              originalItemCount: 1,
              retainedItemCount: 0,
              omittedItemCount: 1,
            },
          }),
        ]),
      },
    })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('does not call app-server when no local live projection is available', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const rpc = vi.spyOn(shared.appServer, 'rpc').mockImplementation(async (method, params) => {
      if (method === 'thread/read' && (params as { includeTurns?: boolean }).includeTurns === true) {
        throw new Error('full history read forbidden')
      }
      if (method === 'thread/read') {
        return {
          thread: {
            id: 'thread-malformed-page',
            path: '/sessions/thread-malformed-page.jsonl',
            turns: [],
          },
        }
      }
      if (method === 'thread/turns/list') return {}
      throw new Error(`Unexpected RPC method: ${method}`)
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({ state: 'idle' })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-malformed-page`,
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      threadId: 'thread-malformed-page',
      conversationState: { turns: [] },
      liveStateError: null,
    })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('keeps command activity in live-state while active text stays on the text endpoint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-session-order-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-order.jsonl')
    await writeFile(rolloutPath, [
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-order' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'call-order',
          arguments: JSON.stringify({ cmd: 'echo recovered' }),
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call-order',
          output: 'Process exited with code 0\nWall time: 0.001 seconds\nOutput:\nrecovered\n',
        },
      }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant' } }),
      '',
    ].join('\n'))

    const middleware = createCodexBridgeMiddleware()
    storePassiveThreadSnapshot('thread-order', rolloutPath)
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.appServer, 'rpc').mockResolvedValue({
      thread: {
        id: 'thread-order',
        path: rolloutPath,
        turns: [{
          id: 'turn-order',
          status: 'completed',
          items: [
            { id: 'user-1', type: 'userMessage', content: [] },
            { id: 'reasoning-1', type: 'reasoning', summary: ['thinking'], content: [] },
            { id: 'agent-1', type: 'agentMessage', text: 'first' },
            { id: 'tool-1', type: 'mcpToolCall', status: 'completed' },
            { id: 'agent-2', type: 'agentMessage', text: 'second' },
          ],
        }],
      },
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({ state: 'idle' })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-order`)
    const payload = await response.json() as {
      conversationState?: { turns?: Array<{ items?: Array<{ id?: string; type?: string }> }> }
    }
    const itemIds = payload.conversationState?.turns?.[0]?.items?.map((item) => item.id) ?? []

    expect(response.status).toBe(200)
    expect(itemIds).toEqual(['session-cmd-call-order'])
  })

  it('recovers no-id user message rows before the matching assistant output in live-state responses', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-user-message-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-live-user-message.jsonl')
    await writeFile(rolloutPath, [
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-live-user-message' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '我在两个机器上配置了免密登录，为什么我ssh还需要输入密码' }],
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '我会按 SSH 认证链逐层检查。' }],
        },
      }),
      '',
    ].join('\n'))

    const middleware = createCodexBridgeMiddleware()
    storePassiveThreadSnapshot('thread-live-user-message', rolloutPath)
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.appServer, 'rpc').mockResolvedValue({
      thread: {
        id: 'thread-live-user-message',
        path: rolloutPath,
        turns: [{
          id: 'turn-live-user-message',
          status: 'completed',
          items: [
            { id: 'agent-live-user-message-1', type: 'agentMessage', text: '我会按 SSH 认证链逐层检查。' },
          ],
        }],
      },
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({ state: 'idle' })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-live-user-message`,
    )
    const payload = await response.json() as {
      conversationState?: { turns?: Array<{ items?: Array<Record<string, unknown>> }> }
    }
    const items = payload.conversationState?.turns?.[0]?.items ?? []

    expect(response.status).toBe(200)
    expect(items.map((item) => item.type)).toEqual(['userMessage', 'agentMessage'])
    expect(JSON.stringify(items[0])).toContain('我在两个机器上配置了免密登录')
    expect(JSON.stringify(items[1])).toContain('我会按 SSH 认证链逐层检查')
  })

  it('reorders late delegated user messages before their matching assistant output in live-state responses', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-user-message-order-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-live-user-message-order.jsonl')
    await writeFile(rolloutPath, [
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-live-user-message-order' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          id: 'agent-after-steer',
          content: [{ type: 'output_text', text: '收到。继续 Task2。' }],
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'user_message',
          client_id: 'client-steer-order',
          message: '<codex_delegation>\n<input>TASK2_PLANNER_FINDING_2</input>\n</codex_delegation>',
          images: [],
          local_images: [],
          text_elements: [],
        },
      }),
      '',
    ].join('\n'))

    const middleware = createCodexBridgeMiddleware()
    storePassiveThreadSnapshot('thread-live-user-message-order', rolloutPath)
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.appServer, 'rpc').mockResolvedValue({
      thread: {
        id: 'thread-live-user-message-order',
        path: rolloutPath,
        turns: [{
          id: 'turn-live-user-message-order',
          status: 'completed',
          items: [
            { id: 'agent-after-steer', type: 'agentMessage', text: '收到。继续 Task2。' },
            {
              id: 'item-user-existing',
              type: 'userMessage',
              content: [{
                type: 'text',
                text: '<codex_delegation>\n<input>TASK2_PLANNER_FINDING_2</input>\n</codex_delegation>',
              }],
            },
          ],
        }],
      },
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({ state: 'idle' })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-live-user-message-order`,
    )
    const payload = await response.json() as {
      conversationState?: { turns?: Array<{ items?: Array<Record<string, unknown>> }> }
    }
    const items = payload.conversationState?.turns?.[0]?.items ?? []

    expect(response.status).toBe(200)
    expect(items.map((item) => ({ id: item.id, type: item.type }))).toEqual([
      { id: 'session-user-event-turn-live-user-message-order-client-steer-order', type: 'userMessage' },
      { id: 'agent-after-steer', type: 'agentMessage' },
    ])
  })

  it('reorders wrapped late delegated user messages before their matching assistant output in live-state responses', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-wrapped-user-message-order-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const wrappedDelegation = [
      'TASK2_PLANNER_FINDING_2 (apply before Task2 final stop; no history rewrite):',
      '<codex_delegation>',
      '<input>收到。继续 Task2。</input>',
      '</codex_delegation>',
    ].join('\n')
    const rolloutPath = join(dir, 'thread-live-wrapped-user-message-order.jsonl')
    await writeFile(rolloutPath, [
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-live-wrapped-user-message-order' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          id: 'agent-after-steer',
          content: [{ type: 'output_text', text: '收到。继续 Task2。' }],
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'user_message',
          client_id: 'client-wrapped-steer-order',
          message: wrappedDelegation,
          images: [],
          local_images: [],
          text_elements: [],
        },
      }),
      '',
    ].join('\n'))

    const middleware = createCodexBridgeMiddleware()
    storePassiveThreadSnapshot('thread-live-wrapped-user-message-order', rolloutPath)
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.appServer, 'rpc').mockResolvedValue({
      thread: {
        id: 'thread-live-wrapped-user-message-order',
        path: rolloutPath,
        turns: [{
          id: 'turn-live-wrapped-user-message-order',
          status: 'completed',
          items: [
            { id: 'agent-after-steer', type: 'agentMessage', text: '收到。继续 Task2。' },
            {
              id: 'item-user-existing',
              type: 'userMessage',
              content: [{
                type: 'text',
                text: wrappedDelegation,
              }],
            },
          ],
        }],
      },
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({ state: 'idle' })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-live-wrapped-user-message-order`,
    )
    const payload = await response.json() as {
      conversationState?: { turns?: Array<{ items?: Array<Record<string, unknown>> }> }
    }
    const items = payload.conversationState?.turns?.[0]?.items ?? []

    expect(response.status).toBe(200)
    expect(items.map((item) => ({ id: item.id, type: item.type }))).toEqual([
      { id: 'session-user-event-turn-live-wrapped-user-message-order-client-wrapped-steer-order', type: 'userMessage' },
      { id: 'agent-after-steer', type: 'agentMessage' },
    ])
  })

  it('does not reorder ordinary late event-sourced user messages before existing live-state output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-late-user-message-order-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const lateUserInput = 'TASK2_PLANNER_FINDING_2 (apply before Task2 final stop; no history rewrite)'
    const rolloutPath = join(dir, 'thread-live-late-user-message-order.jsonl')
    await writeFile(rolloutPath, [
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-live-late-user-message-order' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          id: 'agent-after-steer',
          content: [{ type: 'output_text', text: '收到。继续 Task2。' }],
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'user_message',
          client_id: 'client-late-user-input',
          message: lateUserInput,
          images: [],
          local_images: [],
          text_elements: [],
        },
      }),
      '',
    ].join('\n'))

    const middleware = createCodexBridgeMiddleware()
    storePassiveThreadSnapshot('thread-live-late-user-message-order', rolloutPath)
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.appServer, 'rpc').mockResolvedValue({
      thread: {
        id: 'thread-live-late-user-message-order',
        path: rolloutPath,
        turns: [{
          id: 'turn-live-late-user-message-order',
          status: 'completed',
          items: [
            { id: 'agent-after-steer', type: 'agentMessage', text: '收到。继续 Task2。' },
            {
              id: 'item-user-existing',
              type: 'userMessage',
              content: [{ type: 'text', text: lateUserInput }],
            },
          ],
        }],
      },
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({ state: 'idle' })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-live-late-user-message-order`,
    )
    const payload = await response.json() as {
      conversationState?: { turns?: Array<{ items?: Array<Record<string, unknown>> }> }
    }
    const items = payload.conversationState?.turns?.[0]?.items ?? []

    expect(response.status).toBe(200)
    expect(items.map((item) => ({ id: item.id, type: item.type }))).toEqual([
      { id: 'agent-after-steer', type: 'agentMessage' },
      { id: 'session-user-event-turn-live-late-user-message-order-client-late-user-input', type: 'userMessage' },
    ])
  })

  it('keeps multiple late delegated user messages paired with their own live-state response segment', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-multi-user-message-order-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const firstDelegation = '<codex_delegation>\n<input>FIRST_STEER</input>\n</codex_delegation>'
    const secondDelegation = '<codex_delegation>\n<input>SECOND_STEER</input>\n</codex_delegation>'
    const rolloutPath = join(dir, 'thread-live-multi-user-message-order.jsonl')
    await writeFile(rolloutPath, [
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-live-multi-user-message-order' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          id: 'agent-first',
          content: [{ type: 'output_text', text: 'First response' }],
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'user_message',
          client_id: 'client-late-first',
          message: firstDelegation,
          images: [],
          local_images: [],
          text_elements: [],
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          id: 'agent-second',
          content: [{ type: 'output_text', text: 'Second response' }],
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'user_message',
          client_id: 'client-late-second',
          message: secondDelegation,
          images: [],
          local_images: [],
          text_elements: [],
        },
      }),
      '',
    ].join('\n'))

    const middleware = createCodexBridgeMiddleware()
    storePassiveThreadSnapshot('thread-live-multi-user-message-order', rolloutPath)
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.appServer, 'rpc').mockResolvedValue({
      thread: {
        id: 'thread-live-multi-user-message-order',
        path: rolloutPath,
        turns: [{
          id: 'turn-live-multi-user-message-order',
          status: 'completed',
          items: [
            { id: 'agent-first', type: 'agentMessage', text: 'First response' },
            {
              id: 'item-user-first-existing',
              type: 'userMessage',
              content: [{ type: 'text', text: firstDelegation }],
            },
            { id: 'agent-second', type: 'agentMessage', text: 'Second response' },
            {
              id: 'item-user-second-existing',
              type: 'userMessage',
              content: [{ type: 'text', text: secondDelegation }],
            },
          ],
        }],
      },
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({ state: 'idle' })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-live-multi-user-message-order`,
    )
    const payload = await response.json() as {
      conversationState?: { turns?: Array<{ items?: Array<Record<string, unknown>> }> }
    }
    const items = payload.conversationState?.turns?.[0]?.items ?? []

    expect(response.status).toBe(200)
    expect(items.map((item) => ({ id: item.id, type: item.type }))).toEqual([
      { id: 'session-user-event-turn-live-multi-user-message-order-client-late-first', type: 'userMessage' },
      { id: 'agent-first', type: 'agentMessage' },
      { id: 'session-user-event-turn-live-multi-user-message-order-client-late-second', type: 'userMessage' },
      { id: 'agent-second', type: 'agentMessage' },
    ])
  })

  it('recovers redacted parent coordination activity in live-state responses', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-live-state-collaboration-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-live-collaboration.jsonl')
    await writeFile(rolloutPath, [
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-live-collaboration' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'send_message',
          call_id: 'call-live-send',
          arguments: JSON.stringify({
            target: '/root/private-reviewer',
            message: 'live-state secret prompt',
          }),
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'wait_threads',
          call_id: 'call-live-wait',
          arguments: JSON.stringify({ targets: [{ threadId: 'private-child-thread' }] }),
        },
      }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant' } }),
      '',
    ].join('\n'))

    const middleware = createCodexBridgeMiddleware()
    storePassiveThreadSnapshot('thread-live-collaboration', rolloutPath)
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.appServer, 'rpc').mockResolvedValue({
      thread: {
        id: 'thread-live-collaboration',
        path: rolloutPath,
        turns: [{
          id: 'turn-live-collaboration',
          status: 'completed',
          items: [
            { id: 'agent-live-1', type: 'agentMessage', text: 'first' },
            { id: 'agent-live-2', type: 'agentMessage', text: 'second' },
          ],
        }],
      },
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({ state: 'idle' })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(
      `http://127.0.0.1:${port}/codex-api/thread-live-state?threadId=thread-live-collaboration`,
    )
    const payload = await response.json() as {
      conversationState?: { turns?: Array<{ items?: Array<Record<string, unknown>> }> }
    }
    const items = payload.conversationState?.turns?.[0]?.items ?? []
    const serialized = JSON.stringify(items)

    expect(response.status).toBe(200)
    expect(items).toEqual([
      {
        id: 'session-collab-call-live-send',
        type: 'collaborationActivity',
        activityKind: 'sendMessage',
        sourceCallId: 'call-live-send',
      },
      {
        id: 'session-collab-call-live-wait',
        type: 'collaborationActivity',
        activityKind: 'waitThreads',
        sourceCallId: 'call-live-wait',
      },
    ])
    expect(serialized).not.toContain('live-state secret prompt')
    expect(serialized).not.toContain('/root/private-reviewer')
    expect(serialized).not.toContain('private-child-thread')
  })

  it('recovers session command rows for normal thread/read RPC responses', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-rpc-session-command-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-rpc.jsonl')
    await writeFile(rolloutPath, [
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-rpc' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'call-rpc',
          arguments: JSON.stringify({ cmd: 'ls -lh' }),
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call-rpc',
          output: 'Process exited with code 0\nWall time: 0.001 seconds\nOutput:\ntotal 0\n',
        },
      }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant' } }),
      '',
    ].join('\n'))

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.appServer, 'rpc').mockResolvedValue({
      thread: {
        id: 'thread-rpc',
        path: rolloutPath,
        turns: [{
          id: 'turn-rpc',
          status: 'completed',
          items: [
            { id: 'user-1', type: 'userMessage', content: [] },
            { id: 'agent-1', type: 'agentMessage', text: 'first' },
            { id: 'native-file-change', type: 'fileChange', status: 'completed', changes: [] },
            { id: 'agent-2', type: 'agentMessage', text: 'second' },
          ],
        }],
      },
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({ state: 'idle' })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/read',
        params: { threadId: 'thread-rpc', includeTurns: true },
      }),
    })
    const payload = await response.json() as {
      result?: { thread?: { turns?: Array<{ items?: Array<{ id?: string; type?: string; command?: string }> }> } }
    }
    const items = payload.result?.thread?.turns?.[0]?.items ?? []

    expect(response.status).toBe(200)
    expect(items.map((item) => item.id)).toEqual([
      'user-1',
      'agent-1',
      'session-cmd-call-rpc',
      'native-file-change',
      'agent-2',
    ])
    expect(items[2]).toMatchObject({
      type: 'commandExecution',
      command: 'ls -lh',
    })
  })

  it('recovers a session command without output as in progress while the turn is still running', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-rpc-running-session-command-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-rpc-running.jsonl')
    await writeFile(rolloutPath, [
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-rpc-running' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'call-rpc-running',
          arguments: JSON.stringify({ cmd: 'sleep 300' }),
        },
      }),
      '',
    ].join('\n'))

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.appServer, 'rpc').mockResolvedValue({
      thread: {
        id: 'thread-rpc-running',
        path: rolloutPath,
        turns: [{
          id: 'turn-rpc-running',
          status: 'inProgress',
          items: [
            { id: 'user-1', type: 'userMessage', content: [] },
            { id: 'agent-1', type: 'agentMessage', text: 'checking' },
          ],
        }],
      },
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({ state: 'idle' })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/read',
        params: { threadId: 'thread-rpc-running', includeTurns: true },
      }),
    })
    const payload = await response.json() as {
      result?: { thread?: { turns?: Array<{ items?: Array<{ id?: string; status?: string; exitCode?: number | null }> }> } }
    }
    const command = payload.result?.thread?.turns?.[0]?.items?.find((item) => item.id === 'session-cmd-call-rpc-running')

    expect(response.status).toBe(200)
    expect(command).toMatchObject({
      status: 'inProgress',
      exitCode: null,
    })
  })

  it('recovers allowlisted parent coordination activity without leaking payloads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-rpc-collaboration-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-collaboration.jsonl')
    await writeFile(rolloutPath, [
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-collaboration' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'send_message',
          call_id: 'call-send',
          arguments: JSON.stringify({ target: '/root/reviewer', message: 'secret child prompt' }),
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'wait_agent',
          call_id: 'call-wait',
          arguments: JSON.stringify({ timeout_ms: 30_000 }),
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'list_agents',
          call_id: 'call-list',
          arguments: '{}',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'send_message_to_thread',
          call_id: 'call-send-thread',
          arguments: JSON.stringify({ threadId: 'thread-child', message: 'private thread message' }),
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'followup_task',
          call_id: 'call-followup',
          arguments: JSON.stringify({ target: '/root/reviewer', message: 'private follow-up' }),
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'wait_threads',
          call_id: 'call-wait-threads',
          arguments: JSON.stringify({ targets: [{ threadId: 'thread-child' }] }),
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'send_message',
          arguments: JSON.stringify({ message: 'missing call id' }),
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'untrusted_private_tool',
          call_id: 'call-private',
          arguments: JSON.stringify({ token: 'must-not-appear' }),
        },
      }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant' } }),
      '',
    ].join('\n'))

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.appServer, 'rpc').mockResolvedValue({
      thread: {
        id: 'thread-collaboration',
        path: rolloutPath,
        turns: [{
          id: 'turn-collaboration',
          status: 'completed',
          items: [
            { id: 'agent-1', type: 'agentMessage', text: 'first' },
            {
              id: 'call-send',
              type: 'subAgentActivity',
              agentThreadId: 'thread-reviewer',
              agentPath: '/root/reviewer',
              kind: 'interacted',
            },
            {
              id: 'call-spawn',
              type: 'subAgentActivity',
              agentThreadId: 'thread-started',
              agentPath: '/root/started',
              kind: 'started',
            },
            { id: 'agent-2', type: 'agentMessage', text: 'second' },
          ],
        }],
      },
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({ state: 'idle' })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/read',
        params: { threadId: 'thread-collaboration', includeTurns: true },
      }),
    })
    const payload = await response.json() as {
      result?: { thread?: { turns?: Array<{ items?: Array<Record<string, unknown>> }> } }
    }
    const items = payload.result?.thread?.turns?.[0]?.items ?? []
    const serialized = JSON.stringify(items)

    expect(items.map((item) => item.id)).toEqual([
      'agent-1',
      'session-collab-call-send',
      'session-collab-call-wait',
      'session-collab-call-list',
      'session-collab-call-send-thread',
      'session-collab-call-followup',
      'session-collab-call-wait-threads',
      'call-spawn',
      'agent-2',
    ])
    expect(items.slice(1, 7)).toEqual([
      {
        id: 'session-collab-call-send',
        type: 'collaborationActivity',
        activityKind: 'sendMessage',
        sourceCallId: 'call-send',
      },
      {
        id: 'session-collab-call-wait',
        type: 'collaborationActivity',
        activityKind: 'waitThreads',
        sourceCallId: 'call-wait',
      },
      {
        id: 'session-collab-call-list',
        type: 'collaborationActivity',
        activityKind: 'listAgents',
        sourceCallId: 'call-list',
      },
      {
        id: 'session-collab-call-send-thread',
        type: 'collaborationActivity',
        activityKind: 'sendMessage',
        sourceCallId: 'call-send-thread',
      },
      {
        id: 'session-collab-call-followup',
        type: 'collaborationActivity',
        activityKind: 'sendMessage',
        sourceCallId: 'call-followup',
      },
      {
        id: 'session-collab-call-wait-threads',
        type: 'collaborationActivity',
        activityKind: 'waitThreads',
        sourceCallId: 'call-wait-threads',
      },
    ])
    expect(serialized).not.toContain('secret child prompt')
    expect(serialized).not.toContain('private thread message')
    expect(serialized).not.toContain('private follow-up')
    expect(serialized).not.toContain('thread-child')
    expect(serialized).not.toContain('missing call id')
    expect(serialized).not.toContain('must-not-appear')
    expect(serialized).not.toContain('thread-reviewer')
  })

  it('caps recovered session command output in normal thread/read RPC responses', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mobile-rpc-session-command-large-output-'))
    disposers.push(() => {
      void rm(dir, { recursive: true, force: true })
    })
    const rolloutPath = join(dir, 'thread-rpc-large-output.jsonl')
    const longOutput = `first-line\n${'x'.repeat(70_000)}\nlast-line`
    await writeFile(rolloutPath, [
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-rpc-large-output' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'call-rpc-large-output',
          arguments: JSON.stringify({ cmd: 'journalctl --user -n 5000' }),
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call-rpc-large-output',
          output: `Process exited with code 0\nWall time: 0.001 seconds\nOutput:\n${longOutput}\n`,
        },
      }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant' } }),
      '',
    ].join('\n'))

    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest() as ReturnType<typeof sharedBridgeForTest> & {
      appServer: ReturnType<typeof sharedBridgeForTest>['appServer'] & {
        rpc: (method: string, params: unknown) => Promise<unknown>
      }
    }
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.appServer, 'rpc').mockResolvedValue({
      thread: {
        id: 'thread-rpc-large-output',
        path: rolloutPath,
        turns: [{
          id: 'turn-rpc-large-output',
          status: 'completed',
          items: [
            { id: 'user-1', type: 'userMessage', content: [] },
            { id: 'agent-1', type: 'agentMessage', text: 'done' },
          ],
        }],
      },
    })
    vi.spyOn(shared.runtimeProbe, 'inspect').mockResolvedValue({ state: 'idle' })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/read',
        params: { threadId: 'thread-rpc-large-output', includeTurns: true },
      }),
    })
    const payload = await response.json() as {
      result?: { thread?: { turns?: Array<{ items?: Array<{ id?: string; aggregatedOutput?: string }> }> } }
    }
    const command = payload.result?.thread?.turns?.[0]?.items?.find((item) => item.id === 'session-cmd-call-rpc-large-output')

    expect(response.status).toBe(200)
    expect(command?.aggregatedOutput?.length).toBeLessThan(20_000)
    expect(command?.aggregatedOutput).toContain('first-line')
    expect(command?.aggregatedOutput).toContain('last-line')
    expect(command?.aggregatedOutput).toContain('truncated')
  })
})

describe('POST /codex-api/thread-runtime-states', () => {
  it('reuses archive metadata across the before-and-after runtime checks', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-runtime-archive-cache-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const threadId = 'runtime-archive-cache'
    const stateDbPath = join(codexHome, 'state_5.sqlite')
    expect(spawnSync('sqlite3', [stateDbPath], {
      input: [
        'CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER);',
        `INSERT INTO threads VALUES ('${threadId}', 0);`,
      ].join(' '),
      encoding: 'utf8',
    }).status).toBe(0)
    const sqlitePath = spawnSync('which', ['sqlite3'], { encoding: 'utf8' }).stdout.trim()
    const shimDir = join(codexHome, 'sqlite-shim')
    const callLog = join(codexHome, 'sqlite-calls.log')
    await mkdir(shimDir)
    await writeFile(join(shimDir, 'sqlite3'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${callLog}'\nexec '${sqlitePath}' "$@"\n`)
    await chmod(join(shimDir, 'sqlite3'), 0o755)
    const originalSqliteCommand = process.env.CODEXUI_SQLITE_COMMAND
    process.env.CODEXUI_SQLITE_COMMAND = join(shimDir, 'sqlite3')
    disposers.push(() => {
      if (originalSqliteCommand === undefined) delete process.env.CODEXUI_SQLITE_COMMAND
      else process.env.CODEXUI_SQLITE_COMMAND = originalSqliteCommand
    })
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.runtimeProbe, 'inspectMany').mockResolvedValue({ [threadId]: { state: 'idle' } })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-runtime-states`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadIds: [threadId] }),
    })

    expect(response.status).toBe(200)
    const archiveQueries = (await readFile(callLog, 'utf8')).split(/\r?\n/u).filter((line) => (
      line.trim().length > 0 && !line.includes('--version')
    ))
    expect(archiveQueries).toHaveLength(1)
  })

  it('does not let a stale archive index hide a thread after its archive file is removed', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-runtime-unarchived-fresh-'))
    process.env.CODEX_HOME = codexHome
    disposers.push(() => rm(codexHome, { recursive: true, force: true }))
    const threadId = 'runtime-unarchived-after-cache'
    const archivedFile = join(codexHome, 'archived_sessions', 'nested', 'archived.jsonl')
    await mkdir(join(codexHome, 'archived_sessions', 'nested'), { recursive: true })
    await writeFile(archivedFile, `${JSON.stringify({
      type: 'session_meta', payload: { id: threadId },
    })}\n`)
    expect(spawnSync('sqlite3', [join(codexHome, 'state_5.sqlite'), [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER);',
      `INSERT INTO threads VALUES ('${threadId}', 0);`,
    ].join(' ')], { encoding: 'utf8' }).status).toBe(0)
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.runtimeProbe, 'inspectMany').mockResolvedValue({ [threadId]: { state: 'idle' } })
    const port = await listenWithMiddleware(middleware)
    const request = () => fetch(`http://127.0.0.1:${port}/codex-api/thread-runtime-states`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadIds: [threadId] }),
    })

    const archivedResponse = await request()
    await expect(archivedResponse.json()).resolves.toEqual({ states: { [threadId]: { state: 'archived' } } })
    await rm(archivedFile)

    const activeResponse = await request()
    await expect(activeResponse.json()).resolves.toEqual({ states: { [threadId]: { state: 'idle' } } })
  })

  it('prefers a currently running local app-server turn over external idle', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.runtimeProbe, 'inspectMany').mockResolvedValue({
      'thread-local': { state: 'idle' },
    })
    shared.localRuntimeLedger.record({
      method: 'turn/started',
      params: { threadId: 'thread-local', turn: { id: 'turn-local' } },
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-runtime-states`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadIds: ['thread-local'] }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      states: {
        'thread-local': {
          state: 'running',
          turnId: 'turn-local',
          interruptible: true,
          source: 'local-app-server',
        },
      },
    })
  })

  it('reads local authority after the external scan settles', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    let resolveInspection!: (value: Record<string, ExternalThreadRuntime>) => void
    const inspectMany = vi.spyOn(shared.runtimeProbe, 'inspectMany').mockImplementation(
      () => new Promise((resolve) => {
        resolveInspection = resolve
      }),
    )
    const port = await listenWithMiddleware(middleware)

    const responsePromise = fetch(`http://127.0.0.1:${port}/codex-api/thread-runtime-states`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadIds: ['thread-local'] }),
    })
    await vi.waitFor(() => expect(inspectMany).toHaveBeenCalledTimes(1))
    shared.localRuntimeLedger.record({
      method: 'turn/started',
      params: { threadId: 'thread-local', turn: { id: 'turn-during-scan' } },
    })
    resolveInspection({ 'thread-local': { state: 'idle' } })

    const response = await responsePromise
    await expect(response.json()).resolves.toEqual({
      states: {
        'thread-local': {
          state: 'running',
          turnId: 'turn-during-scan',
          interruptible: true,
          source: 'local-app-server',
        },
      },
    })
  })

  it('returns external idle after the matching local turn completes', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    vi.spyOn(shared.runtimeProbe, 'inspectMany').mockResolvedValue({
      'thread-local': { state: 'idle' },
    })
    shared.localRuntimeLedger.record({
      method: 'turn/started',
      params: { threadId: 'thread-local', turn: { id: 'turn-local' } },
    })
    shared.localRuntimeLedger.record({
      method: 'turn/completed',
      params: { threadId: 'thread-local', turn: { id: 'turn-local' } },
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-runtime-states`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadIds: ['thread-local'] }),
    })

    await expect(response.json()).resolves.toEqual({
      states: { 'thread-local': { state: 'idle' } },
    })
  })

  it('returns runtime states for a validated batch and excludes the mobile child PID', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const inspectMany = vi.spyOn(shared.runtimeProbe, 'inspectMany').mockResolvedValue({
      'thread-a': {
        state: 'running',
        turnId: 'turn-a',
        interruptible: false,
        source: 'external-session-writer',
      },
      'thread-b': { state: 'idle' },
    })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-runtime-states`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadIds: ['thread-a', 'thread-b'] }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      states: {
        'thread-a': {
          state: 'running',
          turnId: 'turn-a',
          interruptible: false,
          source: 'external-session-writer',
        },
        'thread-b': { state: 'idle' },
      },
    })
    expect(inspectMany).toHaveBeenCalledTimes(1)
    expect(inspectMany).toHaveBeenCalledWith(['thread-a', 'thread-b'], 4242)
  })

  it('rejects malformed JSON without inspecting runtimes', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    const inspectMany = vi.spyOn(shared.runtimeProbe, 'inspectMany')
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-runtime-states`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"threadIds":',
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Invalid JSON body' })
    expect(inspectMany).not.toHaveBeenCalled()
  })

  it.each([
    ['null body', null],
    ['missing threadIds', {}],
    ['empty threadIds', { threadIds: [] }],
    ['more than 50 threadIds', { threadIds: Array.from({ length: 51 }, (_, index) => `thread-${index}`) }],
    ['duplicate threadIds', { threadIds: ['thread-a', 'thread-a'] }],
    ['empty threadId', { threadIds: [''] }],
    ['whitespace threadId', { threadIds: [' thread-a'] }],
    ['non-string threadId', { threadIds: [123] }],
    ['extra body property', { threadIds: ['thread-a'], extra: true }],
  ])('rejects %s without inspecting runtimes', async (_label, payload) => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    const inspectMany = vi.spyOn(shared.runtimeProbe, 'inspectMany')
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-runtime-states`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    expect(response.status).toBe(400)
    expect(inspectMany).not.toHaveBeenCalled()
  })

  it('applies route security policy before invoking the batch runtime handler', async () => {
    const isRouteDisabled = vi.fn(() => true)
    const middleware = createCodexBridgeMiddleware({
      securityPolicy: { ...PERMISSIVE_SECURITY_POLICY, isRouteDisabled, backgroundIntegrationsEnabled: false },
    })
    const shared = sharedBridgeForTest()
    const inspectMany = vi.spyOn(shared.runtimeProbe, 'inspectMany')
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-runtime-states`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadIds: ['thread-a'] }),
    })

    expect(response.status).toBe(403)
    expect(isRouteDisabled).toHaveBeenCalledWith('POST', '/codex-api/thread-runtime-states')
    expect(inspectMany).not.toHaveBeenCalled()
  })
})

describe('POST /codex-api/thread-runtime-interrupt', () => {
  it('interrupts an externally owned turn through the runtime probe', async () => {
    const middleware = createCodexBridgeMiddleware()
    const shared = sharedBridgeForTest()
    vi.spyOn(shared.appServer, 'getPid').mockReturnValue(4242)
    const interrupt = vi.spyOn(shared.runtimeProbe, 'interrupt').mockResolvedValue({ interrupted: true })
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-runtime-interrupt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId: 'thread-external', turnId: 'turn-external' }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(interrupt).toHaveBeenCalledWith('thread-external', 'turn-external', 4242)
  })

  it('does not invoke the runtime probe when the route is disabled', async () => {
    const isRouteDisabled = vi.fn((_method: string, pathname: string) => pathname === '/codex-api/thread-runtime-interrupt')
    const middleware = createCodexBridgeMiddleware({
      securityPolicy: { ...PERMISSIVE_SECURITY_POLICY, isRouteDisabled, backgroundIntegrationsEnabled: false },
    })
    const shared = sharedBridgeForTest()
    const interrupt = vi.spyOn(shared.runtimeProbe, 'interrupt')
    const port = await listenWithMiddleware(middleware)

    const response = await fetch(`http://127.0.0.1:${port}/codex-api/thread-runtime-interrupt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId: 'thread-external', turnId: 'turn-external' }),
    })

    expect(response.status).toBe(403)
    expect(interrupt).not.toHaveBeenCalled()
  })
})
