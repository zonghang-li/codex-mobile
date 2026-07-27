import { describe, expect, it } from 'vitest'
import type { UiMessage } from '../../types/codex'
import {
  buildThreadActivitySegments,
  getHiddenCompletedActivityMessageIds,
  getTurnActivityMessagesForWorked,
  getTurnActivitySegmentsForWorked,
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
      'subAgentActivity',
      'dynamicToolCall',
      'sleep',
      'imageGeneration',
      'collaborationActivity',
    ]

    for (const messageType of activityTypes) {
      expect(isThreadActivityMessage(message(messageType, 'assistant', messageType, messageType))).toBe(true)
    }

    expect(isThreadActivityMessage(message('assistant', 'assistant', 'final answer', 'agentMessage'))).toBe(false)
    expect(isThreadActivityMessage(message('user', 'user', 'prompt', 'userMessage'))).toBe(false)
  })

  it('derives ordered desktop-style reasoning, concrete action rows, and agent chips', () => {
    const messages: UiMessage[] = [
      message('reasoning-1', 'assistant', 'Closing the final review', 'reasoning'),
      {
        ...message('file-1', 'system', '', 'fileChange'),
        fileChangeStatus: 'completed',
        fileChanges: [{
          path: 'src/App.vue',
          operation: 'update',
          diff: '',
          addedLineCount: 1,
          removedLineCount: 1,
        }],
      },
      {
        ...message('read-1', 'system', 'sed -n 1,80p src/App.vue', 'commandExecution'),
        commandExecution: {
          command: 'sed -n 1,80p src/App.vue',
          cwd: '/tmp/project',
          status: 'completed',
          aggregatedOutput: '',
          exitCode: 0,
          activityCategories: ['read'],
        },
      },
      {
        ...message('run-1', 'system', 'pnpm test', 'commandExecution'),
        commandExecution: {
          command: 'pnpm test',
          cwd: '/tmp/project',
          status: 'completed',
          aggregatedOutput: '',
          exitCode: 0,
          activityCategories: ['unknown'],
        },
      },
      {
        ...message('agent-1', 'system', 'Updated docs coverage review', 'subAgentActivity'),
        activity: {
          kind: 'subAgent',
          label: 'Updated docs coverage review',
          status: 'updated',
          agentThreadId: 'thread-docs',
          agentPath: '/root/updated_docs_coverage_review',
          subAgentKind: 'interacted',
        },
      },
    ]

    expect(buildThreadActivitySegments(messages)).toEqual([
      {
        kind: 'reasoning',
        id: 'reasoning-1',
        label: 'Closing the final review',
        iconKind: 'status',
        sourceMessageIds: ['reasoning-1'],
      },
      {
        kind: 'event',
        id: 'run-1',
        label: 'Ran pnpm test',
        iconKind: 'terminal',
        sourceMessageIds: ['file-1', 'read-1', 'run-1'],
      },
      {
        kind: 'subAgent',
        id: 'agent-1',
        agents: [{
          id: 'thread-docs',
          label: 'Updated docs coverage review',
          state: 'updated',
          tone: 'purple',
        }],
        status: 'updated',
        sourceMessageIds: ['agent-1'],
      },
    ])
  })

  it('shows only the latest concrete action detail for adjacent file and command activity', () => {
    const messages: UiMessage[] = [
      {
        ...message('file-1', 'system', '', 'fileChange'),
        fileChangeStatus: 'completed',
        fileChanges: [{
          path: 'src/App.vue',
          operation: 'update',
          diff: '',
          addedLineCount: 1,
          removedLineCount: 1,
        }],
      },
      {
        ...message('read-1', 'system', 'sed -n 1,80p src/App.vue', 'commandExecution'),
        commandExecution: {
          command: 'sed -n 1,80p src/App.vue',
          cwd: '/tmp/project',
          status: 'completed',
          aggregatedOutput: '',
          exitCode: 0,
          displayLabel: 'Read App component',
          activityCategories: ['read'],
        },
      },
      {
        ...message('run-1', 'system', 'pnpm exec vitest run src/App.test.ts', 'commandExecution'),
        commandExecution: {
          command: 'pnpm exec vitest run src/App.test.ts',
          cwd: '/tmp/project',
          status: 'inProgress',
          aggregatedOutput: '',
          exitCode: null,
          activityCategories: ['unknown'],
        },
      },
    ]

    expect(buildThreadActivitySegments(messages)).toEqual([{
      kind: 'event',
      id: 'run-1',
      label: 'Ran pnpm exec vitest run src/App.test.ts',
      iconKind: 'terminal',
      sourceMessageIds: ['file-1', 'read-1', 'run-1'],
    }])
  })

  it('groups adjacent subagent events but keeps clusters separated by parent transcript content', () => {
    const agent = (id: string, threadId: string, label: string): UiMessage => ({
      ...message(id, 'system', label, 'subAgentActivity'),
      activity: {
        kind: 'subAgent',
        label,
        status: 'started',
        agentThreadId: threadId,
        agentPath: `/root/${threadId}`,
        subAgentKind: 'started',
      },
    })
    const messages = [
      agent('docs', 'thread-docs', 'Docs reviewer'),
      agent('shell', 'thread-shell', 'Shell reviewer'),
      message('parent-commentary', 'assistant', 'Both reviewers are running.', 'agentMessage'),
      agent('tests', 'thread-tests', 'Test reviewer'),
    ]

    expect(buildThreadActivitySegments(messages)).toEqual([
      expect.objectContaining({
        kind: 'subAgent',
        id: 'shell',
        agents: [
          expect.objectContaining({ id: 'thread-docs' }),
          expect.objectContaining({ id: 'thread-shell' }),
        ],
      }),
      expect.objectContaining({
        kind: 'subAgent',
        id: 'tests',
        agents: [expect.objectContaining({ id: 'thread-tests' })],
      }),
    ])
  })

  it('aggregates adjacent unique parent collaboration actions in desktop order', () => {
    const collaboration = (
      id: string,
      text: string,
      collaborationKind: 'sendMessage' | 'waitThreads' | 'listAgents',
    ): UiMessage => ({
      ...message(id, 'system', text, 'collaborationActivity'),
      activity: {
        kind: 'collaboration',
        label: text,
        collaborationKind,
      },
    })
    const messages = [
      collaboration('send-1', 'Sent message to chat', 'sendMessage'),
      collaboration('wait-1', 'Wait threads', 'waitThreads'),
      collaboration('wait-2', 'Wait threads', 'waitThreads'),
    ]

    expect(buildThreadActivitySegments(messages)).toEqual([{
      kind: 'event',
      id: 'wait-2',
      label: 'Sent message to chat, wait threads',
      iconKind: 'integration',
      sourceMessageIds: ['send-1', 'wait-1', 'wait-2'],
    }])
  })

  it('keeps collaboration activity in the completed Worked for fold', () => {
    const messages: UiMessage[] = [
      {
        ...message('send', 'system', 'Sent message to chat', 'collaborationActivity'),
        activity: {
          kind: 'collaboration',
          label: 'Sent message to chat',
          collaborationKind: 'sendMessage',
        },
      },
      message('worked', 'system', 'Worked for 1m 25s', 'worked'),
    ]

    expect(getHiddenCompletedActivityMessageIds(messages)).toEqual(new Set(['send']))
    expect(getTurnActivitySegmentsForWorked(messages, 1)).toEqual([
      expect.objectContaining({
        kind: 'event',
        label: 'Sent message to chat',
        iconKind: 'integration',
      }),
    ])
  })

  it('uses latest concrete action detail and does not combine activity across turn boundaries', () => {
    const command = (
      id: string,
      category: 'read' | 'listFiles' | 'search' | 'unknown',
    ): UiMessage => ({
      ...message(id, 'system', id, 'commandExecution'),
      commandExecution: {
        command: id,
        cwd: null,
        status: 'completed',
        aggregatedOutput: '',
        exitCode: 0,
        activityCategories: [category],
      },
    })
    const fileChange = (id: string, paths: string[]): UiMessage => ({
      ...message(id, 'system', '', 'fileChange'),
      fileChangeStatus: 'completed',
      fileChanges: paths.map((path) => ({
        path,
        operation: 'update' as const,
        diff: '',
        addedLineCount: 1,
        removedLineCount: 0,
      })),
    })

    expect(buildThreadActivitySegments([
      fileChange('files', ['a.ts', 'b.ts']),
      command('read-1', 'read'),
      command('read-2', 'read'),
      command('list-1', 'listFiles'),
      command('search-1', 'search'),
      command('run-1', 'unknown'),
      command('run-2', 'unknown'),
      message('user-2', 'user', 'continue', 'userMessage'),
      command('read-3', 'read'),
    ])).toEqual([
      expect.objectContaining({
        id: 'run-2',
        label: 'Ran run-2',
        iconKind: 'terminal',
      }),
      expect.objectContaining({
        id: 'read-3',
        label: 'Ran read-3',
        iconKind: 'book',
      }),
    ])
  })

  it('uses semantic desktop icon kinds for activity', () => {
    const command = (
      id: string,
      category: 'read' | 'unknown',
    ): UiMessage => ({
      ...message(id, 'system', id, 'commandExecution'),
      commandExecution: {
        command: id,
        cwd: null,
        status: 'completed',
        aggregatedOutput: '',
        exitCode: 0,
        activityCategories: [category],
      },
    })

    expect(buildThreadActivitySegments([command('read', 'read')])).toEqual([
      expect.objectContaining({ iconKind: 'book' }),
    ])
    expect(buildThreadActivitySegments([command('run', 'unknown')])).toEqual([
      expect.objectContaining({ iconKind: 'terminal' }),
    ])
    expect(buildThreadActivitySegments([
      message('codegraph', 'system', 'Used codegraph integration', 'dynamicToolCall'),
    ])).toEqual([
      expect.objectContaining({ iconKind: 'integration' }),
    ])
    expect(buildThreadActivitySegments([
      message('image', 'assistant', 'Viewed an image', 'imageView'),
    ])).toEqual([
      expect.objectContaining({ iconKind: 'image' }),
    ])
    expect(buildThreadActivitySegments([
      message('compact', 'system', 'Context automatically compacting', 'contextCompaction'),
    ])).toEqual([
      expect.objectContaining({ iconKind: 'status' }),
    ])
  })

  it('removes desktop reasoning emphasis markers from compact activity labels', () => {
    expect(buildThreadActivitySegments([
      message(
        'reasoning-markdown',
        'assistant',
        '**Planning diagnostic instrumentation**\n\n__Assessing socket failure causes__',
        'reasoning',
      ),
    ])).toEqual([{
      kind: 'reasoning',
      id: 'reasoning-markdown',
      label: 'Planning diagnostic instrumentation Assessing socket failure causes',
      iconKind: 'status',
      sourceMessageIds: ['reasoning-markdown'],
    }])
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
