<template>
  <span
    class="conversation-progress-donut"
    role="progressbar"
    aria-valuemin="0"
    aria-valuemax="100"
    :aria-valuenow="roundedValue"
    :style="{ '--progress': `${roundedValue * 3.6}deg` }"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ value: number }>()
const roundedValue = computed(() =>
  Math.max(0, Math.min(100, Math.round(props.value))),
)
</script>

<style scoped>
.conversation-progress-donut {
  display: inline-block;
  width: 1rem;
  height: 1rem;
  flex: 0 0 auto;
  border-radius: 9999px;
  color: rgb(14 165 233);
  background: conic-gradient(
    currentColor var(--progress),
    color-mix(in srgb, currentColor 18%, transparent) 0
  );
  mask: radial-gradient(circle, transparent 42%, #000 44%);
}
</style>
