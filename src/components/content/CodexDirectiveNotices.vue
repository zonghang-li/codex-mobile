<template>
  <div class="codex-directive-list" aria-label="Codex status">
    <article
      v-for="(directive, index) in directives"
      :key="`${directive.kind}:${index}`"
      class="codex-directive-notice"
      :class="{
        'codex-directive-notice-generic': directive.kind === 'generic',
        'codex-directive-notice-invalid': directive.kind === 'invalid',
      }"
      :data-kind="directive.kind"
      :role="directive.kind === 'invalid' ? 'status' : undefined"
    >
      <span class="codex-directive-icon" aria-hidden="true">
        {{ directive.kind === 'invalid' ? '!' : directive.kind === 'generic' ? 'i' : '✓' }}
      </span>
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
          <span class="codex-directive-meta">{{ codexDirectiveLocation(directive) }}</span>
          <p class="codex-directive-body">{{ directive.body }}</p>
        </template>
        <dl
          v-else-if="directive.kind === 'generic'"
          class="codex-directive-attributes"
        >
          <div
            v-for="attribute in directive.attributes"
            :key="attribute.key"
          >
            <dt>{{ attribute.key }}</dt>
            <dd>{{ attribute.value }}</dd>
          </div>
        </dl>
        <template v-else-if="directive.kind === 'invalid'">
          <span v-if="directive.name" class="codex-directive-meta">{{ directive.name }}</span>
          <p class="codex-directive-body">{{ codexDirectiveInvalidReason(directive, t) }}</p>
        </template>
      </div>
    </article>
  </div>
</template>

<script setup lang="ts">
import type { UiCodexDirective } from '../../types/codex'
import { useUiLanguage } from '../../composables/useUiLanguage'
import {
  codexDirectiveHref,
  codexDirectiveInvalidReason,
  codexDirectiveLabel,
  codexDirectiveLocation,
} from '../../utils/codexDirectives'

defineProps<{ directives: UiCodexDirective[] }>()

const { t } = useUiLanguage()
</script>
