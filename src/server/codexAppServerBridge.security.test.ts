import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('Codex bridge security-policy wiring', () => {
  it('checks disabled routes, RPC allowlisting, and terminal input before dispatch', async () => {
    const source = await readFile(new URL('./codexAppServerBridge.ts', import.meta.url), 'utf8')
    expect(source).toContain('securityPolicy.isRouteDisabled')
    expect(source).toContain('securityPolicy.isRpcMethodAllowed')
    expect(source).toContain('securityPolicy.terminalInputEnabled')
    expect(source.indexOf('securityPolicy.isRpcMethodAllowed')).toBeLessThan(source.indexOf('callRpcWithArchiveRecovery(appServer, body.method'))
    expect(source.indexOf('securityPolicy.terminalInputEnabled')).toBeLessThan(source.indexOf('terminalManager.write(sessionId, data)'))
  })
})
