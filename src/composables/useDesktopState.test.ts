import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { watch } from 'vue'
import {
  buildWorkspaceRootsProjectOrderState,
  collectWorkspaceRootPathsForProjectRemoval,
  filterGroupsByWorkspaceRoots,
  findAdjacentThreadId,
  isThreadNotFoundError,
  removeThreadFromGroups,
  isThreadUnreadByLastRead,
  useDesktopState,
} from './useDesktopState'
import { CodexApiError } from '../api/codexErrors'
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
  getOlderThreadMessages: vi.fn(),
  getThreadGoal: vi.fn(),
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
  setThreadGoal: vi.fn(),
  setWorkspaceRootsState: vi.fn(),
  clearThreadGoal: vi.fn(),
  cleanupManagedUploads: vi.fn(),
  startThread: vi.fn(),
  startThreadTurn: vi.fn(),
  subscribeCodexNotifications: vi.fn(),
}))

describe('isThreadNotFoundError', () => {
  it('treats inaccessible thread-read failures as stale routes', () => {
    expect(isThreadNotFoundError(new CodexApiError('forbidden', {
      code: 'http_error',
      method: 'thread/read',
      status: 403,
    }))).toBe(true)
    expect(isThreadNotFoundError(new CodexApiError('gone', {
      code: 'http_error',
      method: 'thread/read',
      status: 410,
    }))).toBe(true)
    expect(isThreadNotFoundError(new Error('no rollout found for thread archived-thread'))).toBe(true)
    expect(isThreadNotFoundError(new Error('thread is archived'))).toBe(true)
    expect(isThreadNotFoundError(new Error('thread is not accessible'))).toBe(true)
  })

  it('does not hide unrelated transport failures', () => {
    expect(isThreadNotFoundError(new CodexApiError('bad gateway', {
      code: 'http_error',
      method: 'thread/read',
      status: 502,
    }))).toBe(false)
    expect(isThreadNotFoundError(new Error('network failed'))).toBe(false)
  })
})

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

function installTestWindow(
  initialStorage: Record<string, string> = {},
  options: { isMobile?: boolean } = {},
) {
  const store = new Map(Object.entries(initialStorage))
  vi.stubGlobal('window', {
    innerWidth: options.isMobile === true ? 390 : 1024,
    localStorage: {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store.set(key, value)
      }),
      removeItem: vi.fn((key: string) => {
        store.delete(key)
      }),
    },
    matchMedia: vi.fn((query: string) => ({
      matches: options.isMobile === true && /max-width:\s*767px/u.test(query),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
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
  gatewayMocks.getThreadDetail.mockReset().mockResolvedValue(idleDetail())
  gatewayMocks.getOlderThreadMessages.mockReset()
  gatewayMocks.resumeThread.mockReset().mockResolvedValue(idleDetail())
  gatewayMocks.getExternalThreadLiveSnapshot.mockImplementation(
    (threadId: string, signal?: AbortSignal) => gatewayMocks.getThreadDetail(threadId, signal),
  )
  gatewayMocks.getThreadQueueState.mockResolvedValue({})
  gatewayMocks.getThreadGoal.mockResolvedValue(null)
  gatewayMocks.getThreadRuntimeStates.mockResolvedValue({})
  gatewayMocks.setThreadQueueState.mockResolvedValue(undefined)
  gatewayMocks.cleanupManagedUploads.mockResolvedValue(true)
  gatewayMocks.getThreadTitleCache.mockResolvedValue({ titles: {} })
  gatewayMocks.getWorkspaceRootsState.mockRejectedValue(new Error('no workspace roots state'))
})

describe('existing thread loading', () => {
  it('reads an existing thread without resuming it on selection or forced refresh', async () => {
    installTestWindow()
    gatewayMocks.getThreadDetail.mockResolvedValue(idleDetail())

    const state = useDesktopState()
    state.primeSelectedThread('thread-1')

    await state.loadMessages('thread-1')
    await state.loadMessages('thread-1', { force: true })

    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(2)
    expect(gatewayMocks.getThreadDetail).toHaveBeenNthCalledWith(1, 'thread-1')
    expect(gatewayMocks.getThreadDetail).toHaveBeenNthCalledWith(2, 'thread-1')
    expect(gatewayMocks.resumeThread).not.toHaveBeenCalled()
  })

  it('uses the opaque older cursor and reindexes prepended turns contiguously', async () => {
    installTestWindow()
    gatewayMocks.getThreadDetail.mockResolvedValue({
      ...idleDetail(),
      isPagedProjection: true,
      olderCursor: 'opaque-page-1',
      hasMoreOlder: true,
      turnIndexByTurnId: {
        'turn-4': 0,
        'turn-5': 1,
      },
      messages: [
        {
          id: 'agent-4',
          role: 'assistant',
          text: 'four',
          messageType: 'agentMessage',
          turnId: 'turn-4',
          turnIndex: 0,
        },
        {
          id: 'agent-5',
          role: 'assistant',
          text: 'five',
          messageType: 'agentMessage',
          turnId: 'turn-5',
          turnIndex: 1,
        },
      ],
    })
    gatewayMocks.getOlderThreadMessages.mockResolvedValue({
      messages: [
        {
          id: 'agent-2',
          role: 'assistant',
          text: 'two',
          messageType: 'agentMessage',
          turnId: 'turn-2',
          turnIndex: 0,
        },
        {
          id: 'agent-3',
          role: 'assistant',
          text: 'three',
          messageType: 'agentMessage',
          turnId: 'turn-3',
          turnIndex: 1,
        },
      ],
      completionSummaries: [],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: true,
      nextCursor: 'opaque-page-2',
      turnIds: ['turn-2', 'turn-3'],
      startTurnIndex: 0,
      turnIndexByTurnId: {
        'turn-2': 0,
        'turn-3': 1,
      },
    })

    const state = useDesktopState()
    state.primeSelectedThread('thread-1')
    await state.loadMessages('thread-1')
    await state.loadOlderMessages('thread-1')

    expect(gatewayMocks.getOlderThreadMessages).toHaveBeenCalledWith(
      'thread-1',
      'opaque-page-1',
    )
    expect(state.messages.value.map((message) => [message.id, message.turnIndex])).toEqual([
      ['agent-2', 0],
      ['agent-3', 1],
      ['agent-4', 2],
      ['agent-5', 3],
    ])

    await state.loadOlderMessages('thread-1')
    expect(gatewayMocks.getOlderThreadMessages).toHaveBeenLastCalledWith(
      'thread-1',
      'opaque-page-2',
    )
  })

  it('preserves loaded older turns and their absolute indices across a forced paged refresh', async () => {
    installTestWindow()
    const newestDetail = {
      ...idleDetail(),
      isPagedProjection: true,
      olderCursor: 'opaque-page-1',
      hasMoreOlder: true,
      turnIndexByTurnId: { 'turn-2': 0 },
      messages: [{
        id: 'agent-2',
        role: 'assistant' as const,
        text: 'two',
        messageType: 'agentMessage',
        turnId: 'turn-2',
        turnIndex: 0,
      }],
    }
    gatewayMocks.getThreadDetail.mockResolvedValue(newestDetail)
    gatewayMocks.getOlderThreadMessages.mockResolvedValue({
      messages: [{
        id: 'agent-1',
        role: 'assistant',
        text: 'one',
        messageType: 'agentMessage',
        turnId: 'turn-1',
        turnIndex: 0,
      }],
      completionSummaries: [],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      nextCursor: null,
      turnIds: ['turn-1'],
      startTurnIndex: 0,
      turnIndexByTurnId: { 'turn-1': 0 },
    })

    const state = useDesktopState()
    state.primeSelectedThread('thread-1')
    await state.loadMessages('thread-1')
    await state.loadOlderMessages('thread-1')
    await state.loadMessages('thread-1', { force: true })

    expect(state.messages.value.map((message) => [message.id, message.turnIndex])).toEqual([
      ['agent-1', 0],
      ['agent-2', 1],
    ])
  })

  it('stops older pagination when the server repeats a consumed cursor without mutating messages', async () => {
    installTestWindow()
    gatewayMocks.getThreadDetail.mockResolvedValue({
      ...idleDetail(),
      isPagedProjection: true,
      olderCursor: 'opaque-loop',
      hasMoreOlder: true,
      turnIndexByTurnId: { 'turn-2': 0 },
      messages: [{
        id: 'agent-2',
        role: 'assistant',
        text: 'two',
        messageType: 'agentMessage',
        turnId: 'turn-2',
        turnIndex: 0,
      }],
    })
    gatewayMocks.getOlderThreadMessages.mockResolvedValue({
      messages: [{
        id: 'agent-1',
        role: 'assistant',
        text: 'one',
        messageType: 'agentMessage',
        turnId: 'turn-1',
        turnIndex: 0,
      }],
      completionSummaries: [],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: true,
      nextCursor: 'opaque-loop',
      turnIds: ['turn-1'],
      startTurnIndex: 0,
      turnIndexByTurnId: { 'turn-1': 0 },
    })

    const state = useDesktopState()
    state.primeSelectedThread('thread-1')
    await state.loadMessages('thread-1')
    await state.loadOlderMessages('thread-1')
    await state.loadOlderMessages('thread-1')

    expect(gatewayMocks.getOlderThreadMessages).toHaveBeenCalledTimes(1)
    expect(state.messages.value.map((message) => message.id)).toEqual(['agent-2'])
  })

  it('keeps the user-selected model and effort when the first follow-up resumes the thread', async () => {
    installTestWindow()
    gatewayMocks.resumeThread.mockResolvedValue({
      ...idleDetail(),
      model: 'gpt-5.5',
      modelProvider: 'openai',
    })
    gatewayMocks.startThreadTurn.mockResolvedValue('turn-selected-settings')

    const state = useDesktopState()
    state.primeSelectedThread('thread-1')
    state.setSelectedModelIdForThread('thread-1', 'gpt-5.6-sol')
    state.setSelectedReasoningEffort('max')

    await state.sendMessageToSelectedThread('use the selected settings')

    expect(gatewayMocks.resumeThread).toHaveBeenCalledWith('thread-1')
    expect(gatewayMocks.startThreadTurn).toHaveBeenCalledWith(
      'thread-1',
      'use the selected settings',
      [],
      'gpt-5.6-sol',
      'max',
      undefined,
      [],
      'default',
    )
  })
})

describe('thread goal state', () => {
  const activeGoal = {
    objective: 'Match the Codex conversation page',
    status: 'active' as const,
    updatedAt: 1_785_000_000,
    timeUsedSeconds: 75,
    tokensUsed: 1200,
    tokenBudget: 8000,
  }

  it('loads the selected thread goal without coupling it to thread detail errors', async () => {
    installTestWindow()
    gatewayMocks.getThreadDetail.mockResolvedValue(idleDetail())
    gatewayMocks.getThreadGoal.mockResolvedValue(activeGoal)

    const state = useDesktopState()
    state.primeSelectedThread('thread-1')
    await state.loadMessages('thread-1')
    await flushMicrotasks()

    expect(gatewayMocks.getThreadGoal).toHaveBeenCalledWith('thread-1')
    expect(state.selectedThreadGoal.value).toEqual(activeGoal)
    expect(state.selectedThreadGoalSupported.value).toBe(true)
  })

  it('refreshes authoritative goal state after polling reconnects', async () => {
    installTestWindow()
    gatewayMocks.getThreadDetail.mockResolvedValue(idleDetail())
    gatewayMocks.getThreadDetail.mockResolvedValue(idleDetail())
    gatewayMocks.getThreadGoal.mockResolvedValueOnce(activeGoal).mockResolvedValueOnce(null)

    const state = useDesktopState()
    state.primeSelectedThread('thread-1')
    await state.loadMessages('thread-1')
    await flushMicrotasks()
    expect(state.selectedThreadGoal.value).toEqual(activeGoal)

    state.stopPolling()
    state.startPolling()
    await state.loadMessages('thread-1')
    await flushMicrotasks()

    expect(gatewayMocks.getThreadGoal).toHaveBeenCalledTimes(2)
    expect(state.selectedThreadGoal.value).toBeNull()
  })

  it('ignores a stale goal response from the connection that stopped polling', async () => {
    installTestWindow()
    gatewayMocks.getThreadDetail.mockResolvedValue(idleDetail())
    gatewayMocks.getThreadDetail.mockResolvedValue(idleDetail())
    const staleGoal = deferred<typeof activeGoal | null>()
    gatewayMocks.getThreadGoal
      .mockReturnValueOnce(staleGoal.promise)
      .mockResolvedValueOnce(null)

    const state = useDesktopState()
    state.primeSelectedThread('thread-1')
    await state.loadMessages('thread-1')
    await flushMicrotasks()
    expect(gatewayMocks.getThreadGoal).toHaveBeenCalledTimes(1)

    state.stopPolling()
    state.startPolling()
    await state.loadMessages('thread-1', { force: true })
    await flushMicrotasks()
    expect(gatewayMocks.getThreadGoal).toHaveBeenCalledTimes(2)
    expect(state.selectedThreadGoal.value).toBeNull()

    staleGoal.resolve(activeGoal)
    await flushMicrotasks()

    expect(state.selectedThreadGoal.value).toBeNull()
  })

  it('applies goal update and clear notifications to the matching thread', async () => {
    const { state, emit } = await setupTurnLifecycleNotificationState('thread-1')

    emit({
      method: 'thread/goal/updated',
      params: { threadId: 'thread-1', goal: activeGoal },
    })
    expect(state.selectedThreadGoal.value).toEqual(activeGoal)
    expect(state.selectedThreadGoalSupported.value).toBe(true)

    emit({
      method: 'thread/goal/cleared',
      params: { threadId: 'thread-1' },
    })
    expect(state.selectedThreadGoal.value).toBeNull()
    expect(state.selectedThreadGoalSupported.value).toBe(true)
  })

  it('updates, pauses, resumes, and clears the selected goal through Codex RPCs', async () => {
    installTestWindow()
    gatewayMocks.setThreadGoal.mockResolvedValue(activeGoal)
    gatewayMocks.clearThreadGoal.mockResolvedValue(undefined)

    const state = useDesktopState()
    state.primeSelectedThread('thread-1')

    await state.updateSelectedThreadGoal({
      objective: activeGoal.objective,
      status: 'active',
    })
    expect(gatewayMocks.setThreadGoal).toHaveBeenCalledWith({
      threadId: 'thread-1',
      objective: activeGoal.objective,
      status: 'active',
    })
    expect(state.selectedThreadGoal.value).toEqual(activeGoal)

    await state.clearSelectedThreadGoal()
    expect(gatewayMocks.clearThreadGoal).toHaveBeenCalledWith('thread-1')
    expect(state.selectedThreadGoal.value).toBeNull()
  })

  it('views and mutates Goal metadata without resuming or taking ownership from an external writer', async () => {
    installTestWindow()
    const completedGoal = {
      ...activeGoal,
      status: 'complete' as const,
      updatedAt: activeGoal.updatedAt + 10,
      timeUsedSeconds: 91,
      tokensUsed: 1700,
      tokenBudget: 9000,
    }
    gatewayMocks.getThreadDetail.mockResolvedValue(externalDetail())
    gatewayMocks.getThreadGoal.mockResolvedValue(activeGoal)
    gatewayMocks.setThreadGoal.mockResolvedValue(completedGoal)
    gatewayMocks.clearThreadGoal.mockResolvedValue(undefined)

    const state = useDesktopState()
    state.primeSelectedThread('thread-1')
    await state.loadMessages('thread-1')
    await flushMicrotasks()

    expect(state.selectedThreadRuntimeOwnership.value).toBe('external')
    expect(state.selectedThreadGoal.value).toEqual(activeGoal)

    await expect(state.updateSelectedThreadGoal({
      objective: 'Finish while another client runs the turn',
      status: 'complete',
    })).resolves.toBe(true)
    expect(gatewayMocks.setThreadGoal).toHaveBeenCalledWith({
      threadId: 'thread-1',
      objective: 'Finish while another client runs the turn',
      status: 'complete',
    })
    expect(state.selectedThreadGoal.value).toEqual(completedGoal)
    expect(state.selectedThreadRuntimeOwnership.value).toBe('external')

    await expect(state.clearSelectedThreadGoal()).resolves.toBe(true)
    expect(gatewayMocks.clearThreadGoal).toHaveBeenCalledWith('thread-1')
    expect(state.selectedThreadGoal.value).toBeNull()
    expect(state.selectedThreadRuntimeOwnership.value).toBe('external')
    expect(gatewayMocks.resumeThread).not.toHaveBeenCalled()
  })

  it('keeps a newer Goal notification when an older set response settles', async () => {
    const pendingSet = deferred<typeof activeGoal>()
    const staleSetGoal = {
      ...activeGoal,
      objective: 'Stale set response',
      updatedAt: activeGoal.updatedAt + 1,
    }
    const notifiedGoal = {
      ...activeGoal,
      objective: 'Newer notification',
      status: 'blocked' as const,
      updatedAt: activeGoal.updatedAt + 2,
    }
    gatewayMocks.setThreadGoal.mockReturnValue(pendingSet.promise)
    const { state, emit } = await setupTurnLifecycleNotificationState('thread-1')

    const mutation = state.updateSelectedThreadGoal({
      objective: staleSetGoal.objective,
      status: 'active',
    })
    emit({
      method: 'thread/goal/updated',
      params: { threadId: 'thread-1', goal: notifiedGoal },
    })
    pendingSet.resolve(staleSetGoal)
    await mutation

    expect(state.selectedThreadGoal.value).toEqual(notifiedGoal)
  })

  it('keeps a Goal created by notification when an older clear response settles', async () => {
    const pendingClear = deferred<void>()
    const notifiedGoal = {
      ...activeGoal,
      objective: 'Created while clear was pending',
      updatedAt: activeGoal.updatedAt + 1,
    }
    gatewayMocks.clearThreadGoal.mockReturnValue(pendingClear.promise)
    const { state, emit } = await setupTurnLifecycleNotificationState('thread-1')

    const mutation = state.clearSelectedThreadGoal()
    emit({
      method: 'thread/goal/updated',
      params: { threadId: 'thread-1', goal: notifiedGoal },
    })
    pendingClear.resolve()
    await mutation

    expect(state.selectedThreadGoal.value).toEqual(notifiedGoal)
  })

  it('does not reuse a pending mutation epoch after Goal polling reconnects', async () => {
    installTestWindow()
    const pendingSet = deferred<typeof activeGoal>()
    const staleSetGoal = {
      ...activeGoal,
      objective: 'Response from the previous polling generation',
    }
    const refreshedGoal = {
      ...activeGoal,
      objective: 'Goal loaded after reconnect',
      updatedAt: activeGoal.updatedAt + 1,
    }
    gatewayMocks.setThreadGoal.mockReturnValue(pendingSet.promise)
    gatewayMocks.getThreadGoal.mockResolvedValue(refreshedGoal)

    const state = useDesktopState()
    state.primeSelectedThread('thread-1')
    const mutation = state.updateSelectedThreadGoal({
      objective: staleSetGoal.objective,
      status: 'active',
    })

    state.stopPolling()
    state.startPolling()
    pollingCleanups.push(() => state.stopPolling())
    await state.loadMessages('thread-1')
    await flushMicrotasks()
    expect(state.selectedThreadGoal.value).toEqual(refreshedGoal)

    pendingSet.resolve(staleSetGoal)
    await mutation

    expect(state.selectedThreadGoal.value).toEqual(refreshedGoal)
  })

  it('does not let an old set finally unlock a newer clear mutation', async () => {
    installTestWindow()
    const pendingSet = deferred<typeof activeGoal>()
    const pendingClear = deferred<void>()
    gatewayMocks.setThreadGoal.mockReset().mockReturnValueOnce(pendingSet.promise)
    gatewayMocks.clearThreadGoal.mockReset().mockReturnValueOnce(pendingClear.promise)

    const state = useDesktopState()
    state.primeSelectedThread('thread-1')
    const oldSet = state.updateSelectedThreadGoal({
      objective: 'Old generation set',
      status: 'active',
    })

    state.stopPolling()
    state.startPolling()
    pollingCleanups.push(() => state.stopPolling())
    const currentClear = state.clearSelectedThreadGoal()
    expect(state.isUpdatingThreadGoal.value).toBe(true)

    pendingSet.resolve(activeGoal)
    await oldSet

    expect(state.isUpdatingThreadGoal.value).toBe(true)
    await expect(state.updateSelectedThreadGoal({
      objective: 'Must remain locked',
      status: 'active',
    })).resolves.toBe(false)
    expect(gatewayMocks.setThreadGoal).toHaveBeenCalledTimes(1)
    expect(gatewayMocks.clearThreadGoal).toHaveBeenCalledTimes(1)

    pendingClear.resolve()
    await currentClear
    expect(state.isUpdatingThreadGoal.value).toBe(false)
  })

  it('does not let an old clear finally unlock a newer set mutation', async () => {
    installTestWindow()
    const pendingClear = deferred<void>()
    const pendingSet = deferred<typeof activeGoal>()
    gatewayMocks.clearThreadGoal.mockReset().mockReturnValueOnce(pendingClear.promise)
    gatewayMocks.setThreadGoal.mockReset().mockReturnValueOnce(pendingSet.promise)

    const state = useDesktopState()
    state.primeSelectedThread('thread-1')
    const oldClear = state.clearSelectedThreadGoal()

    state.stopPolling()
    state.startPolling()
    pollingCleanups.push(() => state.stopPolling())
    const currentSet = state.updateSelectedThreadGoal({
      objective: 'Current generation set',
      status: 'active',
    })
    expect(state.isUpdatingThreadGoal.value).toBe(true)

    pendingClear.resolve()
    await oldClear

    expect(state.isUpdatingThreadGoal.value).toBe(true)
    await expect(state.clearSelectedThreadGoal()).resolves.toBe(false)
    expect(gatewayMocks.clearThreadGoal).toHaveBeenCalledTimes(1)
    expect(gatewayMocks.setThreadGoal).toHaveBeenCalledTimes(1)

    pendingSet.resolve(activeGoal)
    await currentSet
    expect(state.isUpdatingThreadGoal.value).toBe(false)
  })

  it('keeps goal mutation progress scoped to the thread that started it', async () => {
    installTestWindow()
    let resolveGoal!: (goal: typeof activeGoal) => void
    gatewayMocks.setThreadGoal.mockImplementation(() => new Promise((resolve) => {
      resolveGoal = resolve
    }))

    const state = useDesktopState()
    state.primeSelectedThread('thread-1')
    const updatePromise = state.updateSelectedThreadGoal({
      objective: activeGoal.objective,
      status: 'active',
    })

    expect(state.isUpdatingThreadGoal.value).toBe(true)
    state.primeSelectedThread('thread-2')
    expect(state.isUpdatingThreadGoal.value).toBe(false)
    state.primeSelectedThread('thread-1')
    expect(state.isUpdatingThreadGoal.value).toBe(true)

    resolveGoal(activeGoal)
    await updatePromise
    expect(state.isUpdatingThreadGoal.value).toBe(false)
  })
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

  it('withholds and then renders a split typed pull-request directive', async () => {
    const { state, emit } = await setupCodexDirectiveNotificationState()
    emit({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-1', itemId: 'agent-typed-pr',
        delta: 'Done.\n::git-create-pr{cwd="/tmp/repo" branch="feature/one" url="https://example.com/pull/1" isDr',
      },
    })
    expect(state.messages.value.at(-1)).toMatchObject({ text: 'Done.' })
    expect(state.messages.value.at(-1)?.directives).toBeUndefined()

    emit({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', itemId: 'agent-typed-pr', delta: 'aft=false}' },
    })
    expect(state.messages.value.at(-1)).toMatchObject({
      text: 'Done.',
      directives: [{ kind: 'git-create-pr', url: 'https://example.com/pull/1', isDraft: false }],
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
  it('renders the first thread page before ancillary thread-list metadata settles', async () => {
    installTestWindow()
    const titleCache = deferred<{ titles: Record<string, string> }>()
    const rootsState = deferred<WorkspaceRootsState>()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('thread-1', '/tmp/project')] }],
      nextCursor: null,
    })
    gatewayMocks.getThreadTitleCache.mockReturnValue(titleCache.promise)
    gatewayMocks.getWorkspaceRootsState.mockReturnValue(rootsState.promise)

    const state = useDesktopState()
    const refresh = state.refreshAll({ includeSelectedThreadMessages: false })
    await flushMicrotasks()

    expect(state.projectGroups.value[0]?.threads.map((row) => row.id)).toEqual(['thread-1'])
    expect(state.isLoadingThreads.value).toBe(false)

    titleCache.resolve({ titles: { 'thread-1': 'Imported title' } })
    rootsState.resolve({
      order: ['/tmp/project'],
      labels: {},
      active: ['/tmp/project'],
      projectOrder: ['Project'],
      remoteProjects: [],
    })
    await refresh
  })

  it('starts loading a URL-selected thread without waiting for the thread list', async () => {
    installTestWindow()
    const threadPage = {
      groups: [{ projectName: 'Project', threads: [thread('thread-1', '/tmp/project')] }],
      nextCursor: null,
    }
    const pendingThreadList = deferred<typeof threadPage>()
    const pendingThreadDetail = deferred<ReturnType<typeof idleDetail>>()
    gatewayMocks.getThreadGroupsPage.mockReturnValue(pendingThreadList.promise)
    gatewayMocks.getThreadDetail.mockReturnValue(pendingThreadDetail.promise)

    const state = useDesktopState()
    state.primeSelectedThread('thread-1')
    const refresh = state.refreshAll()
    await flushMicrotasks()

    expect(gatewayMocks.getThreadGroupsPage).toHaveBeenCalledTimes(1)
    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledWith('thread-1')

    pendingThreadList.resolve(threadPage)
    pendingThreadDetail.resolve(idleDetail())
    await refresh
  })

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
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })
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

  it('does not automatically load older history pages after startup', async () => {
    vi.useFakeTimers()
    installFakeTimerWindow()
    gatewayMocks.getThreadGroupsPage
      .mockResolvedValueOnce({
        groups: [{ projectName: 'Project', threads: [thread('thread-1', '/tmp/project')] }],
        nextCursor: 'older-page',
      })

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false })

    expect(state.projectGroups.value[0]?.threads.map((row) => row.id)).toEqual(['thread-1'])
    expect(state.isThreadListFullyLoaded.value).toBe(false)
    expect(gatewayMocks.getThreadGroupsPage).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(10_000)
    await flushMicrotasks()

    expect(state.projectGroups.value[0]?.threads.map((row) => row.id)).toEqual(['thread-1'])
    expect(gatewayMocks.getThreadGroupsPage).toHaveBeenCalledTimes(1)
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
    gatewayMocks.getThreadDetail.mockResolvedValue(idleDetail)
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

  it('keeps interrupted completion metadata without adding a visible summary', async () => {
    const { state, emit } = await setupTurnLifecycleNotificationState('thread-1')

    emit({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-a' } } })
    emit({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        durationMs: 3_000,
        turn: { id: 'turn-a', status: 'interrupted' },
      },
    })
    expect(JSON.parse(window.localStorage.getItem('codex-web-local.turn-completion-summaries.v1') ?? '{}'))
      .toMatchObject({
        'thread-1': {
          'turn-a': {
            turnId: 'turn-a',
            durationMs: 3_000,
            status: 'interrupted',
          },
        },
      })
    expect(state.messages.value.filter((message) => message.id.startsWith('turn-summary:')))
      .not.toEqual(expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('You stopped') }),
      ]))

    emit({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-b' } } })

    expect(state.messages.value.filter((message) => message.id.startsWith('turn-summary:')))
      .not.toEqual(expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('You stopped') }),
      ]))
  })

  it('restores completed summaries but not interrupted summaries on detail reload', async () => {
    installTestWindow()
    gatewayMocks.getThreadDetail.mockResolvedValue({
      ...idleDetail(),
      messages: [
        { id: 'user-a', role: 'user', text: 'first', turnId: 'turn-a', turnIndex: 0 },
        { id: 'assistant-a', role: 'assistant', text: 'done', turnId: 'turn-a', turnIndex: 0 },
        { id: 'user-b', role: 'user', text: 'second', turnId: 'turn-b', turnIndex: 1 },
      ],
      completionSummaries: [
        { turnId: 'turn-a', status: 'completed', durationMs: 12_000 },
        { turnId: 'turn-b', status: 'interrupted', durationMs: 3_000 },
      ],
    })

    const state = useDesktopState()
    state.primeSelectedThread('thread-1')
    await state.loadMessages('thread-1')

    expect(state.messages.value.map((message) => message.text)).toEqual([
      'first',
      'Worked for 12s',
      'done',
      'second',
    ])
    expect(state.messages.value.filter((message) => message.id.startsWith('turn-summary:')))
      .not.toEqual(expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('You stopped') }),
      ]))
  })

  it('keeps an observed completion duration across a browser state reload', async () => {
    const { state, emit } = await setupTurnLifecycleNotificationState('thread-1')

    emit({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-a' } } })
    emit({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        durationMs: 3_000,
        turn: { id: 'turn-a', status: 'completed' },
      },
    })
    state.stopPolling()

    gatewayMocks.getThreadDetail.mockResolvedValue({
      ...idleDetail(),
      messages: [
        { id: 'user-a', role: 'user', text: 'first', turnId: 'turn-a', turnIndex: 0 },
        { id: 'assistant-a', role: 'assistant', text: 'done', turnId: 'turn-a', turnIndex: 0 },
      ],
      completionSummaries: [
        { turnId: 'turn-a', status: 'completed', durationMs: null },
      ],
    })

    const restoredState = useDesktopState()
    restoredState.primeSelectedThread('thread-1')
    await restoredState.loadMessages('thread-1')

    expect(restoredState.messages.value.map((message) => message.text)).toEqual([
      'first',
      'Worked for 3s',
      'done',
    ])
  })

  it('does not invent a sub-second duration when persisted history has no timing metadata', async () => {
    installTestWindow()
    gatewayMocks.getThreadDetail.mockResolvedValue({
      ...idleDetail(),
      messages: [
        { id: 'user-a', role: 'user', text: 'first', turnId: 'turn-a', turnIndex: 0 },
        { id: 'assistant-a', role: 'assistant', text: 'done', turnId: 'turn-a', turnIndex: 0 },
      ],
      completionSummaries: [
        { turnId: 'turn-a', status: 'completed', durationMs: null },
      ],
    })

    const state = useDesktopState()
    state.primeSelectedThread('thread-1')
    await state.loadMessages('thread-1')

    expect(state.messages.value.map((message) => message.text)).toEqual([
      'first',
      'Worked',
      'done',
    ])
  })

  it('retains an event-established turn across a lagging idle detail', async () => {
    const { state, emit } = await setupTurnLifecycleNotificationState('thread-1')
    gatewayMocks.getThreadDetail.mockResolvedValue({
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
    gatewayMocks.getThreadDetail.mockResolvedValueOnce(localDetail())
    await state.loadMessages('thread-1')
    expect(state.selectedThreadRuntimeOwnership.value).toBe('local')
    expect(state.selectedThread.value?.inProgress).toBe(true)
    gatewayMocks.getThreadDetail.mockClear()

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
    gatewayMocks.getThreadDetail.mockResolvedValueOnce(localDetail())
    gatewayMocks.getThreadDetail.mockResolvedValue(localDetail('turn-local-fallback'))
    gatewayMocks.interruptThreadTurn.mockResolvedValue(undefined)
    await state.loadMessages('thread-1')
    gatewayMocks.getThreadDetail.mockClear()

    await state.interruptSelectedThreadTurn()

    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(1)
    expect(gatewayMocks.interruptThreadTurn).toHaveBeenCalledWith('thread-1', 'turn-local-fallback')
  })

  it('does not overwrite a local lease established while fallback detail is pending', async () => {
    const { state, emit } = await setupTurnLifecycleNotificationState('thread-1')
    const pendingDetail = deferred<ReturnType<typeof localDetail>>()
    gatewayMocks.getThreadDetail.mockResolvedValueOnce(localDetail())
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
    gatewayMocks.getThreadDetail.mockResolvedValue(localDetail('turn-b'))
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

  it('clears a stale local running lease when mismatched completion is confirmed idle', async () => {
    const { state, emit } = await setupTurnLifecycleNotificationState('thread-1')
    emit({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-old' } } })
    emit({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-cached' } } })
    gatewayMocks.getThreadDetail.mockResolvedValue(idleDetail())

    emit({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-old', status: 'completed' } },
    })
    await flushMicrotasks()

    expect(state.selectedThread.value?.inProgress).toBe(false)
    expect(state.selectedThreadRuntimeOwnership.value).toBe('idle')
    expect(state.selectedActiveTurnId.value).toBe('')
  })

  it('adopts the authoritative newer local turn after mismatched completion', async () => {
    const { state, emit } = await setupTurnLifecycleNotificationState('thread-1')
    gatewayMocks.interruptThreadTurn.mockResolvedValue(undefined)
    emit({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-old' } } })
    emit({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-cached' } } })
    gatewayMocks.getThreadDetail.mockResolvedValue(localDetail('turn-newer'))

    emit({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-old', status: 'completed' } },
    })
    await flushMicrotasks()

    expect(state.selectedThread.value?.inProgress).toBe(true)
    expect(state.selectedThreadRuntimeOwnership.value).toBe('local')
    expect(state.selectedActiveTurnId.value).toBe('turn-newer')
    await state.interruptSelectedThreadTurn()
    expect(gatewayMocks.interruptThreadTurn).toHaveBeenCalledWith('thread-1', 'turn-newer')
  })

  it('preserves the current turn error through stale completion message sync', async () => {
    const { state, emit } = await setupTurnLifecycleNotificationState('thread-1')
    gatewayMocks.getThreadDetail.mockResolvedValue(localDetail('turn-b'))
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
    gatewayMocks.getThreadDetail.mockResolvedValue({
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
    gatewayMocks.getThreadDetail.mockResolvedValue({
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

    const managedImageUrl = '/codex-local-image?path=%2Ftmp%2Fcodex-web-uploads%2Fupload%2Fphoto.png&uploadHandle=upload-handle'
    await state.sendMessageToSelectedThread('retry this request', [managedImageUrl])
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
    expect(gatewayMocks.cleanupManagedUploads).not.toHaveBeenCalled()

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
      [managedImageUrl],
      'gpt-5.4-mini',
      'medium',
      undefined,
      [],
      'default',
    )
    const stop = state.interruptSelectedThreadTurn()
    expect(gatewayMocks.interruptThreadTurn).not.toHaveBeenCalled()
    resolveFallbackStart?.('turn-fallback')
    await fallbackStartSettled
    await Promise.all([stop, flushMicrotasks()])
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
    await vi.waitFor(() => {
      expect(gatewayMocks.cleanupManagedUploads).toHaveBeenCalledWith([managedImageUrl], [])
    })
    expect(gatewayMocks.cleanupManagedUploads).toHaveBeenCalledTimes(1)
    await state.interruptSelectedThreadTurn()
    expect(gatewayMocks.interruptThreadTurn).toHaveBeenCalledTimes(1)
    expect(gatewayMocks.startThreadTurn).toHaveBeenCalledTimes(2)
  })

  it('releases managed attachments after the fallback handoff finally fails', async () => {
    const { state, emit } = await setupTurnLifecycleNotificationState('thread-1')
    const managedImageUrl = '/codex-local-image?path=%2Ftmp%2Fcodex-web-uploads%2Fupload%2Fphoto.png&uploadHandle=upload-final-fail'
    gatewayMocks.getThreadDetail.mockResolvedValue({
      ...idleDetail(),
      model: 'gpt-5.5',
      modelProvider: 'openai',
    })
    gatewayMocks.rollbackThread.mockResolvedValue([])
    gatewayMocks.startThreadTurn
      .mockResolvedValueOnce('turn-primary')
      .mockRejectedValueOnce(new Error('fallback handoff failed'))

    await state.sendMessageToSelectedThread('retry then fail', [managedImageUrl])
    emit({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-primary' } } })
    emit({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-primary', status: 'failed', error: { message: 'model is not supported' } },
      },
    })

    await vi.waitFor(() => {
      expect(gatewayMocks.startThreadTurn).toHaveBeenCalledTimes(2)
      expect(gatewayMocks.cleanupManagedUploads).toHaveBeenCalledWith([managedImageUrl], [])
    })
  })

  it('keeps the submitted user row visible while an unsupported-model fallback is starting', async () => {
    const { state, emit } = await setupTurnLifecycleNotificationState('thread-1')
    const fallbackTurn = deferred<string>()
    gatewayMocks.rollbackThread.mockResolvedValue([])
    gatewayMocks.startThreadTurn
      .mockResolvedValueOnce('turn-primary')
      .mockReturnValueOnce(fallbackTurn.promise)

    await state.sendMessageToSelectedThread('keep me visible')
    gatewayMocks.getThreadDetail.mockResolvedValue({
      ...localDetail('turn-primary'),
      model: 'gpt-5.5',
      modelProvider: 'openai',
      messages: [{
        id: 'persisted-primary-user',
        role: 'user',
        text: 'keep me visible',
        messageType: 'userMessage',
        turnId: 'turn-primary',
      }],
    })
    await state.loadMessages('thread-1', { force: true })
    expect(state.messages.value.filter((message) => message.text === 'keep me visible'))
      .toHaveLength(1)

    emit({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-primary' } } })
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
    await vi.waitFor(() => {
      expect(gatewayMocks.startThreadTurn).toHaveBeenCalledTimes(2)
    })

    expect(state.messages.value.some((message) => (
      message.text === 'keep me visible'
      && message.messageType === 'userMessage.optimistic'
    ))).toBe(true)
  })

  it('queues managed attachments without starting another turn immediately', async () => {
    const { state, emit } = await setupTurnLifecycleNotificationState('thread-1')
    gatewayMocks.startThreadTurn.mockResolvedValue('turn-steer')
    emit({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-active' } } })
    const persistenceCalls = gatewayMocks.setThreadQueueState.mock.calls.length
    const managedImageUrl = '/codex-local-image?path=%2Ftmp%2Fcodex-web-uploads%2Fupload%2Fphoto.png&uploadHandle=queue-handle'

    await state.sendMessageToSelectedThread('send later', [managedImageUrl], [], 'queue')

    expect(gatewayMocks.startThreadTurn).not.toHaveBeenCalled()
    expect(gatewayMocks.setThreadQueueState).toHaveBeenCalledTimes(persistenceCalls + 1)
    expect(gatewayMocks.setThreadQueueState).toHaveBeenLastCalledWith({
      'thread-1': [expect.objectContaining({
        text: 'send later',
        imageUrls: [managedImageUrl],
      })],
    })
    expect(state.selectedThreadQueuedMessages.value).toEqual([
      expect.objectContaining({ text: 'send later', imageUrls: [managedImageUrl] }),
    ])

    const queuedId = state.selectedThreadQueuedMessages.value[0]!.id
    state.steerQueuedMessage(queuedId)
    await flushMicrotasks()
    expect(gatewayMocks.setThreadQueueState).toHaveBeenLastCalledWith(
      {},
      { transferManagedMessageIds: [queuedId] },
    )
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

    gatewayMocks.getThreadDetail.mockResolvedValue({
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

describe('subagent item notification synchronization', () => {
  it('authoritatively reloads the selected parent thread after a child lifecycle item', async () => {
    vi.useFakeTimers()
    installFakeTimerWindow()
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
    gatewayMocks.getThreadDetail.mockResolvedValue(idleDetail())

    const state = useDesktopState()
    state.primeSelectedThread('thread-1')
    await state.refreshAll({ includeSelectedThreadMessages: false })
    state.startPolling()
    pollingCleanups.push(() => state.stopPolling())

    notificationHandler?.({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        item: {
          id: 'child-state',
          type: 'collabAgentToolCall',
          tool: 'wait',
          status: 'completed',
        },
      },
    })
    const eventSyncCallback = vi.mocked(window.setTimeout).mock.calls
      .filter(([, delay]) => delay === 220)
      .pop()?.[0]
    expect(eventSyncCallback).toBeTypeOf('function')
    eventSyncCallback?.()
    await flushMicrotasks()

    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledWith('thread-1')
    expect(gatewayMocks.resumeThread).not.toHaveBeenCalled()
  })
})

describe('external runtime ownership', () => {
  it('preserves running state from thread list rows before background polling', async () => {
    installTestWindow({
      'codex-web-local.thread-unread-cutoff.v1': '2026-01-01T00:00:00.000Z',
    })
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [
        {
          ...thread('thread-running', '/tmp/project'),
          updatedAtIso: '2026-07-14T00:00:00.000Z',
          inProgress: true,
        },
        thread('thread-selected', '/tmp/project'),
      ] }],
      nextCursor: null,
    })

    const state = useDesktopState()
    state.primeSelectedThread('thread-selected')
    await state.refreshAll({ includeSelectedThreadMessages: false })

    expect(state.projectGroups.value[0]?.threads[0]).toMatchObject({
      id: 'thread-running',
      inProgress: true,
      unread: false,
    })
  })

  it('defers background runtime polling while selected thread detail is loading', async () => {
    vi.useFakeTimers()
    installFakeTimerWindow()
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
    const pendingDetail = deferred<ReturnType<typeof idleDetail>>()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('thread-selected', '/tmp/project')] }],
      nextCursor: null,
    })
    gatewayMocks.getThreadDetail.mockReturnValue(pendingDetail.promise)
    gatewayMocks.getThreadRuntimeStates.mockResolvedValue({})

    const state = useDesktopState()
    state.primeSelectedThread('thread-selected')
    await state.refreshAll({ includeSelectedThreadMessages: false })
    expect(state.projectGroups.value[0]?.threads.map((row) => row.id)).toEqual(['thread-selected'])
    const load = state.loadMessages('thread-selected')
    await flushMicrotasks()
    state.startPolling()
    pollingCleanups.push(() => state.stopPolling())

    await vi.advanceTimersByTimeAsync(0)
    expect(gatewayMocks.getThreadRuntimeStates).not.toHaveBeenCalled()

    pendingDetail.resolve(idleDetail())
    await load
    await vi.runOnlyPendingTimersAsync()
    await vi.runOnlyPendingTimersAsync()

    expect(gatewayMocks.getThreadRuntimeStates).toHaveBeenCalledWith(
      ['thread-selected'],
      expect.any(AbortSignal),
    )
  })

  it('continues background runtime polling for sidebar tasks while selected detail is loading', async () => {
    const state = await setupBackgroundRuntimeState()
    const pendingDetail = deferred<ReturnType<typeof idleDetail>>()
    gatewayMocks.getThreadDetail.mockReturnValue(pendingDetail.promise)
    gatewayMocks.getThreadRuntimeStates.mockResolvedValue({
      'thread-running': {
        state: 'running',
        turnId: 'turn-external',
        interruptible: false,
        source: 'external-session-writer',
      },
    })

    const load = state.loadMessages('thread-selected')
    await flushMicrotasks()
    state.startPolling()
    pollingCleanups.push(() => state.stopPolling())
    await vi.advanceTimersByTimeAsync(0)
    await flushMicrotasks()

    expect(gatewayMocks.getThreadRuntimeStates).toHaveBeenCalledWith(
      ['thread-running'],
      expect.any(AbortSignal),
    )
    expect(state.projectGroups.value[0]?.threads[0]).toMatchObject({
      inProgress: true,
      unread: false,
    })

    pendingDetail.resolve(idleDetail())
    await load
  })

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

  it('passes the last live projection key and preserves messages on not-modified polls', async () => {
    const state = await setupBackgroundRuntimeState()
    gatewayMocks.getThreadRuntimeStates.mockResolvedValue({
      'thread-selected': {
        state: 'running',
        turnId: 'turn-external',
        interruptible: false,
        source: 'external-session-writer',
      },
    })
    gatewayMocks.getExternalThreadLiveSnapshot
      .mockResolvedValueOnce({
        ...externalDetail('turn-external'),
        isLiveProjection: true,
        projectionKey: 'projection-1',
        messages: [{
          id: 'agent-external',
          role: 'assistant',
          text: 'desktop output',
          messageType: 'agentMessage',
          turnId: 'turn-external',
        }],
      })
      .mockResolvedValueOnce({
        ...externalDetail('turn-external'),
        isLiveProjection: true,
        notModified: true,
        projectionKey: 'projection-1',
        messages: [],
      })

    state.startPolling()
    pollingCleanups.push(() => state.stopPolling())
    await vi.advanceTimersByTimeAsync(0)
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(1)
    await flushMicrotasks()

    expect(gatewayMocks.getExternalThreadLiveSnapshot).toHaveBeenCalledTimes(1)
    expect(state.messages.value).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'agent-external', text: 'desktop output' }),
    ]))

    await vi.advanceTimersByTimeAsync(1_000)
    await flushMicrotasks()

    expect(gatewayMocks.getExternalThreadLiveSnapshot).toHaveBeenCalledTimes(2)
    expect(gatewayMocks.getExternalThreadLiveSnapshot).toHaveBeenNthCalledWith(
      2,
      'thread-selected',
      expect.any(AbortSignal),
      'projection-1',
    )
    expect(state.messages.value).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'agent-external', text: 'desktop output' }),
    ]))
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

  it('keeps a locally running selected task in unified runtime discovery', async () => {
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
      ['thread-selected', 'thread-running'],
      expect.any(AbortSignal),
    )
    expect(state.selectedThreadRuntimeOwnership.value).toBe('local')
  })

  it('excludes an externally owned selected task from the background batch', async () => {
    const state = await setupBackgroundRuntimeState()
    gatewayMocks.getThreadDetail.mockResolvedValue(externalDetail())
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

  it('keeps one selected detail read in flight and resumes one second after settlement', async () => {
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
    await vi.advanceTimersByTimeAsync(999)
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

  it('repairs a missed local start and removes the false unread dot', async () => {
    const state = await setupBackgroundRuntimeState()
    gatewayMocks.getThreadRuntimeStates.mockResolvedValue({
      'thread-running': {
        state: 'running',
        turnId: 'turn-local',
        interruptible: true,
        source: 'local-app-server',
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
    state.primeSelectedThread('thread-running')
    expect(state.selectedThreadRuntimeOwnership.value).toBe('local')
  })

  it('repairs a missed local completion in the background and refreshes unread state', async () => {
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    const state = await setupBackgroundRuntimeState()
    gatewayMocks.getThreadRuntimeStates.mockResolvedValue({
      'thread-running': { state: 'idle' },
      'thread-selected': { state: 'idle' },
    })

    state.startPolling()
    pollingCleanups.push(() => state.stopPolling())
    expect(notificationHandler).toBeDefined()
    notificationHandler!({
      method: 'turn/started',
      params: { threadId: 'thread-running', turn: { id: 'turn-local' } },
    })
    expect(state.projectGroups.value[0]?.threads[0]).toMatchObject({
      inProgress: true,
      unread: false,
    })

    await vi.advanceTimersByTimeAsync(0)
    await flushMicrotasks()

    expect(state.projectGroups.value[0]?.threads[0]).toMatchObject({
      inProgress: false,
      unread: true,
    })
    expect(gatewayMocks.getThreadGroupsPage).toHaveBeenCalledTimes(2)
  })

  it('loads the final assistant output before releasing a selected missed local completion', async () => {
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    const state = await setupBackgroundRuntimeState()
    gatewayMocks.getThreadRuntimeStates.mockResolvedValue({
      'thread-selected': { state: 'idle' },
    })
    gatewayMocks.getThreadDetail.mockResolvedValue({
      ...idleDetail(),
      messages: [{
        id: 'final-agent',
        role: 'assistant',
        text: 'final desktop output',
        messageType: 'agentMessage',
        turnId: 'turn-local',
      }],
    })

    state.startPolling()
    pollingCleanups.push(() => state.stopPolling())
    notificationHandler!({
      method: 'turn/started',
      params: { threadId: 'thread-selected', turn: { id: 'turn-local' } },
    })
    await vi.advanceTimersByTimeAsync(0)
    await flushMicrotasks()

    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledWith(
      'thread-selected',
      expect.any(AbortSignal),
    )
    expect(state.messages.value).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'final-agent', text: 'final desktop output' }),
    ]))
    expect(state.selectedThreadRuntimeOwnership.value).toBe('idle')
    expect(state.selectedThread.value).toMatchObject({ inProgress: false })
  })

  it('retains a selected local lease when terminal detail recovery fails', async () => {
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    const state = await setupBackgroundRuntimeState()
    gatewayMocks.getThreadRuntimeStates.mockResolvedValue({
      'thread-selected': { state: 'idle' },
    })
    gatewayMocks.getThreadDetail.mockRejectedValue(new Error('temporary detail failure'))

    state.startPolling()
    pollingCleanups.push(() => state.stopPolling())
    notificationHandler!({
      method: 'turn/started',
      params: { threadId: 'thread-selected', turn: { id: 'turn-local' } },
    })
    await vi.advanceTimersByTimeAsync(0)
    await flushMicrotasks()

    expect(state.selectedThreadRuntimeOwnership.value).toBe('local')
    expect(state.selectedThread.value).toMatchObject({ inProgress: true })
  })

  it('does not let stale terminal detail clear a newer local turn', async () => {
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    const state = await setupBackgroundRuntimeState()
    const pendingDetail = deferred<ReturnType<typeof idleDetail>>()
    gatewayMocks.getThreadRuntimeStates.mockResolvedValue({
      'thread-selected': { state: 'idle' },
    })
    gatewayMocks.getThreadDetail.mockReturnValue(pendingDetail.promise)

    state.startPolling()
    pollingCleanups.push(() => state.stopPolling())
    notificationHandler!({
      method: 'turn/started',
      params: { threadId: 'thread-selected', turn: { id: 'turn-old' } },
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(1)
    notificationHandler!({
      method: 'turn/started',
      params: { threadId: 'thread-selected', turn: { id: 'turn-new' } },
    })
    pendingDetail.resolve(idleDetail())
    await flushMicrotasks()

    expect(state.selectedThreadRuntimeOwnership.value).toBe('local')
    expect(state.selectedThread.value).toMatchObject({ inProgress: true })
  })

  it('retains a local lease when unified runtime observation is unknown', async () => {
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    const state = await setupBackgroundRuntimeState()
    gatewayMocks.getThreadRuntimeStates.mockResolvedValue({
      'thread-selected': { state: 'unknown' },
    })

    state.startPolling()
    pollingCleanups.push(() => state.stopPolling())
    notificationHandler!({
      method: 'turn/started',
      params: { threadId: 'thread-selected', turn: { id: 'turn-local' } },
    })
    await vi.advanceTimersByTimeAsync(0)
    await flushMicrotasks()

    expect(gatewayMocks.getThreadDetail).not.toHaveBeenCalled()
    expect(state.selectedThreadRuntimeOwnership.value).toBe('local')
    expect(state.selectedThread.value).toMatchObject({ inProgress: true })
  })

  it('rotates batches so every loaded task is probed without exceeding the limit', async () => {
    vi.useFakeTimers()
    installFakeTimerWindow()
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    const backgroundThreads = Array.from({ length: 55 }, (_value, index) => (
      thread(`thread-${index.toString().padStart(2, '0')}`, '/tmp/project')
    ))
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{
        projectName: 'Project',
        threads: [...backgroundThreads, thread('thread-selected', '/tmp/project')],
      }],
      nextCursor: null,
    })
    gatewayMocks.getThreadRuntimeStates.mockImplementation(async (threadIds: readonly string[]) => (
      Object.fromEntries(threadIds.map((threadId) => [threadId, { state: 'idle' }]))
    ))

    const state = useDesktopState()
    state.primeSelectedThread('thread-selected')
    await state.refreshAll({ includeSelectedThreadMessages: false })
    state.startPolling()
    pollingCleanups.push(() => state.stopPolling())
    await vi.advanceTimersByTimeAsync(0)
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(2_000)
    await flushMicrotasks()

    const batches = gatewayMocks.getThreadRuntimeStates.mock.calls.slice(0, 2)
      .map(([threadIds]) => threadIds as string[])
    expect(batches).toHaveLength(2)
    expect(batches.every((threadIds) => threadIds.length <= 50)).toBe(true)
    expect(batches.every((threadIds) => threadIds.includes('thread-selected'))).toBe(true)
    expect(new Set(batches.flat())).toEqual(new Set([
      'thread-selected',
      ...backgroundThreads.map((row) => row.id),
    ]))
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
    gatewayMocks.getThreadDetail.mockResolvedValue(idleDetail())

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
    gatewayMocks.getThreadDetail.mockResolvedValue(externalDetail('turn-selected-newer'))

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

  it('polls local and idle rows in group order within the 50-row limit', async () => {
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
        ...Array.from({ length: 28 }, (_, index) => `thread-${index}`),
        'thread-local',
        ...Array.from({ length: 20 }, (_, index) => `thread-${index + 28}`),
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
    gatewayMocks.getThreadDetail.mockResolvedValueOnce(externalDetail())
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
    gatewayMocks.getThreadDetail.mockClear()

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
    gatewayMocks.getThreadDetail.mockResolvedValue(externalDetail())
    gatewayMocks.getExternalThreadLiveSnapshot.mockResolvedValue(externalDetail())
    await state.loadMessages('thread-1')
    gatewayMocks.getThreadDetail.mockClear()

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

  it('restores and polls an externally owned selected thread after 1 second', async () => {
    const { state } = await setupExternalRuntimeState()
    gatewayMocks.getThreadDetail.mockResolvedValueOnce(externalDetail())
    gatewayMocks.getThreadDetail.mockResolvedValue(externalDetail())

    await state.loadMessages('thread-1')
    gatewayMocks.getThreadDetail.mockClear()

    expect(state.selectedThreadRuntimeOwnership.value).toBe('external')
    expect(state.selectedThread.value?.inProgress).toBe(true)
    expect(gatewayMocks.getThreadDetail).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(999)
    expect(gatewayMocks.getThreadDetail).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(1)
    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledWith('thread-1', expect.any(AbortSignal))
    expect(gatewayMocks.getThreadRuntimeState).not.toHaveBeenCalled()
  })

  it('refreshes external reasoning and agent output without a page reload', async () => {
    const { state } = await setupExternalRuntimeState()
    gatewayMocks.getThreadDetail.mockResolvedValueOnce(externalDetail('turn-external'))
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

    await vi.advanceTimersByTimeAsync(1_000)
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

    await vi.advanceTimersByTimeAsync(1_000)
    await flushMicrotasks()

    expect(state.messages.value.filter((message) => message.id === 'agent-live')).toEqual([
      expect.objectContaining({ text: 'New desktop output updated' }),
    ])
  })

  it('starts the next external snapshot one second after settlement', async () => {
    const { state } = await setupExternalRuntimeState()
    const pending = deferred<ReturnType<typeof externalDetail>>()
    gatewayMocks.getThreadDetail.mockResolvedValueOnce(externalDetail())
    gatewayMocks.getThreadDetail
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(externalDetail())
    await state.loadMessages('thread-1')
    gatewayMocks.getThreadDetail.mockClear()

    await vi.advanceTimersByTimeAsync(6_000)
    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(1)

    pending.resolve(externalDetail())
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(999)
    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(2)
  })

  it('aborts a stale selected-thread request so a new external thread can poll', async () => {
    const { state } = await setupExternalRuntimeState()
    const oldRequest = deferred<ReturnType<typeof idleDetail>>()
    const newRequest = deferred<ReturnType<typeof externalDetail>>()
    const signals: AbortSignal[] = []
    gatewayMocks.getThreadDetail.mockResolvedValueOnce(externalDetail())
    gatewayMocks.getThreadDetail.mockImplementation((threadId: string, signal?: AbortSignal) => {
      if (!signal) return Promise.resolve(externalDetail())
      if (signal) signals.push(signal)
      if (threadId === 'thread-1') return oldRequest.promise
      return newRequest.promise
    })
    await state.loadMessages('thread-1')
    gatewayMocks.getThreadDetail.mockClear()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(1)

    state.primeSelectedThread('thread-2')
    await state.loadMessages('thread-2')
    await vi.advanceTimersByTimeAsync(2_000)

    expect(gatewayMocks.getThreadDetail).toHaveBeenNthCalledWith(3, 'thread-2', expect.any(AbortSignal))
    expect(signals[0]?.aborted).toBe(true)
    oldRequest.resolve(idleDetail())
    await flushMicrotasks()
    expect(state.selectedThreadRuntimeOwnership.value).toBe('external')

    await vi.advanceTimersByTimeAsync(4_000)
    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(3)
    newRequest.resolve(externalDetail())
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(4)
    expect(gatewayMocks.getThreadRuntimeState).not.toHaveBeenCalled()
  })

  it('aborts an in-flight external runtime request on local takeover', async () => {
    const { state, emit } = await setupExternalRuntimeState()
    const pending = deferred<ReturnType<typeof externalDetail>>()
    let signal: AbortSignal | undefined
    gatewayMocks.getThreadDetail.mockResolvedValueOnce(externalDetail())
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
    gatewayMocks.getThreadDetail.mockResolvedValueOnce(externalDetail())
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
    gatewayMocks.getThreadDetail.mockResolvedValueOnce(externalDetail())
    gatewayMocks.getThreadDetail.mockResolvedValue({
      ...idleDetail(),
      externalRuntimeState: 'unknown',
    })
    await state.loadMessages('thread-1')
    gatewayMocks.getThreadDetail.mockClear()

    await state.loadMessages('thread-1', { silent: true, force: true })

    expect(state.selectedThreadRuntimeOwnership.value).toBe('external')
    expect(state.selectedThread.value?.inProgress).toBe(true)
  })

  it('retains the authoritative external turn id for the pinned run footer', async () => {
    const { state } = await setupExternalRuntimeState()
    gatewayMocks.getThreadDetail.mockResolvedValue(externalDetail('turn-external-footer'))

    await state.loadMessages('thread-1')

    expect(state.selectedThreadRuntimeOwnership.value).toBe('external')
    expect(state.selectedActiveTurnId.value).toBe('turn-external-footer')
  })

  it('does not let an older running detail overwrite a newer idle detail', async () => {
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
    const { state } = await setupExternalRuntimeState()
    const olderRunning = deferred<Omit<ReturnType<typeof externalDetail>, 'messages'> & { messages: UiMessage[] }>()
    gatewayMocks.getThreadDetail.mockResolvedValue(externalDetail())
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

  it('rebases a paged live projection onto the already-loaded absolute turn indices', async () => {
    const state = await setupBackgroundRuntimeState()
    gatewayMocks.getThreadDetail.mockResolvedValue({
      ...externalDetail('turn-2'),
      olderCursor: 'opaque-deep',
      hasMoreOlder: true,
      turnIndexByTurnId: {
        'turn-0': 2,
        'turn-1': 3,
        'turn-2': 4,
      },
      messages: [
        {
          id: 'older-user',
          role: 'user',
          text: 'older prompt',
          messageType: 'userMessage',
          turnId: 'turn-0',
          turnIndex: 2,
        },
        {
          id: 'older-agent',
          role: 'assistant',
          text: 'older answer',
          messageType: 'agentMessage',
          turnId: 'turn-1',
          turnIndex: 3,
        },
        {
          id: 'stale-current-agent',
          role: 'assistant',
          text: 'stale current answer',
          messageType: 'agentMessage',
          turnId: 'turn-2',
          turnIndex: 4,
        },
      ],
    })
    gatewayMocks.getExternalThreadLiveSnapshot.mockResolvedValue({
      ...externalDetail('turn-2'),
      isLiveProjection: true,
      olderCursor: 'opaque-newest',
      hasMoreOlder: true,
      turnIndexByTurnId: { 'turn-2': 0 },
      messages: [{
        id: 'fresh-current-agent',
        role: 'assistant',
        text: 'fresh current answer',
        messageType: 'agentMessage',
        turnId: 'turn-2',
        turnIndex: 0,
      }],
    })
    gatewayMocks.getOlderThreadMessages.mockResolvedValue({
      messages: [],
      completionSummaries: [],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      nextCursor: null,
      turnIds: [],
      startTurnIndex: 0,
      turnIndexByTurnId: {},
    })

    await state.loadMessages('thread-selected')
    state.startPolling()
    pollingCleanups.push(() => state.stopPolling())
    await vi.advanceTimersByTimeAsync(1_000)
    await flushMicrotasks()

    expect(state.messages.value.map((message) => message.id)).toEqual([
      'older-user',
      'older-agent',
      'fresh-current-agent',
    ])
    expect(state.messages.value.map((message) => message.turnIndex)).toEqual([2, 3, 4])
    await state.loadOlderMessages('thread-selected')
    expect(gatewayMocks.getOlderThreadMessages).toHaveBeenCalledWith(
      'thread-selected',
      'opaque-deep',
    )
  })

  it('pauses selected live projection polling while hidden and resumes immediately when visible', async () => {
    const state = await setupBackgroundRuntimeState()
    Object.assign(document, { visibilityState: 'hidden' })
    gatewayMocks.getThreadDetail.mockResolvedValue(externalDetail('turn-external'))
    gatewayMocks.getExternalThreadLiveSnapshot.mockResolvedValue(externalDetail('turn-external'))

    await state.loadMessages('thread-selected')
    state.startPolling()
    pollingCleanups.push(() => state.stopPolling())
    await vi.advanceTimersByTimeAsync(10_000)
    expect(gatewayMocks.getExternalThreadLiveSnapshot).not.toHaveBeenCalled()

    const visibilityHandler = vi.mocked(document.addEventListener).mock.calls.find(
      ([eventName]) => eventName === 'visibilitychange',
    )?.[1] as EventListener
    expect(visibilityHandler).toBeDefined()
    Object.assign(document, { visibilityState: 'visible' })
    visibilityHandler(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    await flushMicrotasks()

    expect(gatewayMocks.getExternalThreadLiveSnapshot).toHaveBeenCalledTimes(1)
  })

  it('does not establish external ownership from inconclusive detail while idle', async () => {
    const { state } = await setupExternalRuntimeState()
    gatewayMocks.getThreadDetail.mockResolvedValue({
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
    gatewayMocks.getThreadDetail.mockResolvedValueOnce(externalDetail())
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
    gatewayMocks.getThreadDetail.mockClear()

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
    gatewayMocks.getThreadDetail.mockResolvedValueOnce(externalDetail())
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

  it.each([
    ['external', externalDetail('turn-desktop')],
    ['unknown', { ...idleDetail(), externalRuntimeState: 'unknown' as const }],
  ])('does not dispatch turn/start when resume returns %s ownership', async (_label, resumed) => {
    const { state } = await setupExternalRuntimeState()
    gatewayMocks.resumeThread.mockResolvedValue(resumed)
    gatewayMocks.startThreadTurn.mockResolvedValue('turn-must-not-start')

    await expect(state.sendMessageToSelectedThread('do not race desktop')).rejects.toThrow(
      'task writer ownership is not idle',
    )

    expect(gatewayMocks.resumeThread).toHaveBeenCalledWith('thread-1')
    expect(gatewayMocks.startThreadTurn).not.toHaveBeenCalled()
    expect(state.selectedThreadRuntimeOwnership.value).toBe('external')
  })

  it('does not let a delayed terminal detail clear a newer local lease', async () => {
    const { state, emit } = await setupExternalRuntimeState()
    const terminalDetail = deferred<ReturnType<typeof idleDetail>>()
    let signal: AbortSignal | undefined
    gatewayMocks.getThreadDetail.mockResolvedValueOnce(externalDetail())
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
    gatewayMocks.getThreadDetail.mockResolvedValueOnce(externalDetail())
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
    gatewayMocks.getThreadDetail.mockClear()

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
    gatewayMocks.getThreadDetail.mockResolvedValueOnce(externalDetail())
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
    gatewayMocks.getThreadDetail.mockClear()

    await vi.advanceTimersByTimeAsync(1_000)
    await flushMicrotasks()
    expect(state.selectedLiveOverlay.value?.activityLabel).toBe('Retaining detailed work')

    await vi.advanceTimersByTimeAsync(1_000)
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
    gatewayMocks.getThreadDetail.mockResolvedValueOnce(externalDetail())
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
    gatewayMocks.getThreadDetail.mockResolvedValue(externalDetail())
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
    gatewayMocks.getThreadDetail.mockResolvedValue(externalDetail())
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
    gatewayMocks.getThreadDetail.mockResolvedValueOnce(externalDetail())
    gatewayMocks.getThreadDetail.mockReturnValueOnce(selectionPending.promise)
    await state.loadMessages('thread-1')
    gatewayMocks.getThreadDetail.mockClear()
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
    gatewayMocks.getThreadDetail.mockResolvedValue(externalDetail())
    await state.loadMessages('thread-1')
    gatewayMocks.getThreadDetail.mockClear()

    state.stopPolling()
    await vi.advanceTimersByTimeAsync(4_000)
    expect(gatewayMocks.getThreadDetail).not.toHaveBeenCalled()

    state.startPolling()
    await vi.advanceTimersByTimeAsync(1_000)
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
    gatewayMocks.getThreadDetail.mockResolvedValue({
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
    gatewayMocks.getThreadDetail.mockClear()
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
    gatewayMocks.getThreadDetail.mockResolvedValue({
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

  it('issues only one RPC when the same pending request is resolved twice concurrently', async () => {
    const { state, emit } = await setupExternalRuntimeState()
    const reply = deferred<void>()
    gatewayMocks.replyToServerRequest.mockReturnValue(reply.promise)
    emit({
      method: 'server/request',
      params: {
        id: 102,
        method: 'item/tool/requestUserInput',
        params: { threadId: 'thread-2', questions: [] },
      },
    })

    const first = state.respondToPendingServerRequest({ id: 102, result: {} })
    const second = state.respondToPendingServerRequest({ id: 102, result: {} })
    await flushMicrotasks()

    expect(gatewayMocks.replyToServerRequest).toHaveBeenCalledTimes(1)
    expect(await second).toBe(false)

    reply.resolve()
    expect(await first).toBe(true)
  })

  it('waits for an edited-message rollback before starting the replacement turn', async () => {
    const { state } = await setupExternalRuntimeState()
    gatewayMocks.getThreadDetail.mockResolvedValue({
      ...idleDetail(),
      messages: [{
        id: 'interrupted-user-message',
        role: 'user',
        text: 'original prompt',
        turnId: 'turn-interrupted',
        turnIndex: 0,
      }],
    })
    const reverted = deferred<{ success: boolean }>()
    gatewayMocks.revertThreadFileChanges.mockReturnValue(reverted.promise)
    gatewayMocks.rollbackThread.mockResolvedValue([])
    gatewayMocks.startThreadTurn.mockResolvedValue('turn-replacement')
    await state.loadMessages('thread-1')

    const rollback = state.rollbackSelectedThread('turn-interrupted')
    await flushMicrotasks()
    const resend = state.sendMessageToSelectedThread('edited prompt')
    await flushMicrotasks()

    expect(gatewayMocks.startThreadTurn).not.toHaveBeenCalled()

    reverted.resolve({ success: true })
    await rollback
    await resend

    expect(gatewayMocks.rollbackThread).toHaveBeenCalledWith('thread-1', 1)
    expect(gatewayMocks.startThreadTurn).toHaveBeenCalledWith(
      'thread-1',
      'edited prompt',
      [],
      undefined,
      'medium',
      undefined,
      [],
      'default',
    )
    expect(gatewayMocks.rollbackThread.mock.invocationCallOrder[0]).toBeLessThan(
      gatewayMocks.startThreadTurn.mock.invocationCallOrder[0]!,
    )
  })

  it('releases a managed image once when selection changes during a pending rollback', async () => {
    const { state } = await setupExternalRuntimeState()
    gatewayMocks.getThreadDetail.mockResolvedValue({
      ...idleDetail(),
      messages: [{
        id: 'switch-user-message',
        role: 'user',
        text: 'original prompt',
        turnId: 'turn-switch',
        turnIndex: 0,
      }],
    })
    const reverted = deferred<{ success: boolean }>()
    gatewayMocks.revertThreadFileChanges.mockReturnValue(reverted.promise)
    gatewayMocks.rollbackThread.mockResolvedValue([])
    await state.loadMessages('thread-1')
    const managedImageUrl = '/codex-local-image?path=%2Ftmp%2Fcodex-web-uploads%2Fupload%2Fphoto.png&uploadHandle=rollback-switch'

    const rollback = state.rollbackSelectedThread('turn-switch')
    await flushMicrotasks()
    const send = state.sendMessageToSelectedThread('edited prompt', [managedImageUrl])
    await flushMicrotasks()
    state.primeSelectedThread('thread-2')

    reverted.resolve({ success: true })
    await rollback
    await send

    expect(gatewayMocks.startThreadTurn).not.toHaveBeenCalled()
    expect(gatewayMocks.cleanupManagedUploads).toHaveBeenCalledTimes(1)
    expect(gatewayMocks.cleanupManagedUploads).toHaveBeenCalledWith([managedImageUrl], [])
  })

  it('releases a managed image once when external ownership takes over during a pending rollback', async () => {
    const { state } = await setupExternalRuntimeState()
    gatewayMocks.getThreadDetail.mockResolvedValue({
      ...idleDetail(),
      messages: [{
        id: 'external-user-message',
        role: 'user',
        text: 'original prompt',
        turnId: 'turn-external-takeover',
        turnIndex: 0,
      }],
    })
    const reverted = deferred<{ success: boolean }>()
    gatewayMocks.revertThreadFileChanges.mockReturnValue(reverted.promise)
    gatewayMocks.rollbackThread.mockResolvedValue([])
    await state.loadMessages('thread-1')
    const managedImageUrl = '/codex-local-image?path=%2Ftmp%2Fcodex-web-uploads%2Fupload%2Fphoto.png&uploadHandle=rollback-external'

    const rollback = state.rollbackSelectedThread('turn-external-takeover')
    await flushMicrotasks()
    const send = state.sendMessageToSelectedThread('edited prompt', [managedImageUrl])
    await flushMicrotasks()
    gatewayMocks.getThreadDetail.mockResolvedValue(externalDetail('turn-external'))
    await state.loadMessages('thread-1', { force: true })

    reverted.resolve({ success: true })
    await rollback
    await send

    expect(state.selectedThreadRuntimeOwnership.value).toBe('external')
    expect(gatewayMocks.startThreadTurn).not.toHaveBeenCalled()
    expect(gatewayMocks.cleanupManagedUploads).toHaveBeenCalledTimes(1)
    expect(gatewayMocks.cleanupManagedUploads).toHaveBeenCalledWith([managedImageUrl], [])
  })

  it('rejects a pending request owned by an external thread after selection changes', async () => {
    const { state, emit } = await setupExternalRuntimeState()
    gatewayMocks.getThreadDetail.mockResolvedValue(externalDetail())
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
    gatewayMocks.getThreadDetail.mockResolvedValue(externalDetail())
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

  it('excludes dynamic tool calls from pending approvals without replying to external requests', async () => {
    const { state, emit } = await setupExternalRuntimeState()
    gatewayMocks.replyToServerRequest.mockResolvedValue(undefined)

    emit({
      method: 'server/request',
      params: {
        id: 204,
        method: 'item/tool/call',
        params: {
          threadId: 'thread-1',
          toolName: 'codex_app/list_threads',
          arguments: [],
        },
      },
    })

    expect(state.selectedThreadServerRequests.value).toEqual([])
    expect(await state.respondToPendingServerRequest({ id: 204, result: {} })).toBe(false)
    expect(gatewayMocks.replyToServerRequest).not.toHaveBeenCalled()
  })

  it('allows an explicitly global pending request while an external thread is selected', async () => {
    const { state, emit } = await setupExternalRuntimeState()
    gatewayMocks.getThreadDetail.mockResolvedValue(externalDetail())
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
    gatewayMocks.getThreadDetail.mockResolvedValue({
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
    gatewayMocks.getThreadDetail.mockResolvedValue(externalDetail())
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

  it('rejects reasoning efforts that are not supported by the selected model', async () => {
    const { state } = await setupExternalRuntimeState()
    state.primeSelectedThread('', { persist: false })
    state.setSelectedModelIdForThread('', 'gpt-5.5')
    state.setSelectedReasoningEffort('high')

    state.setSelectedReasoningEffort('max')

    expect(state.selectedReasoningEffort.value).toBe('high')
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
    gatewayMocks.getThreadDetail.mockResolvedValue({
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

  it('persists the selected thread model and effort with queued messages', async () => {
    const { state, emit } = await setupExternalRuntimeState()
    emit({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-local' } } })
    state.setSelectedModelIdForThread('thread-1', 'gpt-5.6-sol')
    state.setSelectedReasoningEffort('max')

    await state.sendMessageToSelectedThread('queued with selected settings', [], [], 'queue')

    expect(gatewayMocks.setThreadQueueState).toHaveBeenLastCalledWith({
      'thread-1': [expect.objectContaining({
        text: 'queued with selected settings',
        model: 'gpt-5.6-sol',
        effort: 'max',
      })],
    })
  })
})

describe('external live reasoning overlay', () => {
  it('shows the latest visible external reasoning summary without duplicating its message', async () => {
    installTestWindow()
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.getThreadDetail.mockResolvedValue({
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
    gatewayMocks.getThreadDetail.mockResolvedValue(externalDetail('turn-external'))

    const state = useDesktopState()
    state.primeSelectedThread('thread-external')
    await state.loadMessages('thread-external')

    expect(state.selectedLiveOverlay.value?.activityLabel).toBe('Thinking')
  })

  it('keeps prior active-turn reasoning hidden across consecutive bounded snapshots', async () => {
    installTestWindow()
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.getThreadDetail.mockResolvedValueOnce({
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
    gatewayMocks.getThreadDetail.mockResolvedValueOnce({
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
    gatewayMocks.getThreadDetail.mockResolvedValueOnce({
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
    gatewayMocks.getThreadDetail.mockResolvedValueOnce({
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
    gatewayMocks.getThreadDetail.mockReturnValue(pendingDetail.promise)
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

    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(2)
  })
})

describe('live error overlay', () => {
  it('shows the default thinking overlay while a selected thread is in progress without activity events', async () => {
    installTestWindow()
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.getThreadDetail.mockResolvedValue(null)
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
    gatewayMocks.getThreadDetail.mockResolvedValue(null)
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
    gatewayMocks.getThreadDetail.mockResolvedValue(null)
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
  it('defaults fresh Codex new chats to gpt-5.6-sol max fast when available', async () => {
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
    gatewayMocks.getAvailableModelIds.mockResolvedValue([
      'gpt-5.5',
      'gpt-5.6-sol',
      'gpt-5.4-mini',
    ])

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })

    expect(state.selectedModelId.value).toBe('gpt-5.6-sol')
    expect(state.readModelIdForThread('').trim()).toBe('gpt-5.6-sol')
    expect(state.selectedReasoningEffort.value).toBe('max')
    expect(state.selectedSpeedMode.value).toBe('fast')
    expect(gatewayMocks.setCodexSpeedMode).toHaveBeenCalledWith('fast')
    expect(JSON.parse(window.localStorage.getItem('codex-web-local.selected-model-by-context.v1') ?? '{}')).toEqual({
      '__new-thread-provider__::codex': 'gpt-5.6-sol',
    })
  })

  it('defaults existing Codex mobile task contexts to fast mode', async () => {
    installTestWindow({}, { isMobile: true })
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

    const state = useDesktopState()
    state.primeSelectedThread('thread-1')
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })

    expect(state.selectedSpeedMode.value).toBe('fast')
    expect(gatewayMocks.setCodexSpeedMode).toHaveBeenCalledWith('fast')
  })

  it('uses selected external thread model and effort instead of mobile defaults', async () => {
    installTestWindow({}, { isMobile: true })
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('external-thread', '/tmp/project')] }],
      nextCursor: null,
    })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.6-sol',
      providerId: '',
      reasoningEffort: 'medium',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModelIds.mockResolvedValue(['gpt-5.5', 'gpt-5.6-sol'])
    gatewayMocks.getThreadDetail.mockResolvedValue({
      ...externalDetail('turn-external'),
      model: 'gpt-5.5',
      modelProvider: 'openai',
      reasoningEffort: 'xhigh',
    })

    const state = useDesktopState()
    state.primeSelectedThread('external-thread')
    await state.refreshAll({ includeSelectedThreadMessages: true, awaitAncillaryRefreshes: true })

    expect(state.selectedModelId.value).toBe('gpt-5.5')
    expect(state.readModelIdForThread('external-thread')).toBe('gpt-5.5')
    expect(state.selectedReasoningEffort.value).toBe('xhigh')
    expect(state.selectedSpeedMode.value).toBe('fast')
  })

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
    gatewayMocks.getThreadDetail.mockResolvedValue({
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
    gatewayMocks.getThreadDetail.mockResolvedValue({
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

  it('renders a follow-up user message immediately in an existing thread while turn start is pending', async () => {
    installTestWindow()
    const pendingTurn = deferred<string>()
    gatewayMocks.getThreadDetail.mockResolvedValue({
      ...idleDetail(),
      messages: [
        {
          id: 'user-existing',
          role: 'user',
          text: 'previous',
          messageType: 'userMessage',
        },
        {
          id: 'assistant-existing',
          role: 'assistant',
          text: 'ready',
          messageType: 'agentMessage',
        },
      ],
    })
    gatewayMocks.resumeThread.mockResolvedValue(idleDetail())
    gatewayMocks.startThreadTurn.mockReturnValue(pendingTurn.promise)

    const state = useDesktopState()
    state.primeSelectedThread('thread-1')
    await state.loadMessages('thread-1')

    const send = state.sendMessageToSelectedThread('next question')
    await flushMicrotasks()

    expect(state.messages.value.map((message) => `${message.role}:${message.text}`)).toContain('user:next question')
    expect(state.messages.value.find((message) => message.text === 'next question')?.messageType)
      .toBe('userMessage.optimistic')

    pendingTurn.resolve('turn-follow-up')
    await send
  })

  it('keeps an optimistic user row visible across an empty running detail projection', async () => {
    installTestWindow()
    const pendingTurn = deferred<string>()
    gatewayMocks.getThreadDetail
      .mockResolvedValueOnce({
        ...idleDetail(),
        messages: [
          {
            id: 'user-existing',
            role: 'user',
            text: 'previous',
            messageType: 'userMessage',
          },
          {
            id: 'assistant-existing',
            role: 'assistant',
            text: 'ready',
            messageType: 'agentMessage',
          },
        ],
      })
      .mockResolvedValueOnce({
        ...idleDetail(),
        inProgress: true,
        activeTurnId: 'turn-follow-up',
        ownership: 'local',
        messages: [],
      })
    gatewayMocks.resumeThread.mockResolvedValue(idleDetail())
    gatewayMocks.startThreadTurn.mockReturnValue(pendingTurn.promise)

    const state = useDesktopState()
    state.primeSelectedThread('thread-1')
    await state.loadMessages('thread-1')

    const send = state.sendMessageToSelectedThread('next question')
    await flushMicrotasks()
    expect(state.messages.value.some((message) => message.text === 'next question')).toBe(true)

    pendingTurn.resolve('turn-follow-up')
    await send
    await state.loadMessages('thread-1', { force: true })

    expect(state.messages.value.some((message) => message.text === 'next question')).toBe(true)
  })

  it('keeps an optimistic user row while a transient turn-start response is ambiguous', async () => {
    installTestWindow()
    gatewayMocks.getThreadDetail.mockResolvedValue({
      ...idleDetail(),
      messages: [
        {
          id: 'user-existing',
          role: 'user',
          text: 'previous',
          messageType: 'userMessage',
        },
      ],
    })
    gatewayMocks.resumeThread.mockResolvedValue(idleDetail())
    gatewayMocks.startThreadTurn.mockRejectedValue(new CodexApiError('bad gateway', {
      code: 'http_error',
      method: 'turn/start',
      status: 502,
    }))

    const state = useDesktopState()
    state.primeSelectedThread('thread-1')
    await state.loadMessages('thread-1')

    await expect(state.sendMessageToSelectedThread('next question')).rejects.toThrow('bad gateway')

    expect(state.messages.value.some((message) => (
      message.role === 'user'
      && message.text === 'next question'
      && message.messageType === 'userMessage.optimistic'
    ))).toBe(true)
    expect(state.selectedLiveOverlay.value?.activityLabel).toBe('Thinking')
  })

  it('reconciles optimistic rows by attachment identity instead of attachment count', async () => {
    installTestWindow()
    gatewayMocks.startThreadTurn
      .mockResolvedValueOnce('turn-a')
      .mockResolvedValueOnce('turn-b')
    const state = useDesktopState()
    state.primeSelectedThread('thread-1')
    await state.loadMessages('thread-1')

    const firstFile = { label: 'first.txt', path: '/tmp/first.txt', fsPath: '/tmp/first.txt' }
    const secondFile = { label: 'second.txt', path: '/tmp/second.txt', fsPath: '/tmp/second.txt' }
    await state.sendMessageToSelectedThread('same prompt', [], [], 'steer', [firstFile])
    await state.sendMessageToSelectedThread('same prompt', [], [], 'steer', [secondFile])

    gatewayMocks.getThreadDetail.mockResolvedValue({
      ...localDetail('turn-b'),
      messages: [{
        id: 'persisted-first',
        role: 'user',
        text: 'same prompt',
        messageType: 'userMessage',
        fileAttachments: [{ label: firstFile.label, path: firstFile.path }],
      }],
    })
    await state.loadMessages('thread-1', { force: true })

    const matchingRows = state.messages.value.filter((message) => (
      message.role === 'user' && message.text === 'same prompt'
    ))
    expect(matchingRows).toHaveLength(2)
    expect(matchingRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        messageType: 'userMessage.optimistic',
        fileAttachments: [expect.objectContaining({ path: secondFile.path })],
      }),
    ]))
  })

  it('does not reconcile a repeated optimistic prompt against an older identical row', async () => {
    installTestWindow()
    gatewayMocks.getThreadDetail.mockResolvedValue({
      ...idleDetail(),
      messages: [{
        id: 'persisted-old',
        role: 'user',
        text: 'continue',
        messageType: 'userMessage',
      }],
    })
    gatewayMocks.startThreadTurn.mockResolvedValue('turn-new')
    const state = useDesktopState()
    state.primeSelectedThread('thread-1')
    await state.loadMessages('thread-1')

    await state.sendMessageToSelectedThread('continue')
    await state.loadMessages('thread-1', { force: true })

    expect(state.messages.value.filter((message) => (
      message.role === 'user' && message.text === 'continue'
    ))).toHaveLength(2)
    expect(state.messages.value.some((message) => (
      message.text === 'continue' && message.messageType === 'userMessage.optimistic'
    ))).toBe(true)
  })

  it('uses one persisted echo to reconcile at most one identical pending submission', async () => {
    installTestWindow()
    gatewayMocks.getThreadDetail.mockResolvedValue({
      ...idleDetail(),
      messages: [{
        id: 'persisted-old',
        role: 'user',
        text: 'continue',
        messageType: 'userMessage',
      }],
    })
    gatewayMocks.startThreadTurn
      .mockResolvedValueOnce('turn-one')
      .mockResolvedValueOnce('turn-two')
    const state = useDesktopState()
    state.primeSelectedThread('thread-1')
    await state.loadMessages('thread-1')

    await state.sendMessageToSelectedThread('continue')
    await state.sendMessageToSelectedThread('continue')
    gatewayMocks.getThreadDetail.mockResolvedValue({
      ...localDetail('turn-two'),
      messages: [
        {
          id: 'persisted-old',
          role: 'user',
          text: 'continue',
          messageType: 'userMessage',
        },
        {
          id: 'persisted-new',
          role: 'user',
          text: 'continue',
          messageType: 'userMessage',
        },
      ],
    })
    await state.loadMessages('thread-1', { force: true })

    const identicalRows = state.messages.value.filter((message) => (
      message.role === 'user' && message.text === 'continue'
    ))
    expect(identicalRows).toHaveLength(3)
    expect(identicalRows.filter((message) => message.messageType === 'userMessage.optimistic'))
      .toHaveLength(1)
  })

  it('interrupts exactly once when Stop is requested before turn/start returns an id', async () => {
    installTestWindow()
    const pendingTurn = deferred<string>()
    gatewayMocks.startThreadTurn.mockReturnValue(pendingTurn.promise)
    gatewayMocks.interruptThreadTurn.mockResolvedValue(undefined)

    const state = useDesktopState()
    state.primeSelectedThread('thread-1')
    await state.loadMessages('thread-1')

    const send = state.sendMessageToSelectedThread('run this')
    await flushMicrotasks()
    const stop = state.interruptSelectedThreadTurn()

    expect(gatewayMocks.interruptThreadTurn).not.toHaveBeenCalled()
    pendingTurn.resolve('turn-new')
    await Promise.all([send, stop])

    expect(gatewayMocks.interruptThreadTurn).toHaveBeenCalledTimes(1)
    expect(gatewayMocks.interruptThreadTurn).toHaveBeenCalledWith('thread-1', 'turn-new')
  })

  it('uses a turn/started notification to satisfy a pending Stop before the RPC resolves', async () => {
    const { state, emit } = await setupTurnLifecycleNotificationState('thread-1')
    const pendingTurn = deferred<string>()
    gatewayMocks.startThreadTurn.mockReturnValue(pendingTurn.promise)
    gatewayMocks.interruptThreadTurn.mockResolvedValue(undefined)

    const send = state.sendMessageToSelectedThread('run this')
    await flushMicrotasks()
    const stop = state.interruptSelectedThreadTurn()
    emit({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-new' } } })
    await flushMicrotasks()

    expect(gatewayMocks.interruptThreadTurn).toHaveBeenCalledTimes(1)
    expect(gatewayMocks.interruptThreadTurn).toHaveBeenCalledWith('thread-1', 'turn-new')

    pendingTurn.resolve('turn-new')
    await Promise.all([send, stop])
    expect(gatewayMocks.interruptThreadTurn).toHaveBeenCalledTimes(1)
  })

  it('does not resurrect a turn that completed before turn/start returned its id', async () => {
    const { state, emit } = await setupTurnLifecycleNotificationState('thread-1')
    const pendingTurn = deferred<string>()
    gatewayMocks.startThreadTurn.mockReturnValue(pendingTurn.promise)

    const send = state.sendMessageToSelectedThread('finish quickly')
    await flushMicrotasks()
    emit({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-fast' } } })
    emit({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-fast', status: 'completed' } },
    })
    expect(state.selectedThread.value?.inProgress).toBe(false)

    pendingTurn.resolve('turn-fast')
    await send

    expect(state.selectedThread.value?.inProgress).toBe(false)
    expect(state.selectedThreadRuntimeOwnership.value).toBe('idle')
    expect(state.selectedActiveTurnId.value).toBe('')
  })

  it('cancels a new-thread submission before turn/start is issued', async () => {
    installTestWindow()
    const pendingThread = deferred<{ threadId: string; model: string; modelProvider: string }>()
    gatewayMocks.startThread.mockReturnValue(pendingThread.promise)

    const state = useDesktopState()
    const send = state.sendMessageToNewThread('run this', '/tmp/project')
    await flushMicrotasks()
    expect(state.isSendingMessage.value).toBe(true)
    expect(state.pendingNewThreadMessages.value).toEqual([
      expect.objectContaining({ role: 'user', text: 'run this' }),
    ])

    state.interruptPendingNewThreadSubmission()
    pendingThread.resolve({
      threadId: 'thread-new',
      model: 'gpt-5.5',
      modelProvider: 'openai',
    })

    await expect(send).resolves.toBe('thread-new')
    expect(gatewayMocks.startThreadTurn).not.toHaveBeenCalled()
    expect(state.isSendingMessage.value).toBe(false)
    expect(state.messages.value).toEqual([
      expect.objectContaining({ role: 'user', text: 'run this' }),
    ])
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

  it('renders a managed image as an @filename token before first-turn reconciliation', async () => {
    installTestWindow()
    const pendingTurn = deferred<string>()
    gatewayMocks.startThread.mockResolvedValue({
      threadId: 'new-image-thread',
      model: 'gpt-5.4-mini',
      modelProvider: 'openai',
    })
    gatewayMocks.startThreadTurn.mockReturnValue(pendingTurn.promise)
    const managedImageUrl = '/codex-local-image?path=%2Ftmp%2Fcodex-web-uploads%2Fupload-123%2Fphoto.png&uploadHandle=managed-photo'
    const state = useDesktopState()

    const send = state.sendMessageToNewThread('describe this', '/tmp/project', [managedImageUrl])
    await flushMicrotasks()

    const optimistic = state.messages.value.find((message) => message.messageType === 'userMessage.optimistic')
    expect(optimistic).toMatchObject({
      role: 'user',
      text: '@photo.png\n\ndescribe this',
    })
    expect(optimistic?.images ?? []).toEqual([])

    pendingTurn.resolve('turn-first')
    await expect(send).resolves.toBe('new-image-thread')
  })

  it('retains a managed image after an ambiguous turn/start response until terminal confirmation', async () => {
    const { state, emit } = await setupTurnLifecycleNotificationState('thread-1')
    const managedImageUrl = '/codex-local-image?path=%2Ftmp%2Fcodex-web-uploads%2Fupload%2Fphoto.png&uploadHandle=ambiguous-existing'
    gatewayMocks.startThreadTurn.mockRejectedValue(new CodexApiError('bad gateway', {
      code: 'http_error',
      method: 'turn/start',
      status: 502,
    }))

    await expect(state.sendMessageToSelectedThread('inspect this', [managedImageUrl]))
      .rejects.toThrow('bad gateway')
    expect(gatewayMocks.cleanupManagedUploads).not.toHaveBeenCalled()

    emit({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-accepted' } } })
    emit({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-accepted', status: 'completed' } },
    })
    await flushMicrotasks()

    expect(gatewayMocks.cleanupManagedUploads).toHaveBeenCalledTimes(1)
    expect(gatewayMocks.cleanupManagedUploads).toHaveBeenCalledWith([managedImageUrl], [])
  })

  it('cleans a managed image once when immediate Stop cancels before turn/start', async () => {
    installTestWindow()
    const pendingResume = deferred<ReturnType<typeof idleDetail>>()
    const managedImageUrl = '/codex-local-image?path=%2Ftmp%2Fcodex-web-uploads%2Fupload%2Fphoto.png&uploadHandle=cancel-before-start'
    gatewayMocks.resumeThread.mockReturnValue(pendingResume.promise)
    const state = useDesktopState()
    state.primeSelectedThread('thread-1')
    await state.loadMessages('thread-1')

    const send = state.sendMessageToSelectedThread('inspect this', [managedImageUrl])
    await flushMicrotasks()
    const stop = state.interruptSelectedThreadTurn()
    pendingResume.resolve(idleDetail())
    await Promise.all([send, stop])

    expect(gatewayMocks.startThreadTurn).not.toHaveBeenCalled()
    expect(gatewayMocks.cleanupManagedUploads).toHaveBeenCalledTimes(1)
    expect(gatewayMocks.cleanupManagedUploads).toHaveBeenCalledWith([managedImageUrl], [])
  })

  it('keeps an ambiguous new-thread upload owned until its accepted turn completes', async () => {
    const { state, emit } = await setupTurnLifecycleNotificationState('thread-1')
    const managedImageUrl = '/codex-local-image?path=%2Ftmp%2Fcodex-web-uploads%2Fupload%2Fphoto.png&uploadHandle=ambiguous-new'
    gatewayMocks.startThread.mockResolvedValue({
      threadId: 'new-ambiguous-thread',
      model: 'gpt-5.5',
      modelProvider: 'openai',
    })
    gatewayMocks.startThreadTurn.mockRejectedValue(new CodexApiError('bad gateway', {
      code: 'http_error',
      method: 'turn/start',
      status: 502,
    }))

    await expect(state.sendMessageToNewThread('inspect this', '/tmp/project', [managedImageUrl]))
      .resolves.toBe('new-ambiguous-thread')
    expect(state.selectedThreadId.value).toBe('new-ambiguous-thread')
    expect(gatewayMocks.cleanupManagedUploads).not.toHaveBeenCalled()

    emit({
      method: 'turn/started',
      params: { threadId: 'new-ambiguous-thread', turn: { id: 'turn-accepted' } },
    })
    emit({
      method: 'turn/completed',
      params: {
        threadId: 'new-ambiguous-thread',
        turn: { id: 'turn-accepted', status: 'completed' },
      },
    })
    await flushMicrotasks()

    expect(gatewayMocks.cleanupManagedUploads).toHaveBeenCalledTimes(1)
    expect(gatewayMocks.cleanupManagedUploads).toHaveBeenCalledWith([managedImageUrl], [])
  })

  it('releases a new-thread upload once after primary and fallback thread/start both fail', async () => {
    installTestWindow()
    const state = useDesktopState()
    state.setSelectedModelId('gpt-5.5')
    const managedImageUrl = '/codex-local-image?path=%2Ftmp%2Fcodex-web-uploads%2Fupload%2Fphoto.png&uploadHandle=new-thread-fail'
    gatewayMocks.startThread
      .mockRejectedValueOnce(new Error('model is not supported'))
      .mockRejectedValueOnce(new Error('fallback thread start failed'))

    await expect(state.sendMessageToNewThread('hi', '/tmp/project', [managedImageUrl]))
      .rejects.toThrow('fallback thread start failed')

    expect(gatewayMocks.startThread).toHaveBeenCalledTimes(2)
    expect(gatewayMocks.cleanupManagedUploads).toHaveBeenCalledTimes(1)
    expect(gatewayMocks.cleanupManagedUploads).toHaveBeenCalledWith([managedImageUrl], [])
  })

  it('releases a new-thread upload once when thread/start returns an empty thread id', async () => {
    installTestWindow()
    const state = useDesktopState()
    const managedImageUrl = '/codex-local-image?path=%2Ftmp%2Fcodex-web-uploads%2Fupload%2Fphoto.png&uploadHandle=empty-thread'
    gatewayMocks.startThread.mockResolvedValue({
      threadId: '',
      model: '',
      modelProvider: '',
    })

    await expect(state.sendMessageToNewThread('hi', '/tmp/project', [managedImageUrl])).resolves.toBe('')

    expect(gatewayMocks.cleanupManagedUploads).toHaveBeenCalledTimes(1)
    expect(gatewayMocks.cleanupManagedUploads).toHaveBeenCalledWith([managedImageUrl], [])
  })

  it('rejects and rolls back an optimistic new thread when first turn start fails', async () => {
    installTestWindow()
    const state = useDesktopState()
    const managedImageUrl = '/codex-local-image?path=%2Ftmp%2Fcodex-web-uploads%2Fupload%2Fphoto.png&uploadHandle=pending-owner'
    gatewayMocks.startThread.mockResolvedValue({
      threadId: 'new-thread',
      model: 'gpt-5.4-mini',
      modelProvider: 'openai',
    })
    gatewayMocks.startThreadTurn.mockRejectedValue(new Error('final turn handoff failed'))

    await expect(state.sendMessageToNewThread('hi', '/tmp/project', [managedImageUrl]))
      .rejects.toThrow('final turn handoff failed')

    expect(state.selectedThreadId.value).toBe('')
    expect(state.messages.value).toEqual([])
    expect(state.projectGroups.value.flatMap((group) => group.threads).some((thread) => thread.id === 'new-thread'))
      .toBe(false)
    expect(state.error.value).toBe('final turn handoff failed')
    expect(gatewayMocks.cleanupManagedUploads).toHaveBeenCalledTimes(1)
    expect(gatewayMocks.cleanupManagedUploads).toHaveBeenCalledWith([managedImageUrl], [])
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
      'system:Worked',
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
    gatewayMocks.getThreadDetail.mockRejectedValue(new Error('thread not found'))

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
    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledTimes(1)
    expect(gatewayMocks.resumeThread).not.toHaveBeenCalled()
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
