<template>
  <header class="content-header">
    <div class="content-leading" :class="{ 'is-accent': accent }">
      <slot name="leading" />
    </div>
    <div class="content-title-wrap">
      <input
        v-if="isEditing"
        ref="titleInputRef"
        v-model="titleDraft"
        class="content-title-input"
        type="text"
        :aria-label="`Rename ${title}`"
        :disabled="disabled"
        @blur="submitRename"
        @keydown.enter.prevent="submitRename"
        @keydown.esc.prevent="cancelRename"
      />
      <h1
        v-else
        class="content-title"
        :class="{ 'is-accent': accent }"
        :title="title"
      >
        {{ title }}
      </h1>
      <button
        v-if="editable && !accent && !isEditing"
        class="content-title-edit"
        type="button"
        :disabled="disabled"
        :aria-label="`Rename ${title}`"
        :title="`Rename ${title}`"
        @click="beginRename"
      >
        <IconTablerFilePencil />
      </button>
    </div>
    <div class="content-actions">
      <slot name="actions" />
    </div>
  </header>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import IconTablerFilePencil from '../icons/IconTablerFilePencil.vue'

const props = defineProps<{
  title: string
  accent?: boolean
  editable?: boolean
  disabled?: boolean
}>()

const emit = defineEmits<{
  rename: [title: string]
}>()

const isEditing = ref(false)
const titleDraft = ref(props.title)
const titleInputRef = ref<HTMLInputElement | null>(null)

function beginRename(): void {
  if (!props.editable || props.disabled) return
  titleDraft.value = props.title
  isEditing.value = true
  void nextTick(() => {
    titleInputRef.value?.focus()
    titleInputRef.value?.select()
  })
}

function cancelRename(): void {
  titleDraft.value = props.title
  isEditing.value = false
}

function submitRename(): void {
  if (!isEditing.value) return
  const title = titleDraft.value.trim()
  isEditing.value = false
  if (!title || title === props.title) {
    titleDraft.value = props.title
    return
  }
  emit('rename', title)
}

watch(
  () => props.title,
  (title) => {
    if (!isEditing.value) titleDraft.value = title
  },
)
</script>

<style scoped>
@reference "tailwindcss";

.content-header {
  @apply relative z-[250] w-full min-w-0 min-h-12 sm:min-h-14 flex items-center gap-2 sm:gap-3 px-2 sm:px-3 pt-3 sm:pt-4 pb-2 bg-white;
  max-width: 100%;
  overflow: hidden;
}

.content-title-wrap {
  @apply flex min-w-0 flex-1 items-center gap-1;
}

.content-title {
  @apply m-0 min-w-0 max-w-[min(72ch,100%)] flex-1 text-sm font-medium leading-6 text-slate-900 max-sm:text-xs;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.content-title.is-accent {
  @apply text-lg font-semibold leading-7 tracking-[-0.01em] text-zinc-950 sm:text-[1.4rem];
}

.content-title-input {
  @apply h-8 min-w-0 flex-1 rounded-md border border-zinc-300 bg-white px-2 text-sm font-medium text-zinc-900 outline-none focus:border-zinc-500;
}

.content-title-edit {
  @apply inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-0 bg-transparent text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900 disabled:cursor-default disabled:opacity-40;
}

.content-title-edit :deep(svg) {
  @apply h-4 w-4;
}

.content-actions {
  @apply ml-auto flex min-w-0 shrink-0 items-center justify-end gap-1;
  max-width: min(60%, 24rem);
}

.content-leading {
  @apply flex shrink-0 items-center gap-1;
}

.content-leading.is-accent {
  @apply gap-2;
}

:global(:root.dark) .content-title.is-accent {
  @apply text-zinc-100;
}

:global(:root.dark) .content-title {
  @apply text-zinc-100;
}

:global(:root.dark) .content-title-input {
  @apply border-zinc-700 bg-zinc-900 text-zinc-100 focus:border-zinc-500;
}

:global(:root.dark) .content-title-edit {
  @apply text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100;
}

@media (max-width: 640px) {
  .content-header {
    @apply gap-1 px-2;
  }

  .content-actions {
    max-width: 56%;
  }

  .content-title-edit {
    @apply h-7 w-7;
  }
}
</style>
