import { createServer as createHttpServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { listenWithFallback } from '../cli/shared/launcher'
import { createServer as createApp, shouldBypassSpaFallbackForStaticAsset } from './httpServer'

describe('frontend static asset fallback', () => {
  it('marks the SPA entry as non-cacheable and exposes a build version endpoint', async () => {
    const httpServer = await import('./httpServer') as typeof import('./httpServer') & {
      FRONTEND_ENTRY_CACHE_CONTROL?: string
      getFrontendBuildIdForClient?: () => string
      readFrontendBuildIdFromMetadata?: (raw: string) => string
    }

    expect(httpServer.FRONTEND_ENTRY_CACHE_CONTROL).toBe('private, no-store, max-age=0')
    expect(httpServer.readFrontendBuildIdFromMetadata?.('{"buildId":"build-a"}')).toBe('build-a')
    expect(httpServer.readFrontendBuildIdFromMetadata?.('{"buildId":"  "}')).toBe('')
    expect(httpServer.readFrontendBuildIdFromMetadata?.('not json')).toBe('')
    expect(httpServer.getFrontendBuildIdForClient?.()).toEqual(expect.any(String))
    expect(httpServer.getFrontendBuildIdForClient?.()).not.toBe('')
  })

  it('serves the app build version without cache', async () => {
    const instance = createApp()
    const server = createHttpServer(instance.app)
    const listening = await listenWithFallback(server, 0, '127.0.0.1')

    try {
      const response = await fetch(`http://127.0.0.1:${String(listening.port)}/codex-api/app-version`)
      const payload = await response.json() as { buildId?: unknown }

      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0')
      expect(payload.buildId).toEqual(expect.any(String))
      expect(payload.buildId).not.toBe('')
    } finally {
      instance.dispose()
      await listening.close()
    }
  })

  it('does not precache the SPA document in the service worker app shell', async () => {
    const source = await readFile(new URL('../../public/sw.js', import.meta.url), 'utf8')

    expect(source).toContain("const APP_SHELL_PATHS = ['/manifest.webmanifest']")
    expect(source).not.toContain("['/', '/manifest.webmanifest']")
  })

  it('does not serve the SPA document for missing hashed frontend assets', () => {
    expect(shouldBypassSpaFallbackForStaticAsset('/assets/index-old.js')).toBe(true)
    expect(shouldBypassSpaFallbackForStaticAsset('/assets/ThreadConversation-old.css')).toBe(true)
    expect(shouldBypassSpaFallbackForStaticAsset('/icons/pwa-192x192.png')).toBe(true)
    expect(shouldBypassSpaFallbackForStaticAsset('/sw.js')).toBe(true)
    expect(shouldBypassSpaFallbackForStaticAsset('/manifest.webmanifest')).toBe(true)
  })

  it('continues to serve SPA fallback for application routes', () => {
    expect(shouldBypassSpaFallbackForStaticAsset('/')).toBe(false)
    expect(shouldBypassSpaFallbackForStaticAsset('/thread/abc123')).toBe(false)
    expect(shouldBypassSpaFallbackForStaticAsset('/projects/prima.cpp')).toBe(false)
  })
})
