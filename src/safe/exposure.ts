import { spawnSync } from 'node:child_process'

export type CommandResult = {
  status: number
  stdout: string
  stderr: string
}

export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>

export type TailscaleStatus = {
  available: boolean
  loggedIn: boolean
  message: string
}

export async function defaultRunner(command: string, args: string[]): Promise<CommandResult> {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
  }
}

export async function getTailscaleStatus(run: CommandRunner = defaultRunner): Promise<TailscaleStatus> {
  const version = await run('tailscale', ['version'])
  if (version.status !== 0) {
    return { available: false, loggedIn: false, message: version.stderr || 'tailscale command is unavailable' }
  }
  const status = await run('tailscale', ['status', '--json'])
  if (status.status !== 0) {
    return { available: true, loggedIn: false, message: status.stderr || 'tailscale is not logged in' }
  }
  return { available: true, loggedIn: true, message: 'tailscale is available' }
}

export function assertPasswordProtectedExposure(passwordProtected: boolean): void {
  if (!passwordProtected) {
    throw new Error('Tailscale exposure requires a password-protected server. Restart without --no-password.')
  }
}

export async function exposeTailscale(port: number, run: CommandRunner = defaultRunner): Promise<string> {
  const status = await getTailscaleStatus(run)
  if (!status.available || !status.loggedIn) throw new Error(status.message)
  const result = await run('tailscale', [
    'serve',
    '--bg',
    '--https=443',
    `http://127.0.0.1:${String(port)}`,
  ])
  if (result.status !== 0) throw new Error(result.stderr || 'tailscale serve failed')
  const tailnetUrl = result.stdout.match(/https:\/\/[^\s|]+/u)?.[0]
  return tailnetUrl || `http://127.0.0.1:${String(port)}`
}

export async function unexposeTailscale(_port: number, run: CommandRunner = defaultRunner): Promise<void> {
  const result = await run('tailscale', ['serve', '--https=443', 'off'])
  if (result.status !== 0) throw new Error(result.stderr || 'tailscale serve disable failed')
}
