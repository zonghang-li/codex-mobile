import { describe, expect, it } from 'vitest'
import type { UiMessage } from '../types/codex'
import {
  finalizeHydratedTurnText,
  mergeHydratedTurnTextIntoTranscript,
  mergeThreadTextPage,
} from './threadTextHydration'

function textMessage(
  id: string,
  messageType: 'agentMessage' | 'reasoning' | 'contextCompaction',
  turnId = 'turn-active',
  sessionOrder?: number,
): UiMessage {
  return {
    id,
    role: messageType === 'contextCompaction' ? 'system' : 'assistant',
    text: id,
    messageType,
    turnId,
    sessionOrder,
  }
}

function userMessage(
  id: string,
  text: string,
  turnId = 'turn-active',
  sessionOrder?: number,
): UiMessage {
  return {
    id,
    role: 'user',
    text,
    messageType: 'userMessage',
    turnId,
    sessionOrder,
  }
}

describe('thread text hydration', () => {
  it('prepends older pages into deterministic session order', () => {
    const newest = [
      textMessage('reason-3', 'reasoning', 'turn-active', 300),
      textMessage('agent-3', 'agentMessage', 'turn-active', 400),
    ]
    const older = [
      textMessage('reason-1', 'reasoning', 'turn-active', 100),
      textMessage('agent-1', 'agentMessage', 'turn-active', 200),
    ]

    expect(mergeThreadTextPage(newest, older).map((message) => message.id)).toEqual([
      'reason-1',
      'agent-1',
      'reason-3',
      'agent-3',
    ])
  })

  it('deduplicates overlapping IDs and keeps the ordered version', () => {
    const unordered = textMessage('agent-1', 'agentMessage')
    const ordered = {
      ...textMessage('agent-1', 'agentMessage', 'turn-active', 200),
      text: 'ordered copy',
    }

    const merged = mergeThreadTextPage([
      unordered,
      textMessage('reason-3', 'reasoning', 'turn-active', 300),
    ], [
      textMessage('reason-1', 'reasoning', 'turn-active', 100),
      ordered,
    ])

    expect(merged.map((message) => message.id)).toEqual([
      'reason-1',
      'agent-1',
      'reason-3',
    ])
    expect(merged[1]).toBe(ordered)
  })

  it('keeps longer live text when an ordered rollout row is an older prefix', () => {
    const live = {
      ...textMessage('agent-shared', 'agentMessage'),
      text: 'complete live response',
      sessionOrder: undefined,
    }
    const staleRollout = {
      ...textMessage('agent-shared', 'agentMessage', 'turn-active', 200),
      text: 'complete live',
    }

    expect(mergeThreadTextPage([live], [staleRollout])).toEqual([{
      ...live,
      sessionOrder: 200,
    }])
  })

  it('keeps growing unordered live text after an ordered rollout prefix', () => {
    const rollout = {
      ...textMessage('agent-shared', 'agentMessage', 'turn-active', 200),
      text: 'partial response',
    }
    const live = {
      ...textMessage('agent-shared', 'agentMessage'),
      text: 'partial response completed live',
      sessionOrder: undefined,
    }

    expect(mergeThreadTextPage([rollout], [live])).toEqual([{
      ...live,
      sessionOrder: 200,
    }])
  })

  it('does not let an older page replace newer text for the same message ID', () => {
    const newer = {
      ...textMessage('agent-shared', 'agentMessage', 'turn-active', 300),
      text: 'newer complete transcript',
    }
    const stale = {
      ...textMessage('agent-shared', 'agentMessage', 'turn-active', 200),
      text: 'stale partial transcript',
    }

    expect(mergeThreadTextPage([newer], [stale])).toEqual([newer])
  })

  it('does not let divergent equal-order text replace the current transcript row', () => {
    const current = {
      ...textMessage('agent-shared', 'agentMessage', 'turn-active', 300),
      text: 'authoritative current output',
    }
    const divergent = {
      ...textMessage('agent-shared', 'agentMessage', 'turn-active', 300),
      text: 'stale but longer divergent output',
    }

    expect(mergeThreadTextPage([current], [divergent])).toEqual([current])
  })

  it('does not let stale hydration replace newer transcript text for the same message ID', () => {
    const newer = {
      ...textMessage('agent-shared', 'agentMessage', 'turn-active', 300),
      text: 'newer complete transcript',
    }
    const staleHydration = {
      ...textMessage('agent-shared', 'agentMessage', 'turn-active', 200),
      text: 'stale partial transcript',
    }

    expect(mergeHydratedTurnTextIntoTranscript(
      [newer],
      [staleHydration],
      'turn-active',
    )).toEqual([newer])
  })

  it('upgrades an in-progress context compaction row when the completed event arrives', () => {
    const compacting = {
      ...textMessage('compact-start', 'contextCompaction', 'turn-active', 100),
      text: 'Context automatically compacting',
    }
    const compacted = {
      ...textMessage('rollout:contextCompaction:200', 'contextCompaction', 'turn-active', 200),
      text: 'Context automatically compacted',
    }

    const merged = mergeThreadTextPage([compacting], [compacted])

    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      id: 'rollout:contextCompaction:200',
      text: 'Context automatically compacted',
      messageType: 'contextCompaction',
      sessionOrder: 200,
    })
  })

  it('deduplicates event-sourced and response-sourced copies of the same user input', () => {
    const eventCopy = userMessage(
      'rollout:userMessage:event:client-steer-1',
      '继续 Task2',
      'turn-active',
      200,
    )
    const responseCopy = userMessage(
      'msg-steer-1',
      '继续 Task2',
      'turn-active',
      208,
    )

    const merged = mergeThreadTextPage([
      eventCopy,
      textMessage('agent-after', 'agentMessage', 'turn-active', 300),
    ], [
      responseCopy,
    ])

    expect(merged.map((message) => message.id)).toEqual([
      'msg-steer-1',
      'agent-after',
    ])
  })

  it('does not deduplicate repeated identical user inputs separated by assistant output', () => {
    const merged = mergeThreadTextPage([
      userMessage('rollout:userMessage:event:client-steer-1', '继续', 'turn-active', 100),
      textMessage('agent-1', 'agentMessage', 'turn-active', 200),
    ], [
      userMessage('msg-steer-2', '继续', 'turn-active', 300),
      userMessage('rollout:userMessage:event:client-steer-2', '继续', 'turn-active', 308),
      textMessage('agent-2', 'agentMessage', 'turn-active', 400),
    ])

    expect(merged.map((message) => message.id)).toEqual([
      'rollout:userMessage:event:client-steer-1',
      'agent-1',
      'msg-steer-2',
      'agent-2',
    ])
  })

  it('places late delegated user input before the assistant response it triggered', () => {
    const merged = mergeThreadTextPage([
      textMessage('agent-after-steer', 'agentMessage', 'turn-active', 100),
    ], [
      userMessage(
        'rollout:userMessage:event:client-late-delegation',
        '<codex_delegation>\n<input>TASK2_PLANNER_FINDING_2</input>\n</codex_delegation>',
        'turn-active',
        200,
      ),
    ])

    expect(merged.map((message) => message.id)).toEqual([
      'rollout:userMessage:event:client-late-delegation',
      'agent-after-steer',
    ])
  })

  it('places wrapped late delegated user input before the assistant response it triggered', () => {
    const wrappedDelegation = [
      'TASK2_PLANNER_FINDING_2 (apply before Task2 final stop; no history rewrite):',
      '<codex_delegation>',
      '<input>收到。继续 Task2。</input>',
      '</codex_delegation>',
    ].join('\n')
    const merged = mergeThreadTextPage([
      textMessage('agent-after-steer', 'agentMessage', 'turn-active', 100),
    ], [
      userMessage(
        'rollout:userMessage:event:client-late-wrapped-delegation',
        wrappedDelegation,
        'turn-active',
        200,
      ),
    ])

    expect(merged.map((message) => message.id)).toEqual([
      'rollout:userMessage:event:client-late-wrapped-delegation',
      'agent-after-steer',
    ])
  })

  it('places escaped late delegated user input before the assistant response it triggered', () => {
    const escapedDelegation = [
      '&lt;codex_delegation&gt;',
      '&lt;input&gt;TASK2_PLANNER_FINDING_2&lt;/input&gt;',
      '&lt;/codex_delegation&gt;',
    ].join('\n')
    const merged = mergeThreadTextPage([
      textMessage('agent-after-steer', 'agentMessage', 'turn-active', 100),
    ], [
      userMessage(
        'rollout:userMessage:event:client-late-escaped-delegation',
        escapedDelegation,
        'turn-active',
        200,
      ),
    ])

    expect(merged.map((message) => message.id)).toEqual([
      'rollout:userMessage:event:client-late-escaped-delegation',
      'agent-after-steer',
    ])
  })

  it('does not place ordinary late event-sourced user input before existing output', () => {
    const lateUserInput = 'TASK2_PLANNER_FINDING_2 (apply before Task2 final stop; no history rewrite)'
    const merged = mergeThreadTextPage([
      textMessage('agent-after-steer', 'agentMessage', 'turn-active', 100),
    ], [
      userMessage(
        'rollout:userMessage:event:client-late-user-input',
        lateUserInput,
        'turn-active',
        200,
      ),
    ])

    expect(merged.map((message) => message.id)).toEqual([
      'agent-after-steer',
      'rollout:userMessage:event:client-late-user-input',
    ])
  })

  it('keeps multiple late delegated user inputs paired with their own response segment', () => {
    const firstDelegation = '<codex_delegation>\n<input>FIRST_STEER</input>\n</codex_delegation>'
    const secondDelegation = '<codex_delegation>\n<input>SECOND_STEER</input>\n</codex_delegation>'
    const merged = mergeThreadTextPage([
      textMessage('agent-first', 'agentMessage', 'turn-active', 100),
      userMessage('rollout:userMessage:event:client-late-first', firstDelegation, 'turn-active', 200),
      textMessage('agent-second', 'agentMessage', 'turn-active', 300),
      userMessage('rollout:userMessage:event:client-late-second', secondDelegation, 'turn-active', 400),
    ], [])

    expect(merged.map((message) => message.id)).toEqual([
      'rollout:userMessage:event:client-late-first',
      'agent-first',
      'rollout:userMessage:event:client-late-second',
      'agent-second',
    ])
  })

  it('appends a bounded live-only row without deleting hydrated text', () => {
    const hydrated = [
      textMessage('reason-1', 'reasoning', 'turn-active', 100),
      textMessage('agent-1', 'agentMessage', 'turn-active', 200),
      textMessage('reason-3', 'reasoning', 'turn-active', 300),
    ]
    const live = [textMessage('agent-4', 'agentMessage', 'turn-active', 400)]

    expect(mergeThreadTextPage(hydrated, live).map((message) => message.id)).toEqual([
      'reason-1',
      'agent-1',
      'reason-3',
      'agent-4',
    ])
  })

  it('keeps only the latest row from consecutive duplicate reasoning updates', () => {
    const first = {
      ...textMessage('reasoning-old', 'reasoning', 'turn-active', 100),
      text: '**Assessing crash ring payload limits**',
    }
    const second = {
      ...textMessage('reasoning-new', 'reasoning', 'turn-active', 110),
      text: '**Assessing crash ring payload limits**',
    }

    expect(mergeThreadTextPage([first], [second]).map((message) => message.id)).toEqual([
      'reasoning-new',
    ])
  })

  it('lets a consolidated reasoning update overwrite its adjacent split rows', () => {
    const splitFirst = {
      ...textMessage('reasoning-a', 'reasoning', 'turn-active', 100),
      text: '**Planning platform context storage**',
    }
    const splitSecond = {
      ...textMessage('reasoning-b', 'reasoning', 'turn-active', 110),
      text: '**Assessing crash ring payload limits**',
    }
    const consolidated = {
      ...textMessage('reasoning-ab', 'reasoning', 'turn-active', 120),
      text: '**Planning platform context storage**\n\n**Assessing crash ring payload limits**',
    }

    expect(mergeThreadTextPage([splitFirst, splitSecond], [consolidated]).map((message) => message.id)).toEqual([
      'reasoning-ab',
    ])
  })

  it('replaces only matching-turn text while retaining activity and historical turns', () => {
    const historicalReasoning = textMessage('reason-old', 'reasoning', 'turn-old')
    const activity: UiMessage = {
      id: 'tool-active',
      role: 'system',
      text: 'Used tool',
      messageType: 'dynamicToolCall',
      turnId: 'turn-active',
    }
    const transcript = [
      historicalReasoning,
      textMessage('agent-live', 'agentMessage'),
      activity,
      textMessage('agent-after', 'agentMessage', 'turn-after'),
    ]
    const hydrated = [
      textMessage('reason-1', 'reasoning', 'turn-active', 100),
      textMessage('agent-1', 'agentMessage', 'turn-active', 200),
    ]

    const merged = mergeHydratedTurnTextIntoTranscript(transcript, hydrated, 'turn-active')

    expect(merged.map((message) => message.id)).toEqual([
      'reason-old',
      'reason-1',
      'agent-1',
      'agent-live',
      'tool-active',
      'agent-after',
    ])
    expect(merged[0]).toBe(historicalReasoning)
    expect(merged[4]).toBe(activity)
    expect(merged[5]).toBe(transcript[3])
  })

  it('sorts hydrated and live-only active turn text together by session order', () => {
    const transcript = [
      textMessage('agent-live-earlier', 'agentMessage', 'turn-active', 200),
    ]
    const hydrated = [
      textMessage('reason-hydrated-later', 'reasoning', 'turn-active', 300),
    ]

    const merged = mergeHydratedTurnTextIntoTranscript(transcript, hydrated, 'turn-active')

    expect(merged.map((message) => message.id)).toEqual([
      'agent-live-earlier',
      'reason-hydrated-later',
    ])
  })

  it('deduplicates live-only active text that matches a hydrated text row with a different id', () => {
    const duplicateLiveProjectionRow = {
      ...textMessage('item-live', 'agentMessage', 'turn-active'),
      text: 'CUDA multi-neighbor transport 通过。继续 CUDA ring-shadow route-recovery 过滤集；先检查 GPU。',
    }
    const hydrated = [{
      ...textMessage('msg-hydrated', 'agentMessage', 'turn-active', 44506883),
      text: duplicateLiveProjectionRow.text,
    }]

    const merged = mergeHydratedTurnTextIntoTranscript(
      [duplicateLiveProjectionRow],
      hydrated,
      'turn-active',
    )

    expect(merged.map((message) => message.id)).toEqual(['msg-hydrated'])
  })

  it('does not reinsert live-only reasoning once active text hydration is available', () => {
    const liveReasoning = {
      ...textMessage('rollout:reasoning:100', 'reasoning', 'turn-active'),
      text: '**Defining shape vector and optional bytes**',
    }
    const liveAgent = {
      ...textMessage('agent-live', 'agentMessage', 'turn-active', 200),
      text: 'Visible update',
    }
    const hydrated = [{
      ...textMessage('agent-page', 'agentMessage', 'turn-active', 200),
      text: 'Visible update',
    }]

    const merged = mergeHydratedTurnTextIntoTranscript(
      [liveReasoning, liveAgent],
      hydrated,
      'turn-active',
    )

    expect(merged.map((message) => message.id)).toEqual(['agent-page'])
  })

  it('preserves ordered hydrated active text when a later page only includes newer rows', () => {
    const transcript = [
      {
        ...textMessage('rollout:reasoning:100', 'reasoning', 'turn-active', 100),
        text: 'Earlier hydrated reasoning body.',
      },
      {
        ...textMessage('agent-200', 'agentMessage', 'turn-active', 200),
        text: 'Earlier hydrated response',
      },
    ]
    const hydrated = [
      {
        ...textMessage('reason-300', 'reasoning', 'turn-active', 300),
        text: 'Newer hydrated reasoning body.',
      },
    ]

    const merged = mergeHydratedTurnTextIntoTranscript(transcript, hydrated, 'turn-active')

    expect(merged.map((message) => message.id)).toEqual([
      'rollout:reasoning:100',
      'agent-200',
      'reason-300',
    ])
  })

  it('drops title-only reasoning status rows while keeping reasoning body text', () => {
    const hydrated = [
      {
        ...textMessage('reason-title', 'reasoning', 'turn-active', 100),
        text: '**Planning mobile synchronization**',
      },
      {
        ...textMessage('reason-title-dotted', 'reasoning', 'turn-active', 150),
        text: '**Planning topology.cpp synchronization and testing**',
      },
      {
        ...textMessage('reason-title-exact', 'reasoning', 'turn-active', 175),
        text: 'Planning',
      },
      {
        ...textMessage('reason-title-ellipsis-planning', 'reasoning', 'turn-active', 180),
        text: 'Planning ...',
      },
      {
        ...textMessage('reason-title-ellipsis-updating', 'reasoning', 'turn-active', 181),
        text: 'Updating ...',
      },
      {
        ...textMessage('reason-title-ellipsis-inspecting', 'reasoning', 'turn-active', 182),
        text: 'Inspecting ...',
      },
      {
        ...textMessage('reason-title-ellipsis-reviewing', 'reasoning', 'turn-active', 183),
        text: 'Reviewing ...',
      },
      {
        ...textMessage('reason-title-scope', 'reasoning', 'turn-active', 190),
        text: 'Verifying std::array initialization and constexpr usage',
      },
      {
        ...textMessage('reason-body', 'reasoning', 'turn-active', 200),
        text: 'The runtime refresh now only needs the changed thread id.',
      },
    ]

    const merged = mergeHydratedTurnTextIntoTranscript([], hydrated, 'turn-active')

    expect(merged.map((message) => message.id)).toEqual(['reason-body'])
  })

  it('keeps the active turn user message before hydrated assistant text', () => {
    const user: UiMessage = {
      id: 'user-active',
      role: 'user',
      text: '继续',
      messageType: 'userMessage',
      turnId: 'turn-active',
    }
    const activity: UiMessage = {
      id: 'tool-active',
      role: 'system',
      text: 'Called codegraph.codegraph_explore',
      messageType: 'mcpToolCall',
      turnId: 'turn-active',
    }
    const transcript = [
      user,
      activity,
    ]
    const hydrated = [
      textMessage('reason-1', 'reasoning', 'turn-active', 100),
      textMessage('agent-1', 'agentMessage', 'turn-active', 200),
    ]

    const merged = mergeHydratedTurnTextIntoTranscript(transcript, hydrated, 'turn-active')

    expect(merged.map((message) => message.id)).toEqual([
      'user-active',
      'reason-1',
      'agent-1',
      'tool-active',
    ])
  })

  it('keeps a hydrated active turn user message when live-state omitted active items', () => {
    const hydrated = [
      userMessage('user-active', '设置 goal: 需要最终审核 0/0/0 通过', 'turn-active', 100),
      textMessage('agent-1', 'agentMessage', 'turn-active', 200),
    ]

    const merged = mergeHydratedTurnTextIntoTranscript([], hydrated, 'turn-active')

    expect(merged.map((message) => message.id)).toEqual([
      'user-active',
      'agent-1',
    ])
    expect(merged[0]?.role).toBe('user')
    expect(merged[0]?.text).toBe('设置 goal: 需要最终审核 0/0/0 通过')
  })

  it('keeps ordered mid-turn user messages in session order', () => {
    const transcript = [{
      id: 'tool-active',
      role: 'system',
      text: 'Ran a command',
      messageType: 'mcpToolCall',
      turnId: 'turn-active',
    } satisfies UiMessage]
    const hydrated = [
      textMessage('agent-before', 'agentMessage', 'turn-active', 100),
      userMessage('user-steer', '补充约束', 'turn-active', 200),
      textMessage('agent-after', 'agentMessage', 'turn-active', 300),
    ]

    const merged = mergeHydratedTurnTextIntoTranscript(transcript, hydrated, 'turn-active')

    expect(merged.map((message) => message.id)).toEqual([
      'agent-before',
      'user-steer',
      'agent-after',
      'tool-active',
    ])
  })

  it('removes reasoning on completion but retains commentary and final responses', () => {
    const messages = [
      textMessage('reason-historical', 'reasoning', 'turn-previous', 50),
      textMessage('reason-1', 'reasoning', 'turn-active', 100),
      {
        ...textMessage('agent-commentary', 'agentMessage', 'turn-active', 200),
        text: 'Working update',
      },
      {
        ...textMessage('agent-final', 'agentMessage', 'turn-active', 400),
        text: 'Final response',
      },
    ]

    expect(finalizeHydratedTurnText(messages, 'turn-active').map((message) => message.id)).toEqual([
      'reason-historical',
      'agent-commentary',
      'agent-final',
    ])
  })
})
