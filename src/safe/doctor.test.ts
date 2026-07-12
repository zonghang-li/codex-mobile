import { describe, expect, it } from 'vitest'
import { inspectSafeSources } from './doctor'

describe('safe doctor', () => {
  it('accepts required safe invariants', () => {
    const result = inspectSafeSources({
      runtimePolicy: "bindHost: '127.0.0.1'; approvalPolicy: 'on-request'; sandboxMode: 'workspace-write'",
      featureGate: 'isDisabledRoute isAllowedRpcMethod',
      bridge: 'securityPolicy.isRouteDisabled securityPolicy.isRpcMethodAllowed securityPolicy.terminalInputEnabled',
      safeCli: "exposeTailscale(state.port); option('--password-file <path>', 'description')",
    })
    expect(result).toEqual({ ok: true, failures: [] })
  })

  it('reports every missing invariant', () => {
    const result = inspectSafeSources({ runtimePolicy: '', featureGate: '', bridge: '', safeCli: '' })
    expect(result.ok).toBe(false)
    expect(result.failures.length).toBeGreaterThan(4)
  })
})
