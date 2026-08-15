import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFile, writeFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { createCodexBridgeMiddleware } from './codexAppServerBridge'

const action = process.env.CODEX_MOBILE_CURSOR_PROCESS_ACTION ?? ''
const cursorPath = process.env.CODEX_MOBILE_CURSOR_PROCESS_FILE ?? ''
const snapshotBacked = process.env.CODEX_MOBILE_CURSOR_PROCESS_SNAPSHOT === '1'

describe.skipIf(!action || !cursorPath)('thread list cursor process worker', () => {
  it('generates or consumes a cursor in an isolated process', async () => {
    const middleware = createCodexBridgeMiddleware()
    const snapshotRows = Array.from({ length: 120 }, (_, index) => ({
      id: `snapshot-process-${String(index).padStart(3, '0')}`,
      updatedAt: 1_000 - index,
    }))
    if (snapshotBacked) {
      const shared = (globalThis as typeof globalThis & {
        __codexRemoteSharedBridge__: { appServer: { rpc(method: string, params: unknown): Promise<unknown> } }
      }).__codexRemoteSharedBridge__
      vi.spyOn(shared.appServer, 'rpc').mockImplementation(async (method, params) => {
        if (method !== 'thread/list') return {}
        const cursor = (params as { cursor?: string | null }).cursor
        const offset = cursor ? Number.parseInt(cursor.replace('native-', ''), 10) : 0
        const data = snapshotRows.slice(offset, offset + 40)
        const nextOffset = offset + data.length
        return { data, nextCursor: nextOffset < snapshotRows.length ? `native-${nextOffset}` : null }
      })
    }
    const server = createServer((req, res) => {
      void middleware(req, res, () => {
        res.statusCode = 404
        res.end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const cursor = action === 'consume' ? await readFile(cursorPath, 'utf8') : null
      const response = await fetch(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}/codex-api/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'thread/list',
          params: {
            archived: false,
            limit: snapshotBacked ? 40 : 2,
            sortKey: 'updated_at',
            modelProviders: [],
            cursor,
          },
        }),
      })
      const payload = await response.json() as {
        result?: { data?: Array<{ id?: string }>; nextCursor?: string | null }
      }
      expect(response.status).toBe(200)
      if (action === 'generate') {
        expect(payload.result?.data?.map((row) => row.id)).toEqual(snapshotBacked
          ? snapshotRows.slice(0, 40).map((row) => row.id)
          : ['restart-3', 'restart-2'])
        expect(payload.result?.nextCursor).toEqual(expect.any(String))
        await writeFile(cursorPath, payload.result?.nextCursor ?? '', 'utf8')
      } else {
        expect(payload.result?.data?.map((row) => row.id)).toEqual(snapshotBacked
          ? snapshotRows.slice(40, 80).map((row) => row.id)
          : ['restart-1'])
        if (snapshotBacked) expect(payload.result?.nextCursor).toEqual(expect.any(String))
      }
    } finally {
      middleware.dispose()
      await new Promise<void>((resolve) => (server as Server).close(() => resolve()))
    }
  })
})
