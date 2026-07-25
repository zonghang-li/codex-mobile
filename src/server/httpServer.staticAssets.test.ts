import { describe, expect, it } from 'vitest'
import { shouldBypassSpaFallbackForStaticAsset } from './httpServer'

describe('frontend static asset fallback', () => {
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
