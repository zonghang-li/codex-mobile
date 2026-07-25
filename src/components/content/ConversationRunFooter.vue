<template>
  <div v-if="footerState" class="conversation-run-footer" aria-live="polite">
    <div class="conversation-run-footer-pill">
      <ConversationProgressDonut
        v-if="footerState.stepNumber !== null"
        :value="footerState.completedPercent"
      />
      <span v-if="footerState.stepNumber !== null" class="conversation-run-footer-step">
        {{
          t('Step {step} / {count}', {
            step: footerState.stepNumber,
            count: footerState.stepCount,
          })
        }}
      </span>
      <span
        v-if="footerState.stepNumber !== null && footerState.fileCount > 0"
        class="conversation-run-footer-separator"
        aria-hidden="true"
      >
        ·
      </span>
      <span v-if="footerState.fileCount > 0" class="conversation-run-footer-files">
        {{ formatFileCount(footerState.fileCount) }}
      </span>
      <span v-if="footerState.additions > 0" class="conversation-run-footer-delta is-added">
        +{{ footerState.additions }}
      </span>
      <span v-if="footerState.deletions > 0" class="conversation-run-footer-delta is-deleted">
        -{{ footerState.deletions }}
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ConversationFooterState } from '../../types/codex'
import { useUiLanguage } from '../../composables/useUiLanguage'
import ConversationProgressDonut from './ConversationProgressDonut.vue'

defineProps<{
  footerState: ConversationFooterState | null
}>()

const { t } = useUiLanguage()

function formatFileCount(count: number): string {
  return count === 1 ? t('1 file changed') : t('{count} files changed', { count })
}
</script>

<style scoped>
@reference "tailwindcss";

.conversation-run-footer {
  @apply flex w-full min-w-0 justify-center;
}

.conversation-run-footer-pill {
  @apply inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-2xl border border-zinc-300 bg-zinc-100/95 px-3 py-1.5 text-sm leading-5 text-zinc-600 shadow-sm backdrop-blur;
}

:global(.dark) .conversation-run-footer-pill {
  @apply border-zinc-700 bg-zinc-800/95 text-zinc-300 shadow-lg shadow-black/20;
}

.conversation-run-footer-step,
.conversation-run-footer-files {
  @apply min-w-0 truncate tabular-nums;
}

.conversation-run-footer-separator {
  @apply shrink-0 text-zinc-400;
}

.conversation-run-footer-delta {
  @apply shrink-0 font-medium tabular-nums;
}

.conversation-run-footer-delta.is-added {
  @apply text-emerald-500;
}

.conversation-run-footer-delta.is-deleted {
  @apply text-rose-500;
}
</style>
