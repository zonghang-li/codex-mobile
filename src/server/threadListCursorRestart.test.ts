import { spawnSync } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

type BridgeMiddleware = ((
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
) => Promise<void>) & { dispose(): void }

const cleanup: Array<() => void | Promise<void>> = []
const originalCodexHome = process.env.CODEX_HOME

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodexHome
  vi.restoreAllMocks()
})

async function listen(middleware: BridgeMiddleware): Promise<number> {
  const server = createServer((req, res) => {
    void middleware(req, res, () => {
      res.statusCode = 404
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => {
    middleware.dispose()
    await new Promise<void>((resolve) => (server as Server).close(() => resolve()))
  })
  return (server.address() as AddressInfo).port
}

async function requestPage(port: number, cursor: string | null, limit = 2): Promise<Response> {
  return await fetch(`http://127.0.0.1:${port}/codex-api/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      method: 'thread/list',
      params: { archived: false, limit, sortKey: 'updated_at', modelProviders: [], cursor },
    }),
  })
}

it('keeps an authenticated thread-list cursor usable after module process state is reset', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-list-cursor-restart-'))
  process.env.CODEX_HOME = codexHome
  cleanup.push(() => rm(codexHome, { recursive: true, force: true }))
  const stateDbPath = join(codexHome, 'state_5.sqlite')
  expect(spawnSync('sqlite3', [stateDbPath, [
    'CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, model_provider TEXT, cwd TEXT, title TEXT, cli_version TEXT, first_user_message TEXT, archived INTEGER);',
    "INSERT INTO threads VALUES ('restart-3', '/tmp/sessions/restart-3.jsonl', 1, 3, 'cli', 'openai', '/tmp/project', 'Restart 3', '', 'Restart 3', 0);",
    "INSERT INTO threads VALUES ('restart-2', '/tmp/sessions/restart-2.jsonl', 1, 2, 'cli', 'openai', '/tmp/project', 'Restart 2', '', 'Restart 2', 0);",
    "INSERT INTO threads VALUES ('restart-1', '/tmp/sessions/restart-1.jsonl', 1, 1, 'cli', 'openai', '/tmp/project', 'Restart 1', '', 'Restart 1', 0);",
  ].join(' ')], { encoding: 'utf8' }).status).toBe(0)

  const firstBridge = await import('./codexAppServerBridge')
  const firstMiddleware = firstBridge.createCodexBridgeMiddleware() as BridgeMiddleware
  const firstPort = await listen(firstMiddleware)
  const firstResponse = await requestPage(firstPort, null)
  const firstPayload = await firstResponse.json() as {
    error?: string
    result?: { data?: Array<{ id?: string }>; nextCursor?: string | null }
  }
  expect({ status: firstResponse.status, error: firstPayload.error }).toEqual({ status: 200, error: undefined })
  expect(firstPayload.result?.data?.map((row) => row.id)).toEqual(['restart-3', 'restart-2'])
  expect(firstPayload.result?.nextCursor).toEqual(expect.any(String))

  firstMiddleware.dispose()
  vi.resetModules()
  const restartedBridge = await import('./codexAppServerBridge')
  const restartedMiddleware = restartedBridge.createCodexBridgeMiddleware() as BridgeMiddleware
  const restartedPort = await listen(restartedMiddleware)
  const secondResponse = await requestPage(restartedPort, firstPayload.result?.nextCursor ?? null)
  const secondPayload = await secondResponse.json() as {
    result?: { data?: Array<{ id?: string }>; nextCursor?: string | null }
  }

  expect(secondResponse.status).toBe(200)
  expect(secondPayload.result?.data?.map((row) => row.id)).toEqual(['restart-1'])
  expect(secondPayload.result?.nextCursor ?? null).toBe(null)
}, 30_000)

it('keeps an authenticated thread-list cursor usable across independent processes', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-list-real-restart-'))
  cleanup.push(() => rm(codexHome, { recursive: true, force: true }))
  await writeFile(join(codexHome, 'session_index.jsonl'), [
    { id: 'restart-1', thread_name: 'Restart 1', updated_at: new Date(1_000).toISOString() },
    { id: 'restart-2', thread_name: 'Restart 2', updated_at: new Date(2_000).toISOString() },
    { id: 'restart-3', thread_name: 'Restart 3', updated_at: new Date(3_000).toISOString() },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
  const cursorPath = join(codexHome, 'cursor.txt')
  const workerArgs = [
    'vitest',
    'run',
    'src/server/threadListCursorProcessWorker.test.ts',
    '--maxWorkers=1',
  ]
  const runWorker = (action: 'generate' | 'consume') => spawnSync('pnpm', workerArgs, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      CODEX_MOBILE_CURSOR_PROCESS_ACTION: action,
      CODEX_MOBILE_CURSOR_PROCESS_FILE: cursorPath,
    },
    encoding: 'utf8',
    timeout: 30_000,
  })

  const generated = runWorker('generate')
  expect(generated.status, generated.stderr || generated.stdout).toBe(0)
  const consumed = runWorker('consume')
  expect(consumed.status, consumed.stderr || consumed.stdout).toBe(0)
}, 70_000)

it('keeps a snapshot-backed thread-list cursor usable across independent processes', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-thread-list-snapshot-restart-'))
  cleanup.push(() => rm(codexHome, { recursive: true, force: true }))
  const rows = Array.from({ length: 120 }, (_, index) => ({
    id: `snapshot-process-${String(index).padStart(3, '0')}`,
    updatedAt: 1_000 - index,
  }))
  const inserts = rows.map((row) => (
    `INSERT INTO threads VALUES ('${row.id}', '/tmp/sessions/${row.id}.jsonl', 1, ${row.updatedAt}, 'cli', 'openai', '/tmp/project', '${row.id}', '', '${row.id}', 0);`
  ))
  expect(spawnSync('sqlite3', [join(codexHome, 'state_5.sqlite'), [
    'CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, model_provider TEXT, cwd TEXT, title TEXT, cli_version TEXT, first_user_message TEXT, archived INTEGER);',
    ...inserts,
  ].join(' ')], { encoding: 'utf8' }).status).toBe(0)
  const cursorPath = join(codexHome, 'snapshot-cursor.txt')
  const workerArgs = [
    'vitest',
    'run',
    'src/server/threadListCursorProcessWorker.test.ts',
    '--maxWorkers=1',
  ]
  const runWorker = (action: 'generate' | 'consume') => spawnSync('pnpm', workerArgs, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      CODEX_MOBILE_CURSOR_PROCESS_ACTION: action,
      CODEX_MOBILE_CURSOR_PROCESS_FILE: cursorPath,
      CODEX_MOBILE_CURSOR_PROCESS_SNAPSHOT: '1',
    },
    encoding: 'utf8',
    timeout: 30_000,
  })

  const generated = runWorker('generate')
  expect(generated.status, generated.stderr || generated.stdout).toBe(0)
  expect(await readdir(join(codexHome, 'codex-mobile-cache', 'thread-list-cursor-state'))).toHaveLength(1)
  const consumed = runWorker('consume')
  expect(consumed.status, consumed.stderr || consumed.stdout).toBe(0)
  expect(await readdir(join(codexHome, 'codex-mobile-cache', 'thread-list-cursor-state'))).toHaveLength(1)
}, 70_000)
