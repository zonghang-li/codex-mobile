<template>
  <div class="codex-directive-list" aria-label="Codex status">
    <article
      v-for="(directive, index) in directives"
      :key="`${directive.kind}:${index}`"
      class="codex-directive-notice"
      :data-kind="directive.kind"
    >
      <span class="codex-directive-icon" aria-hidden="true">✓</span>
      <div class="codex-directive-content">
        <a
          v-if="codexDirectiveHref(directive)"
          class="codex-directive-title"
          :href="codexDirectiveHref(directive) || undefined"
          :target="directive.kind === 'git-create-pr' ? '_blank' : undefined"
          :rel="directive.kind === 'git-create-pr' ? 'noopener noreferrer' : undefined"
        >{{ codexDirectiveLabel(directive, t) }}</a>
        <span v-else class="codex-directive-title">{{ codexDirectiveLabel(directive, t) }}</span>
        <template v-if="directive.kind === 'code-comment'">
          <span class="codex-directive-meta">{{ directive.file }}<template v-if="directive.start">:{{ directive.start }}</template></span>
          <p class="codex-directive-body">{{ directive.body }}</p>
        </template>
      </div>
    </article>
  </div>
</template>

<script setup lang="ts">
import type { UiCodexDirective } from '../../types/codex'
import { useUiLanguage } from '../../composables/useUiLanguage'
import { codexDirectiveHref, codexDirectiveLabel } from '../../utils/codexDirectives'

defineProps<{ directives: UiCodexDirective[] }>()

const { t } = useUiLanguage()
</script>
