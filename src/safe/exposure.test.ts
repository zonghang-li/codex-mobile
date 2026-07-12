import { describe, expect, it } from 'vitest'
import {
  assertPasswordProtectedExposure,
  exposeTailscale,
  getTailscaleStatus,
  unexposeTailscale,
  type CommandRunner,
} from './exposure'

describe('Tailscale exposure', () => {
  it('requires an available logged-in Tailscale CLI', async () => {
    const unavailable: CommandRunner = async () => ({ status: 1, stdout: '', stderr: 'missing' })
    await expect(getTailscaleStatus(unavailable)).resolves.toMatchObject({ available: false, loggedIn: false })
    await expect(exposeTailscale(5900, unavailable)).rejects.toThrow('missing')
  })

  it('uses Serve on loopback and never Funnel', async () => {
    const calls: Array<[string, string[]]> = []
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, args])
      return { status: 0, stdout: args[0] === 'serve' ? 'https://host.tailnet.ts.net' : '{}', stderr: '' }
    }
    await expect(exposeTailscale(5900, runner)).resolves.toBe('https://host.tailnet.ts.net')
    await unexposeTailscale(5900, runner)
    expect(calls).toContainEqual(['tailscale', ['serve', '--bg', '--https=443', 'http://127.0.0.1:5900']])
    expect(calls.flatMap(([, args]) => args)).not.toContain('funnel')
  })

  it('refuses exposure without password protection', () => {
    expect(() => assertPasswordProtectedExposure(false)).toThrow('password-protected')
    expect(() => assertPasswordProtectedExposure(true)).not.toThrow()
  })
})
