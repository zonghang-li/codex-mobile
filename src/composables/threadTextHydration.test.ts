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

  it('removes reasoning on completion but retains commentary and final responses', () => {
    const messages = [
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

    expect(finalizeHydratedTurnText(messages).map((message) => message.id)).toEqual([
      'agent-commentary',
      'agent-final',
    ])
  })
})
