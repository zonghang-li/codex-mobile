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
const donutSource = readFileSync(
  new URL('./ConversationProgressDonut.vue', import.meta.url),
  'utf8',
)
const conversationSource = readFileSync(
  new URL('./ThreadConversation.vue', import.meta.url),
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

  it('renders the desktop goal strip with edit, pause/resume, delete, and expansion controls', () => {
    expect(appSource).toContain(':goal="selectedThreadGoal"')
    expect(appSource).toContain('@set-goal="updateSelectedThreadGoal"')
    expect(appSource).toContain('@clear-goal="clearSelectedThreadGoal"')
    expect(footerSource).toContain('deriveThreadGoalPresentation')
    expect(footerSource).toContain('goal-pause-button')
    expect(footerSource).toContain('goal-resume-button')
    expect(footerSource).toContain('goal-edit-button')
    expect(footerSource).toContain('goal-clear-button')
    expect(footerSource).toContain('goal-expand-button')
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
})
