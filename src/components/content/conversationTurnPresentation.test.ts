import { describe, expect, it } from 'vitest'
import type { UiMessage } from '../../types/codex'
import {
  formatCompletionClockTime,
  hiddenSimplifiedTranscriptMessageIds,
  projectConversationTurns,
  stripTitleOnlyReasoningStatusLines,
  suppressResponseActions,
} from './conversationTurnPresentation'

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
      completionCreatedAtMs: null,
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
      completionCreatedAtMs: null,
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

  it('carries completion time from the worked marker to the completed turn section', () => {
    const completedAtMs = new Date(2026, 0, 1, 21, 15).getTime()
    const sections = projectConversationTurns({
      messages: [
        message('u1', 'user', 'Run tests', 'turn-1'),
        { ...message('worked', 'system', 'Worked for 1m', 'turn-1', 'worked'), createdAtMs: completedAtMs },
        message('final', 'assistant', 'Done.', 'turn-1', 'agentMessage'),
      ],
      activeTurnId: null,
    })

    expect(sections[0]?.completionCreatedAtMs).toBe(completedAtMs)
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

  it('does not promote commentary-phase assistant progress into final response actions', () => {
    const sections = projectConversationTurns({
      messages: [
        message('u1', 'user', 'Continue', 'turn-1'),
        { ...message('commentary-1', 'assistant', 'Intermediate progress.', 'turn-1', 'agentMessage'), phase: 'commentary' },
        { ...message('commentary-2', 'assistant', 'Still working.', 'turn-1', 'agentMessage'), phase: 'commentary' },
        { ...message('final', 'assistant', 'Final body only.', 'turn-1', 'agentMessage'), phase: 'final' },
      ],
      activeTurnId: null,
    })

    expect(sections[0]?.finalMessageId).toBe('final')
  })

  it('does not invent a final response for commentary-only retained windows', () => {
    const sections = projectConversationTurns({
      messages: [
        message('u1', 'user', 'Continue', 'turn-1'),
        { ...message('commentary-1', 'assistant', 'Intermediate progress.', 'turn-1', 'agentMessage'), phase: 'commentary' },
        { ...message('commentary-2', 'assistant', 'Still working.', 'turn-1', 'agentMessage'), phase: 'commentary' },
      ],
      activeTurnId: null,
    })

    expect(sections[0]?.finalMessageId).toBeNull()
  })
})

describe('formatCompletionClockTime', () => {
  it('formats completion time as a precise local date and minute', () => {
    expect(formatCompletionClockTime(new Date(2026, 0, 1, 1, 30).getTime())).toBe('2026-01-01 01:30')
    expect(formatCompletionClockTime(new Date(2026, 0, 1, 21, 30).getTime())).toBe('2026-01-01 21:30')
    expect(formatCompletionClockTime(new Date(2026, 0, 1, 0, 5).getTime())).toBe('2026-01-01 00:05')
    expect(formatCompletionClockTime(new Date(2026, 0, 1, 12, 5).getTime())).toBe('2026-01-01 12:05')
  })

  it('omits invalid completion times', () => {
    expect(formatCompletionClockTime(null)).toBe('')
    expect(formatCompletionClockTime(Number.NaN)).toBe('')
  })
})

describe('simplified mobile transcript visibility', () => {
  it('keeps only body text for completed turns even when the last turn has reasoning and activity', () => {
    const hiddenIds = hiddenSimplifiedTranscriptMessageIds({
      activeTurnId: null,
      isThreadInProgress: false,
      messages: [
        message('user', 'user', '继续', 'turn-2'),
        message('reasoning', 'assistant', 'Planning comment and option patch', 'turn-2', 'reasoning'),
        {
          ...message('child', 'assistant', '', 'turn-2', 'subAgentActivity'),
          activity: {
            kind: 'subAgent',
            label: 'P03 t02 requirements review',
            subAgentKind: 'started',
          },
        },
        {
          ...message('tool', 'assistant', 'Called codegraph.codegraph_explore', 'turn-2', 'mcpToolCall'),
          activity: {
            kind: 'tool',
            label: 'Called codegraph.codegraph_explore',
          },
        },
        message('done', 'system', 'Worked for 1m 25s', 'turn-2', 'worked'),
        message('body', 'assistant', '正文结果。', 'turn-2', 'agentMessage'),
      ],
    })

    expect([...hiddenIds].sort()).toEqual(['child', 'done', 'reasoning', 'tool'])
  })

  it('keeps active reasoning body text while hiding title-only reasoning status lines', () => {
    const hiddenIds = hiddenSimplifiedTranscriptMessageIds({
      activeTurnId: 'turn-2',
      isThreadInProgress: true,
      messages: [
        message('old-user', 'user', '旧输入', 'turn-1'),
        message('old-reasoning', 'assistant', '旧推理', 'turn-1', 'reasoning'),
        message('new-user', 'user', '继续', 'turn-2'),
        message('new-title-1', 'assistant', 'Planning report note update', 'turn-2', 'reasoning'),
        message('new-title-2', 'assistant', 'Reviewing rotor dimension consistency', 'turn-2', 'reasoning'),
        message('new-title-3', 'assistant', '**Updating test configs and expert tensor handling**', 'turn-2', 'reasoning'),
        message('new-title-4', 'assistant', '**Asserting tensor data shapes and handling duplicates**', 'turn-2', 'reasoning'),
        message('new-title-5', 'assistant', '**Clarifying skill usage requirements**', 'turn-2', 'reasoning'),
        message('new-title-6', 'assistant', '**Proposing expert pairs collection in filter_tensors**', 'turn-2', 'reasoning'),
        message('new-title-7', 'assistant', 'Weighing struct replication versus public inclusion', 'turn-2', 'reasoning'),
        message('new-title-8', 'assistant', 'Preventing shell injection in rg command', 'turn-2', 'reasoning'),
        message('new-title-9', 'assistant', 'Defining serialization fields for layer counts', 'turn-2', 'reasoning'),
        message('new-title-10', 'assistant', 'Parsing and validating cut wire bytes', 'turn-2', 'reasoning'),
        message('new-title-11', 'assistant', 'Comparing current and expected transaction shape', 'turn-2', 'reasoning'),
        message('new-title-12', 'assistant', 'Existing tests', 'turn-2', 'reasoning'),
        message('new-body-1', 'assistant', '确认：通用 loader 会先读取 rope.dimension_count 到 n_rot_full。', 'turn-2', 'reasoning'),
        message('new-body-2', 'assistant', 'The loader already preserves the auxiliary width; next I will verify the staged diff.', 'turn-2', 'reasoning'),
        {
          ...message('new-child', 'assistant', '', 'turn-2', 'collabAgentToolCall'),
          activity: {
            kind: 'subAgent',
            label: 'P03 t02 requirements review',
            collabAgent: {
              tool: 'wait',
              receiverThreadIds: ['child'],
              agentsStates: { child: 'running' },
            },
          },
        },
        message('new-body', 'assistant', '正在处理。', 'turn-2', 'agentMessage.live'),
      ],
    })

    expect(hiddenIds.has('old-reasoning')).toBe(true)
    expect(hiddenIds.has('new-child')).toBe(true)
    expect(hiddenIds.has('new-title-1')).toBe(true)
    expect(hiddenIds.has('new-title-2')).toBe(true)
    expect(hiddenIds.has('new-title-3')).toBe(true)
    expect(hiddenIds.has('new-title-4')).toBe(true)
    expect(hiddenIds.has('new-title-5')).toBe(true)
    expect(hiddenIds.has('new-title-6')).toBe(true)
    expect(hiddenIds.has('new-title-7')).toBe(true)
    expect(hiddenIds.has('new-title-8')).toBe(true)
    expect(hiddenIds.has('new-title-9')).toBe(true)
    expect(hiddenIds.has('new-title-10')).toBe(true)
    expect(hiddenIds.has('new-title-11')).toBe(true)
    expect(hiddenIds.has('new-title-12')).toBe(true)
    expect(hiddenIds.has('new-body-1')).toBe(false)
    expect(hiddenIds.has('new-body-2')).toBe(false)
    expect(hiddenIds.has('new-user')).toBe(false)
    expect(hiddenIds.has('new-body')).toBe(false)
  })

  it('strips title-only reasoning status lines embedded in active assistant text', () => {
    expect(stripTitleOnlyReasoningStatusLines([
      'Planning data-plane warm-up implementation',
      '**Updating test configs and expert tensor handling**',
      '**Clarifying skill usage requirements**',
      'Evaluating retry strategy for memory_txn send',
      'Designing retransmission for transaction execution',
      'Weighing struct replication versus public inclusion',
      'Preventing shell injection in rg command',
      'Choosing plain mv for moving headers',
      'Locating README for profile model updates',
      'Comparing current and expected transaction shape',
      'Existing tests',
      'memory_txn 的 worker 侧已经按 ((epoch, mutation_id, txn)) 去重。',
    ].join('\n'))).toBe('memory_txn 的 worker 侧已经按 ((epoch, mutation_id, txn)) 去重。')
  })

  it('does not leak title-only active reasoning while the active turn id is still unknown', () => {
    const hiddenIds = hiddenSimplifiedTranscriptMessageIds({
      activeTurnId: null,
      isThreadInProgress: true,
      messages: [
        message('title', 'assistant', '**Updating test configs and expert tensor handling**', 'turn-late', 'reasoning'),
        message('body', 'assistant', 'Task 2 需要把 K3 routed expert 的 weight/scale pair 原生写入。', 'turn-late', 'reasoning'),
      ],
    })

    expect(hiddenIds.has('title')).toBe(true)
    expect(hiddenIds.has('body')).toBe(false)
  })

  it('hides active title-only status messages that would otherwise render as blank rows', () => {
    const hiddenIds = hiddenSimplifiedTranscriptMessageIds({
      activeTurnId: 'turn-3',
      isThreadInProgress: true,
      messages: [
        message('assistant-title-1', 'assistant', 'Planning fix for missing llama-model.h include', 'turn-3', 'agentMessage.live'),
        message('assistant-title-2', 'assistant', 'Verifying removal of K2.7 references', 'turn-3', 'agentMessage.live'),
        message('assistant-title-3', 'assistant', 'Inspecting llama-memory.h compatibility', 'turn-3', 'agentMessage.live'),
        message('assistant-body', 'assistant', '核心修复已完成，正在先写契约。', 'turn-3', 'agentMessage.live'),
        message('user', 'user', '继续', 'turn-3'),
      ],
    })

    expect(hiddenIds.has('assistant-title-1')).toBe(true)
    expect(hiddenIds.has('assistant-title-2')).toBe(true)
    expect(hiddenIds.has('assistant-title-3')).toBe(true)
    expect(hiddenIds.has('assistant-body')).toBe(false)
    expect(hiddenIds.has('user')).toBe(false)
  })
})

describe('response action visibility', () => {
  it('suppresses the authoritative active turn', () => {
    expect(suppressResponseActions({
      messageTurnId: 'turn-active',
      activeTurnId: 'turn-active',
      runtimeActive: true,
    })).toBe(true)
    expect(suppressResponseActions({
      messageTurnId: 'turn-complete',
      activeTurnId: 'turn-active',
      runtimeActive: true,
    })).toBe(false)
  })

  it('fails closed while runtime is active and active turn identity is unknown', () => {
    expect(suppressResponseActions({
      messageTurnId: 'turn-unknown',
      activeTurnId: '',
      runtimeActive: true,
    })).toBe(true)
    expect(suppressResponseActions({
      messageTurnId: 'turn-complete',
      activeTurnId: '',
      runtimeActive: false,
    })).toBe(false)
    expect(suppressResponseActions({
      messageTurnId: '',
      activeTurnId: 'turn-active',
      runtimeActive: true,
    })).toBe(true)
  })
})
