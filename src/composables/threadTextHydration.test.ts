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
