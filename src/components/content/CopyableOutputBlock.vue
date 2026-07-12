<template>
  <div class="copyable-output-block">
    <slot />
    <button
      v-if="copyText.length > 0"
      type="button"
      class="output-block-copy-button"
      :data-copied="copied"
      :aria-label="copied ? 'Copied' : label"
      :title="copied ? 'Copied' : label"
      @click.stop="copyOutput"
    >
      <IconTablerCopy class="output-block-copy-icon" />
      <span>{{ copied ? 'Copied' : 'Copy' }}</span>
    </button>
    <span class="output-block-copy-status" aria-live="polite">{{ errorText }}</span>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { createOutputBlockCopyController } from './outputBlockCopyController'
import IconTablerCopy from '../icons/IconTablerCopy.vue'

const props = defineProps<{
  copyText: string
  label: string
}>()

const copied = ref(false)
const errorText = ref('')

const controller = createOutputBlockCopyController({
  getCopyText: () => props.copyText,
  onStateChange: (state) => {
    copied.value = state.copied
    errorText.value = state.errorText
  },
})

function copyOutput(event: MouseEvent): Promise<void> {
  return controller.copyOutput(event)
}

onBeforeUnmount(controller.dispose)
</script>

<style scoped>
.copyable-output-block {
  position: relative;
  min-width: 0;
  flex: 1;
}

.output-block-copy-button {
  position: absolute;
  top: 0;
  right: 0;
  z-index: 1;
  display: inline-flex;
  min-width: 32px;
  min-height: 32px;
  align-items: center;
  justify-content: center;
  gap: 0.25rem;
  padding: 0.25rem 0.5rem;
  border: 1px solid rgb(203 213 225 / 0.9);
  border-radius: 9999px;
  background: rgb(255 255 255 / 0.92);
  color: rgb(71 85 105);
  font-size: 0.6875rem;
  line-height: 1;
  transition: opacity 150ms ease, color 150ms ease, border-color 150ms ease;
}

.output-block-copy-button:hover,
.output-block-copy-button:focus-visible {
  border-color: rgb(148 163 184);
  color: rgb(15 23 42);
}

.output-block-copy-button:focus-visible {
  outline: 2px solid rgb(56 189 248);
  outline-offset: 2px;
}

.output-block-copy-button[data-copied='true'] {
  color: rgb(4 120 87);
}

.output-block-copy-icon {
  width: 0.875rem;
  height: 0.875rem;
}

.output-block-copy-status {
  position: absolute;
  top: 2.125rem;
  right: 0;
  z-index: 1;
  color: rgb(190 18 60);
  font-size: 0.6875rem;
  line-height: 1rem;
}

@media (hover: none), (pointer: coarse) {
  .output-block-copy-button {
    opacity: 1;
    pointer-events: auto;
  }
}

@media (hover: hover) and (pointer: fine) {
  .output-block-copy-button {
    opacity: 0;
    pointer-events: none;
  }

  .copyable-output-block:hover .output-block-copy-button,
  .output-block-copy-button:focus-visible {
    opacity: 1;
    pointer-events: auto;
  }
}
</style>
