export type ThreadRowInteractionAction = 'main' | 'overflow'

export type ThreadRowInteractionHandlers = {
  onOverflow: (threadId: string) => void
  onSelect: (threadId: string) => void
}

export function dispatchThreadRowInteraction(
  action: ThreadRowInteractionAction,
  threadId: string,
  handlers: ThreadRowInteractionHandlers,
): void {
  if (action === 'main') {
    handlers.onSelect(threadId)
    return
  }
  handlers.onOverflow(threadId)
}
