import type {
  ConversationFooterState,
  UiFileChange,
  UiMessage,
  UiPlanStep,
  UiThreadLiveAuthority,
  UiThreadLiveFooter,
} from '../../types/codex'

export type ConversationFooterInput = {
  messages: readonly UiMessage[]
  turnId: string
  isTurnInProgress: boolean
  authoritativeFooter?: UiThreadLiveFooter | null
  externalLiveAuthority?: UiThreadLiveAuthority | null
}

export function selectDesktopPlanStep(steps: readonly UiPlanStep[]): number | null {
  if (steps.length === 0) return null
  const inProgressIndex = steps.findIndex((step) => step.status === 'inProgress')
  if (inProgressIndex >= 0) return inProgressIndex
  const firstOpenIndex = steps.findIndex((step) => step.status !== 'completed')
  return firstOpenIndex >= 0 ? firstOpenIndex : steps.length - 1
}

function fileChangeKey(change: UiFileChange): string {
  return `${change.path}\u0000${change.movedToPath ?? ''}`
}

export function deriveConversationFooterState(
  input: ConversationFooterInput,
): ConversationFooterState | null {
  const turnId = input.turnId.trim()
  if (!input.isTurnInProgress || !turnId) return null

  if (input.authoritativeFooter) {
    const footer = input.authoritativeFooter
    return {
      turnId,
      stepNumber: footer.stepCurrent,
      stepCount: footer.stepTotal ?? 0,
      completedPercent: footer.completedPercent ?? 0,
      fileCount: footer.fileCount ?? 0,
      additions: footer.additions ?? 0,
      deletions: footer.deletions ?? 0,
    }
  }

  if (input.externalLiveAuthority) return null

  let latestPlan: readonly UiPlanStep[] = []
  const fileChangesByPath = new Map<string, UiFileChange>()
  const seenMessageIds = new Set<string>()

  for (const message of input.messages) {
    if (message.turnId !== turnId || seenMessageIds.has(message.id)) continue
    seenMessageIds.add(message.id)

    if (message.plan) {
      latestPlan = message.plan.steps
    }

    for (const change of message.fileChanges ?? []) {
      const key = fileChangeKey(change)
      const previous = fileChangesByPath.get(key)
      fileChangesByPath.set(key, previous
        ? {
            ...change,
            addedLineCount: previous.addedLineCount + change.addedLineCount,
            removedLineCount: previous.removedLineCount + change.removedLineCount,
          }
        : { ...change })
    }
  }

  if (latestPlan.length === 0 && fileChangesByPath.size === 0) return null

  const selectedStepIndex = selectDesktopPlanStep(latestPlan)
  const completedStepCount = latestPlan.reduce(
    (count, step) => count + Number(step.status === 'completed'),
    0,
  )
  const changes = Array.from(fileChangesByPath.values())

  return {
    turnId,
    stepNumber: selectedStepIndex === null ? null : selectedStepIndex + 1,
    stepCount: latestPlan.length,
    completedPercent: latestPlan.length > 0
      ? (completedStepCount / latestPlan.length) * 100
      : 0,
    fileCount: changes.length,
    additions: changes.reduce((sum, change) => sum + change.addedLineCount, 0),
    deletions: changes.reduce((sum, change) => sum + change.removedLineCount, 0),
  }
}
