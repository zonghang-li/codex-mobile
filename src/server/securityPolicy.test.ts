import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { buildSafeSecurityPolicy, PERMISSIVE_SECURITY_POLICY } from './securityPolicy'
import { loadSafeRuntimeConfig } from '../safe/runtimePolicy'

describe('server security policy', () => {
  it('preserves upstream behavior with the permissive default', async () => {
    expect(PERMISSIVE_SECURITY_POLICY.isRouteDisabled('POST', '/codex-api/composio/connect')).toBe(false)
    expect(PERMISSIVE_SECURITY_POLICY.isRpcMethodAllowed('command/exec')).toBe(true)
    expect(PERMISSIVE_SECURITY_POLICY.terminalInputEnabled).toBe(true)
    expect(PERMISSIVE_SECURITY_POLICY.fileEditingEnabled).toBe(true)
    expect(PERMISSIVE_SECURITY_POLICY.backgroundIntegrationsEnabled).toBe(true)
    await expect(PERMISSIVE_SECURITY_POLICY.resolveLocalPath('/tmp/example')).resolves.toBe('/tmp/example')
  })

  it('maps safe runtime configuration to restrictive request behavior', async () => {
    const policy = buildSafeSecurityPolicy(loadSafeRuntimeConfig({}))
    expect(policy.isRouteDisabled('POST', '/codex-api/composio/connect')).toBe(true)
    expect(policy.isRpcMethodAllowed('thread/resume')).toBe(true)
    expect(policy.isRpcMethodAllowed('command/exec')).toBe(false)
    expect(policy.terminalInputEnabled).toBe(false)
    expect(policy.fileEditingEnabled).toBe(false)
    expect(policy.backgroundIntegrationsEnabled).toBe(false)
    await expect(policy.resolveLocalPath('/tmp/example')).resolves.toBeNull()
  })

  it('honors explicit safe raw-RPC and terminal/file switches without enabling disabled routes', () => {
    const policy = buildSafeSecurityPolicy(loadSafeRuntimeConfig({
      CODEX_MOBILE_SAFE_RAW_RPC: 'true',
      CODEX_MOBILE_SAFE_TERMINAL_INPUT: 'true',
      CODEX_MOBILE_SAFE_FILE_EDITING: 'true',
    }))
    expect(policy.isRpcMethodAllowed('command/exec')).toBe(true)
    expect(policy.terminalInputEnabled).toBe(true)
    expect(policy.fileEditingEnabled).toBe(true)
    expect(policy.isRouteDisabled('POST', '/codex-api/telegram/config')).toBe(true)
  })

  it('creates no notifier or notification subscription when configuration is absent', async () => {
    const httpServer = await import('./httpServer') as unknown as {
      createNtfyNotifierLifecycle?: (options: Record<string, unknown>) => { dispose: () => void }
    }
    expect(httpServer.createNtfyNotifierLifecycle).toBeTypeOf('function')
    const subscribeNotifications = vi.fn()
    const createStateStore = vi.fn()
    const createNotifier = vi.fn()
    const createExternalMonitor = vi.fn()

    const lifecycle = httpServer.createNtfyNotifierLifecycle!({
      bridge: {
        subscribeNotifications,
        readThreadForNotifier: vi.fn(),
        getAppServerPidForNotifier: vi.fn(),
        getSessionsRootForNotifier: vi.fn(),
      },
      config: undefined,
      createStateStore,
      createNotifier,
      createExternalMonitor,
      warn: vi.fn(),
    })

    expect(createStateStore).not.toHaveBeenCalled()
    expect(createNotifier).not.toHaveBeenCalled()
    expect(createExternalMonitor).not.toHaveBeenCalled()
    expect(subscribeNotifications).not.toHaveBeenCalled()
    lifecycle.dispose()
  })

  it('starts, subscribes, and disposes the notifier only for explicit configuration', async () => {
    const httpServer = await import('./httpServer') as unknown as {
      createNtfyNotifierLifecycle?: (options: Record<string, unknown>) => { dispose: () => void }
    }
    expect(httpServer.createNtfyNotifierLifecycle).toBeTypeOf('function')
    let listener: ((notification: { method: string; params: unknown }) => void) | undefined
    const unsubscribe = vi.fn()
    const bridge = {
      readThreadForNotifier: vi.fn(async () => ({ thread: { turns: [] } })),
      getAppServerPidForNotifier: vi.fn(() => 1234),
      getSessionsRootForNotifier: vi.fn(() => '/home/test/.codex/sessions'),
      subscribeNotifications: vi.fn((next: typeof listener) => {
        listener = next
        return unsubscribe
      }),
    }
    const stateStore = { load: vi.fn(), save: vi.fn() }
    const createStateStore = vi.fn(() => stateStore)
    const notifier = {
      start: vi.fn(async () => {}),
      handle: vi.fn(),
      handleObserved: vi.fn(),
      dispose: vi.fn(async () => {}),
    }
    const createNotifier = vi.fn(() => notifier)
    let onLifecycle: ((event: unknown) => void) | undefined
    let finishMonitorDispose: (() => void) | undefined
    const monitor = {
      start: vi.fn(async () => {}),
      dispose: vi.fn(() => new Promise<void>((resolve) => {
        finishMonitorDispose = resolve
      })),
    }
    const createExternalMonitor = vi.fn((monitorOptions: { onLifecycle: (event: unknown) => void }) => {
      onLifecycle = monitorOptions.onLifecycle
      return monitor
    })

    const lifecycle = httpServer.createNtfyNotifierLifecycle!({
      bridge,
      config: { publishUrl: 'https://ntfy.sh/test-topic', statePath: '/tmp/ntfy-state.json' },
      createStateStore,
      createNotifier,
      createExternalMonitor,
      warn: vi.fn(),
    })
    await vi.waitFor(() => expect(notifier.start).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(monitor.start).toHaveBeenCalledTimes(1))
    expect(createExternalMonitor).toHaveBeenCalledWith(expect.objectContaining({
      sessionsRoot: '/home/test/.codex/sessions',
      getExcludedPid: bridge.getAppServerPidForNotifier,
    }))
    listener?.({ method: 'turn/started', params: {} })
    expect(notifier.handle).toHaveBeenCalledTimes(1)
    const observed = {
      method: 'turn/completed',
      threadId: 'thread-1',
      turnId: 'turn-1',
      status: 'completed',
      occurredAt: 600_000,
      durationMs: 600_000,
    }
    onLifecycle?.(observed)
    expect(notifier.handleObserved).toHaveBeenCalledWith(observed)

    lifecycle.dispose()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(monitor.dispose).toHaveBeenCalledTimes(1)
    expect(notifier.dispose).not.toHaveBeenCalled()
    finishMonitorDispose?.()
    await vi.waitFor(() => expect(notifier.dispose).toHaveBeenCalledTimes(1))
  })

  it('keeps notifier thread reads internal to the bridge with no HTTP route', async () => {
    const [bridgeSource, httpServerSource] = await Promise.all([
      readFile(new URL('./codexAppServerBridge.ts', import.meta.url), 'utf8'),
      readFile(new URL('./httpServer.ts', import.meta.url), 'utf8'),
    ])
    expect(bridgeSource).toContain('readThreadForNotifier')
    expect(bridgeSource).toContain("appServer.rpc('thread/read', { threadId, includeTurns: true })")
    expect(bridgeSource).not.toContain('/codex-api/ntfy')
    expect(httpServerSource).toContain('createNtfyNotifierLifecycle')
  })
})
