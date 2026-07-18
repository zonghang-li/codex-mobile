import { describe, expect, it } from 'vitest'
import { inspectSafeSources } from './doctor'

const VALID_BRIDGE_SOURCE = [
  'securityPolicy.isRouteDisabled',
  'securityPolicy.isRpcMethodAllowed',
  'securityPolicy.terminalInputEnabled',
  'readThreadForNotifier',
  'getAppServerPidForNotifier',
  'getSessionsRootForNotifier',
  "appServer.rpc('thread/read', { threadId, includeTurns: true })",
  'readMergedThreadTitleCache',
  'augmentThreadReadWithNotificationTitle',
  'notificationTitle',
].join(' ')

describe('safe doctor', () => {
  it('accepts required safe invariants', () => {
    const result = inspectSafeSources({
      runtimePolicy: "bindHost: '127.0.0.1'; approvalPolicy: 'on-request'; sandboxMode: 'workspace-write'",
      featureGate: 'isDisabledRoute isAllowedRpcMethod',
      bridge: VALID_BRIDGE_SOURCE,
      safeCli: "exposeTailscale(state.port); option('--password-file <path>', 'description'); option('--ntfy-url-file <path>', 'description'); loadNtfyPublishUrl({ explicitPath: options.ntfyUrlFile })",
      ntfyConfig: "url.origin !== 'https://ntfy.sh'; url.username; url.password; url.search; url.hash; !/^\\/[A-Za-z0-9_-]+$/u.test(url.pathname)",
      httpServer: 'options.ntfyNotifications createNtfyNotifierLifecycle bridge.subscribeNotifications NtfyCompletionNotifier createExternalTurnMonitor getSessionsRootForNotifier return notifier.handleObserved(event)',
      securityPolicy: 'backgroundIntegrationsEnabled: false',
    })
    expect(result).toEqual({ ok: true, failures: [] })
  })

  it('reports every missing invariant', () => {
    const result = inspectSafeSources({
      runtimePolicy: '',
      featureGate: '',
      bridge: '',
      safeCli: '',
      ntfyConfig: '',
      httpServer: '',
      securityPolicy: '',
    })
    expect(result.ok).toBe(false)
    expect(result.failures.length).toBeGreaterThan(9)
  })

  it('reports missing optional ntfy safety wiring without requiring runtime configuration', () => {
    const result = inspectSafeSources({
      runtimePolicy: "bindHost: '127.0.0.1'; approvalPolicy: 'on-request'; sandboxMode: 'workspace-write'",
      featureGate: 'isDisabledRoute isAllowedRpcMethod',
      bridge: 'securityPolicy.isRouteDisabled securityPolicy.isRpcMethodAllowed securityPolicy.terminalInputEnabled',
      safeCli: "exposeTailscale(state.port); option('--password-file <path>', 'description')",
      ntfyConfig: '',
      httpServer: '',
      securityPolicy: 'backgroundIntegrationsEnabled: false',
    })
    expect(result.ok).toBe(false)
    expect(result.failures.join('\n')).toContain('ntfy')
  })

  it('rejects external lifecycle wiring that discards the durable acknowledgement', () => {
    const result = inspectSafeSources({
      runtimePolicy: "bindHost: '127.0.0.1'; approvalPolicy: 'on-request'; sandboxMode: 'workspace-write'",
      featureGate: 'isDisabledRoute isAllowedRpcMethod',
      bridge: VALID_BRIDGE_SOURCE,
      safeCli: "exposeTailscale(state.port); option('--password-file <path>', 'description'); option('--ntfy-url-file <path>', 'description'); loadNtfyPublishUrl({ explicitPath: options.ntfyUrlFile })",
      ntfyConfig: "url.origin !== 'https://ntfy.sh'; url.username; url.password; url.search; url.hash; !/^\\/[A-Za-z0-9_-]+$/u.test(url.pathname)",
      httpServer: 'options.ntfyNotifications createNtfyNotifierLifecycle bridge.subscribeNotifications NtfyCompletionNotifier createExternalTurnMonitor getSessionsRootForNotifier void notifier.handleObserved(event)',
      securityPolicy: 'backgroundIntegrationsEnabled: false',
    })

    expect(result.failures).toContain('External turn lifecycle must return the durable notifier acknowledgement')
  })

  it.each([
    ['url.password', 'password'],
    ['url.hash', 'fragment'],
  ] as const)('rejects ntfy config source missing the %s check', (missingInvariant, expectedFailure) => {
    const result = inspectSafeSources({
      runtimePolicy: "bindHost: '127.0.0.1'; approvalPolicy: 'on-request'; sandboxMode: 'workspace-write'",
      featureGate: 'isDisabledRoute isAllowedRpcMethod',
      bridge: VALID_BRIDGE_SOURCE,
      safeCli: "exposeTailscale(state.port); option('--password-file <path>', 'description'); option('--ntfy-url-file <path>', 'description'); loadNtfyPublishUrl({ explicitPath: options.ntfyUrlFile })",
      ntfyConfig: "url.origin !== 'https://ntfy.sh'; url.username; url.password; url.search; url.hash; !/^\\/[A-Za-z0-9_-]+$/u.test(url.pathname)"
        .replace(`${missingInvariant}; `, ''),
      httpServer: 'options.ntfyNotifications createNtfyNotifierLifecycle bridge.subscribeNotifications NtfyCompletionNotifier createExternalTurnMonitor getSessionsRootForNotifier return notifier.handleObserved(event)',
      securityPolicy: 'backgroundIntegrationsEnabled: false',
    })

    expect(result.ok).toBe(false)
    expect(result.failures.join('\n')).toContain(expectedFailure)
  })

  it.each([
    'readMergedThreadTitleCache',
    'augmentThreadReadWithNotificationTitle',
    'notificationTitle',
  ] as const)('rejects bridge source missing ntfy title invariant %s', (invariant) => {
    const result = inspectSafeSources({
      runtimePolicy: "bindHost: '127.0.0.1'; approvalPolicy: 'on-request'; sandboxMode: 'workspace-write'",
      featureGate: 'isDisabledRoute isAllowedRpcMethod',
      bridge: VALID_BRIDGE_SOURCE.replace(invariant, ''),
      safeCli: "exposeTailscale(state.port); option('--password-file <path>', 'description'); option('--ntfy-url-file <path>', 'description'); loadNtfyPublishUrl({ explicitPath: options.ntfyUrlFile })",
      ntfyConfig: "url.origin !== 'https://ntfy.sh'; url.username; url.password; url.search; url.hash; !/^\\/[A-Za-z0-9_-]+$/u.test(url.pathname)",
      httpServer: 'options.ntfyNotifications createNtfyNotifierLifecycle bridge.subscribeNotifications NtfyCompletionNotifier createExternalTurnMonitor getSessionsRootForNotifier return notifier.handleObserved(event)',
      securityPolicy: 'backgroundIntegrationsEnabled: false',
    })

    expect(result.ok).toBe(false)
    expect(result.failures.join('\n')).toContain('title')
  })
})
