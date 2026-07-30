<template>
  <div v-if="messages.length > 0" class="queued-messages">
    <div class="queued-messages-inner">
    <div
      v-for="(msg, index) in messages"
      :key="msg.id"
      class="queued-row"
    >
      <div class="queued-row-order-actions">
        <button
          class="queued-row-move queued-row-move-up"
          type="button"
          :aria-label="t('Move queued message up')"
          :title="t('Move queued message up')"
          :disabled="disabled || index === 0"
          @click="onMove(msg.id, -1)"
        >
          <IconTablerChevronDown class="queued-row-move-up-icon" />
        </button>
        <button
          class="queued-row-move queued-row-move-down"
          type="button"
          :aria-label="t('Move queued message down')"
          :title="t('Move queued message down')"
          :disabled="disabled || index === messages.length - 1"
          @click="onMove(msg.id, 1)"
        >
          <IconTablerChevronDown />
        </button>
      </div>
      <span class="queued-row-text">{{ getMessagePreview(msg) }}</span>
      <div class="queued-row-actions">
        <button class="queued-row-edit" type="button" :title="t('Edit queued message')" :disabled="disabled" @click="onEdit(msg.id)">{{ t('Edit') }}</button>
        <button class="queued-row-steer" type="button" :title="t('Send now without interrupting work')" :disabled="isSteerDisabled(msg.id)" @click="onSteer(msg.id)">{{ t('Steer') }}</button>
        <button class="queued-row-delete" type="button" :aria-label="t('Delete queued message')" :title="t('Delete queued message')" :disabled="disabled" @click="onDelete(msg.id)">
          <IconTablerTrash />
        </button>
      </div>
    </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useUiLanguage } from '../../composables/useUiLanguage'
import IconTablerChevronDown from '../icons/IconTablerChevronDown.vue'
import IconTablerTrash from '../icons/IconTablerTrash.vue'

type QueuedMessageRow = {
  id: string
  text: string
  imageUrls?: string[]
  skills?: Array<{ name: string; path: string }>
  fileAttachments?: Array<{ label: string; path: string; fsPath: string }>
}

const props = defineProps<{
  messages: QueuedMessageRow[]
  disabled?: boolean
  steerDisabled?: boolean
  steerDisabledMessageIds?: string[]
}>()

const emit = defineEmits<{
  edit: [messageId: string]
  steer: [messageId: string]
  delete: [messageId: string]
  reorder: [payload: { draggedId: string; targetId: string }]
}>()

const { t } = useUiLanguage()
const steerDisabledMessageIdSet = computed(() => new Set(props.steerDisabledMessageIds ?? []))

function onEdit(messageId: string): void {
  if (props.disabled) return
  emit('edit', messageId)
}

function onSteer(messageId: string): void {
  if (isSteerDisabled(messageId)) return
  emit('steer', messageId)
}

function isSteerDisabled(messageId: string): boolean {
  return props.steerDisabled === true || steerDisabledMessageIdSet.value.has(messageId)
}

function onDelete(messageId: string): void {
  if (props.disabled) return
  emit('delete', messageId)
}

function onMove(messageId: string, direction: -1 | 1): void {
  if (props.disabled) return
  const index = props.messages.findIndex((message) => message.id === messageId)
  const target = props.messages[index + direction]
  if (index < 0 || !target) return
  emit('reorder', { draggedId: messageId, targetId: target.id })
}

function getMessagePreview(message: QueuedMessageRow): string {
  const text = message.text.trim()
  if (text) return text

  const parts: string[] = []
  const imageCount = message.imageUrls?.length ?? 0
  const fileCount = message.fileAttachments?.length ?? 0
  const skillCount = message.skills?.length ?? 0

  if (imageCount > 0) parts.push(`${imageCount} ${t(imageCount === 1 ? 'image' : 'images')}`)
  if (fileCount > 0) parts.push(`${fileCount} ${t(fileCount === 1 ? 'file' : 'files')}`)
  if (skillCount > 0) parts.push(`${skillCount} ${t(skillCount === 1 ? 'skill' : 'skills')}`)

  return parts.join(', ') || t('(empty queued message)')
}
</script>

<style scoped>
@reference "tailwindcss";

.queued-messages {
  @apply w-full max-w-[min(var(--chat-column-max,45rem),100%)] mx-auto;
}

.queued-messages-inner {
  @apply flex max-h-[30dvh] flex-col gap-px overflow-y-auto rounded-t-2xl border-x border-t border-zinc-300 bg-zinc-50/80 px-3 py-1.5;
}

.queued-row {
  @apply flex min-w-0 items-center gap-2 rounded-lg py-1 text-sm transition;
}

.queued-row-order-actions {
  @apply flex shrink-0 items-center gap-0.5;
}

.queued-row-move {
  @apply inline-flex h-6 w-6 items-center justify-center rounded-md border-0 bg-transparent text-zinc-400 transition hover:bg-zinc-200 hover:text-zinc-700;
}

.queued-row-move-up-icon {
  transform: rotate(180deg);
}

.queued-row-move:disabled,
.queued-row-edit:disabled,
.queued-row-steer:disabled,
.queued-row-delete:disabled {
  @apply cursor-not-allowed opacity-50;
}

.queued-row-icon {
  @apply h-4 w-4 shrink-0 text-zinc-400;
}

.queued-row-text {
  @apply min-w-0 flex-1 truncate text-zinc-700;
}

.queued-row-actions {
  @apply flex shrink-0 items-center gap-1;
}

.queued-row-steer {
  @apply rounded-md border border-zinc-300 bg-white px-2 py-0.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100;
}

.queued-row-edit {
  @apply rounded-md border border-zinc-300 bg-white px-2 py-0.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100;
}

.queued-row-delete {
  @apply inline-flex h-6 w-6 items-center justify-center rounded-md border-0 bg-transparent text-zinc-400 transition hover:bg-zinc-200 hover:text-zinc-700;
}
</style>
