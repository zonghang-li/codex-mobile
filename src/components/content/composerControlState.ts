import { ref, watch, type Ref } from 'vue'
import type { ReasoningEffort, SpeedMode } from '../../types/codex'
import type { ThreadRuntimeOwnership } from '../../types/threadRuntime'
import {
  coerceReasoningEffortForModel,
  getSupportedReasoningEfforts,
} from '../../utils/modelReasoningEfforts'

export type ComposerPrimaryAction = 'send' | 'stop' | 'externalRunning' | 'hidden'

export type ComposerControlStateInput = {
  runtimeOwnership: ThreadRuntimeOwnership
  isTurnInProgress: boolean
  hasSubmitContent: boolean
  disabled: boolean
  hasPendingRequest: boolean
  goalSupported: boolean
  selectedModel: string
  selectedReasoningEffort: ReasoningEffort | ''
  selectedSpeedMode: SpeedMode
}

export type ConversationGoalEditorState = {
  isEditingGoal: Ref<boolean>
  editingObjective: Ref<string>
  begin: (objective: string) => void
  cancel: () => void
  finish: () => void
}

export function useConversationGoalEditorState(source: {
  threadId: () => string
  objective: () => string | null
}): ConversationGoalEditorState {
  const isEditingGoal = ref(false)
  const editingObjective = ref('')

  watch(
    () => [source.threadId(), source.objective()] as const,
    ([threadId, objective], previous) => {
      const threadChanged = previous !== undefined && previous[0] !== threadId
      if (threadChanged || objective === null) {
        isEditingGoal.value = false
        editingObjective.value = objective ?? ''
        return
      }
      if (!isEditingGoal.value) editingObjective.value = objective
    },
    { immediate: true },
  )

  return {
    isEditingGoal,
    editingObjective,
    begin(objective: string) {
      editingObjective.value = objective
      isEditingGoal.value = true
    },
    cancel() {
      editingObjective.value = source.objective() ?? ''
      isEditingGoal.value = false
    },
    finish() {
      isEditingGoal.value = false
    },
  }
}

const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
  ultra: 'Ultra',
}

function formatModelLabel(modelId: string): string {
  return modelId.trim().replace(/^gpt/iu, 'GPT')
}

export function deriveComposerControlState(
  input: ComposerControlStateInput,
) {
  const isExternal = input.runtimeOwnership === 'external'
  const reasoningEfforts = getSupportedReasoningEfforts(input.selectedModel)
  const selectedEffort = coerceReasoningEffortForModel(
    input.selectedModel,
    input.selectedReasoningEffort,
  )
  const modelLabel = formatModelLabel(input.selectedModel)
  const effortLabel = selectedEffort ? EFFORT_LABELS[selectedEffort] : ''
  const modelEffortLabel = [modelLabel, effortLabel].filter(Boolean).join(' ')
  const composerVisible = !input.hasPendingRequest
  const primaryAction: ComposerPrimaryAction = !composerVisible
    ? 'hidden'
    : isExternal && input.isTurnInProgress
      ? 'externalRunning'
      : input.isTurnInProgress
        ? 'stop'
        : 'send'
  const canSubmit = composerVisible
    && !input.disabled
    && !isExternal
    && input.hasSubmitContent
  const canStop = composerVisible
    && !input.disabled
    && !isExternal
    && input.isTurnInProgress
  const canEditConfiguration = composerVisible
    && !input.disabled
    && !isExternal
    && !input.isTurnInProgress

  return {
    composerVisible,
    primaryAction,
    canSubmit,
    canStop,
    canEditConfiguration,
    canToggleGoal: composerVisible && !input.disabled && input.goalSupported,
    modelEffortLabel,
    showFastIcon: input.selectedSpeedMode === 'fast'
      && /^gpt-5\.(?:4|5|6)(?:$|-)/iu.test(input.selectedModel.trim()),
    selectedEffort,
    reasoningEfforts,
  }
}
