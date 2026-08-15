import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

export type CommandInvocation = {
  command: string
  args: string[]
}

let sqliteCommandCache: { signature: string; command: string | null } | null = null
let sqliteCommandAsyncCache: { signature: string; promise: Promise<string | null> } | null = null

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const unique: string[] = []
  for (const value of values) {
    const normalized = value?.trim()
    if (!normalized || unique.includes(normalized)) continue
    unique.push(normalized)
  }
  return unique
}

function isPathLike(command: string): boolean {
  return command.includes('/') || command.includes('\\') || /^[a-zA-Z]:/.test(command)
}

function isRunnableCommand(command: string, args: string[] = []): boolean {
  if (isPathLike(command) && !existsSync(command)) {
    return false
  }
  return canRunCommand(command, args)
}

function getWindowsAppDataNpmPrefix(): string | null {
  const appData = process.env.APPDATA?.trim()
  return appData ? join(appData, 'npm') : null
}

function getPotentialNpmPrefixes(): string[] {
  return uniqueStrings([
    process.env.npm_config_prefix,
    process.env.PREFIX,
    getUserNpmPrefix(),
    process.platform === 'win32' ? getWindowsAppDataNpmPrefix() : null,
  ])
}

function getPotentialCodexPackageDirs(prefix: string): string[] {
  const dirs = [join(prefix, 'node_modules', '@openai', 'codex')]
  if (process.platform !== 'win32') {
    dirs.push(join(prefix, 'lib', 'node_modules', '@openai', 'codex'))
  }
  return dirs
}

function getPotentialCodexExecutables(prefix: string): string[] {
  return getPotentialCodexPackageDirs(prefix).map((packageDir) => (
    process.platform === 'win32'
      ? join(
          packageDir,
          'node_modules',
          '@openai',
          'codex-win32-x64',
          'vendor',
          'x86_64-pc-windows-msvc',
          'codex',
          'codex.exe',
        )
      : join(packageDir, 'bin', 'codex')
  ))
}

function getPotentialRipgrepExecutables(prefix: string): string[] {
  return getPotentialCodexPackageDirs(prefix).map((packageDir) => (
    process.platform === 'win32'
      ? join(
          packageDir,
          'node_modules',
          '@openai',
          'codex-win32-x64',
          'vendor',
          'x86_64-pc-windows-msvc',
          'path',
          'rg.exe',
        )
      : join(packageDir, 'bin', 'rg')
  ))
}

export function canRunCommand(command: string, args: string[] = []): boolean {
  const result = spawnSync(command, args, {
    stdio: 'ignore',
    windowsHide: true,
  })
  return !result.error && result.status === 0
}

export function getUserNpmPrefix(): string {
  return join(homedir(), '.npm-global')
}

export function getNpmGlobalBinDir(prefix: string): string {
  return process.platform === 'win32' ? prefix : join(prefix, 'bin')
}

export function prependPathEntry(existingPath: string, entry: string): string {
  const normalizedEntry = entry.trim()
  if (!normalizedEntry) return existingPath

  const parts = existingPath
    .split(delimiter)
    .map((value) => value.trim())
    .filter(Boolean)

  if (parts.includes(normalizedEntry)) {
    return existingPath
  }

  return existingPath ? `${normalizedEntry}${delimiter}${existingPath}` : normalizedEntry
}

export function resolveCodexCommand(): string | null {
  const explicit = process.env.CODEXUI_CODEX_COMMAND?.trim()
  const packageCandidates = getPotentialNpmPrefixes().flatMap(getPotentialCodexExecutables)
  const fallbackCandidates = process.platform === 'win32'
    ? [...packageCandidates, 'codex']
    : ['codex', ...packageCandidates]

  for (const candidate of uniqueStrings([explicit, ...fallbackCandidates])) {
    if (isRunnableCommand(candidate, ['--version'])) {
      return candidate
    }
  }

  return null
}

export function resolveRipgrepCommand(): string | null {
  const explicit = process.env.CODEXUI_RG_COMMAND?.trim()
  const packageCandidates = getPotentialNpmPrefixes().flatMap(getPotentialRipgrepExecutables)
  const fallbackCandidates = process.platform === 'win32'
    ? [...packageCandidates, 'rg']
    : ['rg', ...packageCandidates]

  for (const candidate of uniqueStrings([explicit, ...fallbackCandidates])) {
    if (isRunnableCommand(candidate, ['--version'])) {
      return candidate
    }
  }

  return null
}

export function resolveSqliteCommand(): string | null {
  const home = process.env.HOME?.trim() || homedir()
  const explicit = process.env.CODEXUI_SQLITE_COMMAND?.trim()
  const signature = [process.platform, home, process.env.PATH ?? '', explicit ?? ''].join('\n')
  if (sqliteCommandCache?.signature === signature) return sqliteCommandCache.command

  const fallbackCandidates = process.platform === 'win32'
    ? ['sqlite3']
    : [
        'sqlite3',
        join(home, 'miniconda3', 'bin', 'sqlite3'),
        join(home, 'anaconda3', 'bin', 'sqlite3'),
        join(home, '.local', 'bin', 'sqlite3'),
        '/opt/homebrew/bin/sqlite3',
      ]
  let command: string | null = null
  for (const candidate of uniqueStrings([explicit, ...fallbackCandidates])) {
    if (isRunnableCommand(candidate, ['--version'])) {
      command = candidate
      break
    }
  }
  sqliteCommandCache = { signature, command }
  return command
}

function isRunnableCommandAsync(command: string, args: string[] = []): Promise<boolean> {
  if (isPathLike(command) && !existsSync(command)) return Promise.resolve(false)
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true })
    let settled = false
    const finish = (result: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(result)
    }
    const timeout = setTimeout(() => {
      child.kill()
      finish(false)
    }, 1_000)
    timeout.unref?.()
    child.once('error', () => finish(false))
    child.once('close', (code) => finish(code === 0))
  })
}

export function resolveSqliteCommandAsync(): Promise<string | null> {
  const home = process.env.HOME?.trim() || homedir()
  const explicit = process.env.CODEXUI_SQLITE_COMMAND?.trim()
  const signature = [process.platform, home, process.env.PATH ?? '', explicit ?? ''].join('\n')
  if (sqliteCommandAsyncCache?.signature === signature) return sqliteCommandAsyncCache.promise
  const fallbackCandidates = process.platform === 'win32'
    ? ['sqlite3']
    : [
        'sqlite3',
        join(home, 'miniconda3', 'bin', 'sqlite3'),
        join(home, 'anaconda3', 'bin', 'sqlite3'),
        join(home, '.local', 'bin', 'sqlite3'),
        '/opt/homebrew/bin/sqlite3',
      ]
  const promise = (async () => {
    for (const candidate of uniqueStrings([explicit, ...fallbackCandidates])) {
      if (await isRunnableCommandAsync(candidate, ['--version'])) return candidate
    }
    return null
  })()
  sqliteCommandAsyncCache = { signature, promise }
  return promise
}

export function resolvePythonCommand(): CommandInvocation | null {
  const candidates: CommandInvocation[] = process.platform === 'win32'
    ? [
        { command: 'python', args: [] },
        { command: 'py', args: ['-3'] },
        { command: 'python3', args: [] },
      ]
    : [
        { command: 'python3', args: [] },
        { command: 'python', args: [] },
      ]

  for (const candidate of candidates) {
    if (isRunnableCommand(candidate.command, [...candidate.args, '--version'])) {
      return candidate
    }
  }

  return null
}

export function resolveSkillInstallerScriptPath(codexHome?: string): string | null {
  const normalizedCodexHome = codexHome?.trim()
  const candidates = uniqueStrings([
    normalizedCodexHome
      ? join(normalizedCodexHome, 'skills', '.system', 'skill-installer', 'scripts', 'install-skill-from-github.py')
      : null,
    process.env.CODEX_HOME?.trim()
      ? join(process.env.CODEX_HOME.trim(), 'skills', '.system', 'skill-installer', 'scripts', 'install-skill-from-github.py')
      : null,
    join(homedir(), '.codex', 'skills', '.system', 'skill-installer', 'scripts', 'install-skill-from-github.py'),
    join(homedir(), '.cursor', 'skills', '.system', 'skill-installer', 'scripts', 'install-skill-from-github.py'),
  ])

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }

  return null
}
