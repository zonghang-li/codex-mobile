import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const conversationSource = readFileSync(
  new URL('./ThreadConversation.vue', import.meta.url),
  'utf8',
)
const composerSource = readFileSync(
  new URL('./ThreadComposer.vue', import.meta.url),
  'utf8',
)
const appSource = readFileSync(
  new URL('../../App.vue', import.meta.url),
  'utf8',
)

describe('mobile conversation message actions', () => {
  it('does not offer rollback editing after a user message is sent', () => {
    expect(conversationSource).not.toContain('Edit message')
    expect(conversationSource).not.toContain("emit('rollback'")
    expect(appSource).not.toContain('@rollback="onRollback"')
    expect(appSource).not.toContain('function onRollback(')
  })

  it('submits running-turn input with the configured queue or steer mode', () => {
    expect(composerSource).toContain(
      "props.isTurnInProgress ? props.inProgressSubmitMode ?? 'queue' : 'steer'",
    )
    expect(composerSource).not.toContain(
      "onSubmit(isTurnInProgress ? activeInProgressMode : 'steer')",
    )
  })

  it('shows turn errors without a feedback action in the conversation stream', () => {
    expect(conversationSource).not.toContain('turn-error-feedback')
    expect(conversationSource).not.toContain('prepareTurnErrorFeedback')
    expect(conversationSource).not.toContain('Send feedback')
  })
})
