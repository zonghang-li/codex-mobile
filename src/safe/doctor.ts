import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export type SafeSourceSet = {
  runtimePolicy: string
  featureGate: string
  bridge: string
  safeCli: string
  ntfyConfig: string
  httpServer: string
  securityPolicy: string
}

export type DoctorResult = {
  ok: boolean
  failures: string[]
}

function requireText(failures: string[], source: string, expected: string, message: string): void {
  if (!source.includes(expected)) failures.push(message)
}

export function inspectSafeSources(sources: SafeSourceSet): DoctorResult {
  const failures: string[] = []
  requireText(failures, sources.runtimePolicy, "bindHost: '127.0.0.1'", 'Safe runtime must default to loopback')
  requireText(failures, sources.runtimePolicy, "approvalPolicy: 'on-request'", 'Safe runtime must require approvals by default')
  requireText(failures, sources.runtimePolicy, "sandboxMode: 'workspace-write'", 'Safe runtime must avoid danger-full-access')
  requireText(failures, sources.featureGate, 'isDisabledRoute', 'Safe feature gate must disable risky routes')
  requireText(failures, sources.featureGate, 'isAllowedRpcMethod', 'Safe feature gate must allowlist RPC methods')
  requireText(failures, sources.bridge, 'securityPolicy.isRouteDisabled', 'Bridge must enforce disabled routes')
  requireText(failures, sources.bridge, 'securityPolicy.isRpcMethodAllowed', 'Bridge must enforce RPC allowlisting')
  requireText(failures, sources.bridge, 'securityPolicy.terminalInputEnabled', 'Bridge must gate terminal input')
  requireText(failures, sources.safeCli, 'exposeTailscale(state.port)', 'Safe CLI must expose only through explicit Tailscale command')
  requireText(failures, sources.safeCli, "option('--password-file <path>'", 'Safe CLI must support password files')
  requireText(failures, sources.safeCli, "option('--ntfy-url-file <path>'", 'Safe CLI must support an optional ntfy URL file')
  requireText(failures, sources.safeCli, 'loadNtfyPublishUrl({ explicitPath: options.ntfyUrlFile })', 'Safe CLI must use the validated ntfy loader')
  requireText(failures, sources.ntfyConfig, "url.origin !== 'https://ntfy.sh'", 'ntfy configuration must require the fixed HTTPS origin')
  requireText(failures, sources.ntfyConfig, 'url.username', 'ntfy configuration must reject URL credentials')
  requireText(failures, sources.ntfyConfig, 'url.password', 'ntfy configuration must reject URL passwords')
  requireText(failures, sources.ntfyConfig, 'url.search', 'ntfy configuration must reject URL query strings')
  requireText(failures, sources.ntfyConfig, 'url.hash', 'ntfy configuration must reject URL fragments')
  requireText(failures, sources.ntfyConfig, '!/^\\/[A-Za-z0-9_-]+$/u.test(url.pathname)', 'ntfy configuration must require one strict topic segment')
  requireText(failures, sources.bridge, 'readThreadForNotifier', 'Bridge must keep notifier thread reads internal')
  requireText(failures, sources.bridge, 'readMergedThreadTitleCache', 'Bridge must read cached conversation titles for ntfy')
  requireText(failures, sources.bridge, 'augmentThreadReadWithNotificationTitle', 'Bridge must enrich ntfy thread reads with cached titles')
  requireText(failures, sources.bridge, 'notificationTitle', 'Bridge must expose a notifier-only conversation title')
  requireText(failures, sources.bridge, 'getAppServerPidForNotifier', 'Bridge must keep the notifier app-server PID internal')
  requireText(failures, sources.bridge, 'getSessionsRootForNotifier', 'Bridge must keep the notifier sessions root internal')
  requireText(failures, sources.httpServer, 'options.ntfyNotifications', 'HTTP server must keep ntfy wiring optional')
  requireText(failures, sources.httpServer, 'createNtfyNotifierLifecycle', 'HTTP server must own the optional ntfy lifecycle')
  requireText(failures, sources.httpServer, 'bridge.subscribeNotifications', 'HTTP server must explicitly subscribe the enabled notifier')
  requireText(failures, sources.httpServer, 'NtfyCompletionNotifier', 'HTTP server must use the bounded completion notifier')
  requireText(failures, sources.httpServer, 'createExternalTurnMonitor', 'HTTP server must own external turn monitoring')
  requireText(failures, sources.httpServer, 'getSessionsRootForNotifier', 'External turn monitoring must use the canonical sessions root')
  requireText(failures, sources.httpServer, 'return notifier.handleObserved(event)', 'External turn lifecycle must return the durable notifier acknowledgement')
  requireText(failures, sources.securityPolicy, 'backgroundIntegrationsEnabled: false', 'Safe policy must keep background integrations disabled')
  return { ok: failures.length === 0, failures }
}

async function readSource(root: string, path: string): Promise<string> {
  try {
    return await readFile(join(root, path), 'utf8')
  } catch {
    return ''
  }
}

export async function runDoctor(root: string): Promise<DoctorResult> {
  return inspectSafeSources({
    runtimePolicy: await readSource(root, 'src/safe/runtimePolicy.ts'),
    featureGate: await readSource(root, 'src/safe/featureGate.ts'),
    bridge: await readSource(root, 'src/server/codexAppServerBridge.ts'),
    safeCli: await readSource(root, 'src/cli/safe.ts'),
    ntfyConfig: await readSource(root, 'src/safe/ntfyConfig.ts'),
    httpServer: await readSource(root, 'src/server/httpServer.ts'),
    securityPolicy: await readSource(root, 'src/server/securityPolicy.ts'),
  })
}
