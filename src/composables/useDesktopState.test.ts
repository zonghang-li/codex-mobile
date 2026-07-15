import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { watch } from 'vue'
import {
  buildWorkspaceRootsProjectOrderState,
  collectWorkspaceRootPathsForProjectRemoval,
  filterGroupsByWorkspaceRoots,
  findAdjacentThreadId,
  removeThreadFromGroups,
  isThreadUnreadByLastRead,
  useDesktopState,
} from './useDesktopState'
import type { UiMessage, UiProjectGroup } from '../types/codex'
import type { WorkspaceRootsState } from '../api/codexGateway'

const gatewayMocks = vi.hoisted(() => ({
  archiveThread: vi.fn(),
  forkThread: vi.fn(),
  getAccountRateLimits: vi.fn(),
  getAvailableCollaborationModes: vi.fn(),
  getAvailableModelIds: vi.fn(),
  getCurrentModelConfig: vi.fn(),
  getPendingServerRequests: vi.fn(),
  getSkillsList: vi.fn(),
  getExternalThreadLiveSnapshot: vi.fn(),
  getThreadDetail: vi.fn(),
  getThreadGroupsPage: vi.fn(),
  getThreadRuntimeState: vi.fn(),
  getThreadRuntimeStates: vi.fn(),
  getThreadQueueState: vi.fn(),
  getThreadTitleCache: vi.fn(),
  getWorkspaceRootsState: vi.fn(),
  generateThreadTitle: vi.fn(),
  interruptThreadTurn: vi.fn(),
  persistThreadTitle: vi.fn(),
  renameThread: vi.fn(),
  replyToServerRequest: vi.fn(),
  resumeThread: vi.fn(),
  revertThreadFileChanges: vi.fn(),
  rollbackThread: vi.fn(),
  setCodexSpeedMode: vi.fn(),
  setThreadQueueState: vi.fn(),
  setWorkspaceRootsState: vi.fn(),
  startThread: vi.fn(),
  startThreadTurn: vi.fn(),
  subscribeCodexNotifications: vi.fn(),
}))

const pollingCleanups: Array<() => void> = []

vi.mock('../api/codexGateway', () => ({
  ...gatewayMocks,
  getBackgroundThreadListLimit: vi.fn(() => 100),
  pickCodexRateLimitSnapshot: vi.fn(() => null),
}))

function thread(id: string, cwd: string, options: { hasWorktree?: boolean } = {}) {
  return {
    id,
    title: id,
    projectName: cwd ? cwd.split('/').at(-1) || cwd : 'Projectless',
    cwd,
    hasWorktree: options.hasWorktree ?? false,
    createdAtIso: '2026-04-28T00:00:00.000Z',
    updatedAtIso: '2026-04-28T00:00:00.000Z',
    preview: '',
    unread: false,
    inProgress: false,
  }
}

function installTestWindow(initialStorage: Record<string, string> = {}) {
  const store = new Map(Object.entries(initialStorage))
  vi.stubGlobal('window', {
    localStorage: {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store.set(key, value)
      }),
      removeItem: vi.fn((key: string) => {
        store.delete(key)
      }),
    },
    setTimeout: vi.fn(),
    clearTimeout: vi.fn(),
  })
}

function installFakeTimerWindow(initialStorage: Record<string, string> = {}) {
  installTestWindow(initialStorage)
  vi.mocked(window.setTimeout).mockImplementation(globalThis.setTimeout as typeof window.setTimeout)
  vi.mocked(window.clearTimeout).mockImplementation(globalThis.clearTimeout as typeof window.clearTimeout)
}

function externalDetail(turnId = 'turn-external') {
  return {
    model: '',
    modelProvider: '',
    messages: [],
    inProgress: true,
    activeTurnId: turnId,
    hasMoreOlder: false,
    turnIndexByTurnId: {},
    ownership: 'external' as const,
    canInterrupt: false,
    externalRuntimeState: 'running' as const,
  }
}

function idleDetail() {
  return {
    model: '',
    modelProvider: '',
    messages: [],
    inProgress: false,
    activeTurnId: '',
    hasMoreOlder: false,
    turnIndexByTurnId: {},
    ownership: 'idle' as const,
    canInterrupt: false,
    externalRuntimeState: 'idle' as const,
  }
}

function localDetail(turnId = '') {
  return {
    ...idleDetail(),
    inProgress: true,
    activeTurnId: turnId,
    ownership: 'local' as const,
    canInterrupt: true,
    externalRuntimeState: 'unknown' as const,
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function setupExternalRuntimeState() {
  vi.useFakeTimers()
  installFakeTimerWindow()
  let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
  gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
    notificationHandler = handler as typeof notificationHandler
    return vi.fn()
  })
  gatewayMocks.getPendingServerRequests.mockResolvedValue([])
  gatewayMocks.getThreadGroupsPage.mockResolvedValue({
    groups: [{ projectName: 'Project', threads: [
      thread('thread-1', '/tmp/project'),
      thread('thread-2', '/tmp/project'),
    ] }],
    nextCursor: null,
  })

  const state = useDesktopState()
  await state.refreshAll({ includeSelectedThreadMessages: false })
  state.primeSelectedThread('thread-1')
  state.startPolling()
  pollingCleanups.push(() => state.stopPolling())
  expect(notificationHandler).toBeDefined()

  return {
    state,
    emit(notification: { method: string; params?: unknown }) {
      notificationHandler!(notification)
    },
  }
}

async function setupBackgroundRuntimeState(selectedThreadId = 'thread-selected') {
  vi.useFakeTimers()
  installFakeTimerWindow({
    'codex-web-local.thread-unread-cutoff.v1': '2026-01-01T00:00:00.000Z',
  })
  vi.stubGlobal('document', {
    visibilityState: 'visible',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })
  gatewayMocks.getPendingServerRequests.mockResolvedValue([])
  gatewayMocks.getThreadGroupsPage.mockResolvedValue({
    groups: [{ projectName: 'Project', threads: [
      { ...thread('thread-running', '/tmp/project'), updatedAtIso: '2026-07-14T00:00:00.000Z' },
      thread(selectedThreadId, '/tmp/project'),
    ] }],
    nextCursor: null,
  })
  const state = useDesktopState()
  state.primeSelectedThread(selectedThreadId)
  await state.refreshAll({ includeSelectedThreadMessages: false })
  return state
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve()
  }
}

async function setupTurnLifecycleNotificationState(selectedThreadId: string) {
  installTestWindow()
  let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
  gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
    notificationHandler = handler as typeof notificationHandler
    return vi.fn()
  })
  gatewayMocks.getPendingServerRequests.mockResolvedValue([])
  gatewayMocks.getThreadGroupsPage.mockResolvedValue({
    groups: [{ projectName: 'Project', threads: [thread('thread-1', '/tmp/project')] }],
    nextCursor: null,
  })

  const state = useDesktopState()
  await state.refreshAll({ includeSelectedThreadMessages: false })
  state.primeSelectedThread(selectedThreadId)
  state.startPolling()
  pollingCleanups.push(() => state.stopPolling())
  expect(notificationHandler).toBeDefined()

  return {
    state,
    emit(notification: { method: string; params?: unknown }) {
      notificationHandler!(notification)
    },
  }
}

async function setupCodexDirectiveNotificationState(groups: UiProjectGroup[] = [{
  projectName: 'Project',
  threads: [thread('thread-1', '/tmp/project')],
}]) {
  installTestWindow()
  let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
  gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
    notificationHandler = handler as typeof notificationHandler
    return vi.fn()
  })
  gatewayMocks.getPendingServerRequests.mockResolvedValue([])
  gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups, nextCursor: null })

  const state = useDesktopState()
  await state.refreshAll({ includeSelectedThreadMessages: false })
  state.primeSelectedThread('thread-1')
  state.startPolling()
  pollingCleanups.push(() => state.stopPolling())

  return {
    state,
    emit(notification: { method: string; params?: unknown }) {
      expect(notificationHandler).toBeDefined()
      notificationHandler!(notification)
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  gatewayMocks.getExternalThreadLiveSnapshot.mockImplementation(
    (threadId: string, signal?: AbortSignal) => gatewayMocks.getThreadDetail(threadId, signal),
  )
  gatewayMocks.getThreadQueueState.mockResolvedValue({})
  gatewayMocks.getThreadRuntimeStates.mockResolvedValue({})
  gatewayMocks.setThreadQueueState.mockResolvedValue(undefined)
  gatewayMocks.getThreadTitleCache.mockResolvedValue({ titles: {} })
  gatewayMocks.getWorkspaceRootsState.mockRejectedValue(new Error('no workspace roots state'))
})

afterEach(() => {
  for (const cleanup of pollingCleanups.splice(0)) {
    cleanup()
  }
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Codex directive notification state', () => {
  it('accumulates split deltas until an incomplete directive resolves', async () => {
    const { state, emit } = await setupCodexDirectiveNotificationState()

    emit({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', itemId: 'agent-1', delta: 'Done.\n\n::git-pu' },
    })
    expect(state.messages.value.at(-1)).toMatchObject({
      id: 'agent-1',
      text: 'Done.',
    })

    emit({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-1',
        itemId: 'agent-1',
        delta: 'sh{cwd="/tmp/repo" branch="main"}',
      },
    })
    expect(state.messages.value.at(-1)).toMatchObject({
      id: 'agent-1',
      text: 'Done.',
      directives: [{ kind: 'git-push', cwd: '/tmp/repo', branch: 'main' }],
    })
  })

  it('withholds and then renders a split future directive without raw fragments', async () => {
    const { state, emit } = await setupCodexDirectiveNotificationState()
    emit({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', itemId: 'agent-1', delta: 'Done.\n::future-dire' },
    })
    expect(state.messages.value.at(-1)).toMatchObject({ text: 'Done.' })
    expect(state.messages.value.at(-1)?.directives).toBeUndefined()

    emit({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-1',
        itemId: 'agent-1',
        delta: 'ctive{phase="done"}',
      },
    })
    expect(state.messages.value.at(-1)).toMatchObject({
      text: 'Done.',
      directives: [{
        kind: 'generic',
        name: 'future-directive',
        attributes: [{ key: 'phase', value: 'done', sensitive: false }],
      }],
    })
  })

  it('turns a still-incomplete future directive into one warning on completion', async () => {
    const { state, emit } = await setupCodexDirectiveNotificationState()
    const text = 'Done.\n::future{x="1"'
    emit({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', itemId: 'agent-1', delta: text },
    })
    expect(state.messages.value.at(-1)).toMatchObject({ text: 'Done.' })
    expect(state.messages.value.at(-1)?.directives).toBeUndefined()

    emit({
      method: 'item/completed',
      params: { threadId: 'thread-1', item: { id: 'agent-1', type: 'agentMessage', text } },
    })
    expect(state.messages.value.at(-1)).toMatchObject({
      text: 'Done.',
      directives: [{ kind: 'invalid', name: 'future', reason: 'incomplete' }],
    })
    expect(state.messages.value.filter((message) => message.id === 'agent-1')).toHaveLength(1)
  })

  it('clears raw delta state when an empty agent message completes', async () => {
    const { state, emit } = await setupCodexDirectiveNotificationState()

    emit({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', itemId: 'agent-1', delta: 'stale' },
    })
    emit({
      method: 'item/completed',
      params: { threadId: 'thread-1', item: { id: 'agent-1', type: 'agentMessage', text: '' } },
    })
    expect(state.messages.value.at(-1)).toMatchObject({ id: 'agent-1', text: '' })

    emit({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', itemId: 'agent-1', delta: 'fresh' },
    })
    expect(state.messages.value.at(-1)).toMatchObject({ id: 'agent-1', text: 'fresh' })
  })

  it('prunes raw delta state when a thread becomes inactive', async () => {
    const { state, emit } = await setupCodexDirectiveNotificationState([
      { projectName: 'Project One', threads: [thread('thread-1', '/tmp/project-one')] },
      { projectName: 'Project Two', threads: [thread('thread-2', '/tmp/project-two')] },
    ])

    emit({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', itemId: 'agent-1', delta: 'stale' },
    })
    state.primeSelectedThread('thread-2')
    await state.removeProject('Project One')
    state.primeSelectedThread('thread-1')
    emit({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', itemId: 'agent-1', delta: 'fresh' },
    })

    expect(state.messages.value.at(-1)).toMatchObject({ id: 'agent-1', text: 'fresh' })
  })

  it('clears all raw delta state when notification polling stops', async () => {
    const { state, emit } = await setupCodexDirectiveNotificationState()

    emit({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', itemId: 'agent-1', delta: 'stale' },
    })
    state.stopPolling()
    state.startPolling()
    emit({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', itemId: 'agent-1', delta: 'fresh' },
    })

    expect(state.messages.value.at(-1)).toMatchObject({ id: 'agent-1', text: 'fresh' })
  })
})

describe('filterGroupsByWorkspaceRoots', () => {
  it('keeps projectless chats visible when workspace roots are configured', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'Projectless',
        threads: [thread('projectless-chat', '')],
      },
      {
        projectName: 'allowed-project',
        threads: [thread('allowed-chat', '/tmp/allowed-project')],
      },
      {
        projectName: 'other-project',
        threads: [thread('other-chat', '/tmp/other-project')],
      },
    ]
    const rootsState: WorkspaceRootsState = {
      order: ['/tmp/allowed-project'],
      labels: {},
      active: ['/tmp/allowed-project'],
      projectOrder: [],
    }

    expect(filterGroupsByWorkspaceRoots(groups, rootsState).map((group) => group.projectName)).toEqual([
      'Projectless',
      'allowed-project',
    ])
  })

  it('keeps workspace roots with the same folder name as separate projects', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'api',
        threads: [
          thread('first-api-chat', '/tmp/first/api'),
          thread('second-api-chat', '/tmp/second/api'),
        ],
      },
    ]
    const rootsState: WorkspaceRootsState = {
      order: ['/tmp/first/api', '/tmp/second/api'],
      labels: {},
      active: ['/tmp/first/api', '/tmp/second/api'],
      projectOrder: [],
    }

    expect(filterGroupsByWorkspaceRoots(groups, rootsState).map((group) => group.projectName)).toEqual([
      '/tmp/first/api',
      '/tmp/second/api',
    ])
  })

  it('uses Codex project-order when workspace roots are hydrated', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'alpha',
        threads: [thread('alpha-chat', '/tmp/alpha')],
      },
      {
        projectName: 'beta',
        threads: [thread('beta-chat', '/tmp/beta')],
      },
    ]
    const rootsState: WorkspaceRootsState = {
      order: ['/tmp/alpha', '/tmp/beta'],
      labels: {},
      active: ['/tmp/alpha'],
      projectOrder: ['/tmp/beta', '/tmp/alpha'],
    }

    expect(filterGroupsByWorkspaceRoots(groups, rootsState).map((group) => group.projectName)).toEqual([
      'beta',
      'alpha',
    ])
  })

  it('keeps empty duplicate workspace roots visible in Codex project order', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'TestChat',
        threads: [thread('testchat-chat', '/Users/igor/temp/TestChat')],
      },
    ]
    const rootsState: WorkspaceRootsState = {
      order: ['/Users/igor/Documents/New project 2/TestChat', '/Users/igor/temp/TestChat'],
      labels: {},
      active: ['/Users/igor/Documents/New project 2/TestChat', '/Users/igor/temp/TestChat'],
      projectOrder: ['/Users/igor/Documents/New project 2/TestChat', '/Users/igor/temp/TestChat'],
    }

    expect(filterGroupsByWorkspaceRoots(groups, rootsState).map((group) => [group.projectName, group.threads.length])).toEqual([
      ['/Users/igor/Documents/New project 2/TestChat', 0],
      ['/Users/igor/temp/TestChat', 1],
    ])
  })

  it('keeps remote projects from Codex project order visible as empty project rows', () => {
    const groups: UiProjectGroup[] = []
    const rootsState: WorkspaceRootsState = {
      order: ['/tmp/local-project'],
      labels: {},
      active: ['/tmp/local-project'],
      projectOrder: ['remote-project-id', '/tmp/local-project'],
      remoteProjects: [{
        id: 'remote-project-id',
        hostId: 'remote-ssh-discovered:a1',
        remotePath: '/home/ubuntu',
        label: 'ubuntu',
      }],
    }

    expect(filterGroupsByWorkspaceRoots(groups, rootsState).map((group) => [group.projectName, group.threads.length])).toEqual([
      ['remote-project-id', 0],
      ['local-project', 0],
    ])
  })

  it('keeps managed worktree threads under the matching workspace root project', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'codex-web-local',
        threads: [
          thread('main-chat', '/Users/igor/Git-projects/codex-web-local'),
          thread('worktree-chat', '/Users/igor/.codex/worktrees/53e7/codex-web-local', { hasWorktree: true }),
        ],
      },
    ]
    const rootsState: WorkspaceRootsState = {
      order: ['/Users/igor/Git-projects/codex-web-local'],
      labels: {},
      active: ['/Users/igor/Git-projects/codex-web-local'],
      projectOrder: ['/Users/igor/Git-projects/codex-web-local'],
    }

    expect(filterGroupsByWorkspaceRoots(groups, rootsState).map((group) => [group.projectName, group.threads.map((row) => row.id)])).toEqual([
      ['codex-web-local', ['main-chat', 'worktree-chat']],
    ])
  })

  it('keeps unregistered managed worktrees under the main root when another managed worktree root is registered', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'codex-web-local',
        threads: [
          thread('main-chat', '/Users/igor/Git-projects/codex-web-local'),
          thread('registered-worktree-chat', '/Users/igor/.codex/worktrees/a77f/codex-web-local', { hasWorktree: true }),
          thread('unregistered-worktree-chat', '/Users/igor/.codex/worktrees/53e7/codex-web-local', { hasWorktree: true }),
        ],
      },
    ]
    const rootsState: WorkspaceRootsState = {
      order: [
        '/Users/igor/Git-projects/codex-web-local',
        '/Users/igor/.codex/worktrees/a77f/codex-web-local',
      ],
      labels: {
        '/Users/igor/.codex/worktrees/a77f/codex-web-local': 'codex-web-local2',
      },
      active: ['/Users/igor/Git-projects/codex-web-local'],
      projectOrder: ['/Users/igor/Git-projects/codex-web-local'],
    }

    expect(filterGroupsByWorkspaceRoots(groups, rootsState).map((group) => [group.projectName, group.threads.map((row) => row.id)])).toEqual([
      ['/Users/igor/Git-projects/codex-web-local', ['main-chat', 'unregistered-worktree-chat']],
      ['/Users/igor/.codex/worktrees/a77f/codex-web-local', ['registered-worktree-chat']],
    ])
  })

  it('does not group unrelated git worktrees under a same-leaf workspace root project', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'codex-web-local',
        threads: [
          thread('main-chat', '/Users/igor/Git-projects/codex-web-local'),
          thread('other-git-worktree-chat', '/tmp/other/.git/worktrees/codex-web-local', { hasWorktree: true }),
        ],
      },
    ]
    const rootsState: WorkspaceRootsState = {
      order: ['/Users/igor/Git-projects/codex-web-local'],
      labels: {},
      active: ['/Users/igor/Git-projects/codex-web-local'],
      projectOrder: ['/Users/igor/Git-projects/codex-web-local'],
    }

    expect(filterGroupsByWorkspaceRoots(groups, rootsState).map((group) => [group.projectName, group.threads.map((row) => row.id)])).toEqual([
      ['/Users/igor/Git-projects/codex-web-local', ['main-chat']],
    ])
  })
})

describe('removeThreadFromGroups', () => {
  it('removes an archived thread and drops the now-empty project group', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'alpha',
        threads: [thread('keep-alpha', '/tmp/alpha')],
      },
      {
        projectName: 'archived-project',
        threads: [thread('archive-me', '/tmp/archived-project')],
      },
      {
        projectName: 'beta',
        threads: [thread('keep-beta', '/tmp/beta')],
      },
      {
        projectName: 'empty-workspace-root',
        threads: [],
      },
    ]

    expect(removeThreadFromGroups(groups, 'archive-me').map((group) => [
      group.projectName,
      group.threads.map((row) => row.id),
    ])).toEqual([
      ['alpha', ['keep-alpha']],
      ['beta', ['keep-beta']],
      ['empty-workspace-root', []],
    ])
  })

  it('preserves referential identity when the thread is absent', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'alpha',
        threads: [thread('keep-alpha', '/tmp/alpha')],
      },
    ]

    expect(removeThreadFromGroups(groups, 'missing-thread')).toBe(groups)
  })
})

describe('workspace roots project persistence helpers', () => {
  it('collects duplicate-path project roots by full path when removing a project', () => {
    const rootsState: WorkspaceRootsState = {
      order: ['/tmp/first/api', '/tmp/second/api'],
      labels: {
        '/tmp/first/api': 'First API',
        '/tmp/second/api': 'Second API',
      },
      active: ['/tmp/first/api'],
      projectOrder: ['/tmp/first/api', '/tmp/second/api'],
    }

    expect([...collectWorkspaceRootPathsForProjectRemoval(rootsState, '/tmp/first/api')]).toEqual([
      '/tmp/first/api',
    ])
  })

  it('preserves remote project ids in explicit project order when persisting workspace roots', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'local-project',
        threads: [thread('local-chat', '/tmp/local-project')],
      },
    ]
    const rootsState: WorkspaceRootsState = {
      order: ['/tmp/local-project'],
      labels: {},
      active: ['/tmp/local-project'],
      projectOrder: ['remote-project-id', '/tmp/local-project'],
      remoteProjects: [{
        id: 'remote-project-id',
        hostId: 'remote-ssh-discovered:a1',
        remotePath: '/home/ubuntu',
        label: 'ubuntu',
      }],
    }

    expect(buildWorkspaceRootsProjectOrderState(rootsState, ['remote-project-id', 'local-project'], groups)).toEqual({
      order: ['/tmp/local-project'],
      active: ['/tmp/local-project'],
      projectOrder: ['remote-project-id', '/tmp/local-project'],
    })
  })
})

describe('thread unread state helpers', () => {
  const cutoffIso = '2026-05-01T12:00:00.000Z'

  it('uses the initialization cutoff when a thread has no read state', () => {
    expect(isThreadUnreadByLastRead('2026-05-01T11:59:59.000Z', undefined, cutoffIso)).toBe(false)
    expect(isThreadUnreadByLastRead('2026-05-01T12:00:01.000Z', undefined, cutoffIso)).toBe(true)
  })

  it('uses per-thread read state instead of the global cutoff after a thread is read', () => {
    expect(isThreadUnreadByLastRead(
      '2026-05-01T12:30:00.000Z',
      '2026-05-01T12:45:00.000Z',
      cutoffIso,
    )).toBe(false)
    expect(isThreadUnreadByLastRead(
      '2026-05-01T12:50:00.000Z',
      '2026-05-01T12:45:00.000Z',
      cutoffIso,
    )).toBe(true)
  })
})

describe('collaboration mode selection', () => {
  it('can prime an empty selected thread without clearing persisted selection', () => {
    installTestWindow({
      'codex-web-local.selected-thread-id.v1': 'thread-a',
    })

    const state = useDesktopState()

    expect(state.selectedThreadId.value).toBe('thread-a')

    state.primeSelectedThread('', { persist: false })

    expect(state.selectedThreadId.value).toBe('')
    expect(window.localStorage.getItem('codex-web-local.selected-thread-id.v1')).toBe('thread-a')
  })

  it('does not carry plan mode from new chats into existing threads', () => {
    installTestWindow({
      'codex-web-local.collaboration-mode.v1': 'plan',
    })

    const state = useDesktopState()

    expect(state.selectedCollaborationMode.value).toBe('default')

    state.setSelectedCollaborationMode('plan')

    expect(state.selectedCollaborationMode.value).toBe('plan')
    expect(window.localStorage.getItem('codex-web-local.collaboration-mode-by-context.v1')).toBe(null)

    state.primeSelectedThread('thread-a')

    expect(state.selectedCollaborationMode.value).toBe('default')

    state.setSelectedCollaborationMode('plan')
    state.primeSelectedThread('thread-b')

    expect(state.selectedCollaborationMode.value).toBe('default')

    state.primeSelectedThread('thread-a')

    expect(state.selectedCollaborationMode.value).toBe('plan')
  })
})

describe('Codex CLI availability', () => {
  it('surfaces a chat runtime error when the app-server bridge cannot find Codex CLI', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockRejectedValue(new Error('Codex CLI is not available. Install @openai/codex or set CODEXUI_CODEX_COMMAND.'))

    const state = useDesktopState()

    await state.refreshAll({ awaitAncillaryRefreshes: true })

    expect(state.codexCliMissingError.value).toBe('Codex CLI not found. Install @openai/codex or set CODEXUI_CODEX_COMMAND.')
  })

  it('clears a previous Codex CLI missing banner when a later refresh fails for another reason', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage
      .mockRejectedValueOnce(new Error('Codex CLI is not available. Install @openai/codex or set CODEXUI_CODEX_COMMAND.'))
      .mockRejectedValueOnce(new Error('Connection lost'))

    const state = useDesktopState()

    await state.refreshAll({ awaitAncillaryRefreshes: true })
    expect(state.codexCliMissingError.value).toBe('Codex CLI not found. Install @openai/codex or set CODEXUI_CODEX_COMMAND.')

    await state.refreshAll({ awaitAncillaryRefreshes: true })
    expect(state.error.value).toBe('Connection lost')
    expect(state.codexCliMissingError.value).toBe('')
  })

})

describe('startup request deduplication', () => {
  it('reloads cached thread titles on forced thread refresh', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('thread-1', '/tmp/project')] }],
      nextCursor: null,
    })
    gatewayMocks.getThreadTitleCache
      .mockResolvedValueOnce({ titles: {} })
      .mockResolvedValueOnce({ titles: { 'thread-1': 'Imported title' } })

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false })
    expect(state.projectGroups.value[0]?.threads[0]?.title).toBe('thread-1')

    await state.refreshAll({ includeSelectedThreadMessages: false, forceThreadRefresh: true })

    expect(gatewayMocks.getThreadTitleCache).toHaveBeenCalledTimes(2)
    expect(state.projectGroups.value[0]?.threads[0]?.title).toBe('Imported title')
  })

  it('reuses a just-loaded thread list during startup refresh bursts', async () => {
    installTestWindow()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000)
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('thread-1', '/tmp/project')] }],
      nextCursor: null,
    })

    try {
      const state = useDesktopState()
      await state.refreshAll({ includeSelectedThreadMessages: false })
      await state.refreshAll({ includeSelectedThreadMessages: false })

      expect(gatewayMocks.getThreadGroupsPage).toHaveBeenCalledTimes(1)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('reuses a just-loaded skills list for the same selected cwd', async () => {
    installTestWindow()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000)
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('thread-1', '/tmp/project')] }],
      nextCursor: null,
    })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([
      {
        name: 'example',
        description: 'Example skill',
        path: '/tmp/project/.agents/skills/example/SKILL.md',
        scope: 'project',
        enabled: true,
      },
    ])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.5',
      providerId: '',
      reasoningEffort: 'medium',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModelIds.mockResolvedValue(['gpt-5.5'])

    try {
      const state = useDesktopState()
      state.primeSelectedThread('thread-1')
      await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })
      await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })

      expect(gatewayMocks.getSkillsList).toHaveBeenCalledTimes(1)
      expect(gatewayMocks.getSkillsList).toHaveBeenCalledWith(['/tmp/project'])
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('reuses a just-loaded empty skills list for the same selected cwd', async () => {
    installTestWindow()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000)
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('thread-1', '/tmp/project')] }],
      nextCursor: null,
    })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.5',
      providerId: '',
      reasoningEffort: 'medium',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModelIds.mockResolvedValue(['gpt-5.5'])

    try {
      const state = useDesktopState()
      state.primeSelectedThread('thread-1')
      await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })
      await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })

      expect(gatewayMocks.getSkillsList).toHaveBeenCalledTimes(1)
      expect(state.installedSkills.value).toEqual([])
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('bypasses recent thread-list reuse for event-driven thread refreshes', async () => {
    installTestWindow()
    vi.mocked(window.setTimeout).mockImplementation(((callback: TimerHandler) => {
      if (typeof callback === 'function') {
        void Promise.resolve().then(() => callback())
      }
      return 1
    }) as typeof window.setTimeout)
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000)
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('thread-1', '/tmp/project')] }],
      nextCursor: null,
    })

    try {
      const state = useDesktopState()
      await state.refreshAll({ includeSelectedThreadMessages: false })
      const callsBeforeNotification = gatewayMocks.getThreadGroupsPage.mock.calls.length
      state.startPolling()
      expect(notificationHandler).toBeDefined()
      notificationHandler!({
        method: 'thread/name/updated',
        params: {
          threadId: 'thread-1',
          threadName: 'Updated title',
        },
      })
      await Promise.resolve()
      await Promise.resolve()

      expect(gatewayMocks.getThreadGroupsPage.mock.calls.length).toBeGreaterThan(callsBeforeNotification)
    } finally {
      nowSpy.mockRestore()
    }
  })
})

describe('turn completion lifecycle', () => {
  it('keeps the active lease after stop acknowledgement until matching completion', async () => {
    const { state, emit } = await setupTurnLifecycleNotificationState('thread-1')
    const idleDetail = {
      messages: [], inProgress: false, activeTurnId: '', hasMoreOlder: false, turnIndexByTurnId: {},
    }
    gatewayMocks.resumeThread.mockResolvedValue(idleDetail)
    gatewayMocks.getThreadDetail.mockResolvedValue(idleDetail)
    gatewayMocks.interruptThreadTurn.mockResolvedValue(undefined)

    emit({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-a' } } })
    expect(state.selectedThreadRuntimeOwnership.value).toBe('local')
    await state.interruptSelectedThreadTurn()

    expect(gatewayMocks.interruptThreadTurn).toHaveBeenCalledWith('thread-1', 'turn-a')
    expect(state.projectGroups.value[0]?.threads[0]?.inProgress).toBe(true)

    emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-a', status: 'interrupted' } } })
    expect(state.selectedThreadRuntimeOwnership.value).toBe('idle')
    expect(state.projectGroups.value[0]?.threads[0]?.inProgress).toBe(false)
  })

  it('retains an event-established turn across a lagging idle detail', async () => {
    const { state, emit } = await setupTurnLifecycleNotificationState('thread-1')
    gatewayMocks.resumeThread.mockResolvedValue({
      messages: [], inProgress: false, activeTurnId: '', hasMoreOlder: false, turnIndexByTurnId: {},
    })
    gatewayMocks.interruptThreadTurn.mockRejectedValue(new Error('expected stop probe'))

    emit({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-a' } } })
    await state.loadMessages('thread-1', { silent: true })

    expect(state.projectGroups.value[0]?.threads[0]?.inProgress).toBe(true)
    await state.interruptSelectedThreadTurn()
    expect(gatewayMocks.interruptThreadTurn).toHaveBeenCalledWith('thread-1', 'turn-a')
  })

  it('never caches or interrupts an external turn returned by interrupt fallback detail', async () => {
    const { state } = await setupTurnLifecycleNotificationState('thread-1')
    gatewayMocks.resumeThread.mockResolvedValue(localDetail())
    await state.loadMessages('thread-1')
    expect(state.selectedThreadRuntimeOwnership.value).toBe('local')
    expect(state.selectedThread.value?.inProgress).toBe(true)

    gatewayMocks.getThreadDetail.mockResolvedValue(externalDetail('turn-external-fallback'))
    await state.interruptSelectedThreadTurn()

    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(1)
    expect(gatewayMocks.interruptThreadTurn).not.toHaveBeenCalled()

    gatewayMocks.getThreadDetail.mockResolvedValue(localDetail('turn-local-fallback'))
    await state.interruptSelectedThreadTurn()

    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(2)
    expect(gatewayMocks.interruptThreadTurn).toHaveBeenCalledWith('thread-1', 'turn-local-fallback')
  })

  it('interrupts a validated local turn returned by fallback detail', async () => {
    const { state } = await setupTurnLifecycleNotificationState('thread-1')
    gatewayMocks.resumeThread.mockResolvedValue(localDetail())
    gatewayMocks.getThreadDetail.mockResolvedValue(localDetail('turn-local-fallback'))
    gatewayMocks.interruptThreadTurn.mockResolvedValue(undefined)
    await state.loadMessages('thread-1')

    await state.interruptSelectedThreadTurn()

    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(1)
    expect(gatewayMocks.interruptThreadTurn).toHaveBeenCalledWith('thread-1', 'turn-local-fallback')
  })

  it('does not overwrite a local lease established while fallback detail is pending', async () => {
    const { state, emit } = await setupTurnLifecycleNotificationState('thread-1')
    const pendingDetail = deferred<ReturnType<typeof localDetail>>()
    gatewayMocks.resumeThread.mockResolvedValue(localDetail())
    gatewayMocks.getThreadDetail.mockReturnValue(pendingDetail.promise)
    gatewayMocks.interruptThreadTurn.mockResolvedValue(undefined)
    await state.loadMessages('thread-1')

    const staleInterrupt = state.interruptSelectedThreadTurn()
    await flushMicrotasks()
    emit({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-new-local' } } })
    pendingDetail.resolve(localDetail('turn-stale-local'))
    await staleInterrupt

    expect(gatewayMocks.interruptThreadTurn).not.toHaveBeenCalled()
    await state.interruptSelectedThreadTurn()
    expect(gatewayMocks.interruptThreadTurn).toHaveBeenCalledWith('thread-1', 'turn-new-local')
  })

  it('ignores an older completion while a newer turn owns the running lease', async () => {
    const { state, emit } = await setupTurnLifecycleNotificationState('thread-1')
    gatewayMocks.interruptThreadTurn.mockRejectedValue(new Error('expected stop probe'))
    emit({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-a' } } })
    emit({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-b' } } })
    emit({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-a', status: 'failed', error: { message: 'stale failure' } } },
    })

    expect(state.projectGroups.value[0]?.threads[0]).toMatchObject({ inProgress: true, unread: false })
    expect(state.messages.value.some((message) => message.messageType === 'worked')).toBe(false)
    expect(state.selectedLiveOverlay.value?.errorText).toBe('')
    await state.interruptSelectedThreadTurn()
    expect(gatewayMocks.interruptThreadTurn).toHaveBeenCalledWith('thread-1', 'turn-b')

    emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-b', status: 'completed' } } })
    expect(state.projectGroups.value[0]?.threads[0]?.inProgress).toBe(false)
  })

  it('preserves the current turn error through stale completion message sync', async () => {
    const { state, emit } = await setupTurnLifecycleNotificationState('thread-1')
    gatewayMocks.resumeThread.mockResolvedValue({
      messages: [], inProgress: false, activeTurnId: '', hasMoreOlder: false, turnIndexByTurnId: {},
    })
    emit({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-a' } } })
    emit({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-b' } } })
    emit({
      method: 'error',
      params: { threadId: 'thread-1', message: 'current transient error', willRetry: true },
    })

    emit({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-a', status: 'failed', error: { message: 'stale failure' } } },
    })
    await state.loadMessages('thread-1')

    expect(state.selectedLiveOverlay.value?.errorText).toBe('current transient error')
  })

  it.each([
    [true, 'turn-server', true],
    [false, '', false],
  ])('uses backend running=%s when no local lease exists', async (serverInProgress, activeTurnId, expected) => {
    const { state } = await setupTurnLifecycleNotificationState('thread-1')
    gatewayMocks.interruptThreadTurn.mockRejectedValue(new Error('expected stop probe'))
    gatewayMocks.resumeThread.mockResolvedValue({
      messages: [], inProgress: serverInProgress, activeTurnId, hasMoreOlder: false, turnIndexByTurnId: {},
    })
    await state.loadMessages('thread-1', { silent: true })
    expect(state.projectGroups.value[0]?.threads[0]?.inProgress).toBe(expected)
    if (activeTurnId) {
      await state.interruptSelectedThreadTurn()
      expect(gatewayMocks.interruptThreadTurn).toHaveBeenCalledWith('thread-1', activeTurnId)
    }
  })

  it('keeps a thread running and unread false while fallback retry starts', async () => {
    const { state, emit } = await setupTurnLifecycleNotificationState('thread-1')
    let nowMs = 10_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs)
    pollingCleanups.push(() => nowSpy.mockRestore())
    gatewayMocks.resumeThread.mockResolvedValue({
      model: 'gpt-5.5',
      modelProvider: 'openai',
      messages: [],
      inProgress: true,
      activeTurnId: 'turn-primary',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })
    gatewayMocks.getThreadDetail.mockResolvedValue({
      model: 'gpt-5.5',
      modelProvider: 'openai',
      messages: [],
      inProgress: true,
      activeTurnId: 'turn-primary',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })
    gatewayMocks.rollbackThread.mockResolvedValue([])
    gatewayMocks.interruptThreadTurn.mockRejectedValue(new Error('stop rejected for lifecycle test'))
    let resolveFallbackStart: ((turnId: string) => void) | undefined
    let markFallbackStartSettled: (() => void) | undefined
    const fallbackStartSettled = new Promise<void>((resolve) => {
      markFallbackStartSettled = resolve
    })
    gatewayMocks.startThreadTurn
      .mockResolvedValueOnce('turn-primary')
      .mockImplementationOnce(async () => {
        const turnId = await new Promise<string>((resolve) => {
          resolveFallbackStart = resolve
        })
        markFallbackStartSettled?.()
        return turnId
      })

    await state.sendMessageToSelectedThread('retry this request')
    emit({
      method: 'turn/started',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-primary' },
      },
    })
    emit({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-primary',
          status: 'failed',
          error: { message: 'model is not supported' },
        },
      },
    })

    expect(state.projectGroups.value[0]?.threads[0]).toMatchObject({
      inProgress: true,
      unread: false,
    })
    await vi.waitFor(() => {
      expect(gatewayMocks.startThreadTurn).toHaveBeenCalledTimes(2)
    })

    gatewayMocks.getThreadDetail.mockResolvedValue({
      model: 'gpt-5.5',
      modelProvider: 'openai',
      messages: [],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })
    nowMs += 2_001
    const detailCallsBeforeIdleLoad = gatewayMocks.getThreadDetail.mock.calls.length
    await state.loadMessages('thread-1', { silent: true })

    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(detailCallsBeforeIdleLoad + 1)
    expect(state.projectGroups.value[0]?.threads[0]).toMatchObject({
      inProgress: true,
      unread: false,
    })
    expect(gatewayMocks.startThreadTurn).toHaveBeenLastCalledWith(
      'thread-1',
      'retry this request',
      [],
      'gpt-5.4-mini',
      'medium',
      undefined,
      [],
      'default',
    )
    resolveFallbackStart?.('turn-fallback')
    await fallbackStartSettled
    await flushMicrotasks()

    await state.interruptSelectedThreadTurn()
    expect(gatewayMocks.interruptThreadTurn).toHaveBeenCalledWith('thread-1', 'turn-fallback')
    expect(state.projectGroups.value[0]?.threads[0]).toMatchObject({
      inProgress: true,
      unread: false,
    })

    emit({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-fallback', status: 'interrupted' } },
    })
    await flushMicrotasks()

    expect(state.projectGroups.value[0]?.threads[0]).toMatchObject({
      inProgress: false,
      unread: false,
    })
    await state.interruptSelectedThreadTurn()
    expect(gatewayMocks.interruptThreadTurn).toHaveBeenCalledTimes(1)
    expect(gatewayMocks.startThreadTurn).toHaveBeenCalledTimes(2)
  })

  it('marks a successful background completion unread', async () => {
    const { state, emit } = await setupTurnLifecycleNotificationState('other-thread')

    emit({
      method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
    })
    emit({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
    })

    expect(state.projectGroups.value[0]?.threads[0]).toMatchObject({
      inProgress: false,
      unread: true,
    })

    const refreshedThread = thread('thread-1', '/tmp/project')
    refreshedThread.updatedAtIso = '2099-01-01T00:00:00.000Z'
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [refreshedThread] }],
      nextCursor: null,
    })
    await state.refreshAll({ includeSelectedThreadMessages: false, forceThreadRefresh: true })
    expect(state.projectGroups.value[0]?.threads[0]?.unread).toBe(true)

    gatewayMocks.resumeThread.mockResolvedValue({
      messages: [],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })
    state.primeSelectedThread('thread-1')
    await state.loadMessages('thread-1')
    expect(state.projectGroups.value[0]?.threads[0]?.unread).toBe(false)
  })

  it('does not mark a selected successful thread unread', async () => {
    const { state, emit } = await setupTurnLifecycleNotificationState('thread-1')

    emit({
      method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
    })
    emit({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
    })

    expect(state.projectGroups.value[0]?.threads[0]).toMatchObject({
      inProgress: false,
      unread: false,
    })
  })

  it.each(['failed', 'interrupted', 'declined', 'timeout', 'future-terminal-status'])(
    'does not mark a background %s completion unread',
    async (status) => {
      const { state, emit } = await setupTurnLifecycleNotificationState('other-thread')

      emit({
        method: 'turn/started',
        params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
      })
      emit({
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: { id: 'turn-1', status } },
      })

      expect(state.projectGroups.value[0]?.threads[0]).toMatchObject({
        inProgress: false,
        unread: false,
      })
    },
  )

  it.each(['failed', 'interrupted', 'declined', 'timeout', 'future-terminal-status'])(
    'keeps a background %s completion read after its refreshed summary advances',
    async (status) => {
      const { state, emit } = await setupTurnLifecycleNotificationState('other-thread')

      emit({
        method: 'turn/started',
        params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
      })
      emit({
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: { id: 'turn-1', status } },
      })

      const refreshedThread = thread('thread-1', '/tmp/project')
      refreshedThread.updatedAtIso = '2099-01-01T00:00:00.000Z'
      gatewayMocks.getThreadGroupsPage.mockResolvedValue({
        groups: [{ projectName: 'Project', threads: [refreshedThread] }],
        nextCursor: null,
      })
      await state.refreshAll({ includeSelectedThreadMessages: false, forceThreadRefresh: true })

      expect(state.projectGroups.value[0]?.threads[0]).toMatchObject({
        inProgress: false,
        unread: false,
      })
    },
  )
})

describe('external runtime ownership', () => {
  it('discovers a new desktop turn for the selected idle task and immediately loads its output', async () => {
    const state = await setupBackgroundRuntimeState()
    gatewayMocks.getThreadRuntimeStates.mockResolvedValue({
      'thread-selected': {
        state: 'running',
        turnId: 'turn-external',
        interruptible: false,
        source: 'external-session-writer',
      },
    })
    gatewayMocks.getExternalThreadLiveSnapshot.mockResolvedValue({
      ...externalDetail('turn-external'),
      messages: [
        {
          id: 'user-external',
          role: 'user',
          text: 'desktop input',
          messageType: 'userMessage',
          turnId: 'turn-external',
        },
        {
          id: 'reasoning-external',
          role: 'assistant',
          text: '**Inspecting state**',
          messageType: 'reasoning',
          turnId: 'turn-external',
        },
        {
          id: 'agent-external',
          role: 'assistant',
          text: 'desktop output',
          messageType: 'agentMessage',
          turnId: 'turn-external',
        },
      ],
    })

    state.startPolling()
    pollingCleanups.push(() => state.stopPolling())
    await vi.advanceTimersByTimeAsync(0)
    await flushMicrotasks()

    expect(gatewayMocks.getThreadRuntimeStates).toHaveBeenCalledWith(
      ['thread-selected', 'thread-running'],
      expect.any(AbortSignal),
    )
    expect(state.selectedThreadRuntimeOwnership.value).toBe('external')
    expect(state.selectedThread.value).toMatchObject({ inProgress: true })

    await vi.advanceTimersByTimeAsync(1)
    await flushMicrotasks()

    expect(gatewayMocks.getExternalThreadLiveSnapshot).toHaveBeenCalledTimes(1)
    expect(state.messages.value).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'user-external', text: 'desktop input' }),
      expect.objectContaining({ id: 'agent-external', text: 'desktop output' }),
    ]))
    expect(state.selectedLiveOverlay.value?.activityLabel).toBe('Inspecting state')
  })

  it('keeps probing a selected idle task without starting detail reads for idle or unknown results', async () => {
    const state = await setupBackgroundRuntimeState()
    gatewayMocks.getThreadRuntimeStates
      .mockResolvedValueOnce({ 'thread-selected': { state: 'idle' } })
      .mockResolvedValueOnce({ 'thread-selected': { state: 'unknown' } })

    state.startPolling()
    pollingCleanups.push(() => state.stopPolling())
    await vi.advanceTimersByTimeAsync(0)
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(2_000)
    await flushMicrotasks()

    expect(gatewayMocks.getThreadRuntimeStates).toHaveBeenCalledTimes(2)
    expect(gatewayMocks.getThreadRuntimeStates).toHaveBeenNthCalledWith(
      1,
      ['thread-selected', 'thread-running'],
      expect.any(AbortSignal),
    )
    expect(gatewayMocks.getThreadRuntimeStates).toHaveBeenNthCalledWith(
      2,
      ['thread-selected', 'thread-running'],
      expect.any(AbortSignal),
    )
    expect(gatewayMocks.getExternalThreadLiveSnapshot).not.toHaveBeenCalled()
    expect(state.selectedThreadRuntimeOwnership.value).toBe('idle')
  })

  it('excludes a locally running selected task from idle discovery', async () => {
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    const state = await setupBackgroundRuntimeState()
    state.startPolling()
    pollingCleanups.push(() => state.stopPolling())
    expect(notificationHandler).toBeDefined()
    notificationHandler!({
      method: 'turn/started',
      params: { threadId: 'thread-selected', turn: { id: 'turn-local' } },
    })

    await vi.advanceTimersByTimeAsync(0)
    await flushMicrotasks()

    expect(gatewayMocks.getThreadRuntimeStates).toHaveBeenCalledWith(
      ['thread-running'],
      expect.any(AbortSignal),
    )
    expect(state.selectedThreadRuntimeOwnership.value).toBe('local')
  })

  it('excludes an externally owned selected task from the background batch', async () => {
    const state = await setupBackgroundRuntimeState()
    gatewayMocks.resumeThread.mockResolvedValue(externalDetail())
    await state.loadMessages('thread-selected')

    state.startPolling()
    pollingCleanups.push(() => state.stopPolling())
    await vi.advanceTimersByTimeAsync(0)
    await flushMicrotasks()

    expect(gatewayMocks.getThreadRuntimeStates).toHaveBeenCalledWith(
      ['thread-running'],
      expect.any(AbortSignal),
    )
    expect(state.selectedThreadRuntimeOwnership.value).toBe('external')
  })

  it('ignores a selected running result after the user switches tasks', async () => {
    const state = await setupBackgroundRuntimeState()
    const pending = deferred<Record<string, {
      state: 'running'
      turnId: string
      interruptible: false
      source: string
    }>>()
    gatewayMocks.getThreadRuntimeStates.mockReturnValue(pending.promise)

    state.startPolling()
    pollingCleanups.push(() => state.stopPolling())
    await vi.advanceTimersByTimeAsync(0)
    state.primeSelectedThread('thread-running')
    pending.resolve({
      'thread-selected': {
        state: 'running',
        turnId: 'turn-stale',
        interruptible: false,
        source: 'external-session-writer',
      },
    })
    await flushMicrotasks()

    expect(gatewayMocks.getExternalThreadLiveSnapshot).not.toHaveBeenCalled()
    expect(state.projectGroups.value[0]?.threads.find((row) => row.id === 'thread-selected'))
      .toMatchObject({ inProgress: false })
  })

  it('ignores a selected running result after local ownership takes over', async () => {
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    const state = await setupBackgroundRuntimeState()
    const pending = deferred<Record<string, {
      state: 'running'
      turnId: string
      interruptible: false
      source: string
    }>>()
    gatewayMocks.getThreadRuntimeStates.mockReturnValue(pending.promise)

    state.startPolling()
    pollingCleanups.push(() => state.stopPolling())
    await vi.advanceTimersByTimeAsync(0)
    expect(notificationHandler).toBeDefined()
    notificationHandler!({
      method: 'turn/started',
      params: { threadId: 'thread-selected', turn: { id: 'turn-local' } },
    })
    pending.resolve({
      'thread-selected': {
        state: 'running',
        turnId: 'turn-stale',
        interruptible: false,
        source: 'external-session-writer',
      },
    })
    await flushMicrotasks()

    expect(gatewayMocks.getExternalThreadLiveSnapshot).not.toHaveBeenCalled()
    expect(state.selectedThreadRuntimeOwnership.value).toBe('local')
    expect(state.selectedThread.value).toMatchObject({ inProgress: true })
  })

  it('does not probe while hidden and discovers the selected idle task immediately on foreground', async () => {
    const state = await setupBackgroundRuntimeState()
    Object.assign(document, { visibilityState: 'hidden' })
    gatewayMocks.getThreadRuntimeStates.mockResolvedValue({
      'thread-selected': {
        state: 'running',
        turnId: 'turn-external',
        interruptible: false,
        source: 'external-session-writer',
      },
    })
    gatewayMocks.getExternalThreadLiveSnapshot.mockResolvedValue(externalDetail())

    state.startPolling()
    pollingCleanups.push(() => state.stopPolling())
    await vi.advanceTimersByTimeAsync(10_000)
    expect(gatewayMocks.getThreadRuntimeStates).not.toHaveBeenCalled()
    expect(gatewayMocks.getExternalThreadLiveSnapshot).not.toHaveBeenCalled()

    const visibilityHandler = vi.mocked(document.addEventListener).mock.calls.find(
      ([eventName]) => eventName === 'visibilitychange',
    )?.[1] as EventListener
    expect(visibilityHandler).toBeDefined()
    Object.assign(document, { visibilityState: 'visible' })
    visibilityHandler(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    await flushMicrotasks()

    expect(gatewayMocks.getThreadRuntimeStates).toHaveBeenCalledTimes(1)
    expect(state.selectedThreadRuntimeOwnership.value).toBe('external')
  })

  it('keeps one selected detail read in flight and resumes two seconds after settlement', async () => {
    const state = await setupBackgroundRuntimeState()
    const firstDetail = deferred<ReturnType<typeof externalDetail>>()
    gatewayMocks.getThreadRuntimeStates.mockResolvedValue({
      'thread-selected': {
        state: 'running',
        turnId: 'turn-external',
        interruptible: false,
        source: 'external-session-writer',
      },
    })
    gatewayMocks.getExternalThreadLiveSnapshot
      .mockReturnValueOnce(firstDetail.promise)
      .mockResolvedValue(externalDetail())

    state.startPolling()
    pollingCleanups.push(() => state.stopPolling())
    await vi.advanceTimersByTimeAsync(0)
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(1)
    expect(gatewayMocks.getExternalThreadLiveSnapshot).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(6_000)
    expect(gatewayMocks.getExternalThreadLiveSnapshot).toHaveBeenCalledTimes(1)

    firstDetail.resolve(externalDetail())
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(1_999)
    expect(gatewayMocks.getExternalThreadLiveSnapshot).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(gatewayMocks.getExternalThreadLiveSnapshot).toHaveBeenCalledTimes(2)
  })

  it('retries selected idle discovery two seconds after a failed batch settles', async () => {
    const state = await setupBackgroundRuntimeState()
    gatewayMocks.getThreadRuntimeStates
      .mockRejectedValueOnce(new Error('temporary runtime probe failure'))
      .mockResolvedValue({ 'thread-selected': { state: 'idle' } })

    state.startPolling()
    pollingCleanups.push(() => state.stopPolling())
    await vi.advanceTimersByTimeAsync(0)
    await flushMicrotasks()
    expect(gatewayMocks.getThreadRuntimeStates).toHaveBeenCalledTimes(1)
    expect(state.selectedThreadRuntimeOwnership.value).toBe('idle')

    await vi.advanceTimersByTimeAsync(1_999)
    expect(gatewayMocks.getThreadRuntimeStates).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(gatewayMocks.getThreadRuntimeStates).toHaveBeenCalledTimes(2)
    expect(gatewayMocks.getExternalThreadLiveSnapshot).not.toHaveBeenCalled()
  })

  it('shows a non-selected unread desktop task as working after a running batch result', async () => {
    const state = await setupBackgroundRuntimeState()
    gatewayMocks.getThreadRuntimeStates.mockResolvedValue({
      'thread-running': {
        state: 'running',
        turnId: 'turn-external',
        interruptible: false,
        source: 'external-session-writer',
      },
    })

    expect(state.projectGroups.value[0]?.threads[0]).toMatchObject({
      inProgress: false,
      unread: true,
    })
    state.startPolling()
    pollingCleanups.push(() => state.stopPolling())
    await vi.advanceTimersByTimeAsync(0)
    await flushMicrotasks()

    expect(state.projectGroups.value[0]?.threads[0]).toMatchObject({
      inProgress: true,
      unread: false,
    })
    expect(gatewayMocks.getThreadRuntimeStates).toHaveBeenCalledWith(
      ['thread-selected', 'thread-running'],
      expect.any(AbortSignal),
    )
  })

  it('clears an externally running background task on idle and refreshes its unread summary once', async () => {
    const state = await setupBackgroundRuntimeState()
    gatewayMocks.getThreadRuntimeStates
      .mockResolvedValueOnce({
        'thread-running': {
          state: 'running',
          turnId: 'turn-external',
          interruptible: false,
          source: 'external-session-writer',
        },
      })
      .mockResolvedValueOnce({ 'thread-running': { state: 'idle' } })

    state.startPolling()
    pollingCleanups.push(() => state.stopPolling())
    await vi.advanceTimersByTimeAsync(0)
    await flushMicrotasks()
    expect(state.projectGroups.value[0]?.threads[0]).toMatchObject({
      inProgress: true,
      unread: false,
    })

    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [
        { ...thread('thread-running', '/tmp/project'), updatedAtIso: '2026-07-14T00:00:01.000Z' },
        thread('thread-selected', '/tmp/project'),
      ] }],
      nextCursor: null,
    })
    await vi.advanceTimersByTimeAsync(2_000)
    await flushMicrotasks()

    expect(state.projectGroups.value[0]?.threads[0]).toMatchObject({
      inProgress: false,
      unread: true,
    })
    expect(gatewayMocks.getThreadGroupsPage).toHaveBeenCalledTimes(2)
  })

  it('refreshes the thread list only once when multiple external tasks become idle in one batch', async () => {
    const state = await setupBackgroundRuntimeState()
    const second = { ...thread('thread-second', '/tmp/project'), updatedAtIso: '2026-07-14T00:00:00.000Z' }
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [
        { ...thread('thread-running', '/tmp/project'), updatedAtIso: '2026-07-14T00:00:00.000Z' },
        second,
        thread('thread-selected', '/tmp/project'),
      ] }],
      nextCursor: null,
    })
    await state.refreshAll({ includeSelectedThreadMessages: false, forceThreadRefresh: true })
    gatewayMocks.getThreadRuntimeStates
      .mockResolvedValueOnce({
        'thread-running': { state: 'running', turnId: 'turn-1', interruptible: false, source: 'external' },
        'thread-second': { state: 'running', turnId: 'turn-2', interruptible: false, source: 'external' },
      })
      .mockResolvedValueOnce({
        'thread-running': { state: 'idle' },
        'thread-second': { state: 'idle' },
      })

    state.startPolling()
    pollingCleanups.push(() => state.stopPolling())
    await vi.advanceTimersByTimeAsync(0)
    await flushMicrotasks()
    const callsBeforeIdle = gatewayMocks.getThreadGroupsPage.mock.calls.length
    await vi.advanceTimersByTimeAsync(2_000)
    await flushMicrotasks()

    expect(gatewayMocks.getThreadGroupsPage).toHaveBeenCalledTimes(callsBeforeIdle + 1)
  })

  it('retains established external progress when a background batch returns unknown', async () => {
    const state = await setupBackgroundRuntimeState()
    gatewayMocks.getThreadRuntimeStates
      .mockResolvedValueOnce({
        'thread-running': {
          state: 'running',
          turnId: 'turn-external',
          interruptible: false,
          source: 'external-session-writer',
        },
      })
      .mockResolvedValueOnce({ 'thread-running': { state: 'unknown' } })

    state.startPolling()
    pollingCleanups.push(() => state.stopPolling())
    await vi.advanceTimersByTimeAsync(0)
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(2_000)
    await flushMicrotasks()

    expect(state.projectGroups.value[0]?.threads[0]).toMatchObject({
      inProgress: true,
      unread: false,
    })
  })

  it('keeps the working indicator through missing writer evidence until confirmed idle', async () => {
    const state = await setupBackgroundRuntimeState()
    gatewayMocks.getThreadRuntimeStates
      .mockResolvedValueOnce({
        'thread-running': {
          state: 'running',
          turnId: 'turn-external',
          interruptible: false,
          source: 'external-session-writer',
        },
      })
      .mockResolvedValueOnce({ 'thread-running': { state: 'unknown' } })
      .mockResolvedValueOnce({
        'thread-running': {
          state: 'running',
          turnId: 'turn-external',
          interruptible: false,
          source: 'external-session-writer',
        },
      })
      .mockResolvedValueOnce({ 'thread-running': { state: 'idle' } })

    state.startPolling()
    pollingCleanups.push(() => state.stopPolling())

    await vi.advanceTimersByTimeAsync(0)
    await flushMicrotasks()
    expect(state.projectGroups.value[0]?.threads[0]).toMatchObject({ inProgress: true, unread: false })

    await vi.advanceTimersByTimeAsync(2_000)
    await flushMicrotasks()
    expect(state.projectGroups.value[0]?.threads[0]).toMatchObject({ inProgress: true, unread: false })

    await vi.advanceTimersByTimeAsync(2_000)
    await flushMicrotasks()
    expect(state.projectGroups.value[0]?.threads[0]).toMatchObject({ inProgress: true, unread: false })

    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [
        { ...thread('thread-running', '/tmp/project'), updatedAtIso: '2026-07-14T00:00:01.000Z' },
        thread('thread-selected', '/tmp/project'),
      ] }],
      nextCursor: null,
    })
    const refreshCallsBeforeTerminal = gatewayMocks.getThreadGroupsPage.mock.calls.length
    await vi.advanceTimersByTimeAsync(2_000)
    await flushMicrotasks()

    expect(state.projectGroups.value[0]?.threads[0]).toMatchObject({ inProgress: false, unread: true })
    expect(gatewayMocks.getThreadGroupsPage).toHaveBeenCalledTimes(refreshCallsBeforeTerminal + 1)
  })

  it('ignores a deferred idle result after a background task is taken over locally', async () => {
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    const state = await setupBackgroundRuntimeState()
    const pending = deferred<Record<string, { state: 'idle' }>>()
    gatewayMocks.getThreadRuntimeStates
      .mockResolvedValueOnce({
        'thread-running': {
          state: 'running',
          turnId: 'turn-external',
          interruptible: false,
          source: 'external-session-writer',
        },
      })
      .mockReturnValueOnce(pending.promise)

    state.startPolling()
    pollingCleanups.push(() => state.stopPolling())
    await vi.advanceTimersByTimeAsync(0)
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(notificationHandler).toBeDefined()
    notificationHandler!({
      method: 'turn/started',
      params: { threadId: 'thread-running', turn: { id: 'turn-local' } },
    })
    pending.resolve({ 'thread-running': { state: 'idle' } })
    await flushMicrotasks()

    expect(state.projectGroups.value[0]?.threads[0]).toMatchObject({
      inProgress: true,
      unread: false,
    })
  })

  it('does not resurrect a completed local turn from a stale running batch result', async () => {
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    const state = await setupBackgroundRuntimeState()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [
        { ...thread('thread-running', '/tmp/project'), updatedAtIso: '2026-07-14T00:00:00.000Z' },
        thread('thread-unrelated', '/tmp/project'),
        thread('thread-selected', '/tmp/project'),
      ] }],
      nextCursor: null,
    })
    await state.refreshAll({ includeSelectedThreadMessages: false, forceThreadRefresh: true })
    const pending = deferred<Record<string, {
      state: 'running'
      turnId: string
      interruptible: false
      source: string
    }>>()
    gatewayMocks.getThreadRuntimeStates.mockReturnValue(pending.promise)

    state.startPolling()
    pollingCleanups.push(() => state.stopPolling())
    await vi.advanceTimersByTimeAsync(0)
    expect(notificationHandler).toBeDefined()
    notificationHandler!({
      method: 'turn/started',
      params: { threadId: 'thread-running', turn: { id: 'turn-local' } },
    })
    notificationHandler!({
      method: 'turn/completed',
      params: { threadId: 'thread-running', turn: { id: 'turn-local', status: 'completed' } },
    })
    expect(state.projectGroups.value[0]?.threads.find((row) => row.id === 'thread-running')).toMatchObject({
      inProgress: false,
    })

    pending.resolve({
      'thread-running': {
        state: 'running',
        turnId: 'turn-stale',
        interruptible: false,
        source: 'external-session-writer',
      },
      'thread-unrelated': {
        state: 'running',
        turnId: 'turn-external',
        interruptible: false,
        source: 'external-session-writer',
      },
    })
    await flushMicrotasks()

    expect(state.projectGroups.value[0]?.threads.find((row) => row.id === 'thread-running')).toMatchObject({
      inProgress: false,
    })
    expect(state.projectGroups.value[0]?.threads.find((row) => row.id === 'thread-unrelated')).toMatchObject({
      id: 'thread-unrelated',
      inProgress: true,
    })
  })

  it('ignores a deferred background result for a thread selected during the request', async () => {
    const state = await setupBackgroundRuntimeState()
    const pending = deferred<Record<string, {
      state: 'running'
      turnId: string
      interruptible: false
      source: string
    }>>()
    gatewayMocks.getThreadRuntimeStates.mockReturnValue(pending.promise)

    state.startPolling()
    pollingCleanups.push(() => state.stopPolling())
    await vi.advanceTimersByTimeAsync(0)
    state.primeSelectedThread('thread-running')
    pending.resolve({
      'thread-selected': {
        state: 'running',
        turnId: 'turn-selected-stale',
        interruptible: false,
        source: 'external-session-writer',
      },
      'thread-running': {
        state: 'running',
        turnId: 'turn-external',
        interruptible: false,
        source: 'external-session-writer',
      },
    })
    await flushMicrotasks()

    expect(state.selectedThread.value).toMatchObject({
      id: 'thread-running',
      inProgress: false,
    })
  })

  it('ignores stale running after selected idle reconciliation and deselection', async () => {
    const state = await setupBackgroundRuntimeState()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [
        { ...thread('thread-running', '/tmp/project'), updatedAtIso: '2026-07-14T00:00:00.000Z' },
        thread('thread-unrelated', '/tmp/project'),
        thread('thread-selected', '/tmp/project'),
      ] }],
      nextCursor: null,
    })
    await state.refreshAll({ includeSelectedThreadMessages: false, forceThreadRefresh: true })
    const pending = deferred<Record<string, {
      state: 'running'
      turnId: string
      interruptible: false
      source: string
    }>>()
    gatewayMocks.getThreadRuntimeStates.mockReturnValue(pending.promise)
    gatewayMocks.resumeThread.mockResolvedValue(idleDetail())

    state.startPolling()
    pollingCleanups.push(() => state.stopPolling())
    await vi.advanceTimersByTimeAsync(0)
    state.primeSelectedThread('thread-running')
    await state.loadMessages('thread-running')
    expect(state.selectedThread.value).toMatchObject({
      id: 'thread-running',
      inProgress: false,
    })
    state.primeSelectedThread('thread-selected')

    pending.resolve({
      'thread-running': {
        state: 'running',
        turnId: 'turn-stale',
        interruptible: false,
        source: 'external-session-writer',
      },
      'thread-unrelated': {
        state: 'running',
        turnId: 'turn-unrelated',
        interruptible: false,
        source: 'external-session-writer',
      },
    })
    await flushMicrotasks()

    expect(state.projectGroups.value[0]?.threads.find((row) => row.id === 'thread-running')).toMatchObject({
      inProgress: false,
    })
    expect(state.projectGroups.value[0]?.threads.find((row) => row.id === 'thread-unrelated')).toMatchObject({
      inProgress: true,
    })
  })

  it('ignores stale idle after selected external reconciliation and deselection', async () => {
    const state = await setupBackgroundRuntimeState()
    const pendingIdle = deferred<Record<string, { state: 'idle' }>>()
    gatewayMocks.getThreadRuntimeStates
      .mockResolvedValueOnce({
        'thread-running': {
          state: 'running',
          turnId: 'turn-background',
          interruptible: false,
          source: 'external-session-writer',
        },
      })
      .mockReturnValueOnce(pendingIdle.promise)
    gatewayMocks.resumeThread.mockResolvedValue(externalDetail('turn-selected-newer'))

    state.startPolling()
    pollingCleanups.push(() => state.stopPolling())
    await vi.advanceTimersByTimeAsync(0)
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(2_000)
    state.primeSelectedThread('thread-running')
    await state.loadMessages('thread-running')
    expect(state.selectedThread.value).toMatchObject({
      id: 'thread-running',
      inProgress: true,
    })
    state.primeSelectedThread('thread-selected')

    pendingIdle.resolve({ 'thread-running': { state: 'idle' } })
    await flushMicrotasks()

    expect(state.projectGroups.value[0]?.threads.find((row) => row.id === 'thread-running')).toMatchObject({
      inProgress: true,
    })
  })

  it('ignores a deferred background result after its thread is removed', async () => {
    const state = await setupBackgroundRuntimeState()
    const pending = deferred<Record<string, {
      state: 'running'
      turnId: string
      interruptible: false
      source: string
    }>>()
    gatewayMocks.getThreadRuntimeStates.mockReturnValue(pending.promise)

    state.startPolling()
    pollingCleanups.push(() => state.stopPolling())
    await vi.advanceTimersByTimeAsync(0)
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('thread-selected', '/tmp/project')] }],
      nextCursor: null,
    })
    await state.archiveThreadById('thread-running')
    pending.resolve({
      'thread-running': {
        state: 'running',
        turnId: 'turn-external',
        interruptible: false,
        source: 'external-session-writer',
      },
    })
    await flushMicrotasks()

    expect(state.projectGroups.value[0]?.threads).toEqual([
      expect.objectContaining({ id: 'thread-selected', inProgress: false }),
    ])
  })

  it('polls the first 50 eligible loaded rows in group order', async () => {
    vi.useFakeTimers()
    installFakeTimerWindow()
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    const firstGroup = Array.from({ length: 28 }, (_, index) => thread(`thread-${index}`, '/tmp/project-a'))
    const secondGroup = Array.from({ length: 27 }, (_, index) => thread(`thread-${index + 28}`, '/tmp/project-b'))
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [
        { projectName: 'Project A', threads: [...firstGroup, thread('thread-local', '/tmp/project-a')] },
        { projectName: 'Project B', threads: [thread('thread-selected', '/tmp/project-b'), ...secondGroup] },
      ],
      nextCursor: null,
    })
    const state = useDesktopState()
    state.primeSelectedThread('thread-selected')
    await state.refreshAll({ includeSelectedThreadMessages: false })
    state.startPolling()
    pollingCleanups.push(() => state.stopPolling())
    expect(notificationHandler).toBeDefined()
    notificationHandler!({
      method: 'turn/started',
      params: { threadId: 'thread-local', turn: { id: 'turn-local' } },
    })

    await vi.advanceTimersByTimeAsync(0)
    await flushMicrotasks()

    expect(gatewayMocks.getThreadRuntimeStates).toHaveBeenCalledWith(
      [
        'thread-selected',
        ...Array.from({ length: 49 }, (_, index) => `thread-${index}`),
      ],
      expect.any(AbortSignal),
    )
  })

  it('keeps one background batch in flight and waits 2 seconds after settlement', async () => {
    const state = await setupBackgroundRuntimeState()
    const first = deferred<Record<string, { state: 'unknown' }>>()
    gatewayMocks.getThreadRuntimeStates
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue({ 'thread-running': { state: 'unknown' } })

    state.startPolling()
    pollingCleanups.push(() => state.stopPolling())
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(6_000)
    expect(gatewayMocks.getThreadRuntimeStates).toHaveBeenCalledTimes(1)

    first.resolve({ 'thread-running': { state: 'unknown' } })
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(1_999)
    expect(gatewayMocks.getThreadRuntimeStates).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(gatewayMocks.getThreadRuntimeStates).toHaveBeenCalledTimes(2)
  })

  it('aborts background polling while hidden and resumes immediately when visible', async () => {
    const state = await setupBackgroundRuntimeState()
    const first = deferred<Record<string, {
      state: 'running'
      turnId: string
      interruptible: false
      source: string
    }>>()
    let signal: AbortSignal | undefined
    gatewayMocks.getThreadRuntimeStates.mockImplementationOnce((_threadIds, nextSignal?: AbortSignal) => {
      signal = nextSignal
      return first.promise
    })
    state.startPolling()
    pollingCleanups.push(() => state.stopPolling())
    await vi.advanceTimersByTimeAsync(0)

    const visibilityHandler = vi.mocked(document.addEventListener).mock.calls.find(
      ([eventName]) => eventName === 'visibilitychange',
    )?.[1] as EventListener
    expect(visibilityHandler).toBeDefined()
    Object.assign(document, { visibilityState: 'hidden' })
    visibilityHandler(new Event('visibilitychange'))
    expect(signal?.aborted).toBe(true)
    first.resolve({
      'thread-selected': {
        state: 'running',
        turnId: 'turn-selected-stale',
        interruptible: false,
        source: 'external-session-writer',
      },
    })
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(6_000)
    expect(gatewayMocks.getThreadRuntimeStates).toHaveBeenCalledTimes(1)
    expect(state.selectedThreadRuntimeOwnership.value).toBe('idle')
    expect(state.selectedThread.value).toMatchObject({ inProgress: false })
    expect(gatewayMocks.getExternalThreadLiveSnapshot).not.toHaveBeenCalled()

    Object.assign(document, { visibilityState: 'visible' })
    visibilityHandler(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(gatewayMocks.getThreadRuntimeStates).toHaveBeenCalledTimes(2)
  })

  it('aborts selected and background requests while hidden and refreshes immediately when visible', async () => {
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
    const { state } = await setupExternalRuntimeState()
    const selectedPending = deferred<ReturnType<typeof externalDetail>>()
    const backgroundPending = deferred<Record<string, { state: 'unknown' }>>()
    let selectedSignal: AbortSignal | undefined
    let backgroundSignal: AbortSignal | undefined
    gatewayMocks.resumeThread.mockResolvedValue(externalDetail())
    gatewayMocks.getThreadDetail
      .mockImplementationOnce((_threadId: string, signal?: AbortSignal) => {
        selectedSignal = signal
        return selectedPending.promise
      })
      .mockResolvedValue(externalDetail())
    gatewayMocks.getThreadRuntimeStates
      .mockImplementationOnce((_threadIds: string[], signal?: AbortSignal) => {
        backgroundSignal = signal
        return backgroundPending.promise
      })
      .mockResolvedValue({})
    await state.loadMessages('thread-1')

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(1)
    expect(gatewayMocks.getThreadRuntimeStates).toHaveBeenCalledTimes(1)

    const visibilityHandler = vi.mocked(document.addEventListener).mock.calls.find(
      ([eventName]) => eventName === 'visibilitychange',
    )?.[1] as EventListener
    expect(visibilityHandler).toBeDefined()
    Object.assign(document, { visibilityState: 'hidden' })
    visibilityHandler(new Event('visibilitychange'))

    expect(selectedSignal?.aborted).toBe(true)
    expect(backgroundSignal?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(1)
    expect(gatewayMocks.getThreadRuntimeStates).toHaveBeenCalledTimes(1)

    Object.assign(document, { visibilityState: 'visible' })
    visibilityHandler(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    await flushMicrotasks()

    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(2)
    expect(gatewayMocks.getThreadRuntimeStates).toHaveBeenCalledTimes(2)
  })

  it('shares one selected detail request between foreground resume refresh and external polling', async () => {
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
    const { state } = await setupExternalRuntimeState()
    gatewayMocks.resumeThread.mockResolvedValue(externalDetail())
    gatewayMocks.getExternalThreadLiveSnapshot.mockResolvedValue(externalDetail())
    await state.loadMessages('thread-1')

    const visibilityHandler = vi.mocked(document.addEventListener).mock.calls.find(
      ([eventName]) => eventName === 'visibilitychange',
    )?.[1] as EventListener
    expect(visibilityHandler).toBeDefined()

    visibilityHandler(new Event('visibilitychange'))
    const resumeRefresh = state.refreshAll({ includeSelectedThreadMessages: true })
    await vi.advanceTimersByTimeAsync(0)
    await resumeRefresh
    await flushMicrotasks()

    expect(gatewayMocks.getExternalThreadLiveSnapshot).toHaveBeenCalledTimes(1)
    expect(gatewayMocks.getThreadDetail).not.toHaveBeenCalled()
  })

  it('aborts and invalidates a background batch when polling stops', async () => {
    const state = await setupBackgroundRuntimeState()
    const pending = deferred<Record<string, {
      state: 'running'
      turnId: string
      interruptible: false
      source: string
    }>>()
    let signal: AbortSignal | undefined
    gatewayMocks.getThreadRuntimeStates.mockImplementation((_threadIds, nextSignal?: AbortSignal) => {
      signal = nextSignal
      return pending.promise
    })
    state.startPolling()
    await vi.advanceTimersByTimeAsync(0)

    state.stopPolling()
    pending.resolve({
      'thread-selected': {
        state: 'running',
        turnId: 'turn-selected-stale',
        interruptible: false,
        source: 'external-session-writer',
      },
      'thread-running': {
        state: 'running',
        turnId: 'turn-external',
        interruptible: false,
        source: 'external-session-writer',
      },
    })
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(6_000)

    expect(signal?.aborted).toBe(true)
    expect(gatewayMocks.getThreadRuntimeStates).toHaveBeenCalledTimes(1)
    expect(state.projectGroups.value[0]?.threads[0]).toMatchObject({ inProgress: false })
    expect(state.selectedThreadRuntimeOwnership.value).toBe('idle')
    expect(state.selectedThread.value).toMatchObject({ inProgress: false })
    expect(gatewayMocks.getExternalThreadLiveSnapshot).not.toHaveBeenCalled()
    expect(document.removeEventListener).toHaveBeenCalledWith(
      'visibilitychange',
      expect.any(Function),
    )
  })

  it('restores and polls an externally owned selected thread after 2 seconds', async () => {
    const { state } = await setupExternalRuntimeState()
    gatewayMocks.resumeThread.mockResolvedValue(externalDetail())
    gatewayMocks.getThreadDetail.mockResolvedValue(externalDetail())

    await state.loadMessages('thread-1')

    expect(state.selectedThreadRuntimeOwnership.value).toBe('external')
    expect(state.selectedThread.value?.inProgress).toBe(true)
    expect(gatewayMocks.getThreadDetail).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1_999)
    expect(gatewayMocks.getThreadDetail).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(1)
    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledWith('thread-1', expect.any(AbortSignal))
    expect(gatewayMocks.getThreadRuntimeState).not.toHaveBeenCalled()
  })

  it('refreshes external reasoning and agent output without a page reload', async () => {
    const { state } = await setupExternalRuntimeState()
    gatewayMocks.resumeThread.mockResolvedValue(externalDetail('turn-external'))
    gatewayMocks.getThreadDetail
      .mockResolvedValueOnce({
        ...externalDetail('turn-external'),
        messages: [
          {
            id: 'reasoning-live',
            role: 'assistant',
            text: '**Reading development-workflow.md**',
            messageType: 'reasoning',
            turnId: 'turn-external',
          },
          {
            id: 'agent-live',
            role: 'assistant',
            text: 'New desktop output',
            messageType: 'agentMessage',
            turnId: 'turn-external',
          },
        ],
      })
      .mockResolvedValueOnce({
        ...externalDetail('turn-external'),
        messages: [
          {
            id: 'reasoning-live',
            role: 'assistant',
            text: '**Reading development-workflow.md**',
            messageType: 'reasoning',
            turnId: 'turn-external',
          },
          {
            id: 'agent-live',
            role: 'assistant',
            text: 'New desktop output updated',
            messageType: 'agentMessage',
            turnId: 'turn-external',
          },
        ],
      })
    await state.loadMessages('thread-1')

    await vi.advanceTimersByTimeAsync(2_000)
    await flushMicrotasks()

    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledWith(
      'thread-1',
      expect.any(AbortSignal),
    )
    expect(gatewayMocks.getThreadRuntimeState).not.toHaveBeenCalled()
    expect(state.selectedLiveOverlay.value?.activityLabel).toBe('Reading development-workflow.md')
    expect(state.messages.value).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'agent-live', text: 'New desktop output' }),
    ]))

    await vi.advanceTimersByTimeAsync(2_000)
    await flushMicrotasks()

    expect(state.messages.value.filter((message) => message.id === 'agent-live')).toEqual([
      expect.objectContaining({ text: 'New desktop output updated' }),
    ])
  })

  it('starts the next external snapshot two seconds after settlement', async () => {
    const { state } = await setupExternalRuntimeState()
    const pending = deferred<ReturnType<typeof externalDetail>>()
    gatewayMocks.resumeThread.mockResolvedValue(externalDetail())
    gatewayMocks.getThreadDetail
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(externalDetail())
    await state.loadMessages('thread-1')

    await vi.advanceTimersByTimeAsync(6_000)
    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(1)

    pending.resolve(externalDetail())
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(1_999)
    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(2)
  })

  it('aborts a stale selected-thread request so a new external thread can poll', async () => {
    const { state } = await setupExternalRuntimeState()
    const oldRequest = deferred<ReturnType<typeof idleDetail>>()
    const newRequest = deferred<ReturnType<typeof externalDetail>>()
    const signals: AbortSignal[] = []
    gatewayMocks.resumeThread.mockResolvedValue(externalDetail())
    gatewayMocks.getThreadDetail.mockImplementation((threadId: string, signal?: AbortSignal) => {
      if (signal) signals.push(signal)
      if (threadId === 'thread-1') return oldRequest.promise
      if (gatewayMocks.getThreadDetail.mock.calls.length === 2) return newRequest.promise
      return Promise.resolve(externalDetail())
    })
    await state.loadMessages('thread-1')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(1)

    state.primeSelectedThread('thread-2')
    await state.loadMessages('thread-2')
    await vi.advanceTimersByTimeAsync(2_000)

    expect(gatewayMocks.getThreadDetail).toHaveBeenNthCalledWith(2, 'thread-2', expect.any(AbortSignal))
    expect(signals[0]?.aborted).toBe(true)
    oldRequest.resolve(idleDetail())
    await flushMicrotasks()
    expect(state.selectedThreadRuntimeOwnership.value).toBe('external')

    await vi.advanceTimersByTimeAsync(4_000)
    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(2)
    newRequest.resolve(externalDetail())
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(3)
    expect(gatewayMocks.getThreadRuntimeState).not.toHaveBeenCalled()
  })

  it('aborts an in-flight external runtime request on local takeover', async () => {
    const { state, emit } = await setupExternalRuntimeState()
    const pending = deferred<ReturnType<typeof externalDetail>>()
    let signal: AbortSignal | undefined
    gatewayMocks.resumeThread.mockResolvedValue(externalDetail())
    gatewayMocks.getThreadDetail.mockImplementation((_threadId: string, nextSignal?: AbortSignal) => {
      signal = nextSignal
      return pending.promise
    })
    await state.loadMessages('thread-1')
    await vi.advanceTimersByTimeAsync(2_000)

    emit({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-local' } } })

    expect(signal?.aborted).toBe(true)
    expect(state.selectedThreadRuntimeOwnership.value).toBe('local')
  })

  it('aborts an in-flight external runtime request when polling stops', async () => {
    const { state } = await setupExternalRuntimeState()
    const pending = deferred<ReturnType<typeof externalDetail>>()
    let signal: AbortSignal | undefined
    gatewayMocks.resumeThread.mockResolvedValue(externalDetail())
    gatewayMocks.getThreadDetail.mockImplementation((_threadId: string, nextSignal?: AbortSignal) => {
      signal = nextSignal
      return pending.promise
    })
    await state.loadMessages('thread-1')
    await vi.advanceTimersByTimeAsync(2_000)

    state.stopPolling()

    expect(signal?.aborted).toBe(true)
  })

  it('retains an established external lease across an inconclusive detail refresh', async () => {
    const { state } = await setupExternalRuntimeState()
    gatewayMocks.resumeThread.mockResolvedValue(externalDetail())
    gatewayMocks.getThreadDetail.mockResolvedValue({
      ...idleDetail(),
      externalRuntimeState: 'unknown',
    })
    await state.loadMessages('thread-1')

    await state.loadMessages('thread-1', { silent: true, force: true })

    expect(state.selectedThreadRuntimeOwnership.value).toBe('external')
    expect(state.selectedThread.value?.inProgress).toBe(true)
  })

  it('does not let an older running detail overwrite a newer idle detail', async () => {
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
    const { state } = await setupExternalRuntimeState()
    const olderRunning = deferred<Omit<ReturnType<typeof externalDetail>, 'messages'> & { messages: UiMessage[] }>()
    gatewayMocks.resumeThread.mockResolvedValue(externalDetail())
    gatewayMocks.getExternalThreadLiveSnapshot
      .mockReturnValueOnce(olderRunning.promise)
      .mockResolvedValueOnce({
        ...idleDetail(),
        messages: [{ id: 'newer-idle', role: 'assistant', text: 'newer terminal output' }],
      })
    await state.loadMessages('thread-1')

    await vi.advanceTimersByTimeAsync(2_000)
    const firstSignal = gatewayMocks.getExternalThreadLiveSnapshot.mock.calls[0]?.[1] as AbortSignal
    Object.assign(document, { visibilityState: 'hidden' })
    const visibilityHandler = vi.mocked(document.addEventListener).mock.calls.find(
      ([eventName]) => eventName === 'visibilitychange',
    )?.[1] as EventListener
    visibilityHandler(new Event('visibilitychange'))
    expect(firstSignal.aborted).toBe(true)

    Object.assign(document, { visibilityState: 'visible' })
    visibilityHandler(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    await flushMicrotasks()
    expect(state.selectedThreadRuntimeOwnership.value).toBe('idle')

    olderRunning.resolve({
      ...externalDetail('turn-stale'),
      messages: [{ id: 'older-running', role: 'assistant', text: 'stale running output' }],
    })
    await flushMicrotasks()

    expect(state.selectedThreadRuntimeOwnership.value).toBe('idle')
    expect(state.messages.value).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'newer-idle' }),
    ]))
    expect(state.messages.value).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'older-running' }),
    ]))
  })

  it('does not establish external ownership from inconclusive detail while idle', async () => {
    const { state } = await setupExternalRuntimeState()
    gatewayMocks.resumeThread.mockResolvedValue({
      ...idleDetail(),
      externalRuntimeState: 'unknown',
    })

    await state.loadMessages('thread-1')

    expect(state.selectedThreadRuntimeOwnership.value).toBe('idle')
    expect(state.selectedThread.value?.inProgress).toBe(false)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(gatewayMocks.getThreadRuntimeState).not.toHaveBeenCalled()
  })

  it('applies final external output before clearing the live overlay', async () => {
    const { state } = await setupExternalRuntimeState()
    gatewayMocks.resumeThread.mockResolvedValue(externalDetail())
    gatewayMocks.getThreadDetail.mockResolvedValue({
      ...idleDetail(),
      messages: [
        {
          id: 'reasoning-final',
          role: 'assistant',
          text: '**Finishing external work**',
          messageType: 'reasoning',
          turnId: 'turn-external',
        },
        {
          id: 'agent-final',
          role: 'assistant',
          text: 'Final desktop output',
          messageType: 'agentMessage',
          turnId: 'turn-external',
        },
      ],
    })
    await state.loadMessages('thread-1')

    await vi.advanceTimersByTimeAsync(2_000)
    await flushMicrotasks()

    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(1)
    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledWith('thread-1', expect.any(AbortSignal))
    expect(state.messages.value).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'agent-final', text: 'Final desktop output' }),
    ]))
    expect(state.selectedThreadRuntimeOwnership.value).toBe('idle')
    expect(state.selectedThread.value?.inProgress).toBe(false)
    expect(state.selectedLiveOverlay.value).toBe(null)
  })

  it('keeps the external lease until a delayed terminal detail refresh completes', async () => {
    const { state } = await setupExternalRuntimeState()
    const terminalDetail = deferred<ReturnType<typeof idleDetail>>()
    gatewayMocks.resumeThread.mockResolvedValue(externalDetail())
    gatewayMocks.getThreadDetail.mockReturnValue(terminalDetail.promise)
    gatewayMocks.startThreadTurn.mockResolvedValue('turn-follow-up')
    await state.loadMessages('thread-1')

    await vi.advanceTimersByTimeAsync(2_000)
    await flushMicrotasks()
    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledWith('thread-1', expect.any(AbortSignal))

    const blockedSend = state.sendMessageToSelectedThread('must wait for terminal detail')
    await flushMicrotasks()
    expect(gatewayMocks.startThreadTurn).not.toHaveBeenCalled()
    expect(state.selectedThreadRuntimeOwnership.value).toBe('external')

    terminalDetail.resolve(idleDetail())
    await flushMicrotasks()
    await blockedSend
    expect(state.selectedThreadRuntimeOwnership.value).toBe('idle')

    void state.sendMessageToSelectedThread('safe follow-up')
    await flushMicrotasks()
    expect(gatewayMocks.startThreadTurn).toHaveBeenCalledTimes(1)
  })

  it('does not let a delayed terminal detail clear a newer local lease', async () => {
    const { state, emit } = await setupExternalRuntimeState()
    const terminalDetail = deferred<ReturnType<typeof idleDetail>>()
    let signal: AbortSignal | undefined
    gatewayMocks.resumeThread.mockResolvedValue(externalDetail())
    gatewayMocks.getThreadDetail.mockImplementation((_threadId: string, nextSignal?: AbortSignal) => {
      signal = nextSignal
      return terminalDetail.promise
    })
    await state.loadMessages('thread-1')

    await vi.advanceTimersByTimeAsync(2_000)
    await flushMicrotasks()
    emit({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-new-local' } } })
    terminalDetail.resolve(idleDetail())
    await flushMicrotasks()

    expect(signal?.aborted).toBe(true)
    expect(state.selectedThreadRuntimeOwnership.value).toBe('local')
    expect(state.selectedThread.value?.inProgress).toBe(true)
  })

  it('serializes a forced load behind an existing detail request and then refreshes', async () => {
    const { state } = await setupExternalRuntimeState()
    const staleLoad = deferred<ReturnType<typeof externalDetail>>()
    let detailCallCount = 0
    gatewayMocks.resumeThread.mockResolvedValue(externalDetail())
    gatewayMocks.getThreadDetail.mockImplementation(() => {
      detailCallCount += 1
      return detailCallCount === 1
        ? staleLoad.promise
        : Promise.resolve({
            ...idleDetail(),
            messages: [{ id: 'terminal-after-race', role: 'assistant', text: 'finished after race' }],
          })
    })
    await state.loadMessages('thread-1')

    const loadA = state.loadMessages('thread-1', { silent: true, force: true })
    await flushMicrotasks()
    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(2_000)
    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(1)
    expect(gatewayMocks.getThreadRuntimeState).not.toHaveBeenCalled()
    const concurrentForce = state.loadMessages('thread-1', { silent: true, force: true })
    staleLoad.resolve(externalDetail('turn-stale'))
    await loadA
    await concurrentForce
    await flushMicrotasks()

    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(2)
    expect(state.selectedThreadRuntimeOwnership.value).toBe('idle')
    expect(state.selectedThread.value?.inProgress).toBe(false)
    expect(state.messages.value).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'terminal-after-race' }),
    ]))
  })

  it('retains the last detailed summary and output when a snapshot read fails', async () => {
    const { state } = await setupExternalRuntimeState()
    gatewayMocks.resumeThread.mockResolvedValue(externalDetail())
    gatewayMocks.getThreadDetail
      .mockResolvedValueOnce({
        ...externalDetail(),
        messages: [
          {
            id: 'reasoning-retained',
            role: 'assistant',
            text: '**Retaining detailed work**',
            messageType: 'reasoning',
            turnId: 'turn-external',
          },
          {
            id: 'agent-retained',
            role: 'assistant',
            text: 'Detailed desktop output',
            messageType: 'agentMessage',
            turnId: 'turn-external',
          },
        ],
      })
      .mockRejectedValueOnce(new Error('snapshot unavailable'))
    await state.loadMessages('thread-1')

    await vi.advanceTimersByTimeAsync(2_000)
    await flushMicrotasks()
    expect(state.selectedLiveOverlay.value?.activityLabel).toBe('Retaining detailed work')

    await vi.advanceTimersByTimeAsync(2_000)
    await flushMicrotasks()

    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(2)
    expect(state.selectedLiveOverlay.value?.activityLabel).toBe('Retaining detailed work')
    expect(state.messages.value).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'agent-retained', text: 'Detailed desktop output' }),
    ]))
    expect(state.selectedThreadRuntimeOwnership.value).toBe('external')
    expect(state.selectedThread.value?.inProgress).toBe(true)
  })

  it('never lets stale external idle clear a local lease', async () => {
    const { state, emit } = await setupExternalRuntimeState()
    const staleIdleDetail = {
      ...idleDetail(),
      messages: [{ id: 'stale-idle', role: 'assistant', text: 'stale external output' }],
    }
    const pending = deferred<typeof staleIdleDetail>()
    let signal: AbortSignal | undefined
    gatewayMocks.resumeThread.mockResolvedValue(externalDetail())
    gatewayMocks.getThreadDetail.mockImplementation((_threadId: string, nextSignal?: AbortSignal) => {
      signal = nextSignal
      return pending.promise
    })
    await state.loadMessages('thread-1')
    await vi.advanceTimersByTimeAsync(2_000)

    emit({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-local' } } })
    pending.resolve(staleIdleDetail)
    await flushMicrotasks()

    expect(signal?.aborted).toBe(true)
    expect(state.selectedThreadRuntimeOwnership.value).toBe('local')
    expect(state.selectedThread.value?.inProgress).toBe(true)
    expect(state.messages.value).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'stale-idle' }),
    ]))
  })

  it('does not let a completion without a matching local lease clear external ownership', async () => {
    const { state, emit } = await setupExternalRuntimeState()
    gatewayMocks.resumeThread.mockResolvedValue(externalDetail())
    await state.loadMessages('thread-1')

    emit({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-external', status: 'completed' } },
    })

    expect(state.selectedThreadRuntimeOwnership.value).toBe('external')
    expect(state.selectedThread.value?.inProgress).toBe(true)
  })

  it('keeps local ownership when lagging external detail is loaded', async () => {
    const { state, emit } = await setupExternalRuntimeState()
    gatewayMocks.resumeThread.mockResolvedValue(externalDetail())
    emit({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-local' } } })

    await state.loadMessages('thread-1')

    expect(state.selectedThreadRuntimeOwnership.value).toBe('local')
    expect(state.selectedThread.value?.inProgress).toBe(true)
  })

  it('rejects poll results after selection changes or polling stops', async () => {
    const { state } = await setupExternalRuntimeState()
    const staleSelectionDetail = {
      ...idleDetail(),
      messages: [{ id: 'stale-selection', role: 'assistant', text: 'stale selection output' }],
    }
    const selectionPending = deferred<typeof staleSelectionDetail>()
    gatewayMocks.resumeThread.mockResolvedValue(externalDetail())
    gatewayMocks.getThreadDetail.mockReturnValueOnce(selectionPending.promise)
    await state.loadMessages('thread-1')
    await vi.advanceTimersByTimeAsync(2_000)

    state.primeSelectedThread('thread-2')
    selectionPending.resolve(staleSelectionDetail)
    await flushMicrotasks()

    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(1)
    state.primeSelectedThread('thread-1')
    expect(state.selectedThreadRuntimeOwnership.value).toBe('external')
    expect(state.messages.value).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'stale-selection' }),
    ]))

    const staleStopDetail = {
      ...idleDetail(),
      messages: [{ id: 'stale-stop', role: 'assistant', text: 'stale stop output' }],
    }
    const stopPending = deferred<typeof staleStopDetail>()
    gatewayMocks.getThreadDetail.mockReturnValueOnce(stopPending.promise)
    await vi.advanceTimersByTimeAsync(2_000)
    state.stopPolling()
    stopPending.resolve(staleStopDetail)
    await flushMicrotasks()

    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(2)
    expect(state.messages.value).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'stale-stop' }),
    ]))
  })

  it('cancels scheduled polling on stop and resumes it after reconnect', async () => {
    const { state } = await setupExternalRuntimeState()
    gatewayMocks.resumeThread.mockResolvedValue(externalDetail())
    gatewayMocks.getThreadDetail.mockResolvedValue(externalDetail())
    await state.loadMessages('thread-1')

    state.stopPolling()
    await vi.advanceTimersByTimeAsync(4_000)
    expect(gatewayMocks.getThreadDetail).not.toHaveBeenCalled()

    state.startPolling()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(1)
    expect(gatewayMocks.getThreadRuntimeState).not.toHaveBeenCalled()
  })

  it('guards all selected-thread mutations while externally owned', async () => {
    gatewayMocks.getThreadQueueState.mockResolvedValue({
      'thread-1': [
        {
          id: 'queued-1',
          text: 'first queued',
          imageUrls: [],
          skills: [],
          fileAttachments: [],
          collaborationMode: 'default',
        },
        {
          id: 'queued-2',
          text: 'second queued',
          imageUrls: [],
          skills: [],
          fileAttachments: [],
          collaborationMode: 'default',
        },
      ],
    })
    const { state, emit } = await setupExternalRuntimeState()
    emit({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-local' } } })
    await flushMicrotasks()
    emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-local', status: 'completed' } } })
    await flushMicrotasks()
    gatewayMocks.resumeThread.mockResolvedValue({
      ...externalDetail(),
      messages: [{
        id: 'external-user-message',
        role: 'user',
        text: 'external prompt',
        turnId: 'turn-external',
        turnIndex: 0,
      }],
    })
    gatewayMocks.startThreadTurn.mockResolvedValue('turn-local')
    gatewayMocks.revertThreadFileChanges.mockResolvedValue({ success: true })
    gatewayMocks.rollbackThread.mockResolvedValue([])
    gatewayMocks.replyToServerRequest.mockResolvedValue(undefined)
    await state.loadMessages('thread-1')
    const queueBeforeMutations = state.selectedThreadQueuedMessages.value.map((message) => message.id)
    const persistenceCallsBeforeMutations = gatewayMocks.setThreadQueueState.mock.calls.length

    await state.interruptSelectedThreadTurn()
    await state.sendMessageToSelectedThread('steer externally')
    await state.sendMessageToSelectedThread('queue externally', [], [], 'queue')
    state.removeQueuedMessage('queued-1')
    state.reorderQueuedMessage('queued-1', 'queued-2')
    state.steerQueuedMessage('queued-1')
    await state.rollbackSelectedThread('turn-external')
    const replied = await state.respondToPendingServerRequest({ id: 99, result: {} })
    await flushMicrotasks()

    expect(gatewayMocks.interruptThreadTurn).not.toHaveBeenCalled()
    expect(gatewayMocks.getThreadDetail).not.toHaveBeenCalled()
    expect(gatewayMocks.startThreadTurn).not.toHaveBeenCalled()
    expect(gatewayMocks.revertThreadFileChanges).not.toHaveBeenCalled()
    expect(gatewayMocks.rollbackThread).not.toHaveBeenCalled()
    expect(gatewayMocks.replyToServerRequest).not.toHaveBeenCalled()
    expect(replied).toBe(false)
    expect(state.selectedThreadQueuedMessages.value.map((message) => message.id)).toEqual(queueBeforeMutations)
    expect(gatewayMocks.setThreadQueueState).toHaveBeenCalledTimes(persistenceCallsBeforeMutations)
  })

  it('keeps rollback and pending-request replies available for an idle selected thread', async () => {
    const { state, emit } = await setupExternalRuntimeState()
    gatewayMocks.resumeThread.mockResolvedValue({
      ...idleDetail(),
      messages: [{
        id: 'idle-user-message',
        role: 'user',
        text: 'editable prompt',
        turnId: 'turn-idle',
        turnIndex: 0,
      }],
    })
    gatewayMocks.revertThreadFileChanges.mockResolvedValue({ success: true })
    gatewayMocks.rollbackThread.mockResolvedValue([])
    gatewayMocks.replyToServerRequest.mockResolvedValue(undefined)
    await state.loadMessages('thread-1')

    await state.rollbackSelectedThread('turn-idle')
    emit({
      method: 'server/request',
      params: {
        id: 101,
        method: 'item/tool/requestUserInput',
        params: { threadId: 'thread-1', questions: [] },
      },
    })
    const replied = await state.respondToPendingServerRequest({ id: 101, result: {} })

    expect(gatewayMocks.revertThreadFileChanges).toHaveBeenCalledWith('thread-1', 'turn-idle', '/tmp/project')
    expect(gatewayMocks.rollbackThread).toHaveBeenCalledWith('thread-1', 1)
    expect(gatewayMocks.replyToServerRequest).toHaveBeenCalledWith(101, { result: {}, error: undefined })
    expect(replied).toBe(true)
  })

  it('rejects a pending request owned by an external thread after selection changes', async () => {
    const { state, emit } = await setupExternalRuntimeState()
    gatewayMocks.resumeThread.mockResolvedValue(externalDetail())
    gatewayMocks.replyToServerRequest.mockResolvedValue(undefined)
    await state.loadMessages('thread-1')
    emit({
      method: 'server/request',
      params: {
        id: 201,
        method: 'item/tool/requestUserInput',
        params: { threadId: 'thread-1', questions: [] },
      },
    })
    state.primeSelectedThread('thread-2')

    const replied = await state.respondToPendingServerRequest({ id: 201, result: {} })

    expect(replied).toBe(false)
    expect(gatewayMocks.replyToServerRequest).not.toHaveBeenCalled()
  })

  it('allows a pending request owned by an idle thread even when an external thread is selected', async () => {
    const { state, emit } = await setupExternalRuntimeState()
    gatewayMocks.resumeThread.mockResolvedValue(externalDetail())
    gatewayMocks.replyToServerRequest.mockResolvedValue(undefined)
    await state.loadMessages('thread-1')
    state.primeSelectedThread('thread-2')
    emit({
      method: 'server/request',
      params: {
        id: 202,
        method: 'item/tool/requestUserInput',
        params: { threadId: 'thread-2', questions: [] },
      },
    })
    state.primeSelectedThread('thread-1')

    const replied = await state.respondToPendingServerRequest({ id: 202, result: {} })

    expect(replied).toBe(true)
    expect(gatewayMocks.replyToServerRequest).toHaveBeenCalledWith(202, { result: {}, error: undefined })
  })

  it('rejects an unknown pending request id without sending an RPC', async () => {
    const { state } = await setupExternalRuntimeState()
    gatewayMocks.replyToServerRequest.mockResolvedValue(undefined)

    const replied = await state.respondToPendingServerRequest({ id: 999, result: {} })

    expect(replied).toBe(false)
    expect(gatewayMocks.replyToServerRequest).not.toHaveBeenCalled()
  })

  it('allows an explicitly global pending request while an external thread is selected', async () => {
    const { state, emit } = await setupExternalRuntimeState()
    gatewayMocks.resumeThread.mockResolvedValue(externalDetail())
    gatewayMocks.replyToServerRequest.mockResolvedValue(undefined)
    await state.loadMessages('thread-1')
    emit({
      method: 'server/request',
      params: {
        id: 203,
        method: 'global/test',
        params: {},
      },
    })

    const replied = await state.respondToPendingServerRequest({ id: 203, result: {} })

    expect(replied).toBe(true)
    expect(gatewayMocks.replyToServerRequest).toHaveBeenCalledWith(203, { result: {}, error: undefined })
  })

  it('guards user-facing model setters while preserving server detail reconciliation', async () => {
    const { state } = await setupExternalRuntimeState()
    gatewayMocks.resumeThread.mockResolvedValue({
      ...externalDetail(),
      model: 'server-model',
    })
    await state.loadMessages('thread-1')
    expect(state.selectedModelId.value).toBe('server-model')

    state.setSelectedModelIdForThread('thread-1', 'blocked-direct-model')
    state.setSelectedModelId('blocked-selected-model')

    expect(state.selectedModelId.value).toBe('server-model')
    expect(state.readModelIdForThread('thread-1')).toBe('server-model')
  })

  it('guards user-facing collaboration, reasoning, and speed setters while externally owned', async () => {
    const { state } = await setupExternalRuntimeState()
    gatewayMocks.resumeThread.mockResolvedValue(externalDetail())
    await state.loadMessages('thread-1')
    const initialMode = state.selectedCollaborationMode.value
    const initialEffort = state.selectedReasoningEffort.value
    const initialSpeed = state.selectedSpeedMode.value

    state.setSelectedCollaborationMode(initialMode === 'plan' ? 'default' : 'plan')
    state.setSelectedReasoningEffort(initialEffort === 'high' ? 'low' : 'high')
    await state.updateSelectedSpeedMode(initialSpeed === 'fast' ? 'standard' : 'fast')

    expect(state.selectedCollaborationMode.value).toBe(initialMode)
    expect(state.selectedReasoningEffort.value).toBe(initialEffort)
    expect(state.selectedSpeedMode.value).toBe(initialSpeed)
    expect(gatewayMocks.setCodexSpeedMode).not.toHaveBeenCalled()
  })

  it('keeps collaboration, reasoning, and speed setters available for local, idle, and home contexts', async () => {
    const { state, emit } = await setupExternalRuntimeState()
    gatewayMocks.setCodexSpeedMode.mockResolvedValue(undefined)
    emit({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-local' } } })

    state.setSelectedCollaborationMode('plan')
    state.setSelectedReasoningEffort('high')
    await state.updateSelectedSpeedMode('fast')
    expect(state.selectedCollaborationMode.value).toBe('plan')
    expect(state.selectedReasoningEffort.value).toBe('high')
    expect(state.selectedSpeedMode.value).toBe('fast')

    state.primeSelectedThread('thread-2')
    state.setSelectedCollaborationMode('default')
    state.setSelectedReasoningEffort('low')
    await state.updateSelectedSpeedMode('standard')
    expect(state.selectedCollaborationMode.value).toBe('default')
    expect(state.selectedReasoningEffort.value).toBe('low')
    expect(state.selectedSpeedMode.value).toBe('standard')

    state.primeSelectedThread('', { persist: false })
    state.setSelectedCollaborationMode('plan')
    state.setSelectedReasoningEffort('minimal')
    await state.updateSelectedSpeedMode('fast')
    expect(state.selectedCollaborationMode.value).toBe('plan')
    expect(state.selectedReasoningEffort.value).toBe('minimal')
    expect(state.selectedSpeedMode.value).toBe('fast')
    expect(gatewayMocks.setCodexSpeedMode).toHaveBeenCalledTimes(3)
  })

  it('keeps model setters available for local, idle, and home contexts', async () => {
    const { state, emit } = await setupExternalRuntimeState()
    emit({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-local' } } })

    state.setSelectedModelId('local-model')
    expect(state.selectedModelId.value).toBe('local-model')

    state.primeSelectedThread('thread-2')
    state.setSelectedModelIdForThread('thread-2', 'idle-model')
    expect(state.selectedModelId.value).toBe('idle-model')

    state.primeSelectedThread('', { persist: false })
    state.setSelectedModelId('home-model')
    expect(state.readModelIdForThread('')).toBe('home-model')
    await flushMicrotasks()
  })

  it('preserves local interrupt, send, and queue mutation behavior', async () => {
    const { state, emit } = await setupExternalRuntimeState()
    gatewayMocks.resumeThread.mockResolvedValue({
      ...externalDetail('turn-local'),
      ownership: 'local',
      canInterrupt: true,
    })
    gatewayMocks.interruptThreadTurn.mockResolvedValue(undefined)
    gatewayMocks.startThreadTurn.mockResolvedValue('turn-steer')
    emit({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-local' } } })
    await state.loadMessages('thread-1')

    await state.sendMessageToSelectedThread('queued one', [], [], 'queue')
    await state.sendMessageToSelectedThread('queued two', [], [], 'queue')
    const [first, second] = state.selectedThreadQueuedMessages.value
    state.reorderQueuedMessage(first!.id, second!.id)
    state.removeQueuedMessage(first!.id)
    await state.sendMessageToSelectedThread('steer locally')
    await state.interruptSelectedThreadTurn()
    await flushMicrotasks()

    expect(gatewayMocks.setThreadQueueState).toHaveBeenCalled()
    expect(gatewayMocks.startThreadTurn).toHaveBeenCalled()
    expect(gatewayMocks.interruptThreadTurn).toHaveBeenCalledWith('thread-1', expect.any(String))
  })
})

describe('external live reasoning overlay', () => {
  it('shows the latest visible external reasoning summary without duplicating its message', async () => {
    installTestWindow()
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.resumeThread.mockResolvedValue({
      ...externalDetail('turn-external'),
      messages: [
        {
          id: 'reasoning-1',
          role: 'assistant',
          text: '**Inspecting fixtures**\n\n**Reading development-workflow.md**',
          messageType: 'reasoning',
          turnId: 'turn-external',
        },
        {
          id: 'agent-1',
          role: 'assistant',
          text: 'Initial desktop output',
          messageType: 'agentMessage',
          turnId: 'turn-external',
        },
      ],
    })

    const state = useDesktopState()
    state.primeSelectedThread('thread-external')
    await state.loadMessages('thread-external')

    expect(state.selectedLiveOverlay.value?.activityLabel).toBe('Reading development-workflow.md')
    expect(state.messages.value).toEqual([
      expect.objectContaining({ id: 'agent-1', text: 'Initial desktop output' }),
    ])
  })

  it('falls back to Thinking until the external turn has a visible summary', async () => {
    installTestWindow()
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.resumeThread.mockResolvedValue(externalDetail('turn-external'))

    const state = useDesktopState()
    state.primeSelectedThread('thread-external')
    await state.loadMessages('thread-external')

    expect(state.selectedLiveOverlay.value?.activityLabel).toBe('Thinking')
  })

  it('keeps prior active-turn reasoning hidden across consecutive bounded snapshots', async () => {
    installTestWindow()
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.resumeThread.mockResolvedValue({
      ...externalDetail('turn-external'),
      messages: [
        {
          id: 'reasoning-1',
          role: 'assistant',
          text: '**Inspecting fixtures**',
          messageType: 'reasoning',
          turnId: 'turn-external',
        },
        {
          id: 'agent-1',
          role: 'assistant',
          text: 'First output',
          messageType: 'agentMessage',
          turnId: 'turn-external',
        },
      ],
    })
    gatewayMocks.getThreadDetail
      .mockResolvedValueOnce({
        ...externalDetail('turn-external'),
        messages: [{
          id: 'agent-2',
          role: 'assistant',
          text: 'Second output',
          messageType: 'agentMessage',
          turnId: 'turn-external',
        }],
      })
      .mockResolvedValueOnce({
        ...externalDetail('turn-external'),
        messages: [
          {
            id: 'reasoning-2',
            role: 'assistant',
            text: '**Continuing analysis**',
            messageType: 'reasoning',
            turnId: 'turn-external',
          },
          {
            id: 'agent-3',
            role: 'assistant',
            text: 'Third output',
            messageType: 'agentMessage',
            turnId: 'turn-external',
          },
        ],
      })

    const state = useDesktopState()
    state.primeSelectedThread('thread-external')
    await state.loadMessages('thread-external')
    await state.loadMessages('thread-external', { silent: true, force: true })
    await state.loadMessages('thread-external', { silent: true, force: true })

    expect(state.selectedLiveOverlay.value?.activityLabel).toBe('Continuing analysis')
    expect(state.messages.value.map((message) => message.id)).toEqual([
      'agent-1',
      'agent-2',
      'agent-3',
    ])
  })

  it('preserves the last external reasoning snapshot for an inconclusive detail', async () => {
    installTestWindow()
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.resumeThread.mockResolvedValue({
      ...externalDetail('turn-external'),
      messages: [
        {
          id: 'reasoning-1',
          role: 'assistant',
          text: '**Reading runtime state**',
          messageType: 'reasoning',
          turnId: 'turn-external',
        },
        {
          id: 'agent-1',
          role: 'assistant',
          text: 'Existing output',
          messageType: 'agentMessage',
          turnId: 'turn-external',
        },
      ],
    })
    gatewayMocks.getThreadDetail.mockResolvedValue({
      ...idleDetail(),
      externalRuntimeState: 'unknown',
    })

    const state = useDesktopState()
    state.primeSelectedThread('thread-external')
    await state.loadMessages('thread-external')
    await state.loadMessages('thread-external', { silent: true, force: true })

    expect(state.selectedLiveOverlay.value?.activityLabel).toBe('Reading runtime state')
    expect(state.messages.value.map((message) => message.id)).toEqual(['agent-1'])
  })

  it('merges and hides same-turn reasoning from an inconclusive detail without an active turn id', async () => {
    installTestWindow()
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.resumeThread.mockResolvedValue({
      ...externalDetail('turn-external'),
      messages: [{
        id: 'reasoning-1',
        role: 'assistant',
        text: '**Reading runtime state**',
        messageType: 'reasoning',
        turnId: 'turn-external',
      }],
    })
    gatewayMocks.getThreadDetail.mockResolvedValue({
      ...idleDetail(),
      inProgress: false,
      externalRuntimeState: 'unknown',
      messages: [{
        id: 'reasoning-2',
        role: 'assistant',
        text: '**Inspecting the next snapshot**',
        messageType: 'reasoning',
        turnId: 'turn-external',
      }],
    })

    const state = useDesktopState()
    state.primeSelectedThread('thread-external')
    await state.loadMessages('thread-external')
    await state.loadMessages('thread-external', { silent: true, force: true })

    expect(state.selectedLiveOverlay.value?.activityLabel).toBe('Inspecting the next snapshot')
    expect(state.messages.value.map((message) => message.id)).not.toContain('reasoning-2')
  })

  it('lands the final idle output before clearing the external overlay', async () => {
    installTestWindow()
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.resumeThread.mockResolvedValue({
      ...externalDetail('turn-external'),
      messages: [{
        id: 'reasoning-1',
        role: 'assistant',
        text: '**Finishing work**',
        messageType: 'reasoning',
        turnId: 'turn-external',
      }],
    })
    gatewayMocks.getThreadDetail.mockResolvedValue({
      ...idleDetail(),
      messages: [{
        id: 'agent-final',
        role: 'assistant',
        text: 'Final desktop output',
        messageType: 'agentMessage',
        turnId: 'turn-external',
      }],
    })

    const state = useDesktopState()
    state.primeSelectedThread('thread-external')
    await state.loadMessages('thread-external')
    const overlayChanges: Array<{ label: string | null; messageIds: string[] }> = []
    const stopWatching = watch(
      () => state.selectedLiveOverlay.value?.activityLabel ?? null,
      (label) => {
        overlayChanges.push({
          label,
          messageIds: state.messages.value.map((message) => message.id),
        })
      },
      { flush: 'sync' },
    )

    await state.loadMessages('thread-external', { silent: true, force: true })
    stopWatching()

    expect(overlayChanges.map((change) => change.label)).toEqual([null])
    expect(overlayChanges[0]?.messageIds).toContain('agent-final')
  })
})

describe('thread detail version reconciliation', () => {
  it('does not mark a notification version loaded with an older in-flight detail', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-14T00:00:00.000Z'))
    installTestWindow()
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [
        { ...thread('thread-race', '/tmp/project'), updatedAtIso: '2026-07-14T00:00:00.000Z' },
      ] }],
      nextCursor: null,
    })

    const state = useDesktopState()
    state.primeSelectedThread('thread-race')
    await state.refreshAll({ includeSelectedThreadMessages: false })
    state.startPolling()
    pollingCleanups.push(() => state.stopPolling())
    const pendingDetail = deferred<ReturnType<typeof idleDetail>>()
    gatewayMocks.resumeThread.mockReturnValue(pendingDetail.promise)
    const firstLoad = state.loadMessages('thread-race')

    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [
        { ...thread('thread-race', '/tmp/project'), updatedAtIso: '2026-07-14T00:00:01.000Z' },
      ] }],
      nextCursor: null,
    })
    notificationHandler?.({
      method: 'thread/name/updated',
      params: { threadId: 'thread-race', name: 'Updated while reading detail' },
    })
    const eventSyncCallback = vi.mocked(window.setTimeout).mock.calls
      .filter(([, delay]) => delay === 220)
      .pop()?.[0]
    expect(eventSyncCallback).toBeTypeOf('function')
    eventSyncCallback?.()
    await flushMicrotasks()
    expect(state.projectGroups.value[0]?.threads[0]?.updatedAtIso).toBe('2026-07-14T00:00:01.000Z')

    pendingDetail.resolve(idleDetail())
    await firstLoad
    await flushMicrotasks()
    vi.setSystemTime(new Date('2026-07-14T00:00:03.000Z'))
    gatewayMocks.getThreadDetail.mockResolvedValue(idleDetail())

    await state.loadMessages('thread-race')

    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(1)
  })
})

describe('live error overlay', () => {
  it('shows the default thinking overlay while a selected thread is in progress without activity events', async () => {
    installTestWindow()
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.resumeThread.mockResolvedValue(null)
    gatewayMocks.getThreadDetail.mockResolvedValue({
      messages: [
        {
          id: 'user-1',
          role: 'user',
          text: 'create todo list app',
          messageType: 'userMessage',
        },
      ],
      inProgress: true,
      activeTurnId: 'turn-1',
      turnIndexByTurnId: {},
      hasMoreOlder: false,
    })

    const state = useDesktopState()
    state.primeSelectedThread('thread-thinking')
    await state.loadMessages('thread-thinking')

    expect(state.selectedLiveOverlay.value).toMatchObject({
      activityLabel: 'Thinking',
      reasoningText: '',
      errorText: '',
    })
  })

  it('keeps a new live error visible when an older persisted turn error exists', async () => {
    installTestWindow()
    let notificationHandler: (notification: { method: string; params?: unknown }) => void = () => {}
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler
      return vi.fn()
    })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.resumeThread.mockResolvedValue(null)
    gatewayMocks.getThreadDetail.mockResolvedValue({
      messages: [
        {
          id: 'old-error',
          role: 'system',
          text: 'old persisted failure',
          messageType: 'turnError',
        },
      ],
      inProgress: false,
      activeTurnId: '',
      turnIndexByTurnId: {},
      hasMoreOlder: false,
    })

    const state = useDesktopState()
    state.primeSelectedThread('thread-with-errors')
    await state.loadMessages('thread-with-errors')
    state.startPolling()

    notificationHandler?.({
      method: 'turn/completed',
      params: {
        threadId: 'thread-with-errors',
        turnId: 'new-turn',
        turn: {
          id: 'new-turn',
          status: 'failed',
          error: { message: 'new live failure' },
        },
      },
    })

    expect(state.selectedLiveOverlay.value?.errorText).toBe('new live failure')
  })

  it('suppresses a live error only after that same error has persisted', async () => {
    installTestWindow()
    let notificationHandler: (notification: { method: string; params?: unknown }) => void = () => {}
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler
      return vi.fn()
    })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.resumeThread.mockResolvedValue(null)
    gatewayMocks.getThreadDetail.mockResolvedValue({
      messages: [
        {
          id: 'persisted-error',
          role: 'system',
          text: 'same failure',
          messageType: 'turnError',
        },
      ],
      inProgress: false,
      activeTurnId: '',
      turnIndexByTurnId: {},
      hasMoreOlder: false,
    })

    const state = useDesktopState()
    state.primeSelectedThread('thread-with-persisted-error')
    await state.loadMessages('thread-with-persisted-error')
    state.startPolling()

    notificationHandler?.({
      method: 'turn/completed',
      params: {
        threadId: 'thread-with-persisted-error',
        turnId: 'same-turn',
        turn: {
          id: 'same-turn',
          status: 'failed',
          error: { message: 'same failure' },
        },
      },
    })

    expect(state.selectedLiveOverlay.value).toBe(null)
  })
})

describe('provider model selection', () => {
  it('ignores global selected-model localStorage when OpenCode Zen is the active provider', async () => {
    installTestWindow({
      'codex-web-local.selected-model-by-context.v1': JSON.stringify({
        '__new-thread__': 'gpt-5.5',
      }),
      'codex-web-local.selected-model-id.v1': 'gpt-5.5',
    })
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'big-pickle',
      providerId: 'opencode-zen',
      reasoningEffort: 'medium',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModelIds.mockResolvedValue([
      'big-pickle',
      'deepseek-v4-flash-free',
      'ring-2.6-1t-free',
    ])

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })

    expect(gatewayMocks.getAvailableModelIds).toHaveBeenCalledWith({
      includeProviderModels: true,
      requireProviderModels: true,
      providerId: 'opencode-zen',
    })
    expect(state.availableModelIds.value).toEqual([
      'big-pickle',
      'deepseek-v4-flash-free',
      'ring-2.6-1t-free',
    ])
    expect(state.selectedModelId.value).toBe('big-pickle')
    expect(state.readModelIdForThread('').trim()).toBe('big-pickle')
    expect(JSON.parse(window.localStorage.getItem('codex-web-local.selected-model-by-context.v1') ?? '{}')).toEqual({
      '__new-thread-provider__::opencode-zen': 'big-pickle',
    })
    expect(window.localStorage.getItem('codex-web-local.selected-model-id.v1')).toBe(null)
  })

  it('restores a valid provider-scoped OpenCode Zen selected model from localStorage', async () => {
    installTestWindow({
      'codex-web-local.selected-model-by-context.v1': JSON.stringify({
        '__new-thread-provider__::opencode-zen': 'ring-2.6-1t-free',
      }),
    })
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'big-pickle',
      providerId: 'opencode-zen',
      reasoningEffort: 'medium',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModelIds.mockResolvedValue([
      'big-pickle',
      'deepseek-v4-flash-free',
      'ring-2.6-1t-free',
    ])

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })

    expect(state.availableModelIds.value).toEqual([
      'big-pickle',
      'deepseek-v4-flash-free',
      'ring-2.6-1t-free',
    ])
    expect(state.selectedModelId.value).toBe('ring-2.6-1t-free')
    expect(state.readModelIdForThread('').trim()).toBe('ring-2.6-1t-free')
    expect(JSON.parse(window.localStorage.getItem('codex-web-local.selected-model-by-context.v1') ?? '{}')).toEqual({
      '__new-thread-provider__::opencode-zen': 'ring-2.6-1t-free',
    })
  })

  it('stores the new-thread Codex model in a provider-scoped slot', async () => {
    installTestWindow({
      'codex-web-local.selected-model-by-context.v1': JSON.stringify({
        '__new-thread-provider__::openrouter-free': 'openrouter/free',
      }),
    })
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.5',
      providerId: '',
      reasoningEffort: 'medium',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModelIds.mockResolvedValue([
      'gpt-5.5',
      'gpt-5.4-mini',
    ])

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })

    expect(state.selectedModelId.value).toBe('gpt-5.5')
    expect(state.readModelIdForThread('').trim()).toBe('gpt-5.5')
    expect(JSON.parse(window.localStorage.getItem('codex-web-local.selected-model-by-context.v1') ?? '{}')).toEqual({
      '__new-thread-provider__::openrouter-free': 'openrouter/free',
      '__new-thread-provider__::codex': 'gpt-5.5',
    })
  })

  it('drops stale non-Codex selected models from the Codex model list', async () => {
    installTestWindow({
      'codex-web-local.selected-model-by-context.v1': JSON.stringify({
        '__new-thread-provider__::codex': 'big-pickle',
      }),
    })
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.5',
      providerId: '',
      reasoningEffort: 'medium',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModelIds.mockResolvedValue([
      'gpt-5.5',
      'gpt-5.4-mini',
    ])

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })

    expect(state.availableModelIds.value).toEqual([
      'gpt-5.5',
      'gpt-5.4-mini',
    ])
    expect(state.availableModelIds.value).not.toContain('big-pickle')
    expect(state.selectedModelId.value).toBe('gpt-5.5')
    expect(state.readModelIdForThread('').trim()).toBe('gpt-5.5')
    expect(JSON.parse(window.localStorage.getItem('codex-web-local.selected-model-by-context.v1') ?? '{}')).toEqual({
      '__new-thread-provider__::codex': 'gpt-5.5',
    })
  })

  it('keeps an existing OpenCode Zen thread locked to Zen models after Codex auth becomes active', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('legacy-zen-thread', '/tmp/project')] }],
      nextCursor: null,
    })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.4-mini',
      providerId: '',
      reasoningEffort: 'medium',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModelIds.mockImplementation(async (options?: { providerId?: string }) => {
      if (options?.providerId === 'opencode-zen') {
        return ['big-pickle', 'ring-2.6-1t-free']
      }
      return ['gpt-5.5', 'gpt-5.4-mini']
    })
    gatewayMocks.resumeThread.mockResolvedValue({
      model: 'gpt-5.4-mini',
      modelProvider: 'opencode_zen',
      messages: [],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })

    const state = useDesktopState()
    state.primeSelectedThread('legacy-zen-thread')
    await state.loadMessages('legacy-zen-thread')
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })

    expect(gatewayMocks.getAvailableModelIds).toHaveBeenLastCalledWith({
      includeProviderModels: true,
      requireProviderModels: true,
      providerId: 'opencode-zen',
    })
    expect(state.availableModelIds.value).toEqual([
      'big-pickle',
      'ring-2.6-1t-free',
    ])
    expect(state.selectedModelId.value).toBe('big-pickle')
    expect(state.readModelIdForThread('legacy-zen-thread')).toBe('big-pickle')
    expect(state.readModelIdForThread('')).toBe('gpt-5.4-mini')
  })

  it('loads provider models for a selected provider-backed thread during scheduled refreshes', async () => {
    installTestWindow()
    vi.mocked(window.setTimeout).mockImplementation(((callback: TimerHandler) => {
      if (typeof callback === 'function') {
        void Promise.resolve().then(() => callback())
      }
      return 1
    }) as typeof window.setTimeout)
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('legacy-zen-thread', '/tmp/project')] }],
      nextCursor: null,
    })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.4-mini',
      providerId: '',
      reasoningEffort: 'medium',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModelIds.mockImplementation(async (options?: { providerId?: string }) => {
      if (options?.providerId === 'opencode-zen') {
        return ['big-pickle', 'ring-2.6-1t-free']
      }
      return ['gpt-5.5', 'gpt-5.4-mini']
    })
    gatewayMocks.resumeThread.mockResolvedValue({
      model: 'gpt-5.4-mini',
      modelProvider: 'opencode_zen',
      messages: [],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })

    const state = useDesktopState()
    state.primeSelectedThread('legacy-zen-thread')
    await state.loadMessages('legacy-zen-thread')
    await state.refreshAll({ includeSelectedThreadMessages: false })
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0))

    expect(gatewayMocks.getAvailableModelIds).toHaveBeenLastCalledWith({
      includeProviderModels: true,
      requireProviderModels: true,
      providerId: 'opencode-zen',
    })
    expect(state.availableModelIds.value).toEqual(['big-pickle', 'ring-2.6-1t-free'])
    expect(state.selectedModelId.value).toBe('big-pickle')
  })

  it('captures the active provider when creating a new thread', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.5',
      providerId: '',
      reasoningEffort: 'medium',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModelIds.mockResolvedValue(['gpt-5.5', 'gpt-5.4-mini'])
    gatewayMocks.startThread.mockResolvedValue({
      threadId: 'codex-thread',
      model: 'gpt-5.5',
      modelProvider: 'openai',
    })
    gatewayMocks.startThreadTurn.mockResolvedValue('turn-1')
    gatewayMocks.getThreadDetail.mockResolvedValue({
      model: 'gpt-5.5',
      modelProvider: 'openai',
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          text: 'Hi.',
          messageType: 'agentMessage',
        },
      ],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })
    await state.sendMessageToNewThread('hi', '/tmp/project')

    expect(gatewayMocks.startThread).toHaveBeenCalledWith('/tmp/project', 'gpt-5.5')
    expect(gatewayMocks.startThreadTurn).toHaveBeenCalledWith(
      'codex-thread',
      'hi',
      [],
      'gpt-5.5',
      'medium',
      undefined,
      [],
      'default',
    )
    expect(state.readModelIdForThread('codex-thread')).toBe('gpt-5.5')
    expect(state.messages.value.some((message) => (
      message.role === 'user' &&
      message.text === 'hi' &&
      message.messageType === 'userMessage.optimistic'
    ))).toBe(true)

    const modelConfigCallsBeforeLoad = gatewayMocks.getCurrentModelConfig.mock.calls.length
    const availableModelCallsBeforeLoad = gatewayMocks.getAvailableModelIds.mock.calls.length
    await state.loadMessages('codex-thread')
    expect(gatewayMocks.getCurrentModelConfig).toHaveBeenCalledTimes(modelConfigCallsBeforeLoad)
    expect(gatewayMocks.getAvailableModelIds).toHaveBeenCalledTimes(availableModelCallsBeforeLoad)
    expect(state.messages.value.map((message) => `${message.role}:${message.text}`)).toEqual([
      'user:hi',
      'assistant:Hi.',
    ])
  })

  it('refreshes a loaded optimistic thread when completion events arrive', async () => {
    installTestWindow()
    vi.mocked(window.setTimeout).mockImplementation(((callback: TimerHandler) => {
      if (typeof callback === 'function') {
        void Promise.resolve().then(() => callback())
      }
      return 1
    }) as typeof window.setTimeout)
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.4-mini',
      providerId: '',
      reasoningEffort: 'medium',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModelIds.mockResolvedValue(['gpt-5.5', 'gpt-5.4-mini'])
    gatewayMocks.startThread.mockResolvedValue({
      threadId: 'mini-thread',
      model: 'gpt-5.4-mini',
      modelProvider: 'openai',
    })
    gatewayMocks.startThreadTurn.mockResolvedValue('turn-1')
    gatewayMocks.getThreadDetail.mockResolvedValue({
      model: 'gpt-5.4-mini',
      modelProvider: 'openai',
      messages: [
        {
          id: 'user-1',
          role: 'user',
          text: 'hi',
          messageType: 'userMessage',
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          text: 'Hi.',
          messageType: 'agentMessage',
        },
      ],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })
    await state.sendMessageToNewThread('hi', '/tmp/project')
    state.startPolling()
    expect(notificationHandler).toBeDefined()
    notificationHandler!({
      method: 'turn/completed',
      params: {
        threadId: 'mini-thread',
        turn: { id: 'turn-1', status: 'completed' },
      },
    })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledWith('mini-thread')
    expect(state.messages.value.map((message) => `${message.role}:${message.text}`)).toEqual([
      'user:hi',
      'system:Worked for <1s',
      'assistant:Hi.',
    ])
  })

  it('surfaces selected thread load failures and still refreshes models', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.5',
      providerId: '',
      reasoningEffort: 'medium',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModelIds.mockResolvedValue(['gpt-5.5', 'gpt-5.4-mini'])
    gatewayMocks.resumeThread.mockRejectedValue(new Error('thread not found'))

    const state = useDesktopState()
    state.primeSelectedThread('missing-thread')
    await state.refreshAll({
      includeSelectedThreadMessages: true,
      awaitAncillaryRefreshes: true,
    })

    expect(state.selectedLiveOverlay.value?.errorText).toContain('thread not found')
    expect(state.availableModelIds.value).toEqual(['gpt-5.5', 'gpt-5.4-mini'])
    expect(state.selectedModelId.value).toBe('gpt-5.5')

    await state.ensureThreadMessagesLoaded('missing-thread', { silent: true })
    await state.loadMessages('missing-thread')
    expect(gatewayMocks.resumeThread).toHaveBeenCalledTimes(1)
  })
})

describe('findAdjacentThreadId', () => {
  it('selects the next thread after the archived thread', () => {
    const threads = [
      thread('first-thread', '/tmp/project'),
      thread('selected-thread', '/tmp/project'),
      thread('next-thread', '/tmp/project'),
    ]

    expect(findAdjacentThreadId(threads, 'selected-thread')).toBe('next-thread')
  })

  it('falls back to the previous thread when the last thread is archived', () => {
    const threads = [
      thread('previous-thread', '/tmp/project'),
      thread('selected-thread', '/tmp/project'),
    ]

    expect(findAdjacentThreadId(threads, 'selected-thread')).toBe('previous-thread')
  })

  it('returns no fallback when there is no adjacent thread', () => {
    expect(findAdjacentThreadId([thread('selected-thread', '/tmp/project')], 'selected-thread')).toBe('')
  })
})
