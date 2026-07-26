import type {
  UiCollabAgentStatus,
  UiMessage,
} from '../../types/codex'

export type SubAgentDisplayState =
  | 'waiting'
  | 'working'
  | 'updated'
  | 'done'
  | 'interrupted'
  | 'failed'

export type SubAgentTone = 'green' | 'purple' | 'pink'

export type SubAgentDisplayItem = {
  id: string
  label: string
  state: SubAgentDisplayState
  tone: SubAgentTone
}

export type SubAgentActivityGroup = {
  agents: SubAgentDisplayItem[]
  status: 'started working' | 'updated' | 'interrupted' | 'failed' | 'finished'
  sourceMessageIds: string[]
}

type MutableSubAgent = SubAgentDisplayItem

const SUB_AGENT_TONES = ['green', 'purple', 'pink'] as const

function toneFromAgentIdentity(identity: string): SubAgentTone {
  let hash = 0
  for (const character of identity) {
    hash += character.codePointAt(0) ?? 0
  }
  return SUB_AGENT_TONES[hash % SUB_AGENT_TONES.length] ?? 'green'
}

function isTerminal(state: SubAgentDisplayState): boolean {
  return state === 'done' || state === 'interrupted' || state === 'failed'
}

function stateFromCollabStatus(status: UiCollabAgentStatus): SubAgentDisplayState {
  if (status === 'pendingInit') return 'waiting'
  if (status === 'running') return 'working'
  if (status === 'completed' || status === 'shutdown') return 'done'
  if (status === 'interrupted') return 'interrupted'
  return 'failed'
}

function fallbackAgentId(message: UiMessage): string {
  const agentPath = message.activity?.agentPath?.trim() ?? ''
  if (agentPath) return `path:${agentPath}`
  return `message:${message.id}`
}

function defaultAgentLabel(threadId: string): string {
  const compact = threadId.trim()
  return compact ? `Agent ${compact.slice(0, 8)}` : 'Agent'
}

function sharedStatus(agents: readonly SubAgentDisplayItem[]): SubAgentActivityGroup['status'] {
  if (agents.some((agent) => agent.state === 'failed')) return 'failed'
  if (agents.some((agent) => agent.state === 'interrupted')) return 'interrupted'
  if (agents.some((agent) => agent.state === 'updated')) return 'updated'
  if (agents.every((agent) => agent.state === 'done')) return 'finished'
  return 'started working'
}

export function buildSubAgentActivityGroup(
  messages: readonly UiMessage[],
  options: { parentTurnCompleted?: boolean } = {},
): SubAgentActivityGroup | null {
  const agents = new Map<string, MutableSubAgent>()

  const ensureAgent = (id: string, label?: string): MutableSubAgent => {
    const current = agents.get(id)
    if (current) {
      if (label) current.label = label
      return current
    }
    const created: MutableSubAgent = {
      id,
      label: label || defaultAgentLabel(id),
      state: 'waiting',
      tone: toneFromAgentIdentity(id),
    }
    agents.set(id, created)
    return created
  }

  for (const message of messages) {
    const activity = message.activity
    if (message.messageType === 'subAgentActivity' && activity?.kind === 'subAgent') {
      const id = activity.agentThreadId?.trim() || fallbackAgentId(message)
      const agent = ensureAgent(id, activity.label)
      if (activity.subAgentKind === 'started') {
        agent.state = 'waiting'
      } else if (activity.subAgentKind === 'interacted') {
        if (!isTerminal(agent.state)) agent.state = 'updated'
      } else if (activity.subAgentKind === 'interrupted') {
        agent.state = 'interrupted'
      }
      continue
    }

    if (message.messageType !== 'collabAgentToolCall' || !activity?.collabAgent) continue
    const collab = activity.collabAgent
    const receiverIds = new Set([
      ...collab.receiverThreadIds,
      ...Object.keys(collab.agentsStates),
    ])
    for (const threadId of receiverIds) {
      const agent = ensureAgent(threadId)
      const collabStatus = collab.agentsStates[threadId]
      if (collabStatus) {
        const nextState = stateFromCollabStatus(collabStatus)
        if (
          nextState === 'working' &&
          (agent.state === 'updated' || isTerminal(agent.state))
        ) {
          continue
        }
        if (nextState === 'waiting' && agent.state !== 'waiting') continue
        agent.state = nextState
      }
    }

    if (collab.tool === 'wait' && collab.status === 'completed') {
      for (const threadId of collab.receiverThreadIds) {
        const agent = ensureAgent(threadId)
        if (agent.state !== 'failed' && agent.state !== 'interrupted') {
          agent.state = 'done'
        }
      }
    }
  }

  if (options.parentTurnCompleted) {
    for (const agent of agents.values()) {
      if (!isTerminal(agent.state)) agent.state = 'done'
    }
  }

  const displayAgents = Array.from(agents.values())
  if (displayAgents.length === 0) return null
  return {
    agents: displayAgents,
    status: sharedStatus(displayAgents),
    sourceMessageIds: messages.map((message) => message.id),
  }
}
