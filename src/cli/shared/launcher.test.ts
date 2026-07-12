import { createServer } from 'node:http'
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
})
