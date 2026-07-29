import { createServer, get } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { listenWithFallback, type ListeningServer } from './launcher'

const servers: ListeningServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

describe('shared CLI launcher', () => {
  it('binds the requested host and reports the actual ephemeral port', async () => {
    const launched = await listenWithFallback(createServer((_req, res) => res.end('ok')), 0, '127.0.0.1')
    servers.push(launched)
    expect(launched.port).toBeGreaterThan(0)
    expect(launched.host).toBe('127.0.0.1')
  })

  it('closes an active HTTP response instead of waiting for the client', async () => {
    const launched = await listenWithFallback(
      createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('event: ready\n\n')
      }),
      0,
      '127.0.0.1',
    )
    servers.push(launched)

    const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const request = get(`http://127.0.0.1:${String(launched.port)}/events`, resolve)
      request.once('error', reject)
    })
    response.once('error', () => {})
    const clientClosed = new Promise<void>((resolve) => response.once('close', resolve))

    const result = await Promise.race([
      launched.close().then(() => 'closed'),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 500)),
    ])

    expect(result).toBe('closed')
    await clientClosed
  })
})
