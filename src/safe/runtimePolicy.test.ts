import { delimiter, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SAFE_RUNTIME_CONFIG, loadSafeRuntimeConfig } from './runtimePolicy'

describe('safe runtime policy', () => {
  it('uses loopback, authenticated, non-exposed defaults', () => {
    expect(loadSafeRuntimeConfig({})).toEqual(DEFAULT_SAFE_RUNTIME_CONFIG)
    expect(DEFAULT_SAFE_RUNTIME_CONFIG).toMatchObject({
      bindHost: '127.0.0.1',
      port: 5900,
      lanEnabled: false,
      externalExposure: 'disabled',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      allowTailscaleAuthBypass: false,
      terminalInputEnabled: false,
      fileEditingEnabled: false,
      rawRpcEnabled: false,
    })
  })

  it('enables LAN only through the explicit environment switch', () => {
    expect(loadSafeRuntimeConfig({ CODEX_MOBILE_SAFE_LAN: 'true' })).toMatchObject({
      bindHost: '0.0.0.0',
      lanEnabled: true,
    })
  })

  it('accepts an explicit unrestricted no-approval profile', () => {
    expect(loadSafeRuntimeConfig({
      CODEX_MOBILE_SAFE_SANDBOX_MODE: 'danger-full-access',
      CODEX_MOBILE_SAFE_APPROVAL_POLICY: 'never',
    })).toMatchObject({
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
    })
  })

  it('falls back from unknown sandbox and approval values', () => {
    expect(loadSafeRuntimeConfig({
      CODEX_MOBILE_SAFE_SANDBOX_MODE: 'unknown',
      CODEX_MOBILE_SAFE_APPROVAL_POLICY: 'unknown',
    })).toMatchObject({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
    })
  })

  it('normalizes and de-duplicates allowed roots', () => {
    const first = resolve('/tmp/one')
    const second = resolve('/tmp/two')
    expect(loadSafeRuntimeConfig({
      CODEX_MOBILE_SAFE_ALLOWED_ROOTS: [first, second, first].join(delimiter),
    }).allowedRoots).toEqual([first, second])
  })
})
