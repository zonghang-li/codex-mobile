import { describe, expect, it } from 'vitest'
import { deriveThreadGoalPresentation } from './threadGoalPresentation'

describe('deriveThreadGoalPresentation', () => {
  it('uses live elapsed time and token-budget progress for an active goal', () => {
    expect(deriveThreadGoalPresentation({
      objective: 'Match the Codex conversation page',
      status: 'active',
      updatedAt: 100,
      timeUsedSeconds: 75,
      tokensUsed: 2000,
      tokenBudget: 8000,
    }, 130_000)).toEqual({
      label: 'Pursuing goal',
      durationLabel: '1m 45s',
      progressPercent: 25,
      canPause: true,
      canResume: false,
    })
  })

  it.each([
    ['paused', 'Paused goal', true],
    ['blocked', 'Goal blocked', false],
    ['usageLimited', 'Goal usage limited', false],
    ['budgetLimited', 'Goal limited', false],
    ['complete', 'Goal achieved', false],
  ] as const)('maps %s to the desktop status label', (status, label, canResume) => {
    expect(deriveThreadGoalPresentation({
      objective: 'Ship it',
      status,
      updatedAt: 100,
      timeUsedSeconds: 3605,
      tokensUsed: 100,
      tokenBudget: null,
    }, 900_000)).toMatchObject({
      label,
      durationLabel: '1h 5s',
      canPause: false,
      canResume,
    })
  })
})
