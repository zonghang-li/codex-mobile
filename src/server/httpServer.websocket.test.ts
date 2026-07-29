import { createServer as createHttpServer } from 'node:http'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { listenWithFallback } from '../cli/shared/launcher'
import { createServer as createApp } from './httpServer'

describe('HTTP server WebSocket lifecycle', () => {
  it('returns an idempotent disposer that terminates upgraded clients', async () => {
    const instance = createApp()
    const server = createHttpServer(instance.app)
    const disposeWebSockets = instance.attachWebSocket(server)
    const listening = await listenWithFallback(server, 0, '127.0.0.1')
    const client = new WebSocket(`ws://127.0.0.1:${String(listening.port)}/codex-api/ws`)

    try {
      await once(client, 'open')
      const clientClosed = once(client, 'close')
      expect(typeof disposeWebSockets).toBe('function')
      disposeWebSockets()
      disposeWebSockets()
      await clientClosed
    } finally {
      client.terminate()
      instance.dispose()
      await listening.close()
    }
  })
})
