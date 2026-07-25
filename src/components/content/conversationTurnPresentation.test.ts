import { describe, expect, it } from 'vitest'
import type { UiMessage } from '../../types/codex'
import { projectConversationTurns } from './conversationTurnPresentation'

function message(
  id: string,
  role: UiMessage['role'],
  text: string,
  turnId: string,
  messageType?: string,
): UiMessage {
  return { id, role, text, turnId, messageType }
}

describe('projectConversationTurns', () => {
  it('keeps a running turn expanded and separates activity from assistant output', () => {
    const sections = projectConversationTurns({
      messages: [
        message('u1', 'user', 'Run tests', 'turn-1'),
        {
          ...message('c1', 'assistant', '', 'turn-1', 'commandExecution'),
          commandExecution: {
            command: 'pnpm test',
            cwd: null,
            status: 'inProgress',
            aggregatedOutput: '',
            exitCode: null,
          },
        },
        {
          ...message('a1', 'assistant', '', 'turn-1', 'subAgentActivity'),
          activity: {
            kind: 'subAgent',
            label: 'Reviewer',
            agentThreadId: 'child-1',
          },
        },
        message('draft', 'assistant', '', 'turn-1', 'agentMessage.live'),
      ],
      activeTurnId: 'turn-1',
    })

    expect(sections).toEqual([{
      turnId: 'turn-1',
      userMessageIds: ['u1'],
      activityMessageIds: ['c1', 'a1'],
      finalMessageId: null,
      completionMessageId: null,
      completionLabel: null,
      isCollapsed: false,
    }])
  })

  it('collapses completed activity while leaving the final assistant response visible', () => {
    const sections = projectConversationTurns({
      messages: [
        message('u1', 'user', 'Run tests', 'turn-1'),
        {
          ...message('c1', 'assistant', '', 'turn-1', 'commandExecution'),
          commandExecution: {
            command: 'pnpm test',
            cwd: null,
            status: 'completed',
            aggregatedOutput: 'ok',
            exitCode: 0,
          },
        },
        message('worked', 'system', 'Worked for 1m 25s', 'turn-1', 'worked'),
        message('final', 'assistant', 'All tests pass.', 'turn-1', 'agentMessage'),
      ],
      activeTurnId: null,
    })

    expect(sections).toEqual([{
      turnId: 'turn-1',
      userMessageIds: ['u1'],
      activityMessageIds: ['c1'],
      finalMessageId: 'final',
      completionMessageId: 'worked',
      completionLabel: 'Worked for 1m 25s',
      isCollapsed: true,
    }])
  })

  it('never promotes subagent result payloads into the parent final response', () => {
    const sections = projectConversationTurns({
      messages: [
        message('u1', 'user', 'Review this', 'turn-1'),
        {
          ...message('child', 'assistant', 'Private child transcript', 'turn-1', 'collabAgentToolCall'),
          activity: {
            kind: 'subAgent',
            label: 'Reviewer finished',
            collabAgent: {
              tool: 'wait',
              receiverThreadIds: ['child-1'],
              agentsStates: { 'child-1': 'completed' },
            },
          },
        },
        message('worked', 'system', 'Worked for 4s', 'turn-1', 'worked'),
        message('final', 'assistant', 'Review complete.', 'turn-1', 'agentMessage'),
      ],
      activeTurnId: null,
    })

    expect(sections[0]?.activityMessageIds).toEqual(['child'])
    expect(sections[0]?.finalMessageId).toBe('final')
  })

  it('deduplicates live and persisted copies with the same message identity', () => {
    const duplicated = message('final', 'assistant', 'Done.', 'turn-1', 'agentMessage')
    const sections = projectConversationTurns({
      messages: [
        message('u1', 'user', 'Finish', 'turn-1'),
        duplicated,
        { ...duplicated },
      ],
      activeTurnId: null,
    })

    expect(sections[0]?.finalMessageId).toBe('final')
    expect(sections[0]?.userMessageIds).toEqual(['u1'])
  })

  it('uses turnIndex only when a turnId is unavailable', () => {
    const sections = projectConversationTurns({
      messages: [
        { ...message('u1', 'user', 'First', '', undefined), turnId: undefined, turnIndex: 3 },
        { ...message('final', 'assistant', 'Done.', '', 'agentMessage'), turnId: undefined, turnIndex: 3 },
      ],
      activeTurnId: null,
    })

    expect(sections).toHaveLength(1)
    expect(sections[0]?.turnId).toBe('turn-index:3')
    expect(sections[0]?.finalMessageId).toBe('final')
  })
})
