import { createServer } from 'node:http'
import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterEach, describe, expect, it } from 'vitest'
import { createAuthMiddleware } from './authMiddleware'

const closers: Array<() => Promise<void>> = []

async function listen(app: express.Express): Promise<string> {
  const server = createServer(app)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  closers.push(() => new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  }))
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

async function requestWithHost(
  baseUrl: string,
  path: string,
  options: { method?: string } = {},
): Promise<{ status: number; contentType: string; body: string }> {
  const url = new URL(path, baseUrl)
  return await new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: options.method ?? 'GET',
      headers: { Host: 'l008105.tailbffdfe.ts.net' },
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          contentType: String(res.headers['content-type'] ?? ''),
          body,
        })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

afterEach(async () => {
  while (closers.length > 0) {
    await closers.pop()?.()
  }
})

describe('createAuthMiddleware', () => {
  it('returns JSON 401 for unauthenticated API requests', async () => {
    const app = express()
    app.use(createAuthMiddleware('secret'))
    app.post('/codex-api/rpc', (_req, res) => {
      res.json({ ok: true })
    })
    const baseUrl = await listen(app)

    const response = await requestWithHost(baseUrl, '/codex-api/rpc', { method: 'POST' })

    expect(response.status).toBe(401)
    expect(response.contentType).toContain('application/json')
    expect(JSON.parse(response.body)).toEqual({ error: 'Authentication required' })
  })

  it('still serves the login page for unauthenticated document requests', async () => {
    const app = express()
    app.use(createAuthMiddleware('secret'))
    app.get('/', (_req, res) => {
      res.send('app')
    })
    const baseUrl = await listen(app)

    const response = await requestWithHost(baseUrl, '/')

    expect(response.status).toBe(200)
    expect(response.contentType).toContain('text/html')
    expect(response.body).toContain('<form id="f">')
  })
})
