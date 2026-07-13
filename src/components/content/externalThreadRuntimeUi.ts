import type { ThreadRuntimeOwnership } from '../../types/threadRuntime'

type RuntimeOwnership = ThreadRuntimeOwnership | undefined

export type ExternalRuntimeTakeoverEffects = {
  cancelDictation: () => void
  invalidateAttachments: () => void
}

export function canApplyThreadUiMutation(ownership: RuntimeOwnership): boolean {
  return ownership !== 'external'
}

export function canApplyAttachmentMutation(
  ownership: RuntimeOwnership,
  expectedSessionToken: number,
  currentSessionToken: number,
): boolean {
  return canApplyThreadUiMutation(ownership) && expectedSessionToken === currentSessionToken
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
