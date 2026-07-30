export type ExternalThreadRuntime =
  | {
      state: 'running'
      turnId: string
      interruptible: boolean
      source: 'external-session-writer'
      cwd?: string
    }
  | { state: 'idle'; cwd?: string }
  | { state: 'unknown' }

export type LocalAppServerRunningRuntime = {
  state: 'running'
  turnId: string
  interruptible: true
  source: 'local-app-server'
}

export type ThreadRuntimeObservation =
  | ExternalThreadRuntime
  | LocalAppServerRunningRuntime

export type ThreadRuntimeOwnership = 'idle' | 'local' | 'external'

export type ThreadDetailRuntime = {
  inProgress: boolean
  activeTurnId: string
  ownership: ThreadRuntimeOwnership
  canInterrupt: boolean
  externalRuntimeState: ExternalThreadRuntime['state']
  runtimeCwd?: string
}
