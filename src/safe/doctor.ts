import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export type SafeSourceSet = {
  runtimePolicy: string
  featureGate: string
  bridge: string
  safeCli: string
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
  requireText(failures, sources.safeCli, "option('--password-file <path>')", 'Safe CLI must support password files')
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
  })
}
