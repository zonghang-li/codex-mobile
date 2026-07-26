<template>
  <IconTablerBook2 v-if="kind === 'book'" class="icon-svg codex-activity-icon" />
  <IconTablerSearch v-else-if="kind === 'search'" class="icon-svg codex-activity-icon" />
  <IconTablerFilePencil v-else-if="kind === 'edit'" class="icon-svg codex-activity-icon" />
  <IconTablerTerminal v-else-if="kind === 'terminal'" class="icon-svg codex-activity-icon" />
  <IconTablerAffiliate v-else-if="kind === 'integration' || kind === 'agent'" class="icon-svg codex-activity-icon" />
  <IconTablerPhoto v-else-if="kind === 'image'" class="icon-svg codex-activity-icon" />
  <IconTablerInfoCircle v-else class="icon-svg codex-activity-icon" />
</template>

<script setup lang="ts">
import type { ThreadActivityIconKind } from './threadConversationActivity'
import IconTablerAffiliate from '../icons/IconTablerAffiliate.vue'
import IconTablerBook2 from '../icons/IconTablerBook2.vue'
import IconTablerFilePencil from '../icons/IconTablerFilePencil.vue'
import IconTablerInfoCircle from '../icons/IconTablerInfoCircle.vue'
import IconTablerPhoto from '../icons/IconTablerPhoto.vue'
import IconTablerSearch from '../icons/IconTablerSearch.vue'
import IconTablerTerminal from '../icons/IconTablerTerminal.vue'

defineProps<{ kind: ThreadActivityIconKind }>()
</script>
