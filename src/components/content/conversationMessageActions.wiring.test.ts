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

  it('always submits new running-turn input to the queue', () => {
    expect(composerSource).toContain(
      "props.isTurnInProgress ? 'queue' : 'steer'",
    )
    expect(composerSource).not.toContain(
      "onSubmit(isTurnInProgress ? activeInProgressMode : 'steer')",
    )
  })
})
