import { describe, expect, it } from 'vitest'
import type { UiMessage } from '../types/codex'
import {
  mergeExternalReasoningSnapshots,
  readExternalReasoningSnapshot,
} from './externalLiveSnapshot'

function reasoning(id: string, turnId: string, text: string): UiMessage {
  return { id, turnId, role: 'assistant', text, messageType: 'reasoning' }
}

describe('external live reasoning snapshot', () => {
  it('uses the latest active-turn summary paragraph and removes one outer bold wrapper', () => {
    const result = readExternalReasoningSnapshot([
      reasoning('old-turn', 'turn-old', '**Ignore me**'),
      reasoning('reasoning-1', 'turn-active', '**Inspecting fixtures**\n\n**Reading development-workflow.md**'),
    ], 'turn-active')

    expect(result).toEqual({
      turnId: 'turn-active',
      label: 'Reading development-workflow.md',
      hiddenMessageIds: ['reasoning-1'],
    })
  })

  it('hides every active-turn reasoning item but takes the newest non-empty label', () => {
    expect(readExternalReasoningSnapshot([
      reasoning('reasoning-1', 'turn-active', '**Planning**'),
      reasoning('reasoning-2', 'turn-active', '  Designing   tests  '),
    ], 'turn-active')).toEqual({
      turnId: 'turn-active',
      label: 'Designing tests',
      hiddenMessageIds: ['reasoning-1', 'reasoning-2'],
    })
  })

  it('returns an empty fallback state without exposing another turn', () => {
    expect(readExternalReasoningSnapshot([
      reasoning('reasoning-1', 'turn-old', '**Old summary**'),
    ], 'turn-active')).toEqual({
      turnId: 'turn-active',
      label: '',
      hiddenMessageIds: [],
    })
  })

  it('carries the same-turn label and hidden ids across bounded snapshots', () => {
    expect(mergeExternalReasoningSnapshots(
      {
        turnId: 'turn-active',
        label: 'Inspecting fixtures',
        hiddenMessageIds: ['reasoning-1'],
      },
      {
        turnId: 'turn-active',
        label: '',
        hiddenMessageIds: ['reasoning-2'],
      },
    )).toEqual({
      turnId: 'turn-active',
      label: 'Inspecting fixtures',
      hiddenMessageIds: ['reasoning-1', 'reasoning-2'],
    })
  })
})
