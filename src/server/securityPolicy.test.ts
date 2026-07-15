import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { buildSafeSecurityPolicy, PERMISSIVE_SECURITY_POLICY } from './securityPolicy'
import { loadSafeRuntimeConfig } from '../safe/runtimePolicy'
import { createEmptyNtfyState, type NtfyNotifierState } from '../safe/ntfyState'
import { NtfyCompletionNotifier } from './ntfyCompletionNotifier'

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
    const acknowledgement = Promise.resolve()
    const notifier = {
      start: vi.fn(async () => {}),
      handle: vi.fn(),
      handleObserved: vi.fn(() => acknowledgement),
      dispose: vi.fn(async () => {}),
    }
    const createNotifier = vi.fn(() => notifier)
    let onLifecycle: ((event: unknown) => void | Promise<void>) | undefined
    let finishMonitorDispose: (() => void) | undefined
    const monitor = {
      start: vi.fn(async () => {}),
      dispose: vi.fn(() => new Promise<void>((resolve) => {
        finishMonitorDispose = resolve
      })),
    }
    const createExternalMonitor = vi.fn((monitorOptions: {
      onLifecycle: (event: unknown) => void | Promise<void>
    }) => {
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
    expect(onLifecycle?.(observed)).toBe(acknowledgement)
    expect(notifier.handleObserved).toHaveBeenCalledWith(observed)

    lifecycle.dispose()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(monitor.dispose).toHaveBeenCalledTimes(1)
    expect(notifier.dispose).not.toHaveBeenCalled()
    finishMonitorDispose?.()
    await vi.waitFor(() => expect(notifier.dispose).toHaveBeenCalledTimes(1))
  })

  it('retains direct notifications while notifier startup is pending and delays only the monitor', async () => {
    const { createNtfyNotifierLifecycle } = await import('./httpServer')
    let finishStart: (() => void) | undefined
    let listener: ((notification: { method: string; params: unknown; atIso: string }) => void) | undefined
    const notifier = {
      start: vi.fn(() => new Promise<void>((resolve) => { finishStart = resolve })),
      handle: vi.fn(),
      handleObserved: vi.fn(),
      dispose: vi.fn(async () => {}),
    }
    const monitor = { start: vi.fn(async () => {}), dispose: vi.fn(async () => {}) }
    const createExternalMonitor = vi.fn(() => monitor)
    const unsubscribe = vi.fn()

    const lifecycle = createNtfyNotifierLifecycle({
      bridge: {
        readThreadForNotifier: vi.fn(),
        getAppServerPidForNotifier: vi.fn(() => 1234),
        getSessionsRootForNotifier: vi.fn(() => '/home/test/.codex/sessions'),
        subscribeNotifications: vi.fn((next) => {
          listener = next
          return unsubscribe
        }),
      },
      config: { publishUrl: 'https://ntfy.sh/test-topic', statePath: '/tmp/ntfy-state.json' },
      createStateStore: vi.fn(() => ({ load: vi.fn(), save: vi.fn() }) as never),
      createNotifier: vi.fn(() => notifier),
      createExternalMonitor,
      warn: vi.fn(),
    })

    expect(createExternalMonitor).not.toHaveBeenCalled()
    const notification = { method: 'turn/started', params: {}, atIso: '2026-07-15T00:00:00.000Z' }
    listener?.(notification)
    expect(notifier.handle).toHaveBeenCalledWith(notification)

    finishStart?.()
    await vi.waitFor(() => expect(monitor.start).toHaveBeenCalledTimes(1))
    lifecycle.dispose()
    await vi.waitFor(() => expect(notifier.dispose).toHaveBeenCalledTimes(1))
  })

  it('retries one failed durable external completion through the real notifier wiring', async () => {
    const { createNtfyNotifierLifecycle } = await import('./httpServer')
    let state = createEmptyNtfyState()
    let failPendingSave = true
    const save = vi.fn(async (nextState: NtfyNotifierState) => {
      if (nextState.pending.length > 0 && failPendingSave) {
        failPendingSave = false
        throw new Error('temporary state failure')
      }
      state = structuredClone(nextState)
    })
    const send = vi.fn(async () => {})
    let completionAttempts = 0

    const lifecycle = createNtfyNotifierLifecycle({
      bridge: {
        readThreadForNotifier: vi.fn(async () => ({
          thread: {
            parentThreadId: null,
            source: 'appServer',
            turns: [{ id: 'turn-1', items: [{ type: 'agentMessage', text: '完成。' }] }],
          },
        })),
        getAppServerPidForNotifier: vi.fn(() => 1234),
        getSessionsRootForNotifier: vi.fn(() => '/home/test/.codex/sessions'),
        subscribeNotifications: vi.fn(() => vi.fn()),
      },
      config: { publishUrl: 'https://ntfy.sh/test-topic', statePath: '/tmp/ntfy-state.json' },
      createStateStore: vi.fn(() => ({
        load: async () => structuredClone(state),
        save,
      }) as never),
      createNotifier: vi.fn((options) => new NtfyCompletionNotifier({ ...options, send })),
      createExternalMonitor: vi.fn((options) => ({
        async start() {
          await options.onLifecycle({
            method: 'turn/started',
            threadId: 'thread-1',
            turnId: 'turn-1',
            status: 'inProgress',
            occurredAt: 1_000,
          })
          for (let attempt = 0; attempt < 2; attempt += 1) {
            completionAttempts += 1
            try {
              await options.onLifecycle({
                method: 'turn/completed',
                threadId: 'thread-1',
                turnId: 'turn-1',
                status: 'completed',
                occurredAt: 601_000,
                durationMs: 600_000,
              })
              break
            } catch {
              // The monitor retains its cursor and retries this exact lifecycle record.
            }
          }
        },
        async dispose() {},
      })),
      warn: vi.fn(),
    })

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(completionAttempts).toBe(2)
    expect(state.active).toEqual([])
    expect(state.sent.map(({ key }) => key)).toEqual(['thread-1:turn-1'])
    expect(save.mock.calls.filter(([saved]) => saved.active.length === 1)).toHaveLength(1)

    lifecycle.dispose()
  })

  it('keeps direct subscription cleanup safe when notifier startup rejects', async () => {
    const { createNtfyNotifierLifecycle } = await import('./httpServer')
    const warn = vi.fn()
    const unsubscribe = vi.fn()
    const notifier = {
      start: vi.fn(async () => { throw new Error('secret startup detail') }),
      handle: vi.fn(),
      handleObserved: vi.fn(),
      dispose: vi.fn(async () => {}),
    }
    const createExternalMonitor = vi.fn()
    const subscribeNotifications = vi.fn(() => unsubscribe)

    const lifecycle = createNtfyNotifierLifecycle({
      bridge: {
        readThreadForNotifier: vi.fn(),
        getAppServerPidForNotifier: vi.fn(),
        getSessionsRootForNotifier: vi.fn(),
        subscribeNotifications,
      },
      config: { publishUrl: 'https://ntfy.sh/test-topic', statePath: '/tmp/ntfy-state.json' },
      createStateStore: vi.fn(() => ({ load: vi.fn(), save: vi.fn() }) as never),
      createNotifier: vi.fn(() => notifier),
      createExternalMonitor,
      warn,
    })

    expect(subscribeNotifications).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('Unable to start long-task notifications'))
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('secret'))
    expect(createExternalMonitor).not.toHaveBeenCalled()

    lifecycle.dispose()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(notifier.dispose).toHaveBeenCalledTimes(1))
  })

  it('unsubscribes immediately and leaves no monitor when disposed during notifier startup', async () => {
    const { createNtfyNotifierLifecycle } = await import('./httpServer')
    let finishStart: (() => void) | undefined
    const unsubscribe = vi.fn()
    const notifier = {
      start: vi.fn(() => new Promise<void>((resolve) => { finishStart = resolve })),
      handle: vi.fn(),
      handleObserved: vi.fn(),
      dispose: vi.fn(async () => {}),
    }
    const createExternalMonitor = vi.fn()

    const lifecycle = createNtfyNotifierLifecycle({
      bridge: {
        readThreadForNotifier: vi.fn(),
        getAppServerPidForNotifier: vi.fn(),
        getSessionsRootForNotifier: vi.fn(),
        subscribeNotifications: vi.fn(() => unsubscribe),
      },
      config: { publishUrl: 'https://ntfy.sh/test-topic', statePath: '/tmp/ntfy-state.json' },
      createStateStore: vi.fn(() => ({ load: vi.fn(), save: vi.fn() }) as never),
      createNotifier: vi.fn(() => notifier),
      createExternalMonitor,
      warn: vi.fn(),
    })

    lifecycle.dispose()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(notifier.dispose).not.toHaveBeenCalled()
    finishStart?.()
    await vi.waitFor(() => expect(notifier.dispose).toHaveBeenCalledTimes(1))
    expect(createExternalMonitor).not.toHaveBeenCalled()
  })

  it('redacts monitor startup rejection and still disposes monitor before notifier', async () => {
    const { createNtfyNotifierLifecycle } = await import('./httpServer')
    let finishMonitorDispose: (() => void) | undefined
    const warn = vi.fn()
    const notifier = {
      start: vi.fn(async () => {}),
      handle: vi.fn(),
      handleObserved: vi.fn(),
      dispose: vi.fn(async () => {}),
    }
    const monitor = {
      start: vi.fn(async () => { throw new Error('secret monitor detail') }),
      dispose: vi.fn(() => new Promise<void>((resolve) => { finishMonitorDispose = resolve })),
    }

    const lifecycle = createNtfyNotifierLifecycle({
      bridge: {
        readThreadForNotifier: vi.fn(),
        getAppServerPidForNotifier: vi.fn(() => 1234),
        getSessionsRootForNotifier: vi.fn(() => '/home/test/.codex/sessions'),
        subscribeNotifications: vi.fn(() => vi.fn()),
      },
      config: { publishUrl: 'https://ntfy.sh/test-topic', statePath: '/tmp/ntfy-state.json' },
      createStateStore: vi.fn(() => ({ load: vi.fn(), save: vi.fn() }) as never),
      createNotifier: vi.fn(() => notifier),
      createExternalMonitor: vi.fn(() => monitor),
      warn,
    })

    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('Unable to start external turn monitoring'))
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('secret'))
    lifecycle.dispose()
    expect(monitor.dispose).toHaveBeenCalledTimes(1)
    expect(notifier.dispose).not.toHaveBeenCalled()
    finishMonitorDispose?.()
    await vi.waitFor(() => expect(notifier.dispose).toHaveBeenCalledTimes(1))
  })

  it.each(['sessions getter', 'monitor factory'] as const)(
    'keeps direct notifications active when the external %s throws synchronously',
    async (failurePoint) => {
      const { createNtfyNotifierLifecycle } = await import('./httpServer')
      let listener: ((notification: { method: string; params: unknown; atIso: string }) => void) | undefined
      const warn = vi.fn()
      const unsubscribe = vi.fn()
      const notifier = {
        start: vi.fn(async () => {}),
        handle: vi.fn(),
        handleObserved: vi.fn(),
        dispose: vi.fn(async () => {}),
      }
      const createExternalMonitor = vi.fn(() => {
        if (failurePoint === 'monitor factory') throw new Error('secret factory detail')
        return { start: vi.fn(async () => {}), dispose: vi.fn(async () => {}) }
      })

      const lifecycle = createNtfyNotifierLifecycle({
        bridge: {
          readThreadForNotifier: vi.fn(),
          getAppServerPidForNotifier: vi.fn(),
          getSessionsRootForNotifier: vi.fn(() => {
            if (failurePoint === 'sessions getter') throw new Error('secret getter detail')
            return '/home/test/.codex/sessions'
          }),
          subscribeNotifications: vi.fn((next) => {
            listener = next
            return unsubscribe
          }),
        },
        config: { publishUrl: 'https://ntfy.sh/test-topic', statePath: '/tmp/ntfy-state.json' },
        createStateStore: vi.fn(() => ({ load: vi.fn(), save: vi.fn() }) as never),
        createNotifier: vi.fn(() => notifier),
        createExternalMonitor,
        warn,
      })

      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('Unable to start external turn monitoring'))
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('secret'))
      const notification = { method: 'turn/started', params: {}, atIso: '2026-07-15T00:00:00.000Z' }
      listener?.(notification)
      expect(notifier.handle).toHaveBeenCalledWith(notification)
      lifecycle.dispose()
      expect(unsubscribe).toHaveBeenCalledTimes(1)
      await vi.waitFor(() => expect(notifier.dispose).toHaveBeenCalledTimes(1))
    },
  )

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
