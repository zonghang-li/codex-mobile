import type { ThreadRuntimeOwnership } from '../../types/threadRuntime'

type RuntimeOwnership = ThreadRuntimeOwnership | undefined

export type ExternalRuntimeTakeoverEffects = {
  cancelDictation: () => void
  invalidateAttachments: () => void
}

export function canApplyThreadUiMutation(_ownership: RuntimeOwnership): boolean {
  // Text draft changes are browser-local; external ownership only blocks writer-affecting work.
  return true
}

export function canApplyAttachmentMutation(
  ownership: RuntimeOwnership,
  expectedSessionToken: number,
  currentSessionToken: number,
): boolean {
  return ownership !== 'external' && expectedSessionToken === currentSessionToken
}

export function applyExternalRuntimeTakeover(
  previousOwnership: RuntimeOwnership,
  ownership: RuntimeOwnership,
  effects: ExternalRuntimeTakeoverEffects,
): boolean {
  if (previousOwnership === 'external' || ownership !== 'external') return false
  effects.cancelDictation()
  effects.invalidateAttachments()
  return true
}
