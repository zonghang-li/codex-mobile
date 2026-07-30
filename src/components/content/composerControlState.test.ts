import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import {
  deriveComposerControlState,
  formatComposerModelEffortTriggerLabel,
  useConversationGoalEditorState,
} from './composerControlState'

const composerSource = readFileSync(
  new URL('./ThreadComposer.vue', import.meta.url),
  'utf8',
)

const localIdle = {
  runtimeOwnership: 'idle' as const,
  isTurnInProgress: false,
  canInterruptTurn: false,
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
      canInterruptTurn: true,
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
      canInterruptTurn: true,
      hasSubmitContent: true,
    })).toMatchObject({
      primaryAction: 'send',
      canSubmit: true,
      canStop: true,
      canEditConfiguration: false,
    })
  })

  it('lets an externally owned running turn submit new input without exposing a local Stop control', () => {
    expect(deriveComposerControlState({
      ...localIdle,
      runtimeOwnership: 'external',
      isTurnInProgress: true,
      hasSubmitContent: false,
    })).toMatchObject({
      primaryAction: 'send',
      canSubmit: false,
      canStop: false,
      canToggleGoal: false,
    })

    expect(deriveComposerControlState({
      ...localIdle,
      runtimeOwnership: 'external',
      isTurnInProgress: true,
      hasSubmitContent: true,
    })).toMatchObject({
      primaryAction: 'send',
      canSubmit: true,
      canStop: false,
      canEditConfiguration: false,
      canToggleGoal: false,
    })
  })

  it('shows Stop only when an external runtime is explicitly interruptible', () => {
    expect(deriveComposerControlState({
      ...localIdle,
      runtimeOwnership: 'external',
      isTurnInProgress: true,
      canInterruptTurn: true,
      hasSubmitContent: false,
    })).toMatchObject({
      primaryAction: 'stop',
      canStop: true,
    })
  })

  it('keeps Goal metadata available while a local turn is running', () => {
    expect(deriveComposerControlState({
      ...localIdle,
      runtimeOwnership: 'local',
      isTurnInProgress: true,
      canInterruptTurn: true,
      hasSubmitContent: false,
    })).toMatchObject({
      canEditConfiguration: false,
      canToggleGoal: true,
    })
  })

  it('discards an editing draft when its Goal is cleared or its thread identity changes', async () => {
    const threadId = ref('thread-1')
    const objective = ref<string | null>('First goal')
    const scope = effectScope()
    const editor = scope.run(() => useConversationGoalEditorState({
      threadId: () => threadId.value,
      objective: () => objective.value,
    }))
    expect(editor).toBeDefined()
    if (!editor) throw new Error('Expected Goal editor state')

    editor.begin('First goal')
    editor.editingObjective.value = 'Stale draft'
    objective.value = null
    await nextTick()

    expect(editor.isEditingGoal.value).toBe(false)
    expect(editor.editingObjective.value).toBe('')

    objective.value = 'Second goal'
    await nextTick()
    editor.begin('Second goal')
    editor.editingObjective.value = 'Another stale draft'
    threadId.value = 'thread-2'
    objective.value = 'Other thread goal'
    await nextTick()

    expect(editor.isEditingGoal.value).toBe(false)
    expect(editor.editingObjective.value).toBe('Other thread goal')
    scope.stop()
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

  it('shows the desktop client label and fast indicator for gpt-5.5 extra high', () => {
    const state = deriveComposerControlState({
      ...localIdle,
      selectedModel: 'gpt-5.5',
      selectedReasoningEffort: 'xhigh',
      selectedSpeedMode: 'fast',
    })

    expect(formatComposerModelEffortTriggerLabel('gpt-5.5', state.selectedEffort)).toBe('5.5 Extra High')
    expect(state.modelEffortLabel).toBe('GPT-5.5 Extra High')
    expect(state.showFastIcon).toBe(true)
  })
})
