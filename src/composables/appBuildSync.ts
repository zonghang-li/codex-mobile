const DEFAULT_BUILD_SYNC_INTERVAL_MS = 5_000

type AppBuildVersionPayload = {
  buildId?: unknown
}

export function installAppBuildSync(options: {
  currentBuildId?: string
  intervalMs?: number
  endpoint?: string
} = {}): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {}

  const endpoint = options.endpoint ?? '/codex-api/app-version'
  const intervalMs = Math.max(1_000, options.intervalMs ?? DEFAULT_BUILD_SYNC_INTERVAL_MS)
  let disposed = false
  let checking = false
  let reloading = false
  let knownBuildId = (options.currentBuildId ?? import.meta.env.VITE_APP_BUILD_ID ?? '').trim()
  let timer: number | null = null

  const check = async (): Promise<void> => {
    if (disposed || checking || reloading) return
    if (document.visibilityState !== 'visible') return
    checking = true
    try {
      const response = await fetch(endpoint, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      })
      if (!response.ok) return
      const payload = await response.json() as AppBuildVersionPayload
      const buildId = typeof payload.buildId === 'string' ? payload.buildId.trim() : ''
      if (!buildId) return
      if (!knownBuildId) {
        knownBuildId = buildId
        return
      }
      if (buildId !== knownBuildId) {
        reloading = true
        window.location.reload()
      }
    } catch {
      // Version probing must never interfere with active thread sync.
    } finally {
      checking = false
    }
  }

  const handleVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') {
      void check()
    }
  }

  document.addEventListener('visibilitychange', handleVisibilityChange)
  timer = window.setInterval(() => {
    void check()
  }, intervalMs)
  void check()

  return () => {
    disposed = true
    document.removeEventListener('visibilitychange', handleVisibilityChange)
    if (timer !== null) {
      window.clearInterval(timer)
      timer = null
    }
  }
}
