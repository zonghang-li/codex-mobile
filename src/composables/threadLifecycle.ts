export type TurnTerminalStatus = 'completed' | 'failed' | 'interrupted' | 'declined' | string

export type TurnCompletionDisposition = {
  ownsActiveLease: boolean
  keepRunning: boolean
  markUnread: boolean
}

export function resolveTurnCompletionDisposition(
  status: TurnTerminalStatus,
  willRetry: boolean,
  isSelected: boolean,
  activeTurnId = '',
  completedTurnId = '',
): TurnCompletionDisposition {
  const ownsActiveLease = !activeTurnId || activeTurnId === completedTurnId
  if (!ownsActiveLease) {
    return { ownsActiveLease: false, keepRunning: true, markUnread: false }
  }
  if (willRetry) {
    return { ownsActiveLease: true, keepRunning: true, markUnread: false }
  }
  return {
    ownsActiveLease: true,
    keepRunning: false,
    markUnread: status === 'completed' && !isSelected,
  }
}
