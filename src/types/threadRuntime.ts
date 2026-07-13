export type ExternalThreadRuntime =
  | {
      state: 'running'
      turnId: string
      interruptible: false
      source: 'external-session-writer'
    }
  | { state: 'idle' }
  | { state: 'unknown' }

export type ThreadRuntimeOwnership = 'idle' | 'local' | 'external'

export type ThreadDetailRuntime = {
  inProgress: boolean
  activeTurnId: string
  ownership: ThreadRuntimeOwnership
  canInterrupt: boolean
  externalRuntimeState: ExternalThreadRuntime['state']
}
