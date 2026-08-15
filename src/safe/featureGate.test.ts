import { describe, expect, it } from 'vitest'
import { isAllowedRpcMethod, isDisabledRoute } from './featureGate'

describe('safe feature gate', () => {
  it('allows the thread RPC methods needed by the mobile client', () => {
    expect(isAllowedRpcMethod('thread/read')).toBe(true)
    expect(isAllowedRpcMethod('thread/resume')).toBe(true)
    expect(isAllowedRpcMethod('turn/start')).toBe(true)
  })

  it('allows only the read-only native Goal RPC method', () => {
    expect(isAllowedRpcMethod('thread/goal/get')).toBe(true)
    expect(isAllowedRpcMethod('thread/goal/set')).toBe(false)
    expect(isAllowedRpcMethod('thread/goal/clear')).toBe(false)
    expect(isAllowedRpcMethod('thread/goal/*')).toBe(false)
    expect(isAllowedRpcMethod('thread/goal/get/metadata')).toBe(false)
    expect(isAllowedRpcMethod('thread/goal/delete')).toBe(false)
  })

  it('rejects raw or integration RPC methods outside the allowlist', () => {
    expect(isAllowedRpcMethod('command/exec')).toBe(false)
    expect(isAllowedRpcMethod('composio/connect')).toBe(false)
  })

  it('blocks risky integration and mutation route prefixes', () => {
    expect(isDisabledRoute('POST', '/codex-api/composio/connect')).toBe(true)
    expect(isDisabledRoute('POST', '/codex-api/telegram/config')).toBe(true)
    expect(isDisabledRoute('POST', '/codex-api/skills/install')).toBe(true)
    expect(isDisabledRoute('GET', '/codex-api/thread-turns')).toBe(false)
  })

  it('allows controlled thread routes only for their exact methods and paths', () => {
    expect(isDisabledRoute('GET', '/codex-api/thread-queue-state')).toBe(false)
    expect(isDisabledRoute('PUT', '/codex-api/thread-queue-state')).toBe(false)
    expect(isDisabledRoute('PATCH', '/codex-api/thread-queue-state')).toBe(false)
    expect(isDisabledRoute('POST', '/codex-api/thread-queue-state')).toBe(false)
    expect(isDisabledRoute('GET', '/codex-api/thread-queue-receipt')).toBe(false)
    expect(isDisabledRoute('POST', '/codex-api/thread-goal-set')).toBe(false)
    expect(isDisabledRoute('POST', '/codex-api/thread-goal-clear')).toBe(false)
    expect(isDisabledRoute('POST', '/codex-api/thread-stop-and-archive')).toBe(false)
    expect(isDisabledRoute('GET', '/codex-api/thread-runtime-state')).toBe(false)
    expect(isDisabledRoute('POST', '/codex-api/thread-runtime-states')).toBe(false)
    expect(isDisabledRoute('POST', '/codex-api/thread-runtime-interrupt')).toBe(false)
    expect(isDisabledRoute('GET', '/codex-api/thread-summary')).toBe(false)

    expect(isDisabledRoute('DELETE', '/codex-api/thread-queue-state')).toBe(true)
    expect(isDisabledRoute('GET', '/codex-api/thread-goal-set')).toBe(true)
    expect(isDisabledRoute('POST', '/codex-api/thread-stop-and-archive/extra')).toBe(true)
    expect(isDisabledRoute('POST', '/codex-api/thread-runtime-unknown')).toBe(true)
    expect(isDisabledRoute('POST', '/codex-api/thread-summary')).toBe(true)
    expect(isDisabledRoute('GET', '/codex-api/thread-summary/extra')).toBe(true)
  })
})
