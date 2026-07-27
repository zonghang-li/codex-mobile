import type { UiThreadGoal, UiThreadGoalStatus } from '../../types/codex'

const STATUS_LABELS: Record<UiThreadGoalStatus, string> = {
  active: 'Pursuing goal',
  paused: 'Paused goal',
  blocked: 'Goal blocked',
  usageLimited: 'Goal usage limited',
  budgetLimited: 'Goal limited',
  complete: 'Goal achieved',
}

function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const parts: string[] = []
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0) parts.push(`${minutes}m`)
  if (parts.length === 0) return '<1m'
  return parts.join(' ')
}

export function deriveThreadGoalPresentation(goal: UiThreadGoal, nowMs = Date.now()) {
  const liveSeconds = goal.status === 'active'
    ? Math.max(0, nowMs / 1000 - goal.updatedAt)
    : 0
  const elapsedSeconds = goal.timeUsedSeconds + liveSeconds
  const progressPercent = goal.tokenBudget && goal.tokenBudget > 0
    ? Math.max(0, Math.min(100, Math.round((goal.tokensUsed / goal.tokenBudget) * 100)))
    : null

  return {
    label: STATUS_LABELS[goal.status],
    durationLabel: formatDuration(elapsedSeconds),
    progressPercent,
    canPause: goal.status === 'active',
    canResume: goal.status === 'paused',
  }
}
