import { describe, expect, it } from 'vitest'
import type {
  UiCollabAgentStatus,
  UiMessage,
  UiSubAgentActivityKind,
} from '../../types/codex'
import { buildSubAgentActivityGroup } from './subAgentActivity'

function subAgent(
  id: string,
  agentThreadId: string,
  label: string,
  kind: UiSubAgentActivityKind,
  agentPath = `/root/${label.toLowerCase().replace(/\s+/gu, '_')}`,
): UiMessage {
  return {
    id,
    role: 'system',
    text: label,
    messageType: 'subAgentActivity',
    activity: {
      kind: 'subAgent',
      label,
      status: kind === 'interacted' ? 'updated' : kind,
      agentThreadId,
      agentPath,
      subAgentKind: kind,
    },
  }
}

function collab(
  id: string,
  tool: string,
  status: string,
  receiverThreadIds: string[],
  agentsStates: Record<string, UiCollabAgentStatus>,
): UiMessage {
  return {
    id,
    role: 'system',
    text: 'private child result must not be used',
    messageType: 'collabAgentToolCall',
    activity: {
      kind: 'subAgent',
      label: 'Waited for agents',
      status,
      collabAgent: {
        tool,
        status,
        receiverThreadIds,
        agentsStates,
      },
    },
  }
}

describe('buildSubAgentActivityGroup', () => {
  it('reconciles started, running, interacted, and completed states by child thread id', () => {
    expect(buildSubAgentActivityGroup([
      subAgent('start', 'thread-docs', 'Docs reviewer', 'started'),
    ])).toEqual({
      agents: [{ id: 'thread-docs', label: 'Docs reviewer', state: 'waiting' }],
      status: 'started working',
      sourceMessageIds: ['start'],
    })

    expect(buildSubAgentActivityGroup([
      subAgent('start', 'thread-docs', 'Docs reviewer', 'started'),
      collab('running', 'wait', 'inProgress', ['thread-docs'], { 'thread-docs': 'running' }),
    ])?.agents).toEqual([
      { id: 'thread-docs', label: 'Docs reviewer', state: 'working' },
    ])

    expect(buildSubAgentActivityGroup([
      subAgent('start', 'thread-docs', 'Docs reviewer', 'started'),
      subAgent('update', 'thread-docs', 'Docs reviewer', 'interacted'),
      collab('running', 'sendInput', 'completed', ['thread-docs'], { 'thread-docs': 'running' }),
    ])).toEqual({
      agents: [{ id: 'thread-docs', label: 'Docs reviewer', state: 'updated' }],
      status: 'updated',
      sourceMessageIds: ['start', 'update', 'running'],
    })

    expect(buildSubAgentActivityGroup([
      subAgent('start', 'thread-docs', 'Docs reviewer', 'started'),
      collab('done', 'wait', 'completed', ['thread-docs'], { 'thread-docs': 'completed' }),
    ])).toEqual({
      agents: [{ id: 'thread-docs', label: 'Docs reviewer', state: 'done' }],
      status: 'finished',
      sourceMessageIds: ['start', 'done'],
    })
  })

  it('groups adjacent children, deduplicates repeated events, and preserves failure precedence', () => {
    const group = buildSubAgentActivityGroup([
      subAgent('docs-start', 'thread-docs', 'Docs reviewer', 'started'),
      subAgent('shell-start', 'thread-shell', 'Shell reviewer', 'started'),
      subAgent('docs-update', 'thread-docs', 'Docs reviewer', 'interacted'),
      collab('states', 'wait', 'completed', ['thread-docs', 'thread-shell'], {
        'thread-docs': 'errored',
        'thread-shell': 'interrupted',
      }),
    ])

    expect(group).toEqual({
      agents: [
        { id: 'thread-docs', label: 'Docs reviewer', state: 'failed' },
        { id: 'thread-shell', label: 'Shell reviewer', state: 'interrupted' },
      ],
      status: 'failed',
      sourceMessageIds: ['docs-start', 'shell-start', 'docs-update', 'states'],
    })
    expect(JSON.stringify(group)).not.toContain('private child result')
  })

  it('closes applicable children after a completed wait or parent turn completion', () => {
    expect(buildSubAgentActivityGroup([
      subAgent('start', 'thread-docs', 'Docs reviewer', 'started'),
      collab('wait', 'wait', 'completed', ['thread-docs'], {}),
    ])?.agents).toEqual([
      { id: 'thread-docs', label: 'Docs reviewer', state: 'done' },
    ])

    expect(buildSubAgentActivityGroup([
      subAgent('start', 'thread-docs', 'Docs reviewer', 'started'),
    ], { parentTurnCompleted: true })).toEqual({
      agents: [{ id: 'thread-docs', label: 'Docs reviewer', state: 'done' }],
      status: 'finished',
      sourceMessageIds: ['start'],
    })
  })

  it('uses a deterministic path fallback when a child thread id is absent', () => {
    const row = subAgent('start', '', 'Docs reviewer', 'started', '/root/docs_reviewer')
    expect(buildSubAgentActivityGroup([row])?.agents).toEqual([
      { id: 'path:/root/docs_reviewer', label: 'Docs reviewer', state: 'waiting' },
    ])
  })
})
