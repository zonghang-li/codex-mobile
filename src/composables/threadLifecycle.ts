export type TurnTerminalStatus = 'completed' | 'failed' | 'interrupted' | 'declined' | string

export type TurnCompletionDisposition = {
  keepRunning: boolean
  markUnread: boolean
}

export function resolveTurnCompletionDisposition(
  status: TurnTerminalStatus,
  willRetry: boolean,
  isSelected: boolean,
): TurnCompletionDisposition {
  if (willRetry) return { keepRunning: true, markUnread: false }
  return {
    keepRunning: false,
    markUnread: status === 'completed' && !isSelected,
  }
}
