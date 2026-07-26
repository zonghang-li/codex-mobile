import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { deriveComposerControlState } from './composerControlState'

const composerSource = readFileSync(
  new URL('./ThreadComposer.vue', import.meta.url),
  'utf8',
)

const localIdle = {
  runtimeOwnership: 'idle' as const,
  isTurnInProgress: false,
  hasSubmitContent: true,
  disabled: false,
  hasPendingRequest: false,
  goalSupported: true,
  selectedModel: 'gpt-5.6-sol',
  selectedReasoningEffort: 'max' as const,
  selectedSpeedMode: 'fast' as const,
}

describe('deriveComposerControlState', () => {
  it('exposes editable idle controls without a fixed permission status', () => {
    const state = deriveComposerControlState(localIdle)

    expect(state).toMatchObject({
      composerVisible: true,
      primaryAction: 'send',
      canSubmit: true,
      canEditConfiguration: true,
      canToggleGoal: true,
      modelEffortLabel: 'GPT-5.6-sol Max',
      showFastIcon: true,
    })
    expect(state).not.toHaveProperty('permissionLabel')
    expect(composerSource).not.toContain('Approve for me')
    expect(composerSource).not.toContain('thread-composer-permission-trigger')
  })

  it('turns an empty local running composer into a stop control', () => {
    expect(deriveComposerControlState({
      ...localIdle,
      runtimeOwnership: 'local',
      isTurnInProgress: true,
      hasSubmitContent: false,
    })).toMatchObject({
      primaryAction: 'stop',
      canStop: true,
      canEditConfiguration: false,
    })
  })

  it('keeps Stop as the primary control while a local running draft can still be queued or steered', () => {
    expect(deriveComposerControlState({
      ...localIdle,
      runtimeOwnership: 'local',
      isTurnInProgress: true,
      hasSubmitContent: true,
    })).toMatchObject({
      primaryAction: 'stop',
      canSubmit: true,
      canStop: true,
      canEditConfiguration: false,
    })
  })

  it('does not pretend an externally owned turn can submit or stop', () => {
    expect(deriveComposerControlState({
      ...localIdle,
      runtimeOwnership: 'external',
      isTurnInProgress: true,
      hasSubmitContent: false,
    })).toMatchObject({
      primaryAction: 'externalRunning',
      canSubmit: false,
      canStop: false,
    })
  })

  it('hides the composer while an approval or input request owns the response surface', () => {
    expect(deriveComposerControlState({
      ...localIdle,
      hasPendingRequest: true,
    })).toMatchObject({
      primaryAction: 'hidden',
      composerVisible: false,
    })
  })

  it('coerces unsupported effort values before building the combined label', () => {
    const state = deriveComposerControlState({
      ...localIdle,
      selectedModel: 'gpt-5.5',
      selectedReasoningEffort: 'max',
      selectedSpeedMode: 'standard',
    })
    expect(state.reasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(state.modelEffortLabel).toBe('GPT-5.5 Extra High')
    expect(state.showFastIcon).toBe(false)
  })
})
