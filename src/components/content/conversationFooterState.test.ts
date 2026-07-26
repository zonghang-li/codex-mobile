import { describe, expect, it } from 'vitest'
import type { UiFileChange, UiMessage, UiPlanStep } from '../../types/codex'
import {
  deriveConversationFooterState,
  selectDesktopPlanStep,
} from './conversationFooterState'

function planMessage(
  turnId: string,
  steps: UiPlanStep[],
  id = `${turnId}:plan`,
): UiMessage {
  return {
    id,
    role: 'assistant',
    text: '',
    messageType: 'plan.live',
    turnId,
    plan: { steps },
  }
}

function fileChange(
  path: string,
  addedLineCount: number,
  removedLineCount: number,
): UiFileChange {
  return {
    path,
    operation: 'update',
    movedToPath: null,
    diff: `@@ ${path} @@`,
    addedLineCount,
    removedLineCount,
  }
}

function fileChangeMessage(
  turnId: string,
  changes: UiFileChange[],
  id = `${turnId}:files`,
): UiMessage {
  return {
    id,
    role: 'assistant',
    text: '',
    messageType: 'fileChange',
    turnId,
    fileChanges: changes,
    fileChangeStatus: 'completed',
  }
}

describe('selectDesktopPlanStep', () => {
  it('uses the first in-progress step before any other open step', () => {
    const steps: UiPlanStep[] = [
      { step: 'Inspect', status: 'completed' },
      { step: 'Implement', status: 'inProgress' },
      { step: 'Verify', status: 'pending' },
    ]

    expect(selectDesktopPlanStep(steps)).toBe(1)
  })

  it('uses the first open step, then the last step after completion', () => {
    expect(selectDesktopPlanStep([
      { step: 'Inspect', status: 'pending' },
      { step: 'Implement', status: 'pending' },
    ])).toBe(0)

    expect(selectDesktopPlanStep([
      { step: 'Inspect', status: 'completed' },
      { step: 'Implement', status: 'completed' },
    ])).toBe(1)
  })

  it('returns null for an empty plan', () => {
    expect(selectDesktopPlanStep([])).toBeNull()
  })
})

describe('deriveConversationFooterState', () => {
  it('uses an authoritative writer footer instead of stale message-derived plan data', () => {
    const result = deriveConversationFooterState({
      messages: [{
        id: 'stale-plan',
        role: 'assistant',
        text: '',
        messageType: 'plan',
        turnId: 'turn-1',
        plan: {
          steps: [
            { step: 'old 1', status: 'completed' },
            { step: 'old 2', status: 'inProgress' },
            { step: 'old 3', status: 'pending' },
            { step: 'old 4', status: 'pending' },
            { step: 'old 5', status: 'pending' },
          ],
        },
      }],
      turnId: 'turn-1',
      isTurnInProgress: true,
      externalLiveAuthority: 'writer-snapshot',
      authoritativeFooter: {
        stepCurrent: 2,
        stepTotal: 6,
        completedPercent: 33.3333,
        fileCount: 29,
        additions: 5485,
        deletions: 417,
        label: 'Step 2 / 6 · 29 files changed +5485 -417',
      },
    })

    expect(result).toEqual({
      turnId: 'turn-1',
      stepNumber: 2,
      stepCount: 6,
      completedPercent: 33.3333,
      fileCount: 29,
      additions: 5485,
      deletions: 417,
    })
  })

  it('suppresses stale message-derived footer when external live authority is missing', () => {
    expect(deriveConversationFooterState({
      messages: [{
        id: 'stale-plan',
        role: 'assistant',
        text: '',
        messageType: 'plan',
        turnId: 'turn-1',
        plan: {
          steps: [
            { step: 'old 1', status: 'completed' },
            { step: 'old 2', status: 'inProgress' },
            { step: 'old 3', status: 'pending' },
            { step: 'old 4', status: 'pending' },
            { step: 'old 5', status: 'pending' },
          ],
        },
      }],
      turnId: 'turn-1',
      isTurnInProgress: true,
      externalLiveAuthority: 'missing',
      authoritativeFooter: null,
    })).toBeNull()
  })

  it('combines the current plan and file changes using desktop progress rules', () => {
    const result = deriveConversationFooterState({
      messages: [
        planMessage('turn-7', [
          { step: 'Inspect', status: 'completed' },
          { step: 'Implement', status: 'inProgress' },
          { step: 'Verify', status: 'pending' },
        ]),
        fileChangeMessage('turn-7', [
          fileChange('src/App.vue', 10, 3),
        ]),
      ],
      turnId: 'turn-7',
      isTurnInProgress: true,
    })

    expect(result).toMatchObject({
      turnId: 'turn-7',
      stepNumber: 2,
      stepCount: 3,
      fileCount: 1,
      additions: 10,
      deletions: 3,
    })
    expect(result?.completedPercent).toBeCloseTo(100 / 3)
  })

  it('uses the newest plan and aggregates repeated path entries for the active turn', () => {
    const result = deriveConversationFooterState({
      messages: [
        planMessage('turn-7', [
          { step: 'Old plan', status: 'pending' },
        ], 'plan-old'),
        planMessage('turn-7', [
          { step: 'Inspect', status: 'completed' },
          { step: 'Implement', status: 'completed' },
        ], 'plan-new'),
        fileChangeMessage('turn-7', [
          fileChange('src/App.vue', 10, 3),
        ], 'files-first'),
        fileChangeMessage('turn-7', [
          fileChange('src/App.vue', 2, 1),
        ], 'files-second'),
      ],
      turnId: 'turn-7',
      isTurnInProgress: true,
    })

    expect(result).toEqual({
      turnId: 'turn-7',
      stepNumber: 2,
      stepCount: 2,
      completedPercent: 100,
      fileCount: 1,
      additions: 12,
      deletions: 4,
    })
  })

  it('ignores other turns and hides when the authoritative turn is not active', () => {
    const messages = [
      planMessage('turn-7', [
        { step: 'Implement', status: 'inProgress' },
      ]),
      fileChangeMessage('turn-7', [fileChange('src/App.vue', 1, 0)]),
    ]

    expect(deriveConversationFooterState({
      messages,
      turnId: 'turn-8',
      isTurnInProgress: true,
    })).toBeNull()

    expect(deriveConversationFooterState({
      messages,
      turnId: 'turn-7',
      isTurnInProgress: false,
    })).toBeNull()
  })
})
