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

    const lifecycle = httpServer.createNtfyNotifierLifecycle!({
      bridge: { subscribeNotifications, readThreadForNotifier: vi.fn() },
      config: undefined,
      createStateStore,
      createNotifier,
      warn: vi.fn(),
    })

    expect(createStateStore).not.toHaveBeenCalled()
    expect(createNotifier).not.toHaveBeenCalled()
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
      subscribeNotifications: vi.fn((next: typeof listener) => {
        listener = next
        return unsubscribe
      }),
    }
    const stateStore = { load: vi.fn(), save: vi.fn() }
    const createStateStore = vi.fn(() => stateStore)
    const notifier = { start: vi.fn(async () => {}), handle: vi.fn(), dispose: vi.fn(async () => {}) }
    const createNotifier = vi.fn(() => notifier)

    const lifecycle = httpServer.createNtfyNotifierLifecycle!({
      bridge,
      config: { publishUrl: 'https://ntfy.sh/test-topic', statePath: '/tmp/ntfy-state.json' },
      createStateStore,
      createNotifier,
      warn: vi.fn(),
    })
    await vi.waitFor(() => expect(notifier.start).toHaveBeenCalledTimes(1))
    listener?.({ method: 'turn/started', params: {} })
    expect(notifier.handle).toHaveBeenCalledTimes(1)

    lifecycle.dispose()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
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
