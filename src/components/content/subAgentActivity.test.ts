import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type {
  UiCollabAgentStatus,
  UiMessage,
  UiSubAgentActivityKind,
} from '../../types/codex'
import { buildSubAgentActivityGroup } from './subAgentActivity'

const conversationSource = readFileSync(
  new URL('./ThreadConversation.vue', import.meta.url),
  'utf8',
)

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
      agents: [{
        id: 'thread-docs',
        label: 'Docs reviewer',
        state: 'waiting',
        tone: 'purple',
      }],
      status: 'started working',
      sourceMessageIds: ['start'],
    })

    expect(buildSubAgentActivityGroup([
      subAgent('start', 'thread-docs', 'Docs reviewer', 'started'),
      collab('running', 'wait', 'inProgress', ['thread-docs'], { 'thread-docs': 'running' }),
    ])?.agents).toEqual([
      {
        id: 'thread-docs',
        label: 'Docs reviewer',
        state: 'working',
        tone: 'purple',
      },
    ])

    expect(buildSubAgentActivityGroup([
      subAgent('start', 'thread-docs', 'Docs reviewer', 'started'),
      subAgent('update', 'thread-docs', 'Docs reviewer', 'interacted'),
      collab('running', 'sendInput', 'completed', ['thread-docs'], { 'thread-docs': 'running' }),
    ])).toEqual({
      agents: [{
        id: 'thread-docs',
        label: 'Docs reviewer',
        state: 'updated',
        tone: 'purple',
      }],
      status: 'updated',
      sourceMessageIds: ['start', 'update', 'running'],
    })

    expect(buildSubAgentActivityGroup([
      subAgent('start', 'thread-docs', 'Docs reviewer', 'started'),
      collab('done', 'wait', 'completed', ['thread-docs'], { 'thread-docs': 'completed' }),
    ])).toEqual({
      agents: [{
        id: 'thread-docs',
        label: 'Docs reviewer',
        state: 'done',
        tone: 'purple',
      }],
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
        {
          id: 'thread-docs',
          label: 'Docs reviewer',
          state: 'failed',
          tone: 'purple',
        },
        {
          id: 'thread-shell',
          label: 'Shell reviewer',
          state: 'interrupted',
          tone: 'purple',
        },
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
      {
        id: 'thread-docs',
        label: 'Docs reviewer',
        state: 'done',
        tone: 'purple',
      },
    ])

    expect(buildSubAgentActivityGroup([
      subAgent('start', 'thread-docs', 'Docs reviewer', 'started'),
    ], { parentTurnCompleted: true })).toEqual({
      agents: [{
        id: 'thread-docs',
        label: 'Docs reviewer',
        state: 'done',
        tone: 'purple',
      }],
      status: 'finished',
      sourceMessageIds: ['start'],
    })
  })

  it('uses a deterministic path fallback when a child thread id is absent', () => {
    const row = subAgent('start', '', 'Docs reviewer', 'started', '/root/docs_reviewer')
    expect(buildSubAgentActivityGroup([row])?.agents).toEqual([
      {
        id: 'path:/root/docs_reviewer',
        label: 'Docs reviewer',
        state: 'waiting',
        tone: 'pink',
      },
    ])
  })

  it('maps agent identities to deterministic green, purple, and pink tones', () => {
    const messages = [
      subAgent('green-start', 'agent-a', 'Green reviewer', 'started'),
      subAgent('purple-start', 'agent-b', 'Purple reviewer', 'started'),
      subAgent('pink-start', 'agent-c', 'Pink reviewer', 'started'),
    ]

    expect(buildSubAgentActivityGroup(messages)?.agents.map(({ id, tone }) => ({
      id,
      tone,
    }))).toEqual([
      { id: 'agent-a', tone: 'green' },
      { id: 'agent-b', tone: 'purple' },
      { id: 'agent-c', tone: 'pink' },
    ])
    expect(buildSubAgentActivityGroup([...messages].reverse())?.agents
      .map(({ id, tone }) => ({ id, tone }))
      .sort((left, right) => left.id.localeCompare(right.id))).toEqual([
      { id: 'agent-a', tone: 'green' },
      { id: 'agent-b', tone: 'purple' },
      { id: 'agent-c', tone: 'pink' },
    ])
  })

  it('renders non-button agent chips with transparent neutral bordered styling', () => {
    expect(conversationSource.match(
      /<span\s+v-for="agent in [^"]+"[\s\S]*?class="codex-agent-activity-chip"/gu,
    )).toHaveLength(2)
    expect(conversationSource).not.toMatch(
      /<button[^>]*class="codex-agent-activity-chip"/u,
    )
    expect(conversationSource).toContain(':data-agent-tone="agent.tone"')
    expect(conversationSource).toMatch(
      /\.codex-agent-activity-chip\s*\{\s*@apply [^;]*border [^;]*border-zinc-200\/80 [^;]*bg-transparent/u,
    )
    expect(conversationSource).toMatch(
      /:global\(\.dark\) \.codex-agent-activity-chip\s*\{\s*@apply [^;]*border-zinc-800\/80 [^;]*bg-transparent/u,
    )
    expect(conversationSource).toContain(
      ".codex-agent-activity-chip[data-agent-tone='green'] .codex-agent-activity-icon",
    )
    expect(conversationSource).toContain(
      ".codex-agent-activity-chip[data-agent-tone='purple'] .codex-agent-activity-icon",
    )
    expect(conversationSource).toContain(
      ".codex-agent-activity-chip[data-agent-tone='pink'] .codex-agent-activity-icon",
    )
  })
})
