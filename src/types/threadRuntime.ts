export type ExternalThreadRuntime =
  | {
      state: 'running'
      turnId: string
      interruptible: false
      source: 'external-session-writer'
    }
  | { state: 'idle' }
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
}
