import { describe, expect, it } from 'vitest'
import type { UiProjectGroup, UiThread } from '../../types/codex'
import {
  getSidebarThreadState,
  hasSidebarAttention,
} from './threadSidebarState'

function thread(overrides: Partial<UiThread> = {}): UiThread {
  return {
    id: 'thread-1',
    title: 'Thread',
    projectName: 'Project',
    cwd: '/tmp/project',
    hasWorktree: false,
    createdAtIso: '2026-07-28T00:00:00.000Z',
    updatedAtIso: '2026-07-28T00:00:00.000Z',
    preview: '',
    unread: false,
    inProgress: false,
    ...overrides,
  }
}

function groups(...threads: UiThread[]): UiProjectGroup[] {
  return [{ projectName: 'Project', threads }]
}

describe('sidebar thread state', () => {
  it.each([
    [thread({ pendingRequestState: 'approval' }), 'awaiting-approval'],
    [thread({ pendingRequestState: 'response' }), 'awaiting-response'],
    [thread({ inProgress: true }), 'working'],
    [thread({ unread: true }), 'unread'],
    [thread(), 'idle'],
  ] as const)('resolves the canonical row state', (input, expected) => {
    expect(getSidebarThreadState(input)).toBe(expected)
  })

  it('activates the top dot for unread and pending threads but not working or read threads', () => {
    expect(hasSidebarAttention(groups(thread({ unread: true })))).toBe(true)
    expect(hasSidebarAttention(groups(thread({ pendingRequestState: 'response' })))).toBe(true)
    expect(hasSidebarAttention(groups(thread({ pendingRequestState: 'approval' })))).toBe(true)
    expect(hasSidebarAttention(groups(thread({ inProgress: true })))).toBe(false)
    expect(hasSidebarAttention(groups(thread()))).toBe(false)
  })

  it('uses pending state priority consistently when flags overlap', () => {
    const pendingAndRunning = thread({
      unread: true,
      inProgress: true,
      pendingRequestState: 'approval',
    })

    expect(getSidebarThreadState(pendingAndRunning)).toBe('awaiting-approval')
    expect(hasSidebarAttention(groups(pendingAndRunning))).toBe(true)
  })
})
