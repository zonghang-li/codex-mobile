<template>
  <div v-if="goal" class="conversation-run-footer" aria-live="polite">
    <section v-if="goalSupported && goal && goalPresentation" class="conversation-goal-strip">
      <div class="conversation-goal-row">
        <button
          class="conversation-goal-summary goal-expand-button"
          type="button"
          :aria-expanded="isGoalExpanded"
          :aria-label="t('Show goal details')"
          @click="isGoalExpanded = !isGoalExpanded"
        >
          <IconTablerTargetArrow class="conversation-goal-icon" />
          <span class="conversation-goal-status">{{ t(goalPresentation.label) }}</span>
          <span class="conversation-goal-objective">{{ goal.objective }}</span>
          <span class="conversation-goal-duration">{{ goalPresentation.durationLabel }}</span>
        </button>

        <div class="conversation-goal-actions">
          <button
            class="conversation-goal-action goal-edit-button"
            type="button"
            :disabled="isGoalMutationDisabled"
            :aria-label="t('Edit goal')"
            :title="t('Edit goal')"
            @click="beginGoalEdit"
          >
            <IconTablerFilePencil />
          </button>
          <button
            v-if="goalPresentation.canPause"
            class="conversation-goal-action goal-pause-button"
            type="button"
            :disabled="isGoalMutationDisabled"
            :aria-label="t('Pause goal')"
            :title="t('Pause goal')"
            @click="emitGoalUpdate({ status: 'paused' })"
          >
            <IconTablerPlayerPause />
          </button>
          <button
            v-if="goalPresentation.canResume"
            class="conversation-goal-action goal-resume-button"
            type="button"
            :disabled="isGoalMutationDisabled"
            :aria-label="t('Resume goal')"
            :title="t('Resume goal')"
            @click="emitGoalUpdate({ status: 'active' })"
          >
            <IconTablerPlayerPlay />
          </button>
          <button
            v-if="goal.status !== 'complete'"
            class="conversation-goal-action goal-complete-button"
            type="button"
            :disabled="isGoalMutationDisabled"
            :aria-label="t('Complete goal')"
            :title="t('Complete goal')"
            @click="emitGoalUpdate({ status: 'complete' })"
          >
            <IconTablerTargetArrow />
          </button>
          <button
            v-if="goal.status === 'active' || goal.status === 'paused'"
            class="conversation-goal-action goal-blocked-button"
            type="button"
            :disabled="isGoalMutationDisabled"
            :aria-label="t('Mark goal blocked')"
            :title="t('Mark goal blocked')"
            @click="emitGoalUpdate({ status: 'blocked' })"
          >
            <IconTablerX />
          </button>
          <div
            v-if="isClearGoalConfirming"
            class="conversation-goal-clear-confirmation"
            role="group"
            :aria-label="t('Confirm clear goal')"
            aria-live="polite"
          >
            <span>{{ t('Clear goal') }}?</span>
            <button
              type="button"
              :disabled="isUpdatingGoal"
              @click="cancelGoalClear()"
            >
              {{ t('Cancel') }}
            </button>
            <button
              ref="confirmGoalClearButtonRef"
              class="is-destructive"
              type="button"
              :disabled="isGoalMutationDisabled"
              @click="requestGoalClear"
            >
              {{ t('Clear goal') }}
            </button>
          </div>
          <button
            v-else
            ref="clearGoalButtonRef"
            class="conversation-goal-action goal-clear-button"
            type="button"
            :disabled="isGoalMutationDisabled"
            :aria-label="t('Clear goal')"
            :title="t('Clear goal')"
            @click="requestGoalClear"
          >
            <IconTablerTrash />
          </button>
          <button
            class="conversation-goal-action goal-expand-button"
            type="button"
            :aria-expanded="isGoalExpanded"
            :aria-label="t('Show goal details')"
            @click="isGoalExpanded = !isGoalExpanded"
          >
            <IconTablerChevronRight :class="{ 'is-expanded': isGoalExpanded }" />
          </button>
        </div>
      </div>

      <div v-if="isGoalExpanded" class="conversation-goal-details">
        <template v-if="isEditingGoal">
          <textarea
            v-model="editingObjective"
            class="conversation-goal-editor"
            rows="2"
            :disabled="isGoalMutationDisabled"
            :aria-label="t('Goal objective')"
          />
          <div class="conversation-goal-editor-actions">
            <button type="button" :disabled="isUpdatingGoal" @click="cancelGoalEdit">
              {{ t('Cancel') }}
            </button>
            <button
              type="button"
              :disabled="isGoalMutationDisabled || !editingObjective.trim()"
              @click="saveGoalEdit"
            >
              {{ t('Save') }}
            </button>
          </div>
        </template>
        <template v-else>
          <span v-if="goal.tokenBudget !== null">
            {{ t('{used} / {budget} tokens', { used: goal.tokensUsed, budget: goal.tokenBudget }) }}
          </span>
          <span v-else>{{ t('{count} tokens used', { count: goal.tokensUsed }) }}</span>
          <span v-if="goalPresentation.progressPercent !== null">
            {{ goalPresentation.progressPercent }}%
          </span>
        </template>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { UiThreadGoal, UiThreadGoalStatus } from '../../types/codex'
import { useUiLanguage } from '../../composables/useUiLanguage'
import IconTablerChevronRight from '../icons/IconTablerChevronRight.vue'
import IconTablerFilePencil from '../icons/IconTablerFilePencil.vue'
import IconTablerPlayerPause from '../icons/IconTablerPlayerPause.vue'
import IconTablerPlayerPlay from '../icons/IconTablerPlayerPlay.vue'
import IconTablerTargetArrow from '../icons/IconTablerTargetArrow.vue'
import IconTablerTrash from '../icons/IconTablerTrash.vue'
import IconTablerX from '../icons/IconTablerX.vue'
import { useConversationGoalEditorState } from './composerControlState'
import { deriveThreadGoalPresentation } from './threadGoalPresentation'

const props = defineProps<{
  threadId: string
  goal: UiThreadGoal | null
  goalSupported: boolean
  readOnly: boolean
  isUpdatingGoal: boolean
}>()

const emit = defineEmits<{
  'set-goal': [input: { objective?: string; status: UiThreadGoalStatus }]
  'clear-goal': []
}>()

const { t } = useUiLanguage()
const nowMs = ref(Date.now())
const isGoalExpanded = ref(false)
const isClearGoalConfirming = ref(false)
const clearGoalButtonRef = ref<HTMLButtonElement | null>(null)
const confirmGoalClearButtonRef = ref<HTMLButtonElement | null>(null)
const CLEAR_GOAL_CONFIRMATION_TIMEOUT_MS = 5000
let timer: ReturnType<typeof setInterval> | null = null
let clearGoalConfirmationTimer: ReturnType<typeof setTimeout> | null = null

const goalPresentation = computed(() => (
  props.goal ? deriveThreadGoalPresentation(props.goal, nowMs.value) : null
))
const isGoalMutationDisabled = computed(() => props.readOnly || props.isUpdatingGoal)
const {
  isEditingGoal,
  editingObjective,
  begin: beginEditingGoal,
  cancel: cancelEditingGoal,
  finish: finishEditingGoal,
} = useConversationGoalEditorState({
  threadId: () => props.threadId,
  objective: () => props.goal?.objective ?? null,
})

watch(() => [props.threadId, props.goal?.objective] as const, () => {
  cancelGoalClear(false)
}, { immediate: true })

onMounted(() => {
  timer = setInterval(() => {
    if (props.goal?.status === 'active') nowMs.value = Date.now()
  }, 1000)
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
  clearGoalConfirmationTimerIfNeeded()
})

function beginGoalEdit(): void {
  if (isGoalMutationDisabled.value) return
  cancelGoalClear(false)
  beginEditingGoal(props.goal?.objective ?? '')
  isGoalExpanded.value = true
}

function cancelGoalEdit(): void {
  cancelEditingGoal()
}

function saveGoalEdit(): void {
  if (isGoalMutationDisabled.value) return
  const objective = editingObjective.value.trim()
  if (!objective || !props.goal) return
  emitGoalUpdate({
    objective,
    status: props.goal.status,
  })
  finishEditingGoal()
}

function clearGoalConfirmationTimerIfNeeded(): void {
  if (!clearGoalConfirmationTimer) return
  clearTimeout(clearGoalConfirmationTimer)
  clearGoalConfirmationTimer = null
}

function armGoalClearConfirmation(): void {
  clearGoalConfirmationTimerIfNeeded()
  isClearGoalConfirming.value = true
  clearGoalConfirmationTimer = setTimeout(() => {
    clearGoalConfirmationTimer = null
    cancelGoalClear(false)
  }, CLEAR_GOAL_CONFIRMATION_TIMEOUT_MS)
  void nextTick(() => confirmGoalClearButtonRef.value?.focus())
}

function cancelGoalClear(restoreFocus = true): void {
  clearGoalConfirmationTimerIfNeeded()
  const wasConfirming = isClearGoalConfirming.value
  isClearGoalConfirming.value = false
  if (wasConfirming && restoreFocus) {
    void nextTick(() => clearGoalButtonRef.value?.focus())
  }
}

function requestGoalClear(): void {
  if (isGoalMutationDisabled.value) return
  if (isClearGoalConfirming.value) {
    cancelGoalClear(false)
    emit('clear-goal')
    return
  }
  armGoalClearConfirmation()
}

function emitGoalUpdate(input: { objective?: string; status: UiThreadGoalStatus }): void {
  if (isGoalMutationDisabled.value) return
  emit('set-goal', input)
}
</script>

<style scoped>
@reference "tailwindcss";

.conversation-run-footer {
  @apply flex w-full min-w-0 flex-col items-center gap-2;
  max-width: 100%;
}

.conversation-goal-strip {
  @apply w-full min-w-0 overflow-hidden rounded-2xl border border-zinc-300 bg-zinc-100/95 text-sm text-zinc-600 shadow-sm backdrop-blur;
  min-width: 0;
  max-width: 100%;
}

.conversation-goal-row {
  @apply flex min-w-0 items-center px-2;
}

.conversation-goal-summary {
  @apply flex min-w-0 flex-1 items-center gap-2 border-0 bg-transparent px-1 py-2 text-left text-zinc-600;
}

.conversation-goal-icon {
  @apply h-4 w-4 shrink-0;
}

.conversation-goal-status {
  @apply shrink-0 font-medium text-zinc-800;
}

.conversation-goal-objective {
  @apply min-w-0 flex-1 truncate text-zinc-500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conversation-goal-duration {
  @apply shrink-0 tabular-nums text-zinc-500;
}

.conversation-goal-actions {
  @apply flex shrink-0 items-center gap-0.5;
}

.conversation-goal-action {
  @apply inline-flex h-7 w-7 items-center justify-center rounded-full border-0 bg-transparent text-base text-zinc-500 transition hover:bg-zinc-200 hover:text-zinc-800 disabled:cursor-default disabled:opacity-40;
}

.conversation-goal-action :deep(svg) {
  @apply h-4 w-4;
}

.conversation-goal-clear-confirmation {
  @apply flex shrink-0 items-center gap-1 text-xs text-zinc-500;
}

.conversation-goal-clear-confirmation button {
  @apply rounded-full border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-default disabled:opacity-40;
}

.conversation-goal-clear-confirmation button.is-destructive {
  @apply border-rose-300 text-rose-600 hover:bg-rose-50;
}

.goal-expand-button :deep(.is-expanded) {
  transform: rotate(90deg);
}

.conversation-goal-details {
  @apply flex items-center justify-between gap-3 border-t border-zinc-200 px-3 py-2 text-xs text-zinc-500;
}

.conversation-goal-editor {
  @apply min-h-16 min-w-0 flex-1 resize-none rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-sm text-zinc-800 outline-none focus:border-zinc-500;
}

.conversation-goal-editor-actions {
  @apply flex shrink-0 items-center gap-2;
}

.conversation-goal-editor-actions button {
  @apply rounded-full border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-default disabled:opacity-40;
}

@media (max-width: 640px) {
  .conversation-goal-row {
    @apply px-1.5;
  }

  .conversation-goal-summary {
    @apply gap-1.5;
  }

  .conversation-goal-status {
    @apply max-w-28 truncate;
  }

  .conversation-goal-objective {
    @apply hidden;
  }

  .conversation-goal-actions {
    @apply gap-0;
  }

  .conversation-goal-action {
    @apply h-8 w-8;
  }
}
</style>
