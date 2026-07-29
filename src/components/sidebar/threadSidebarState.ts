import type { UiProjectGroup, UiThread } from '../../types/codex'

export type SidebarThreadState =
  | 'awaiting-approval'
  | 'awaiting-response'
  | 'working'
  | 'unread'
  | 'idle'

export function getSidebarThreadState(thread: UiThread): SidebarThreadState {
  if (thread.pendingRequestState === 'approval') return 'awaiting-approval'
  if (thread.pendingRequestState === 'response') return 'awaiting-response'
  if (thread.inProgress) return 'working'
  if (thread.unread) return 'unread'
  return 'idle'
}

export function hasSidebarAttention(groups: readonly UiProjectGroup[]): boolean {
  return groups.some((group) => group.threads.some((thread) => {
    const state = getSidebarThreadState(thread)
    return state !== 'working' && state !== 'idle'
  }))
}
