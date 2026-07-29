import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(
  new URL('../../App.vue', import.meta.url),
  'utf8',
)
const footerSource = readFileSync(
  new URL('./ConversationRunFooter.vue', import.meta.url),
  'utf8',
)
const composerSource = readFileSync(
  new URL('./ThreadComposer.vue', import.meta.url),
  'utf8',
)
const conversationSource = readFileSync(
  new URL('./ThreadConversation.vue', import.meta.url),
  'utf8',
)
const gatewaySource = readFileSync(
  new URL('../../api/codexGateway.ts', import.meta.url),
  'utf8',
)
const serverSource = readFileSync(
  new URL('../../server/codexAppServerBridge.ts', import.meta.url),
  'utf8',
)
const globalStyleSource = readFileSync(
  new URL('../../style.css', import.meta.url),
  'utf8',
)

describe('ConversationRunFooter desktop parity wiring', () => {
  it('keeps Goal controls outside the scroll container above the composer without a file-change pill', () => {
    const footerIndex = appSource.indexOf('<ConversationRunFooter')
    const conversationIndex = appSource.indexOf('<ThreadConversation ref="threadConversationRef"')
    const composerIndex = appSource.indexOf('<ThreadComposer', conversationIndex)

    expect(footerIndex).toBeGreaterThan(conversationIndex)
    expect(footerIndex).toBeLessThan(composerIndex)
    expect(appSource).not.toContain(':footer-state="selectedConversationFooterState"')
    expect(appSource).not.toContain('deriveConversationFooterState({')
    expect(appSource).not.toContain('const selectedConversationFooterState')
  })

  it('does not render or format the removed file-change summary pill', () => {
    expect(footerSource).not.toContain('conversation-run-footer-pill')
    expect(footerSource).not.toContain('ConversationProgressDonut')
    expect(footerSource).not.toContain('Step {step} / {count}')
    expect(footerSource).not.toContain('formatFileCount')
    expect(footerSource).not.toContain('footerState.fileCount')
    expect(footerSource).not.toContain('footerState.additions')
    expect(footerSource).not.toContain('footerState.deletions')
    expect(footerSource).toContain('aria-live="polite"')
  })

  it('renders create, edit, pause, resume, complete, blocked, clear, and expansion Goal controls', () => {
    expect(appSource).toContain(':goal="selectedThreadGoal"')
    expect(appSource).toContain(':thread-id="selectedThreadId"')
    expect(appSource).toContain('@set-goal="updateSelectedThreadGoal"')
    expect(appSource).toContain('@clear-goal="clearSelectedThreadGoal"')
    expect(composerSource).toContain("emit('set-goal', { objective, status: 'active' })")
    expect(footerSource).toContain('deriveThreadGoalPresentation')
    expect(footerSource).toContain('useConversationGoalEditorState')
    expect(footerSource).toContain('goal-pause-button')
    expect(footerSource).toContain('goal-resume-button')
    expect(footerSource).toContain('goal-edit-button')
    expect(footerSource).toContain('goal-complete-button')
    expect(footerSource).toContain("emit('set-goal', { status: 'complete' })")
    expect(footerSource).toContain('goal-blocked-button')
    expect(footerSource).toContain("emit('set-goal', { status: 'blocked' })")
    expect(footerSource).toContain('goal-clear-button')
    expect(footerSource).toContain('goal-expand-button')
    expect(globalStyleSource).toContain(':root.dark .conversation-goal-strip')
  })

  it('does not make Goal controls read-only for an external turn owner', () => {
    expect(appSource).not.toContain(
      '<ConversationRunFooter\n                    :footer-state="selectedConversationFooterState"\n                    :goal="selectedThreadGoal"\n                    :goal-supported="selectedThreadGoalSupported"\n                    :read-only="selectedThreadRuntimeOwnership === \'external\'"',
    )
    expect(footerSource).not.toContain('v-if="!readOnly"')
  })

  it('requires an accessible inline second click before clearing a goal', () => {
    expect(footerSource).toContain('isClearGoalConfirming')
    expect(footerSource).toContain('conversation-goal-clear-confirmation')
    expect(footerSource).toContain('role="group"')
    expect(footerSource).toContain(':aria-label="t(\'Confirm clear goal\')"')
    expect(footerSource).toContain('@click="cancelGoalClear()"')
    expect(footerSource).toContain('@click="requestGoalClear"')
    expect(footerSource).toContain('CLEAR_GOAL_CONFIRMATION_TIMEOUT_MS')
    expect(footerSource).toMatch(
      /function requestGoalClear\(\): void \{[\s\S]*if \(isClearGoalConfirming\.value\) \{[\s\S]*emit\('clear-goal'\)[\s\S]*return[\s\S]*\}[\s\S]*armGoalClearConfirmation\(\)/u,
    )
  })

  it('does not render file-change summaries in the scrolling transcript', () => {
    expect(conversationSource).not.toContain('file-change-summary-block')
    expect(conversationSource).not.toContain('readStandaloneFileChangeSummary(message)')
    expect(conversationSource).not.toContain('readAnchoredFileChangeSummary(message)')
    expect(conversationSource).not.toContain('fileChangeSummaryLabel(')
    expect(conversationSource).not.toContain('fileChangeSummaryStatusParts(')
    expect(conversationSource).not.toContain('diff-viewer')
    expect(conversationSource).not.toContain('Changed files')
    expect(conversationSource).not.toContain('changed files')
    expect(gatewaySource).not.toContain('thread-file-change-fallback')
    expect(gatewaySource).not.toContain('mergeRecoveredFileChangeMessages(')
    expect(serverSource).not.toContain('thread-file-change-fallback')
    expect(serverSource).not.toContain('buildSessionFileChangeFallback(')
  })

  it('suppresses active-turn plan source rows from the scrolling transcript', () => {
    expect(conversationSource).toContain('hiddenActiveFooterMessageIds')
    expect(conversationSource).toContain("message.messageType === 'fileChange'")
    expect(conversationSource).toContain('hiddenFileChangeMessageIds')
    expect(conversationSource).toContain("message.messageType === 'plan.live'")
  })

  it('keeps response actions before historical summaries and Goal before the composer', () => {
    const responseIndex = conversationSource.indexOf('<CodexDirectiveNotices')
    const toolbarIndex = conversationSource.indexOf('class="message-toolbar"', responseIndex)
    const forkIndex = conversationSource.indexOf('class="message-fork-button"', toolbarIndex)
    const copyIndex = conversationSource.indexOf('class="message-copy-button"', toolbarIndex)
    const conversationIndex = appSource.indexOf('<ThreadConversation')
    const footerIndex = appSource.indexOf('<ConversationRunFooter', conversationIndex)
    const composerIndex = appSource.indexOf('<ThreadComposer', footerIndex)

    expect(toolbarIndex).toBeGreaterThan(responseIndex)
    expect(copyIndex).toBeGreaterThan(toolbarIndex)
    expect(forkIndex).toBeGreaterThan(copyIndex)
    expect(conversationSource).toContain('class="message-copy-label"')
    expect(conversationSource).toContain('class="message-fork-label"')
    expect(conversationSource).toContain('class="message-completion-time"')
    expect(conversationSource).toContain('completionTimeLabel(message)')
    expect(conversationSource).toContain('completionTimeByFinalMessageId = computed(() =>')
    expect(conversationSource).not.toContain('if (!section.isCollapsed || !section.finalMessageId || !section.completionMessageId) continue')
    expect(conversationSource).not.toContain('message-copy-icon')
    expect(conversationSource).not.toContain('message-fork-icon')
    expect(conversationSource).toContain('aria-label="Fork thread from this response"')
    expect(conversationSource).toContain(
      "copiedResponseAnchorId === message.id ? 'Response copied' : 'Copy response'",
    )
    expect(footerIndex).toBeGreaterThan(conversationIndex)
    expect(footerIndex).toBeLessThan(composerIndex)
    expect(footerSource).toContain('class="conversation-goal-strip"')
  })

  it('uses rounded-rectangle text actions with touch-sized targets on coarse pointers', () => {
    const responseActionStylesIndex = conversationSource.indexOf('.message-copy-button,\n.message-fork-button {')
    const responseActionStylesEnd = conversationSource.indexOf('}', responseActionStylesIndex)
    const responseActionStyles = conversationSource.slice(responseActionStylesIndex, responseActionStylesEnd)
    const coarsePointerStylesIndex = conversationSource.indexOf(
      '@media (hover: none), (pointer: coarse)',
    )

    expect(responseActionStylesIndex).toBeGreaterThan(0)
    expect(coarsePointerStylesIndex).toBeGreaterThan(responseActionStylesIndex)
    expect(conversationSource).toMatch(
      /\.message-copy-button,[\s\S]*\.message-fork-button\s*\{[\s\S]*@apply [^;]*min-w-14[^;]*rounded-lg[^;]*border[^;]*bg-transparent/u,
    )
    expect(responseActionStyles).not.toContain('rounded-full')
    expect(conversationSource).toMatch(
      /@media \(hover: none\), \(pointer: coarse\) \{[\s\S]*\.message-toolbar \{[\s\S]*@apply opacity-100;[\s\S]*\.message-fork-button,[\s\S]*\.message-copy-button\s*\{[\s\S]*@apply [^;]*min-h-10[^;]*min-w-16[^;]*rounded-lg/u,
    )
    expect(conversationSource).toMatch(
      /\.message-toolbar:focus-within\s*\{\s*@apply opacity-100;\s*\}/u,
    )
    expect(conversationSource).toMatch(
      /\.message-completion-time\s*\{[\s\S]*@apply [^;]*text-\[11px\][^;]*text-slate-400/u,
    )
  })

  it('renders live errors as dismissible notifications instead of inline transcript rows', () => {
    expect(conversationSource).toContain('visibleLiveErrorText')
    expect(conversationSource).toContain('dismissLiveErrorNotification')
    expect(conversationSource).toContain('class="conversation-notification conversation-notification-error"')
    expect(conversationSource).toContain('aria-label="Dismiss error notification"')
    expect(conversationSource).not.toContain('class="live-overlay-error"')
  })

  it('renders semantic activity through the shared desktop-style icon component', () => {
    expect(conversationSource).toContain("import ThreadActivityIcon from './ThreadActivityIcon.vue'")
    expect(conversationSource).toContain('<ThreadActivityIcon')
    expect(conversationSource).toContain(':kind="activitySegmentIconKind(')
    expect(conversationSource).not.toContain(
      "message.messageType === 'imageView' || message.messageType === 'imageGeneration'",
    )
  })

  it('uses dark theme surfaces for the Goal creation menu', () => {
    expect(composerSource).not.toContain(':global(.dark) .thread-composer-goal')
    expect(globalStyleSource).toContain(':root.dark .thread-composer-goal-trigger')
    expect(globalStyleSource).toContain(':root.dark .thread-composer-goal-menu')
    expect(globalStyleSource).toContain(':root.dark .thread-composer-goal-menu-input')
    expect(globalStyleSource).toMatch(
      /:root\.dark \.thread-composer-goal-menu\s*\{\s*@apply [^;]*border-zinc-700 [^;]*bg-zinc-900 [^;]*text-zinc-100/u,
    )
  })
})
