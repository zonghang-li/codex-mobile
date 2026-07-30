import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installAppBuildSync } from './appBuildSync'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('app build sync', () => {
  it('reloads a running tab when the backend build id changes', async () => {
    const reload = vi.fn()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ buildId: 'build-a' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ buildId: 'build-b' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ buildId: 'build-c' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    const documentMock = {
      visibilityState: 'visible',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('document', documentMock)
    vi.stubGlobal('window', {
      setInterval,
      clearInterval,
      location: { reload },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })

    const dispose = installAppBuildSync({ currentBuildId: 'build-a', intervalMs: 1_000 })
    await vi.advanceTimersByTimeAsync(0)

    expect(reload).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1_000)

    expect(reload).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1_000)
    dispose()

    expect(reload).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledWith('/codex-api/app-version', {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    })
  })

  it('checks immediately when a hidden tab becomes visible', async () => {
    const reload = vi.fn()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ buildId: 'build-a' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ buildId: 'build-b' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    const documentMock = {
      visibilityState: 'hidden',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('document', documentMock)
    vi.stubGlobal('window', {
      setInterval,
      clearInterval,
      location: { reload },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })

    const dispose = installAppBuildSync({ currentBuildId: 'build-a', intervalMs: 1_000 })
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(0)

    documentMock.visibilityState = 'visible'
    const visibilityHandler = documentMock.addEventListener.mock.calls
      .find(([eventName]) => eventName === 'visibilitychange')?.[1] as (() => void) | undefined
    visibilityHandler?.()
    await vi.advanceTimersByTimeAsync(0)
    dispose()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(reload).not.toHaveBeenCalled()
  })

  it('reloads on the first visible check when a hidden old tab sees a newer backend build', async () => {
    const reload = vi.fn()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ buildId: 'build-b' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    const documentMock = {
      visibilityState: 'hidden',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('document', documentMock)
    vi.stubGlobal('window', {
      setInterval,
      clearInterval,
      location: { reload },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })

    const dispose = installAppBuildSync({ currentBuildId: 'build-a', intervalMs: 1_000 })
    await vi.advanceTimersByTimeAsync(0)

    documentMock.visibilityState = 'visible'
    const visibilityHandler = documentMock.addEventListener.mock.calls
      .find(([eventName]) => eventName === 'visibilitychange')?.[1] as (() => void) | undefined
    visibilityHandler?.()
    await vi.advanceTimersByTimeAsync(0)
    dispose()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
