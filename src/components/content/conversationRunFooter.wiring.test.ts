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
const donutSource = readFileSync(
  new URL('./ConversationProgressDonut.vue', import.meta.url),
  'utf8',
)
const conversationSource = readFileSync(
  new URL('./ThreadConversation.vue', import.meta.url),
  'utf8',
)
const globalStyleSource = readFileSync(
  new URL('../../style.css', import.meta.url),
  'utf8',
)

describe('ConversationRunFooter desktop parity wiring', () => {
  it('keeps the current plan and diff pill outside the scroll container above the composer', () => {
    const footerIndex = appSource.indexOf('<ConversationRunFooter')
    const conversationIndex = appSource.indexOf('<ThreadConversation')
    const composerIndex = appSource.indexOf('<ThreadComposer', conversationIndex)

    expect(footerIndex).toBeGreaterThan(conversationIndex)
    expect(footerIndex).toBeLessThan(composerIndex)
    expect(appSource).toContain(':footer-state="selectedConversationFooterState"')
    expect(appSource).toContain('deriveConversationFooterState({')
  })

  it('renders the desktop step, file, addition, and deletion fields', () => {
    expect(footerSource).toContain('Step {step} / {count}')
    expect(footerSource).toContain('formatFileCount(footerState.fileCount)')
    expect(footerSource).toContain('+{{ footerState.additions }}')
    expect(footerSource).toContain('-{{ footerState.deletions }}')
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

  it('uses an accessible progress primitive', () => {
    expect(donutSource).toContain('role="progressbar"')
    expect(donutSource).toContain(':aria-valuenow="roundedValue"')
    expect(donutSource).toContain('conic-gradient(')
  })

  it('suppresses active-turn plan and diff source rows from the scrolling transcript', () => {
    expect(conversationSource).toContain('hiddenActiveFooterMessageIds')
    expect(conversationSource).toContain("message.messageType === 'fileChange'")
    expect(conversationSource).toContain("message.messageType === 'plan.live'")
  })

  it('renders anchored file changes only for historical turns', () => {
    expect(conversationSource).toMatch(
      /function readAnchoredFileChangeSummary\(message: UiMessage\): TurnFileChangeSummary \| null \{[\s\S]*const summary = anchoredFileChangeSummaryByAnchorId\.value\[message\.id\] \?\? null[\s\S]*const activeTurnId = props\.activeTurnId\?\.trim\(\) \?\? ''[\s\S]*if \(activeTurnId && summary\?\.turnId === activeTurnId\) return null[\s\S]*return summary[\s\S]*\}/u,
    )
    expect(conversationSource).toContain(
      '<section v-if="readAnchoredFileChangeSummary(message)" class="file-change-summary-block file-change-summary-block-inline">',
    )
  })

  it('keeps response actions before historical summaries and the active footer before Goal and the composer', () => {
    const responseIndex = conversationSource.indexOf('<CodexDirectiveNotices')
    const toolbarIndex = conversationSource.indexOf('class="message-toolbar"', responseIndex)
    const forkIndex = conversationSource.indexOf('class="message-fork-button"', toolbarIndex)
    const copyIndex = conversationSource.indexOf('class="message-copy-button"', toolbarIndex)
    const historicalSummaryIndex = conversationSource.indexOf(
      '<section v-if="readAnchoredFileChangeSummary(message)"',
      toolbarIndex,
    )
    const conversationIndex = appSource.indexOf('<ThreadConversation')
    const footerIndex = appSource.indexOf('<ConversationRunFooter', conversationIndex)
    const composerIndex = appSource.indexOf('<ThreadComposer', footerIndex)
    const activeFooterIndex = footerSource.indexOf('class="conversation-run-footer-pill"')
    const goalIndex = footerSource.indexOf('class="conversation-goal-strip"', activeFooterIndex)

    expect(toolbarIndex).toBeGreaterThan(responseIndex)
    expect(forkIndex).toBeGreaterThan(toolbarIndex)
    expect(copyIndex).toBeGreaterThan(forkIndex)
    expect(historicalSummaryIndex).toBeGreaterThan(copyIndex)
    expect(footerIndex).toBeGreaterThan(conversationIndex)
    expect(footerIndex).toBeLessThan(composerIndex)
    expect(goalIndex).toBeGreaterThan(activeFooterIndex)
  })

  it('keeps Fork and Copy visible with touch-sized targets on coarse pointers', () => {
    const forkStylesIndex = conversationSource.indexOf('.message-fork-button {')
    const copyStylesIndex = conversationSource.indexOf('.message-copy-button {')
    const coarsePointerStylesIndex = conversationSource.indexOf(
      '@media (hover: none), (pointer: coarse)',
    )

    expect(coarsePointerStylesIndex).toBeGreaterThan(forkStylesIndex)
    expect(coarsePointerStylesIndex).toBeGreaterThan(copyStylesIndex)
    expect(conversationSource).toMatch(
      /@media \(hover: none\), \(pointer: coarse\) \{[\s\S]*\.message-toolbar \{[\s\S]*@apply opacity-100;[\s\S]*\.message-fork-button,[\s\S]*\.message-copy-button,[\s\S]*\.message-edit-button \{[\s\S]*@apply [^;]*min-h-11[^;]*text-xs/u,
    )
  })

  it('uses dark theme surfaces for the Goal creation menu', () => {
    expect(globalStyleSource).toContain(':root.dark .thread-composer-goal-trigger')
    expect(globalStyleSource).toContain(':root.dark .thread-composer-goal-menu')
    expect(globalStyleSource).toContain(':root.dark .thread-composer-goal-menu-input')
    expect(globalStyleSource).toMatch(
      /:root\.dark \.thread-composer-goal-menu\s*\{\s*@apply [^;]*border-zinc-700 [^;]*bg-zinc-900 [^;]*text-zinc-100/u,
    )
  })
})
