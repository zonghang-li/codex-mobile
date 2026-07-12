import { delimiter, resolve } from 'node:path'

export type ExternalExposure = 'disabled' | 'tailscale'
export type SafeSandboxMode = 'read-only' | 'workspace-write'
export type SafeApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request'

export type SafeRuntimeConfig = {
  bindHost: string
  port: number
  lanEnabled: boolean
  externalExposure: ExternalExposure
  sandboxMode: SafeSandboxMode
  approvalPolicy: SafeApprovalPolicy
  allowTailscaleAuthBypass: boolean
  allowedRoots: string[]
  terminalInputEnabled: boolean
  fileEditingEnabled: boolean
  rawRpcEnabled: boolean
}

export const DEFAULT_SAFE_RUNTIME_CONFIG: SafeRuntimeConfig = {
  bindHost: '127.0.0.1',
  port: 5900,
  lanEnabled: false,
  externalExposure: 'disabled',
  sandboxMode: 'workspace-write',
  approvalPolicy: 'on-request',
  allowTailscaleAuthBypass: false,
  allowedRoots: [],
  terminalInputEnabled: false,
  fileEditingEnabled: false,
  rawRpcEnabled: false,
}

function readBoolean(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

function readPort(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535
    ? parsed
    : DEFAULT_SAFE_RUNTIME_CONFIG.port
}

function readAllowedRoots(value: string | undefined): string[] {
  if (!value?.trim()) return []
  const roots: string[] = []
  for (const item of value.split(delimiter)) {
    const trimmed = item.trim()
    if (!trimmed) continue
    const normalized = resolve(trimmed)
    if (!roots.includes(normalized)) roots.push(normalized)
  }
  return roots
}

function readSandboxMode(value: string | undefined): SafeSandboxMode {
  return value?.trim().toLowerCase() === 'read-only' ? 'read-only' : DEFAULT_SAFE_RUNTIME_CONFIG.sandboxMode
}

function readApprovalPolicy(value: string | undefined): SafeApprovalPolicy {
  const normalized = value?.trim().toLowerCase()
  return normalized === 'untrusted' || normalized === 'on-failure' || normalized === 'on-request'
    ? normalized
    : DEFAULT_SAFE_RUNTIME_CONFIG.approvalPolicy
}

export function loadSafeRuntimeConfig(env: NodeJS.ProcessEnv = process.env): SafeRuntimeConfig {
  const lanEnabled = readBoolean(env.CODEX_MOBILE_SAFE_LAN)
  return {
    ...DEFAULT_SAFE_RUNTIME_CONFIG,
    bindHost: lanEnabled ? '0.0.0.0' : DEFAULT_SAFE_RUNTIME_CONFIG.bindHost,
    port: readPort(env.CODEX_MOBILE_SAFE_PORT),
    lanEnabled,
    sandboxMode: readSandboxMode(env.CODEX_MOBILE_SAFE_SANDBOX_MODE),
    approvalPolicy: readApprovalPolicy(env.CODEX_MOBILE_SAFE_APPROVAL_POLICY),
    allowedRoots: readAllowedRoots(env.CODEX_MOBILE_SAFE_ALLOWED_ROOTS),
    terminalInputEnabled: readBoolean(env.CODEX_MOBILE_SAFE_TERMINAL_INPUT),
    fileEditingEnabled: readBoolean(env.CODEX_MOBILE_SAFE_FILE_EDITING),
    rawRpcEnabled: readBoolean(env.CODEX_MOBILE_SAFE_RAW_RPC),
    allowTailscaleAuthBypass: false,
    externalExposure: 'disabled',
  }
}
