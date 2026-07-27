import { describe, expect, it } from 'vitest'
import { normalizeThreadGroupsV2, normalizeThreadMessagesV2, readThreadInProgressFromResponse } from './v2'
import type { ThreadListResponse, ThreadReadResponse } from '../appServerDtos'

function threadReadResponseWithContent(content: unknown[]): ThreadReadResponse {
  return {
    thread: {
      id: 'thread-1',
      preview: 'Use a skill',
      modelProvider: 'openai',
      createdAt: 1,
      updatedAt: 2,
      path: null,
      cwd: '/tmp/project',
      cliVersion: 'test',
      source: 'appServer',
      gitInfo: null,
      turns: [{
        id: 'turn-1',
        status: 'completed',
        error: null,
        items: content as ThreadReadResponse['thread']['turns'][number]['items'],
      }],
    },
  }
}

describe('normalizeThreadMessagesV2', () => {
  it.each([
    '/tmp/codex-web-uploads/f-legacy/photo.png',
    '/private/var/folders/arbitrary/camera.jpg',
  ])('hides persisted user localImage previews and keeps only an attachment token for %s', (path) => {
    const messages = normalizeThreadMessagesV2(threadReadResponseWithContent([{
      type: 'userMessage',
      id: 'user-local-image',
      content: [{ type: 'localImage', path }],
    }]))

    expect(messages[0]).toMatchObject({
      role: 'user',
      text: `@${path.split('/').at(-1)}`,
    })
    expect(messages[0]?.images).toBeUndefined()
  })

  it('extracts persisted Codex directives from assistant messages only', () => {
    const response = threadReadResponseWithContent([
      {
        type: 'agentMessage',
        id: 'assistant-1',
        text: 'Done.\n\n::git-push{cwd="/tmp/repo" branch="main"}',
      },
      {
        type: 'userMessage',
        id: 'user-1',
        content: [{
          type: 'text',
          text: '::git-push{cwd="/tmp/repo" branch="user-content"}',
          text_elements: [],
        }],
      },
    ])

    const messages = normalizeThreadMessagesV2(response)
    expect(messages[0]).toMatchObject({
      text: 'Done.',
      directives: [{ kind: 'git-push', branch: 'main' }],
    })
    expect(messages[1]).toMatchObject({
      text: '::git-push{cwd="/tmp/repo" branch="user-content"}',
    })
    expect(messages[1].directives).toBeUndefined()
  })

  it('normalizes official typed pull-request and code-comment literals', () => {
    const messages = normalizeThreadMessagesV2(threadReadResponseWithContent([{
      type: 'agentMessage',
      id: 'assistant-typed-directives',
      text: [
        'Done.',
        '::git-create-pr{cwd="/tmp/repo" branch="feature/one" url="https://example.com/pull/1" isDraft=false}',
        '::code-comment{title="Fix" body="Body" file="src/a.ts" start=4 end=7 priority=2}',
      ].join('\n'),
    }]))

    expect(messages[0]).toMatchObject({
      text: 'Done.',
      directives: [
        { kind: 'git-create-pr', url: 'https://example.com/pull/1', isDraft: false },
        { kind: 'code-comment', file: 'src/a.ts', start: 4, end: 7, priority: 2 },
      ],
    })
  })

  it('normalizes future and invalid standalone directives only from assistant messages', () => {
    const response = threadReadResponseWithContent([
      {
        type: 'agentMessage',
        id: 'assistant-future',
        text: 'Done.\n::future-directive{phase="done"}\n::git-push{cwd="/tmp/repo"}',
      },
      {
        type: 'userMessage',
        id: 'user-future',
        content: [{
          type: 'text',
          text: '::future-directive{phase="user"}',
          text_elements: [],
        }],
      },
    ])

    const messages = normalizeThreadMessagesV2(response)
    expect(messages[0]).toMatchObject({
      text: 'Done.',
      directives: [
        {
          kind: 'generic',
          name: 'future-directive',
          attributes: [{ key: 'phase', value: 'done', sensitive: false }],
        },
        { kind: 'invalid', name: 'git-push', reason: 'invalid-schema' },
      ],
    })
    expect(messages[1]).toMatchObject({
      text: '::future-directive{phase="user"}',
    })
    expect(messages[1].directives).toBeUndefined()
  })

  it('preserves directive-only assistant messages as structured messages', () => {
    const messages = normalizeThreadMessagesV2(threadReadResponseWithContent([{
      type: 'agentMessage',
      id: 'assistant-directive-only',
      text: '::git-stage{cwd="/tmp/repo"}',
    }]))

    expect(messages).toEqual([expect.objectContaining({
      id: 'assistant-directive-only',
      role: 'assistant',
      text: '',
      directives: [{ kind: 'git-stage', cwd: '/tmp/repo' }],
      messageType: 'agentMessage',
    })])
  })

  it('preserves selected skill inputs on the rendered user message', () => {
    const messages = normalizeThreadMessagesV2(threadReadResponseWithContent([{
      type: 'userMessage',
      id: 'user-1',
      content: [
        { type: 'text', text: 'Use the browser skill', text_elements: [] },
        { type: 'skill', name: 'browser-use:browser', path: '/Users/igor/.codex/skills/browser/SKILL.md' },
      ],
    }]))

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: 'user-1',
      role: 'user',
      text: 'Use the browser skill',
      skills: [{ name: 'browser-use:browser', path: '/Users/igor/.codex/skills/browser/SKILL.md' }],
    })
  })

  it('renders skill-only user messages instead of dropping them as raw blocks', () => {
    const messages = normalizeThreadMessagesV2(threadReadResponseWithContent([{
      type: 'userMessage',
      id: 'user-2',
      content: [
        { type: 'skill', name: 'composio-cli', path: '/Users/igor/.codex/skills/composio-cli/SKILL.md' },
      ],
    }]))

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: 'user-2',
      role: 'user',
      text: '',
      skills: [{ name: 'composio-cli', path: '/Users/igor/.codex/skills/composio-cli/SKILL.md' }],
    })
    expect(messages[0].isUnhandled).toBeUndefined()
  })

  it('decodes escaped heartbeat instructions without exposing raw XML', () => {
    const messages = normalizeThreadMessagesV2(threadReadResponseWithContent([{
      type: 'userMessage',
      id: 'automation-user-1',
      content: [{
        type: 'text',
        text: `<heartbeat>
<automation_id>automation-1</automation_id>
<current_time_iso>2026-05-09T00:00:00.000Z</current_time_iso>
<instructions>
Reply with &lt;/instructions&gt; and A &amp; B
</instructions>
</heartbeat>`,
        text_elements: [],
      }],
    }]))

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: 'automation-user-1',
      role: 'user',
      text: 'Reply with </instructions> and A & B',
      isAutomationRun: true,
      automationDisplayName: 'automation-1',
    })
  })

  it('applies a base turn index for paged thread slices', () => {
    const messages = normalizeThreadMessagesV2(threadReadResponseWithContent([{
      type: 'userMessage',
      id: 'user-3',
      content: [{ type: 'text', text: 'Paged message', text_elements: [] }],
    }]), 12)

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: 'user-3',
      turnId: 'turn-1',
      turnIndex: 12,
    })
  })

  it('restores persisted reasoning from visible summaries without exposing raw content', () => {
    const messages = normalizeThreadMessagesV2(threadReadResponseWithContent([{
      type: 'reasoning',
      id: 'reasoning-1',
      summary: ['Checked the request.', 'Prepared the answer.'],
      content: ['hidden chain-of-thought must not be rendered'],
    }]))

    expect(messages).toEqual([expect.objectContaining({
      id: 'reasoning-1',
      role: 'assistant',
      text: 'Checked the request.\n\nPrepared the answer.',
      messageType: 'reasoning',
      turnId: 'turn-1',
      turnIndex: 0,
    })])
    expect(messages[0]?.text).not.toContain('hidden chain-of-thought')
  })

  it('hides intermediate assistant progress messages from completed historical turns', () => {
    const messages = normalizeThreadMessagesV2(threadReadResponseWithContent([
      {
        type: 'userMessage',
        id: 'user-history',
        content: [{ type: 'text', text: 'Continue the Kimi plan', text_elements: [] }],
      },
      {
        type: 'agentMessage',
        id: 'assistant-progress-1',
        text: 'I will inspect the branch and then write the plan.',
      },
      {
        type: 'commandExecution',
        id: 'cmd-history',
        command: 'git status --short',
        status: 'completed',
        aggregatedOutput: '',
        exitCode: 0,
      },
      {
        type: 'agentMessage',
        id: 'assistant-progress-2',
        text: 'The spec is written. I am running verification now.',
      },
      {
        type: 'agentMessage',
        id: 'assistant-final',
        text: 'Done. The Kimi K3 text-only plan is ready.',
      },
    ]))

    expect(messages.map((message) => message.id)).toEqual([
      'user-history',
      'cmd-history',
      'assistant-final',
    ])
    expect(messages.map((message) => message.text).join('\n')).not.toContain('I will inspect')
    expect(messages.map((message) => message.text).join('\n')).not.toContain('running verification')
  })

  it('keeps intermediate assistant progress messages for the active running turn', () => {
    const response = threadReadResponseWithContent([
      {
        type: 'userMessage',
        id: 'user-running',
        content: [{ type: 'text', text: 'Continue', text_elements: [] }],
      },
      {
        type: 'agentMessage',
        id: 'assistant-running-progress',
        text: 'I am checking the current files.',
      },
      {
        type: 'agentMessage',
        id: 'assistant-running-latest',
        text: 'Still running.',
      },
    ])
    response.thread.turns[0].status = 'inProgress'

    const messages = normalizeThreadMessagesV2(response)

    expect(messages.map((message) => message.id)).toEqual([
      'user-running',
      'assistant-running-progress',
      'assistant-running-latest',
    ])
  })

  it('keeps intermediate assistant progress for the last turn when thread-level state is running', () => {
    const response = threadReadResponseWithContent([
      {
        type: 'userMessage',
        id: 'user-thread-running',
        content: [{ type: 'text', text: 'Continue externally running thread', text_elements: [] }],
      },
      {
        type: 'agentMessage',
        id: 'assistant-thread-running-progress',
        text: 'I am still working from another client.',
      },
      {
        type: 'agentMessage',
        id: 'assistant-thread-running-latest',
        text: 'Waiting for tool output.',
      },
    ])
    ;(response.thread as unknown as Record<string, unknown>).inProgress = true

    const messages = normalizeThreadMessagesV2(response)

    expect(messages.map((message) => message.id)).toEqual([
      'user-thread-running',
      'assistant-thread-running-progress',
      'assistant-thread-running-latest',
    ])
  })

  it('renders failed turn errors as chat system messages', () => {
    const response = threadReadResponseWithContent([{
      type: 'userMessage',
      id: 'user-4',
      content: [{ type: 'text', text: 'hi', text_elements: [] }],
    }])
    response.thread.turns[0].status = 'failed'
    response.thread.turns[0].error = {
      message: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header',
      codexErrorInfo: null,
      additionalDetails: null,
    }

    const messages = normalizeThreadMessagesV2(response)

    expect(messages).toHaveLength(2)
    expect(messages[1]).toMatchObject({
      id: 'turn-1-error',
      role: 'system',
      text: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header',
      messageType: 'turnError',
      turnId: 'turn-1',
      turnIndex: 0,
    })
  })

  it('uses turn index fallback ids for failed turns with blank ids', () => {
    const response = threadReadResponseWithContent([])
    response.thread.turns = [
      {
        id: '',
        status: 'failed',
        error: {
          message: 'first failed turn',
          codexErrorInfo: null,
          additionalDetails: null,
        },
        items: [],
      },
      {
        id: '   ',
        status: 'failed',
        error: {
          message: 'second failed turn',
          codexErrorInfo: null,
          additionalDetails: null,
        },
        items: [],
      },
    ]

    const messages = normalizeThreadMessagesV2(response, 8)

    expect(messages).toEqual([
      expect.objectContaining({
        id: 'turn-8-error',
        text: 'first failed turn',
        turnId: undefined,
        turnIndex: 8,
      }),
      expect.objectContaining({
        id: 'turn-9-error',
        text: 'second failed turn',
        turnId: undefined,
        turnIndex: 9,
      }),
    ])
  })

  it('keeps command action labels for desktop-style activity rows', () => {
    const messages = normalizeThreadMessagesV2(threadReadResponseWithContent([{
      type: 'commandExecution',
      id: 'cmd-read-skill',
      command: 'sed -n 1,120p /tmp/skills/index/SKILL.md',
      cwd: '/tmp/project',
      processId: null,
      status: 'completed',
      commandActions: [{
        type: 'read',
        command: 'sed -n 1,120p /tmp/skills/index/SKILL.md',
        name: 'Index skill',
        path: '/tmp/skills/index/SKILL.md',
      }],
      aggregatedOutput: 'skill body',
      exitCode: 0,
      durationMs: 123,
    }]))

    expect(messages[0]).toMatchObject({
      id: 'cmd-read-skill',
      role: 'system',
      messageType: 'commandExecution',
      commandExecution: expect.objectContaining({
        command: 'sed -n 1,120p /tmp/skills/index/SKILL.md',
        displayLabel: 'Read Index skill',
        commandActions: [{
          type: 'read',
          command: 'sed -n 1,120p /tmp/skills/index/SKILL.md',
          name: 'Index skill',
          path: '/tmp/skills/index/SKILL.md',
        }],
        activityCategories: ['read'],
      }),
    })
  })

  it('preserves newer Codex desktop activity items as typed readable rows', () => {
    const messages = normalizeThreadMessagesV2(threadReadResponseWithContent([
      {
        type: 'subAgentActivity',
        id: 'subagent-updated',
        agentThreadId: 'thread-docs',
        agentPath: '/root/updated_docs_coverage_review',
        kind: 'interacted',
      },
      {
        type: 'dynamicToolCall',
        id: 'dynamic-tool',
        tool: 'codegraph_explore',
        status: 'completed',
        arguments: { query: 'ThreadConversation' },
      },
      {
        type: 'sleep',
        id: 'sleep-1',
        durationMs: 250,
      },
      {
        type: 'imageGeneration',
        id: 'generated-image',
        result: 'aGVsbG8=',
      },
    ]))

    expect(messages).toEqual([
      expect.objectContaining({
        id: 'subagent-updated',
        messageType: 'subAgentActivity',
        text: 'Updated docs coverage review',
        activity: {
          kind: 'subAgent',
          label: 'Updated docs coverage review',
          status: 'updated',
          agentThreadId: 'thread-docs',
          agentPath: '/root/updated_docs_coverage_review',
          subAgentKind: 'interacted',
        },
      }),
      expect.objectContaining({
        id: 'dynamic-tool',
        messageType: 'dynamicToolCall',
        text: 'Used codegraph explore',
        activity: {
          kind: 'tool',
          label: 'Used codegraph explore',
          status: 'completed',
        },
      }),
      expect.objectContaining({
        id: 'sleep-1',
        messageType: 'sleep',
        text: 'Waited briefly',
        activity: {
          kind: 'status',
          label: 'Waited briefly',
        },
      }),
      expect.objectContaining({
        id: 'generated-image',
        messageType: 'imageGeneration',
        text: 'Generated an image',
        activity: {
          kind: 'image',
          label: 'Generated an image',
        },
      }),
    ])
    expect(messages[3]?.images).toEqual(['data:image/png;base64,aGVsbG8='])
  })

  it('normalizes recovered collaboration activity to safe desktop labels', () => {
    const messages = normalizeThreadMessagesV2(threadReadResponseWithContent([
      {
        id: 'session-collab-send',
        type: 'collaborationActivity',
        activityKind: 'sendMessage',
        sourceCallId: 'send',
      },
      {
        id: 'session-collab-wait',
        type: 'collaborationActivity',
        activityKind: 'waitThreads',
        sourceCallId: 'wait',
      },
      {
        id: 'session-collab-list',
        type: 'collaborationActivity',
        activityKind: 'listAgents',
        sourceCallId: 'list',
      },
    ]))

    expect(messages.map((message) => ({
      text: message.text,
      type: message.messageType,
      activity: message.activity,
    }))).toEqual([
      {
        text: 'Sent message to chat',
        type: 'collaborationActivity',
        activity: {
          kind: 'collaboration',
          label: 'Sent message to chat',
          collaborationKind: 'sendMessage',
        },
      },
      {
        text: 'Wait threads',
        type: 'collaborationActivity',
        activity: {
          kind: 'collaboration',
          label: 'Wait threads',
          collaborationKind: 'waitThreads',
        },
      },
      {
        text: 'Listed agents',
        type: 'collaborationActivity',
        activity: {
          kind: 'collaboration',
          label: 'Listed agents',
          collaborationKind: 'listAgents',
        },
      },
    ])
    expect(messages.every((message) => message.rawPayload === undefined)).toBe(true)
  })

  it('normalizes non-command desktop activity items as readable event rows', () => {
    const messages = normalizeThreadMessagesV2(threadReadResponseWithContent([
      { type: 'contextCompaction', id: 'compact-1' },
      { type: 'imageView', id: 'image-1', path: '/tmp/shot.png' },
      {
        type: 'webSearch',
        id: 'web-1',
        query: 'codex mobile',
        action: { type: 'search', query: 'codex mobile', queries: null },
      },
      {
        type: 'mcpToolCall',
        id: 'mcp-1',
        server: 'github',
        tool: 'fetch_pr',
        status: 'completed',
        arguments: { pr: 3 },
        result: null,
        error: null,
        durationMs: 456,
      },
      {
        type: 'collabAgentToolCall',
        id: 'agent-1',
        tool: 'wait',
        status: 'completed',
        senderThreadId: 'thread-1',
        receiverThreadIds: ['thread-2'],
        prompt: null,
        agentsStates: {
          'thread-2': {
            status: 'completed',
            message: 'private child result that must not render',
          },
        },
      },
    ]))

    expect(messages.map((message) => [message.messageType, message.text])).toEqual([
      ['contextCompaction', 'Context automatically compacting'],
      ['imageView', 'Viewed an image'],
      ['webSearch', 'Searched codex mobile'],
      ['mcpToolCall', 'Called github.fetch_pr'],
      ['collabAgentToolCall', 'Waited for agents'],
    ])
    expect(messages[1]?.images).toEqual(['/codex-local-image?path=%2Ftmp%2Fshot.png'])
    expect(messages[4]?.activity).toEqual({
      kind: 'subAgent',
      label: 'Waited for agents',
      status: 'completed',
      collabAgent: {
        tool: 'wait',
        status: 'completed',
        receiverThreadIds: ['thread-2'],
        agentsStates: {
          'thread-2': 'completed',
        },
      },
    })
    expect(JSON.stringify({
      text: messages[4]?.text,
      activity: messages[4]?.activity,
    })).not.toContain('private child result')
  })
})

describe('readThreadInProgressFromResponse', () => {
  it('treats active thread status objects as in progress', () => {
    const response = threadReadResponseWithContent([])
    ;(response.thread as unknown as { status: { type: string } }).status = { type: 'active' }

    expect(readThreadInProgressFromResponse(response)).toBe(true)
  })
})

describe('normalizeThreadGroupsV2', () => {
  it('treats externally running list rows as in progress', () => {
    const response: ThreadListResponse = {
      data: [{
        id: 'thread-external',
        preview: 'Desktop task',
        modelProvider: 'openai',
        createdAt: 1,
        updatedAt: 2,
        path: '/sessions/thread-external.jsonl',
        cwd: '/tmp/project',
        cliVersion: 'test',
        source: 'vscode',
        gitInfo: null,
        turns: [],
        externalRuntime: {
          state: 'running',
          turnId: 'turn-external',
          interruptible: false,
          source: 'external-session-writer',
        },
      } as ThreadListResponse['data'][number],
      ],
      nextCursor: null,
    }

    expect(normalizeThreadGroupsV2(response)[0]?.threads[0]).toMatchObject({
      id: 'thread-external',
      inProgress: true,
      unread: false,
    })
  })
})
