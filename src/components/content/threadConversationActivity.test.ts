import { describe, expect, it } from 'vitest'
import type { UiMessage } from '../../types/codex'
import {
  getHiddenCompletedActivityMessageIds,
  getTurnActivityMessagesForWorked,
  isThreadActivityMessage,
} from './threadConversationActivity'

function message(
  id: string,
  role: UiMessage['role'],
  text: string,
  messageType?: string,
): UiMessage {
  return { id, role, text, messageType }
}

describe('thread conversation completed activity grouping', () => {
  it('treats reasoning, commands, tool events, images, and compaction as turn activity', () => {
    const activityTypes = [
      'reasoning',
      'commandExecution',
      'mcpToolCall',
      'collabAgentToolCall',
      'webSearch',
      'imageView',
      'contextCompaction',
      'fileChange',
      'plan',
    ]

    for (const messageType of activityTypes) {
      expect(isThreadActivityMessage(message(messageType, 'assistant', messageType, messageType))).toBe(true)
    }

    expect(isThreadActivityMessage(message('assistant', 'assistant', 'final answer', 'agentMessage'))).toBe(false)
    expect(isThreadActivityMessage(message('user', 'user', 'prompt', 'userMessage'))).toBe(false)
  })

  it('folds completed turn activity under the worked separator without hiding the final answer', () => {
    const messages: UiMessage[] = [
      message('user-1', 'user', 'do it', 'userMessage'),
      message('reasoning-1', 'assistant', 'Reading files', 'reasoning'),
      {
        ...message('cmd-1', 'system', 'sed -n 1,20p file.ts', 'commandExecution'),
        commandExecution: {
          command: 'sed -n 1,20p file.ts',
          cwd: '/tmp/project',
          status: 'completed',
          aggregatedOutput: 'content',
          exitCode: 0,
          displayLabel: 'Read file.ts',
        },
      },
      message('image-1', 'assistant', 'Viewed an image', 'imageView'),
      message('worked-1', 'system', 'Worked for 1m 25s', 'worked'),
      message('assistant-1', 'assistant', 'Final answer', 'agentMessage'),
    ]

    expect(getTurnActivityMessagesForWorked(messages, 4).map((row) => row.id)).toEqual([
      'reasoning-1',
      'cmd-1',
      'image-1',
    ])
    expect(Array.from(getHiddenCompletedActivityMessageIds(messages)).sort()).toEqual([
      'cmd-1',
      'image-1',
      'reasoning-1',
    ])
  })
})
