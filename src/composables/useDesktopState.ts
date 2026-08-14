import { computed, ref } from 'vue'
import {

  appendThreadQueuedMessage,
  archiveThread,
  forkThread,
  getAvailableCollaborationModes,
  getAccountRateLimits,
  renameThread,
  getAvailableModelIds,
  getCurrentModelConfig,
  getExternalThreadLiveSnapshot,
  getThreadTextPage,
  getThreadGoal,
  getPendingServerRequests,
  getSkillsList,
  getThreadDetail,
  getThreadRuntimeStates,
  getOlderThreadMessages,
  getBackgroundThreadListLimit,
  interruptThreadTurn,
  pickCodexRateLimitSnapshot,
  replyToServerRequest,
  removeThreadQueuedMessage as removeThreadQueuedMessageFromServer,
  reorderThreadQueuedMessages as reorderThreadQueuedMessagesOnServer,
  revertThreadFileChanges,
  rollbackThread,
  getThreadGroupsPage,
  getThreadQueueAppendReceipt,
  getThreadQueueSnapshot,
  getWorkspaceRootsState,
  setCodexSpeedMode,
  setThreadGoal,
  setWorkspaceRootsState,
  getThreadTitleCache,
  persistThreadTitle,
  generateThreadTitle,
  resumeThread,

  startThread,
  subscribeCodexNotifications,
  startThreadTurn,
  cleanupManagedUploads,
  clearThreadGoal,
  type RpcNotification,
  type SkillInfo,
  type WorkspaceRootsState,
} from '../api/codexGateway'
import { CodexApiError } from '../api/codexErrors'
import { normalizeFileChangeStatus, toUiFileChanges } from '../api/normalizers/v2'
import type {
  CollaborationModeKind,
  CollaborationModeOption,
  CommandExecutionData,
  UiPendingRequestState,
  ReasoningEffort,
  SpeedMode,
  UiFileChange,
  UiCodexDirective,
  UiLiveOverlay,
  UiMessage,
  UiPlanData,
  UiPlanStep,
  UiProjectGroup,
  UiRateLimitSnapshot,
  UiServerRequest,
  UiServerRequestReply,
  UiThreadTokenUsage,
  UiTokenUsageBreakdown,
  UiThread,
  UiThreadGoal,
  UiThreadGoalStatus,
  UiThreadLiveAuthority,
  UiThreadLiveSnapshot,
} from '../types/codex'
import type { ThreadRuntimeOwnership } from '../types/threadRuntime'
import { getPathParent, isProjectlessChatPath, normalizePathForUi, toProjectName } from '../pathUtils.js'
import { commandDisplayLabel } from '../utils/commandActivity'
import { normalizeCodexDelegationText } from '../utils/codexDelegationText'
import { parseCodexDirectiveText } from '../utils/codexDirectives'
import {
  ALL_REASONING_EFFORTS,
  coerceReasoningEffortForModel,
  isReasoningEffortSupportedByModel,
} from '../utils/modelReasoningEfforts'
import { resolveTurnCompletionDisposition, type TurnTerminalStatus } from './threadLifecycle'
import { shouldRefreshMessagesForNotification } from './notificationSyncPolicy'
import { createManagedUploadLease } from './managedUploadLease'
import {
  filterTitleOnlyReasoningText,
  finalizeHydratedTurnText,
  mergeHydratedTurnTextIntoTranscript,
  mergeThreadTextPage,
  reorderLateDelegatedUserMessagesForDisplay,
} from './threadTextHydration'
import { createMultiWindowThreadSync } from './multiWindowThreadSync'

type ThreadDetailSnapshot = Awaited<ReturnType<typeof getThreadDetail>> & {
  isPartialTurnProjection?: boolean
  liveAuthority?: UiThreadLiveAuthority
  liveSnapshot?: UiThreadLiveSnapshot | null
  projectionKey?: string
  notModified?: boolean
}

type ThreadTextPageSnapshot = Awaited<ReturnType<typeof getThreadTextPage>>

type ThreadDetailRequestLease = {
  epoch: number
  ownsRequest: boolean
  requestKey: string
  promise: Promise<ThreadDetailSnapshot>
}

type ThreadDetailRequestKind = 'detail' | 'live'

type ActiveTextHydration = {
  turnId: string
  messages: UiMessage[]
  nextOlderCursor: string | null
  hasMoreOlder: boolean
  consumedCursors: Set<string>
  controller: AbortController | null
  recoverableConflictProjectionKey?: string
  tailSignature?: string
  lastUnsignedTailProbeAt?: number
}

type OptimisticUserSubmission = {
  message: UiMessage
  afterMessageId: string
  expectedPersistedOccurrence: number
}

function flattenThreads(groups: UiProjectGroup[]): UiThread[] {
  return groups.flatMap((group) => group.threads)
}

export function findAdjacentThreadId(threads: UiThread[], threadId: string): string {
  const targetIndex = threads.findIndex((thread) => thread.id === threadId)
  if (targetIndex < 0) return ''
  return threads[targetIndex + 1]?.id ?? threads[targetIndex - 1]?.id ?? ''
}

const READ_STATE_STORAGE_KEY = 'codex-web-local.thread-read-state.v1'
const UNREAD_CUTOFF_STORAGE_KEY = 'codex-web-local.thread-unread-cutoff.v1'
const THREAD_TOKEN_USAGE_STORAGE_KEY = 'codex-web-local.thread-token-usage.v1'
const THREAD_TERMINAL_OPEN_STORAGE_KEY = 'codex-web-local.thread-terminal-open.v1'
const TURN_COMPLETION_SUMMARY_STORAGE_KEY = 'codex-web-local.turn-completion-summaries.v1'
const SELECTED_THREAD_STORAGE_KEY = 'codex-web-local.selected-thread-id.v1'
const SELECTED_MODEL_BY_CONTEXT_STORAGE_KEY = 'codex-web-local.selected-model-by-context.v1'
const LEGACY_SELECTED_MODEL_STORAGE_KEY = 'codex-web-local.selected-model-id.v1'
const PROJECT_ORDER_STORAGE_KEY = 'codex-web-local.project-order.v1'
const PROJECT_DISPLAY_NAME_STORAGE_KEY = 'codex-web-local.project-display-name.v1'
const THREAD_GROUPS_SNAPSHOT_STORAGE_KEY = 'codex-web-local.thread-groups-snapshot.v1'
const COLLABORATION_MODE_STORAGE_KEY = 'codex-web-local.collaboration-mode-by-context.v1'
const LEGACY_COLLABORATION_MODE_STORAGE_KEY = 'codex-web-local.collaboration-mode.v1'
const NEW_THREAD_COLLABORATION_MODE_CONTEXT = '__new-thread__'
const NEW_THREAD_PROVIDER_MODEL_CONTEXT_PREFIX = '__new-thread-provider__::'
const ACTIVE_TEXT_NEWEST_REFRESH_DEBOUNCE_MS = 0
const EVENT_SYNC_DEBOUNCE_MS = 220
const BACKGROUND_THREAD_PAGINATION_DELAY_MS = 250
const ENABLE_AUTOMATIC_BACKGROUND_THREAD_PAGINATION = true
const RATE_LIMIT_REFRESH_DEBOUNCE_MS = 500
const SELECTED_EXTERNAL_LIVE_PROJECTION_POLL_MS = 150
const UNSIGNED_ACTIVE_TEXT_TAIL_POLL_MS = 500
const BACKGROUND_RUNTIME_POLL_MS = 2_000
const SELECTED_IDLE_LIVE_PROJECTION_POLL_MS = BACKGROUND_RUNTIME_POLL_MS
const BACKGROUND_RUNTIME_BATCH_LIMIT = 16
const TURN_START_FOLLOW_UP_SYNC_DELAY_MS = 3000
const RECENT_THREAD_MESSAGE_LOAD_REUSE_MS = 2000
const RECENT_THREAD_LIST_LOAD_REUSE_MS = 2000
const RECENT_SKILLS_LOAD_REUSE_MS = 2000
const REASONING_EFFORT_OPTIONS: ReasoningEffort[] = ALL_REASONING_EFFORTS
const GLOBAL_SERVER_REQUEST_SCOPE = '__global__'
const THREAD_LIST_STRUCTURE_NOTIFICATION_METHODS = new Set([
  'thread/archived',
  'thread/created',
  'thread/deleted',
  'thread/restored',
  'thread/unarchived',
])
const ACTIVE_TEXT_NEWEST_REFRESH_NOTIFICATION_METHODS = new Set([
  'item/agentMessage/delta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/textDelta',
])
const ACTIVE_TEXT_ITEM_NOTIFICATION_TYPES = new Set([
  'agentMessage',
  'reasoning',
  'contextCompaction',
])
const DEFAULT_CODEX_NEW_THREAD_MODEL_ID = 'gpt-5.6-sol'
const DEFAULT_CODEX_NEW_THREAD_REASONING_EFFORT: ReasoningEffort = 'max'
const DEFAULT_CODEX_NEW_THREAD_SPEED_MODE: SpeedMode = 'fast'
const MODEL_FALLBACK_ID = 'gpt-5.4-mini'
const OPENCODE_ZEN_DEFAULT_MODEL = 'big-pickle'
const CODEX_CLI_MISSING_MESSAGE = 'Codex CLI not found. Install @openai/codex or set CODEXUI_CODEX_COMMAND.'
const THREAD_GOAL_STATUSES = new Set<UiThreadGoalStatus>([
  'active',
  'paused',
  'blocked',
  'usageLimited',
  'budgetLimited',
  'complete',
])
type SelectThreadResult = 'ok' | 'not-found' | 'error'

function isMobileCodexWebClient(): boolean {
  if (typeof window === 'undefined') return false
  if (typeof window.innerWidth === 'number' && window.innerWidth < 768) return true
  if (typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) {
    return true
  }
  return false
}

function isCodexCliMissingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return message.includes('Codex CLI is not available')
}

export function isThreadNotFoundError(error: unknown): boolean {
  if (
    error instanceof CodexApiError &&
    (error.status === 404 || error.status === 403 || error.status === 410)
  ) return true
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /\b(?:404|403|410)\b|thread.*(?:not found|archived|inaccessible|not accessible)|conversation.*not found|no such thread|no rollout found for thread(?: id)?/i.test(message)
}

function loadReadStateMap(): Record<string, string> {
  if (typeof window === 'undefined') return {}

  try {
    const raw = window.localStorage.getItem(READ_STATE_STORAGE_KEY)
    if (!raw) return {}

    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, string>
  } catch {
    return {}
  }
}

function saveReadStateMap(state: Record<string, string>): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(READ_STATE_STORAGE_KEY, JSON.stringify(state))
}

function readThreadGroupsSnapshot(): UiProjectGroup[] {
  if (typeof window === 'undefined') return []

  try {
    const raw = window.localStorage.getItem(THREAD_GROUPS_SNAPSHOT_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    const groupsRaw = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { groups?: unknown }).groups)
        ? (parsed as { groups: unknown[] }).groups
        : []
    const groups: UiProjectGroup[] = []
    for (const groupRaw of groupsRaw) {
      if (!groupRaw || typeof groupRaw !== 'object') continue
      const group = groupRaw as { projectName?: unknown; threads?: unknown }
      const projectName = typeof group.projectName === 'string' ? group.projectName : ''
      if (!projectName || !Array.isArray(group.threads)) continue
      const threads = group.threads.filter((threadRaw): threadRaw is UiThread => (
        Boolean(threadRaw) &&
        typeof threadRaw === 'object' &&
        typeof (threadRaw as { id?: unknown }).id === 'string' &&
        typeof (threadRaw as { title?: unknown }).title === 'string' &&
        typeof (threadRaw as { projectName?: unknown }).projectName === 'string' &&
        typeof (threadRaw as { cwd?: unknown }).cwd === 'string'
      ))
      if (threads.length > 0) {
        groups.push({ projectName, threads })
      }
    }
    return groups
  } catch {
    return []
  }
}

function saveThreadGroupsSnapshot(groups: UiProjectGroup[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(THREAD_GROUPS_SNAPSHOT_STORAGE_KEY, JSON.stringify({
      groups,
      savedAtIso: new Date().toISOString(),
    }))
  } catch {
    // Startup cache is best-effort only.
  }
}

function loadUnreadCutoffIso(): string {
  if (typeof window === 'undefined') return ''

  const existing = window.localStorage.getItem(UNREAD_CUTOFF_STORAGE_KEY)
  if (existing) return existing

  const initialCutoff = new Date().toISOString()
  window.localStorage.setItem(UNREAD_CUTOFF_STORAGE_KEY, initialCutoff)
  return initialCutoff
}

function saveUnreadCutoffIso(cutoffIso: string): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(UNREAD_CUTOFF_STORAGE_KEY, cutoffIso)
}

function isThreadUpdatedAfterCutoff(updatedAtIso: string, cutoffIso: string): boolean {
  if (!updatedAtIso || !cutoffIso) return false
  const updatedAtMs = new Date(updatedAtIso).getTime()
  const cutoffMs = new Date(cutoffIso).getTime()
  if (!Number.isFinite(updatedAtMs) || !Number.isFinite(cutoffMs)) return false
  return updatedAtMs > cutoffMs
}

function readThreadReadWatermarkIso(updatedAtIso: string, nowMs = Date.now()): string {
  const updatedAtMs = updatedAtIso ? new Date(updatedAtIso).getTime() : Number.NaN
  const watermarkMs = Number.isFinite(updatedAtMs)
    ? Math.max(updatedAtMs, nowMs)
    : nowMs
  return new Date(watermarkMs).toISOString()
}

export function isThreadUnreadByLastRead(
  updatedAtIso: string,
  threadReadStateIso: string | undefined,
  unreadCutoffIso: string,
): boolean {
  const effectiveLastReadIso = threadReadStateIso ?? unreadCutoffIso
  return isThreadUpdatedAfterCutoff(updatedAtIso, effectiveLastReadIso)
}

function normalizeCollaborationMode(value: unknown): CollaborationModeKind {
  return value === 'plan' ? 'plan' : 'default'
}

function normalizeStoredModelId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function createStringKeyedRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>
}

function cloneStringKeyedRecord<T>(record: Record<string, T>): Record<string, T> {
  const next = createStringKeyedRecord<T>()
  for (const [key, value] of Object.entries(record)) {
    next[key] = value
  }
  return next
}

function omitStringKeyedRecordKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record
  const next = createStringKeyedRecord<T>()
  for (const [entryKey, value] of Object.entries(record)) {
    if (entryKey !== key) {
      next[entryKey] = value
    }
  }
  return next
}

function pruneThreadContextStateMap<T>(
  stateMap: Record<string, T>,
  threadIds: Set<string>,
): Record<string, T> {
  let changed = false
  const next = createStringKeyedRecord<T>()
  for (const [contextId, value] of Object.entries(stateMap)) {
    if (
      contextId === NEW_THREAD_COLLABORATION_MODE_CONTEXT
      || contextId.startsWith(NEW_THREAD_PROVIDER_MODEL_CONTEXT_PREFIX)
      || threadIds.has(contextId)
    ) {
      next[contextId] = value
      continue
    }
    changed = true
  }
  return changed ? next : stateMap
}

function normalizeProviderContextId(providerId: string): string {
  const normalized = providerId.trim().toLowerCase().replace(/_/g, '-')
  if (!normalized || normalized === 'openai') return 'codex'
  return normalized
}

function isNewThreadContextId(contextId: string): boolean {
  return contextId === NEW_THREAD_COLLABORATION_MODE_CONTEXT
}

function toProviderModelContextId(providerId: string): string {
  const normalizedProviderId = normalizeProviderContextId(providerId)
  if (!normalizedProviderId) return ''
  return `${NEW_THREAD_PROVIDER_MODEL_CONTEXT_PREFIX}${normalizedProviderId}`
}

function toThreadContextId(threadId: string): string {
  const normalizedThreadId = threadId.trim()
  return normalizedThreadId || NEW_THREAD_COLLABORATION_MODE_CONTEXT
}

function loadSelectedModelMap(): Record<string, string> {
  if (typeof window === 'undefined') return createStringKeyedRecord<string>()

  try {
    const raw = window.localStorage.getItem(SELECTED_MODEL_BY_CONTEXT_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return createStringKeyedRecord<string>()

      const next = createStringKeyedRecord<string>()
      for (const [contextId, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof contextId !== 'string' || contextId.length === 0) continue
        const normalizedModelId = normalizeStoredModelId(value)
        if (normalizedModelId) {
          next[contextId] = normalizedModelId
        }
      }
      return next
    }
  } catch {
    // Fall back to the legacy global preference below.
  }

  const legacyModelId = normalizeStoredModelId(window.localStorage.getItem(LEGACY_SELECTED_MODEL_STORAGE_KEY))
  const next = createStringKeyedRecord<string>()
  if (legacyModelId) {
    next[NEW_THREAD_COLLABORATION_MODE_CONTEXT] = legacyModelId
  }
  return next
}

function readSelectedModel(
  state: Record<string, string>,
  threadId: string,
): string {
  const contextId = toThreadContextId(threadId)
  const contextModelId = normalizeStoredModelId(state[contextId])
  if (contextModelId) return contextModelId
  return normalizeStoredModelId(state[NEW_THREAD_COLLABORATION_MODE_CONTEXT])
}

function pickDefaultCodexNewThreadModel(modelIds: string[]): string {
  return modelIds.includes(DEFAULT_CODEX_NEW_THREAD_MODEL_ID)
    ? DEFAULT_CODEX_NEW_THREAD_MODEL_ID
    : ''
}

function saveSelectedModelMap(state: Record<string, string>): void {
  if (typeof window === 'undefined') return
  try {
    if (Object.keys(state).length === 0) {
      window.localStorage.removeItem(SELECTED_MODEL_BY_CONTEXT_STORAGE_KEY)
    } else {
      window.localStorage.setItem(SELECTED_MODEL_BY_CONTEXT_STORAGE_KEY, JSON.stringify(state))
    }
    window.localStorage.removeItem(LEGACY_SELECTED_MODEL_STORAGE_KEY)
  } catch {
    // Keep in-memory selection working even if localStorage writes fail.
  }
}

function loadSelectedCollaborationModeMap(): Record<string, CollaborationModeKind> {
  if (typeof window === 'undefined') return createStringKeyedRecord<CollaborationModeKind>()

  try {
    const raw = window.localStorage.getItem(COLLABORATION_MODE_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return createStringKeyedRecord<CollaborationModeKind>()
      }

      const next = createStringKeyedRecord<CollaborationModeKind>()
      for (const [contextId, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof contextId !== 'string' || contextId.length === 0) continue
        const normalizedMode = normalizeCollaborationMode(value)
        if (normalizedMode === 'plan') {
          next[contextId] = normalizedMode
        }
      }
      return next
    }
  } catch {
    // Fall back to the legacy global preference below.
  }

  return createStringKeyedRecord<CollaborationModeKind>()
}

function readSelectedCollaborationMode(
  state: Record<string, CollaborationModeKind>,
  threadId: string,
): CollaborationModeKind {
  const contextId = toThreadContextId(threadId)
  return normalizeCollaborationMode(state[contextId])
}

function writeSelectedCollaborationModeForContext(
  state: Record<string, CollaborationModeKind>,
  threadId: string,
  mode: CollaborationModeKind,
): Record<string, CollaborationModeKind> {
  const contextId = toThreadContextId(threadId)
  if (isNewThreadContextId(contextId)) {
    return omitStringKeyedRecordKey(state, contextId)
  }
  if (mode === 'plan') {
    const next = cloneStringKeyedRecord(state)
    next[contextId] = 'plan'
    return next
  }
  return omitStringKeyedRecordKey(state, contextId)
}

function saveSelectedCollaborationModeMap(state: Record<string, CollaborationModeKind>): void {
  if (typeof window === 'undefined') return
  try {
    if (Object.keys(state).length === 0) {
      window.localStorage.removeItem(COLLABORATION_MODE_STORAGE_KEY)
    } else {
      window.localStorage.setItem(COLLABORATION_MODE_STORAGE_KEY, JSON.stringify(state))
    }
    window.localStorage.removeItem(LEGACY_COLLABORATION_MODE_STORAGE_KEY)
  } catch {
    // Keep in-memory mode selection working even if localStorage writes fail.
  }
}

function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.min(Math.max(value, minValue), maxValue)
}

function normalizeStoredTokenCount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value))
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.trunc(parsed))
    }
  }

  return null
}

function normalizeTokenUsageBreakdown(value: unknown): UiThreadTokenUsage['last'] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const record = value as Record<string, unknown>
  return {
    totalTokens: normalizeStoredTokenCount(record.totalTokens) ?? 0,
    inputTokens: normalizeStoredTokenCount(record.inputTokens) ?? 0,
    cachedInputTokens: normalizeStoredTokenCount(record.cachedInputTokens) ?? 0,
    outputTokens: normalizeStoredTokenCount(record.outputTokens) ?? 0,
    reasoningOutputTokens: normalizeStoredTokenCount(record.reasoningOutputTokens) ?? 0,
  }
}

function normalizeThreadTokenUsage(value: unknown): UiThreadTokenUsage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const record = value as Record<string, unknown>
  const total = normalizeTokenUsageBreakdown(record.total)
  const last = normalizeTokenUsageBreakdown(record.last)
  if (!total || !last) return null

  const modelContextWindow = normalizeStoredTokenCount(record.modelContextWindow)
  const currentContextTokens = last.totalTokens
  const remainingContextTokens = typeof modelContextWindow === 'number'
    ? Math.max(modelContextWindow - currentContextTokens, 0)
    : null
  const remainingContextPercent = typeof modelContextWindow === 'number' && modelContextWindow > 0
    ? clamp(Math.round((remainingContextTokens ?? 0) / modelContextWindow * 100), 0, 100)
    : null

  return {
    total,
    last,
    modelContextWindow,
    currentContextTokens,
    remainingContextTokens,
    remainingContextPercent,
  }
}

function loadThreadTokenUsageMap(): Record<string, UiThreadTokenUsage> {
  if (typeof window === 'undefined') return {}

  try {
    const raw = window.localStorage.getItem(THREAD_TOKEN_USAGE_STORAGE_KEY)
    if (!raw) return {}

    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

    const normalizedMap: Record<string, UiThreadTokenUsage> = {}
    for (const [threadId, usage] of Object.entries(parsed as Record<string, unknown>)) {
      if (!threadId) continue
      const normalizedUsage = normalizeThreadTokenUsage(usage)
      if (normalizedUsage) {
        normalizedMap[threadId] = normalizedUsage
      }
    }
    return normalizedMap
  } catch {
    return {}
  }
}

function saveThreadTokenUsageMap(state: Record<string, UiThreadTokenUsage>): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(THREAD_TOKEN_USAGE_STORAGE_KEY, JSON.stringify(state))
}

function loadThreadTerminalOpenMap(): Record<string, boolean> {
  if (typeof window === 'undefined') return {}

  try {
    const raw = window.localStorage.getItem(THREAD_TERMINAL_OPEN_STORAGE_KEY)
    if (!raw) return {}

    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

    const normalizedMap: Record<string, boolean> = {}
    for (const [threadId, isOpen] of Object.entries(parsed as Record<string, unknown>)) {
      if (threadId && typeof isOpen === 'boolean') {
        normalizedMap[threadId] = isOpen
      }
    }
    return normalizedMap
  } catch {
    return {}
  }
}

function saveThreadTerminalOpenMap(state: Record<string, boolean>): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(THREAD_TERMINAL_OPEN_STORAGE_KEY, JSON.stringify(state))
}

function loadSelectedThreadId(): string {
  if (typeof window === 'undefined') return ''
  const raw = window.localStorage.getItem(SELECTED_THREAD_STORAGE_KEY)
  return raw ?? ''
}

function saveSelectedThreadId(threadId: string): void {
  if (typeof window === 'undefined') return
  if (!threadId) {
    window.localStorage.removeItem(SELECTED_THREAD_STORAGE_KEY)
    return
  }
  window.localStorage.setItem(SELECTED_THREAD_STORAGE_KEY, threadId)
}

function loadProjectOrder(): string[] {
  if (typeof window === 'undefined') return []

  try {
    const raw = window.localStorage.getItem(PROJECT_ORDER_STORAGE_KEY)
    if (!raw) return []

    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const order: string[] = []
    for (const item of parsed) {
      if (typeof item !== 'string' || item.length === 0) continue
      const normalizedItem = toProjectName(item)
      if (normalizedItem.length > 0 && !order.includes(normalizedItem)) {
        order.push(normalizedItem)
      }
    }
    return order
  } catch {
    return []
  }
}

function saveProjectOrder(order: string[]): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(PROJECT_ORDER_STORAGE_KEY, JSON.stringify(order))
}

function loadProjectDisplayNames(): Record<string, string> {
  if (typeof window === 'undefined') return {}

  try {
    const raw = window.localStorage.getItem(PROJECT_DISPLAY_NAME_STORAGE_KEY)
    if (!raw) return {}

    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

    const displayNames: Record<string, string> = {}
    for (const [projectName, displayName] of Object.entries(parsed as Record<string, unknown>)) {
      const normalizedProjectName = typeof projectName === 'string' ? toProjectName(projectName) : ''
      if (normalizedProjectName.length > 0 && typeof displayName === 'string') {
        displayNames[normalizedProjectName] = displayName
      }
    }
    return displayNames
  } catch {
    return {}
  }
}

function saveProjectDisplayNames(displayNames: Record<string, string>): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(PROJECT_DISPLAY_NAME_STORAGE_KEY, JSON.stringify(displayNames))
}

function mergeProjectOrder(previousOrder: string[], incomingGroups: UiProjectGroup[]): string[] {
  const nextOrder: string[] = []

  for (const projectName of previousOrder) {
    if (!nextOrder.includes(projectName)) {
      nextOrder.push(projectName)
    }
  }

  for (const group of incomingGroups) {
    if (!nextOrder.includes(group.projectName)) {
      nextOrder.push(group.projectName)
    }
  }

  return areStringArraysEqual(previousOrder, nextOrder) ? previousOrder : nextOrder
}

function orderGroupsByProjectOrder(incoming: UiProjectGroup[], projectOrder: string[]): UiProjectGroup[] {
  const incomingByName = new Map(incoming.map((group) => [group.projectName, group]))
  const ordered: UiProjectGroup[] = projectOrder
    .map((projectName) => incomingByName.get(projectName) ?? null)
    .filter((group): group is UiProjectGroup => group !== null)

  for (const group of incoming) {
    if (!projectOrder.includes(group.projectName)) {
      ordered.push(group)
    }
  }

  return ordered
}

function areStringArraysEqual(first?: string[], second?: string[]): boolean {
  const left = Array.isArray(first) ? first : []
  const right = Array.isArray(second) ? second : []
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function reorderStringArray(items: string[], fromIndex: number, toIndex: number): string[] {
  if (fromIndex < 0 || fromIndex >= items.length || toIndex < 0 || toIndex >= items.length) {
    return items
  }

  if (fromIndex === toIndex) {
    return items
  }

  const next = [...items]
  const [moved] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, moved)
  return next
}

function areCommandExecutionsEqual(first?: CommandExecutionData, second?: CommandExecutionData): boolean {
  if (!first && !second) return true
  if (!first || !second) return false
  return first.status === second.status && first.aggregatedOutput === second.aggregatedOutput && first.exitCode === second.exitCode
}

function arePlanStepsEqual(first: UiPlanStep[] = [], second: UiPlanStep[] = []): boolean {
  if (first.length !== second.length) return false
  for (let index = 0; index < first.length; index += 1) {
    if (first[index]?.step !== second[index]?.step || first[index]?.status !== second[index]?.status) {
      return false
    }
  }
  return true
}

function arePlanDataEqual(first?: UiPlanData, second?: UiPlanData): boolean {
  if (!first && !second) return true
  if (!first || !second) return false
  return (
    first.explanation === second.explanation &&
    first.isStreaming === second.isStreaming &&
    arePlanStepsEqual(first.steps, second.steps)
  )
}

function areCodexDirectivesEqual(
  first?: UiCodexDirective[],
  second?: UiCodexDirective[],
): boolean {
  if (!first && !second) return true
  if (!first || !second || first.length !== second.length) return false
  return first.every((directive, index) =>
    JSON.stringify(directive) === JSON.stringify(second[index]),
  )
}

function isUnsupportedChatGptModelError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  return (
    message.includes('not supported when using codex with a chatgpt account') ||
    message.includes('model is not supported') ||
    message.includes('requires a newer version of codex')
  )
}

function isAmbiguousTurnStartError(error: unknown): boolean {
  if (!(error instanceof CodexApiError)) return false
  if (error.code === 'network_error' || error.code === 'invalid_response') return true
  return error.code === 'http_error'
    && (error.status === 408 || error.status === 502 || error.status === 503 || error.status === 504)
}

function isWriterOwnershipNotIdleError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.message.toLowerCase().includes('task writer ownership is not idle')
}

function isThreadNotFoundInterruptError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  return (
    message.includes('turn/interrupt') &&
    (message.includes('thread not found') || message.includes('no rollout found for thread id'))
  )
}

function isRecoverableInterruptTargetError(error: unknown): boolean {
  if (isThreadNotFoundInterruptError(error)) return true
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  return message.includes('thread-runtime-interrupt') &&
    message.includes('external runtime interrupt unavailable') &&
    (
      message.includes('turn-mismatch') ||
      message.includes('writer-not-found') ||
      message.includes('turn-not-running')
    )
}

function areMessageFieldsEqual(first: UiMessage, second: UiMessage): boolean {
  return (
    first.id === second.id &&
    first.role === second.role &&
    first.text === second.text &&
    areCodexDirectivesEqual(first.directives, second.directives) &&
    areStringArraysEqual(first.images, second.images) &&
    areUiFileChangesEqual(first.fileChanges, second.fileChanges) &&
    first.fileChangeStatus === second.fileChangeStatus &&
    first.messageType === second.messageType &&
    first.phase === second.phase &&
    first.rawPayload === second.rawPayload &&
    first.isUnhandled === second.isUnhandled &&
    areCommandExecutionsEqual(first.commandExecution, second.commandExecution) &&
    arePlanDataEqual(first.plan, second.plan) &&
    first.turnId === second.turnId &&
    first.turnIndex === second.turnIndex &&
    first.sessionOrder === second.sessionOrder &&
    first.isAutomationRun === second.isAutomationRun &&
    first.automationDisplayName === second.automationDisplayName
  )
}

function areMessageArraysEqual(first: UiMessage[], second: UiMessage[]): boolean {
  if (first.length !== second.length) return false
  for (let index = 0; index < first.length; index += 1) {
    if (first[index] !== second[index]) return false
  }
  return true
}

function hasFiniteSessionOrder(message: UiMessage): boolean {
  return typeof message.sessionOrder === 'number' && Number.isFinite(message.sessionOrder)
}

function hasFiniteTurnIndex(message: UiMessage): boolean {
  return typeof message.turnIndex === 'number' && Number.isFinite(message.turnIndex)
}

function uniqueTurnIds(turnIds: Iterable<string>): string[] {
  const unique: string[] = []
  const seen = new Set<string>()
  for (const turnId of turnIds) {
    const normalized = turnId.trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    unique.push(normalized)
  }
  return unique
}

function mergePagedTurnIndexLookup(
  existingLookup: Record<string, number>,
  pagedTurnIds: string[],
  options: { prependUnanchored?: boolean } = {},
): Record<string, number> {
  const pageOrder = uniqueTurnIds(pagedTurnIds)
  const existingOrder = Object.entries(existingLookup)
    .filter(([, turnIndex]) => Number.isFinite(turnIndex))
    .sort((left, right) => left[1] - right[1])
    .map(([turnId]) => turnId)
  const existingPosition = new Map(existingOrder.map((turnId, index) => [turnId, index]))
  const hasKnownPageAnchor = pageOrder.some((turnId) => existingPosition.has(turnId))

  if (!hasKnownPageAnchor) {
    if (options.prependUnanchored === true) {
      const pageSet = new Set(pageOrder)
      const nextOrder = [
        ...pageOrder,
        ...existingOrder.filter((turnId) => !pageSet.has(turnId)),
      ]
      return Object.fromEntries(nextOrder.map((turnId, index) => [turnId, index]))
    }

    const nextOrder = [...existingOrder]
    for (const turnId of pageOrder) {
      if (existingPosition.has(turnId)) continue
      existingPosition.set(turnId, nextOrder.length)
      nextOrder.push(turnId)
    }
    return Object.fromEntries(nextOrder.map((turnId, index) => [turnId, index]))
  }

  const mergedOrder: string[] = []
  const used = new Set<string>()
  let pendingPageOnly: string[] = []
  let existingCursor = 0

  const pushExistingUntil = (exclusiveIndex: number): void => {
    while (existingCursor < exclusiveIndex) {
      const turnId = existingOrder[existingCursor]!
      existingCursor += 1
      if (used.has(turnId)) continue
      used.add(turnId)
      mergedOrder.push(turnId)
    }
  }
  const pushPendingPageOnly = (): void => {
    for (const turnId of pendingPageOnly) {
      if (used.has(turnId)) continue
      used.add(turnId)
      mergedOrder.push(turnId)
    }
    pendingPageOnly = []
  }

  for (const turnId of pageOrder) {
    const anchorIndex = existingPosition.get(turnId)
    if (anchorIndex === undefined) {
      pendingPageOnly.push(turnId)
      continue
    }

    pushExistingUntil(anchorIndex)
    pushPendingPageOnly()
    if (!used.has(turnId)) {
      used.add(turnId)
      mergedOrder.push(turnId)
    }
    existingCursor = Math.max(existingCursor, anchorIndex + 1)
  }

  pushExistingUntil(existingOrder.length)
  pushPendingPageOnly()

  return Object.fromEntries(mergedOrder.map((turnId, index) => [turnId, index]))
}

function reindexMessagesByTurnLookup(
  messages: UiMessage[],
  lookup: Record<string, number>,
): UiMessage[] {
  let changed = false
  const reindexed = messages.map((message) => {
    if (!message.turnId) return message
    const turnIndex = lookup[message.turnId]
    if (typeof turnIndex !== 'number' || !Number.isFinite(turnIndex) || message.turnIndex === turnIndex) {
      return message
    }
    changed = true
    return { ...message, turnIndex }
  })
  return changed ? reindexed : messages
}

const CODEX_DELEGATION_OPEN_RE = /<codex_delegation\b[^>]*>/iu

function isLateDelegatedUserEventMessage(message: UiMessage): boolean {
  return message.messageType === 'userMessage'
    && message.id.startsWith('rollout:userMessage:event:')
    && CODEX_DELEGATION_OPEN_RE.test(normalizeCodexDelegationText(message.text))
}

function shouldPrependUnanchoredDelegationPage(
  hadLoadedMessages: boolean,
  serverInProgress: boolean,
  existingLookup: Record<string, number>,
  pagedTurnIds: string[],
  detailMessages: readonly UiMessage[],
): boolean {
  if (!hadLoadedMessages || serverInProgress) return false
  if (Object.keys(existingLookup).length === 0 || pagedTurnIds.length === 0) return false
  if (pagedTurnIds.some((turnId) => existingLookup[turnId] !== undefined)) return false
  return detailMessages.some(isLateDelegatedUserEventMessage)
}

function buildMaxSessionOrderByTurn(messages: readonly UiMessage[]): Map<string, number> {
  const maxByTurnId = new Map<string, number>()
  for (const message of messages) {
    if (!message.turnId || !hasFiniteSessionOrder(message)) continue
    maxByTurnId.set(
      message.turnId,
      Math.max(maxByTurnId.get(message.turnId) ?? Number.NEGATIVE_INFINITY, message.sessionOrder as number),
    )
  }
  return maxByTurnId
}

function shouldKeepPreviousOrderedMessage(
  previous: UiMessage,
  incoming: UiMessage,
  options: { allowEqualOrderTextGrowth?: boolean } = {},
): boolean {
  if (!previous.turnId || previous.turnId !== incoming.turnId) return false
  if (hasFiniteSessionOrder(previous) && !hasFiniteSessionOrder(incoming)) return true
  if (!hasFiniteSessionOrder(previous) || !hasFiniteSessionOrder(incoming)) return false
  if ((incoming.sessionOrder as number) < (previous.sessionOrder as number)) return true
  if ((incoming.sessionOrder as number) !== (previous.sessionOrder as number)) return false
  if (incoming.text === previous.text) return false
  if (options.allowEqualOrderTextGrowth === true && incoming.text.length >= previous.text.length) {
    return false
  }
  return true
}

function isStaleOrderedAppend(
  incoming: UiMessage,
  previousMaxSessionOrderByTurn: ReadonlyMap<string, number>,
): boolean {
  if (!incoming.turnId || !hasFiniteSessionOrder(incoming)) return false
  const maxSessionOrder = previousMaxSessionOrderByTurn.get(incoming.turnId)
  return typeof maxSessionOrder === 'number' && (incoming.sessionOrder as number) <= maxSessionOrder
}

function shouldInsertBeforeOrderedMessage(candidate: UiMessage, incoming: UiMessage): boolean {
  if (hasFiniteTurnIndex(incoming) && hasFiniteTurnIndex(candidate)) {
    if ((candidate.turnIndex as number) !== (incoming.turnIndex as number)) {
      return (candidate.turnIndex as number) > (incoming.turnIndex as number)
    }
    if (
      candidate.turnId === incoming.turnId
      && hasFiniteSessionOrder(candidate)
      && hasFiniteSessionOrder(incoming)
    ) {
      return (candidate.sessionOrder as number) > (incoming.sessionOrder as number)
    }
    return false
  }
  if (
    candidate.turnId === incoming.turnId
    && hasFiniteSessionOrder(candidate)
    && hasFiniteSessionOrder(incoming)
  ) {
    return (candidate.sessionOrder as number) > (incoming.sessionOrder as number)
  }
  return false
}

function insertOrderedMessagesByTurn(messages: UiMessage[], appended: UiMessage[]): UiMessage[] {
  const merged = [...messages]
  for (const message of appended) {
    if (!message.turnId || (!hasFiniteTurnIndex(message) && !hasFiniteSessionOrder(message))) {
      merged.push(message)
      continue
    }

    let lastSameTurnIndex = -1
    let insertionIndex = -1
    for (let index = 0; index < merged.length; index += 1) {
      const candidate = merged[index]!
      if (candidate.turnId === message.turnId) {
        lastSameTurnIndex = index
      }
      if (shouldInsertBeforeOrderedMessage(candidate, message)) {
        insertionIndex = index
        break
      }
    }

    if (insertionIndex < 0) {
      insertionIndex = lastSameTurnIndex >= 0 ? lastSameTurnIndex + 1 : merged.length
    }
    merged.splice(insertionIndex, 0, message)
  }
  return merged
}

function mergeOptimisticSubmissionsForDisplay(
  persisted: UiMessage[],
  optimistic: OptimisticUserSubmission[],
): UiMessage[] {
  if (optimistic.length === 0) return persisted
  const merged = [...persisted]
  for (const submission of optimistic) {
    const anchorIndex = submission.afterMessageId
      ? merged.findIndex((message) => message.id === submission.afterMessageId)
      : -1
    const insertionIndex = submission.afterMessageId
      ? (anchorIndex >= 0 ? anchorIndex + 1 : merged.length)
      : 0
    merged.splice(insertionIndex, 0, submission.message)
  }
  return merged
}

function mergeMessages(
  previous: UiMessage[],
  incoming: UiMessage[],
  options: {
    preserveMissing?: boolean
    preserveOrderedRows?: boolean
    allowEqualOrderTextGrowth?: boolean
  } = {},
): UiMessage[] {
  const previousById = new Map(previous.map((message) => [message.id, message]))
  const incomingById = new Map(incoming.map((message) => [message.id, message]))
  const previousMaxSessionOrderByTurn = options.preserveOrderedRows === true
    ? buildMaxSessionOrderByTurn(previous)
    : new Map<string, number>()
  const incomingHasOrderedRegression = options.preserveOrderedRows === true
    && incoming.some((incomingMessage) => {
      const previousMessage = previousById.get(incomingMessage.id)
      return Boolean(previousMessage && shouldKeepPreviousOrderedMessage(previousMessage, incomingMessage, {
        allowEqualOrderTextGrowth: options.allowEqualOrderTextGrowth,
      }))
    })

  const mergedIncoming = incoming.map((incomingMessage) => {
    const previousMessage = previousById.get(incomingMessage.id)
    if (
      options.preserveOrderedRows === true
      && previousMessage
      && shouldKeepPreviousOrderedMessage(previousMessage, incomingMessage, {
        allowEqualOrderTextGrowth: options.allowEqualOrderTextGrowth,
      })
    ) {
      return previousMessage
    }
    if (previousMessage && areMessageFieldsEqual(previousMessage, incomingMessage)) {
      return previousMessage
    }
    return incomingMessage
  }).filter((message) => !(
    options.preserveOrderedRows === true
    && incomingHasOrderedRegression
    && !previousById.has(message.id)
    && isStaleOrderedAppend(message, previousMaxSessionOrderByTurn)
  ))

  if (options.preserveMissing !== true) {
    const reorderedIncoming = reorderLateDelegatedUserMessagesForDisplay(mergedIncoming)
    return areMessageArraysEqual(previous, reorderedIncoming) ? previous : reorderedIncoming
  }

  const mergedFromPrevious = previous
    .map((previousMessage) => {
      const nextMessage = incomingById.get(previousMessage.id)
      if (!nextMessage) {
        return previousMessage
      }
      if (
        options.preserveOrderedRows === true
        && shouldKeepPreviousOrderedMessage(previousMessage, nextMessage, {
          allowEqualOrderTextGrowth: options.allowEqualOrderTextGrowth,
        })
      ) {
        return previousMessage
      }
      if (areMessageFieldsEqual(previousMessage, nextMessage)) {
        return previousMessage
      }
      return nextMessage
    })
    .filter((message) => !isOptimisticUserMessage(message) || !hasEquivalentUserMessage(message, incoming))

  const previousIdSet = new Set(previous.map((message) => message.id))
  const appended = mergedIncoming.filter((message) => !previousIdSet.has(message.id))
  const combined = options.preserveOrderedRows === true
    ? insertOrderedMessagesByTurn(mergedFromPrevious, appended)
    : [...mergedFromPrevious, ...appended]
  const merged = reorderLateDelegatedUserMessagesForDisplay(combined)

  return areMessageArraysEqual(previous, merged) ? previous : merged
}

function mergeLiveProjectionMessages(
  previous: UiMessage[],
  incoming: UiMessage[],
  incomingTurnIdsOverride: Iterable<string> = [],
): UiMessage[] {
  const incomingTurnIds = new Set(
    Array.from(incomingTurnIdsOverride)
      .filter((turnId) => typeof turnId === 'string' && turnId.length > 0),
  )
  const incomingTurnIndexes = new Set(
    incoming
      .map((message) => message.turnIndex)
      .filter((turnIndex): turnIndex is number => (
        typeof turnIndex === 'number' && Number.isFinite(turnIndex)
      )),
  )
  for (const message of incoming) {
    if (typeof message.turnId === 'string' && message.turnId.length > 0) {
      incomingTurnIds.add(message.turnId)
    }
  }
  if (incomingTurnIndexes.size === 0 && incomingTurnIds.size === 0) {
    return mergeMessages(previous, incoming, { preserveMissing: true })
  }

  const preserved = previous.filter((message) => {
    if (
      typeof message.turnIndex === 'number'
      && incomingTurnIndexes.has(message.turnIndex)
    ) {
      return false
    }
    return !message.turnId || !incomingTurnIds.has(message.turnId)
  })
  return mergeMessages(preserved, incoming, { preserveMissing: true })
}

function authoritativeTurnSets(
  incoming: readonly UiMessage[],
  incomingTurnIdsOverride: Iterable<string> = [],
): { turnIds: Set<string>; turnIndexes: Set<number> } {
  const turnIds = new Set(
    Array.from(incomingTurnIdsOverride)
      .filter((turnId) => typeof turnId === 'string' && turnId.length > 0),
  )
  const turnIndexes = new Set<number>()
  for (const message of incoming) {
    if (typeof message.turnId === 'string' && message.turnId.length > 0) {
      turnIds.add(message.turnId)
    } else if (
      typeof message.turnIndex === 'number'
      && Number.isFinite(message.turnIndex)
    ) {
      turnIndexes.add(message.turnIndex)
    }
  }
  return { turnIds, turnIndexes }
}

function matchesAuthoritativeTurn(
  message: UiMessage,
  turnIds: ReadonlySet<string>,
  turnIndexes: ReadonlySet<number>,
): boolean {
  if (typeof message.turnId === 'string' && message.turnId.length > 0) {
    return turnIds.has(message.turnId)
  }
  return (
    typeof message.turnIndex === 'number'
    && Number.isFinite(message.turnIndex)
    && turnIndexes.has(message.turnIndex)
  )
}

function filterStaleAuthoritativeIncomingMessages(
  previous: UiMessage[],
  incoming: UiMessage[],
  incomingTurnIdsOverride: Iterable<string> = [],
  options: { allowEqualOrderTextGrowth?: boolean } = {},
): UiMessage[] {
  const { turnIds, turnIndexes } = authoritativeTurnSets(incoming, incomingTurnIdsOverride)
  if (turnIds.size === 0 && turnIndexes.size === 0) return incoming

  const finalAgentTurnIds = hasIncomingFinalAgentMessageByTurn(incoming)
  const finalFilteredIncoming = finalAgentTurnIds.size === 0
    ? incoming
    : incoming.filter((message) => !(
        message.role === 'assistant'
        && message.messageType === 'agentMessage'
        && message.phase === 'commentary'
        && message.turnId
        && finalAgentTurnIds.has(message.turnId)
        && matchesAuthoritativeTurn(message, turnIds, turnIndexes)
      ))

  const previousById = new Map(previous.map((message) => [message.id, message]))
  const hasOrderedRegression = finalFilteredIncoming.some((message) => {
    if (!matchesAuthoritativeTurn(message, turnIds, turnIndexes)) return false
    const previousMessage = previousById.get(message.id)
    return Boolean(previousMessage && shouldKeepPreviousOrderedMessage(previousMessage, message, {
      allowEqualOrderTextGrowth: options.allowEqualOrderTextGrowth,
    }))
  })
  if (!hasOrderedRegression) return finalFilteredIncoming

  const previousMaxSessionOrderByTurn = buildMaxSessionOrderByTurn(previous)
  const filtered = finalFilteredIncoming.filter((message) => {
    if (!matchesAuthoritativeTurn(message, turnIds, turnIndexes)) return true
    if (previousById.has(message.id)) return true
    return !isStaleOrderedAppend(message, previousMaxSessionOrderByTurn)
  })
  return filtered.length === finalFilteredIncoming.length ? finalFilteredIncoming : filtered
}

function hasIncomingFinalAgentMessageByTurn(messages: readonly UiMessage[]): Set<string> {
  const turnIds = new Set<string>()
  for (const message of messages) {
    if (
      message.turnId
      && message.role === 'assistant'
      && message.messageType === 'agentMessage'
      && (message.phase === 'final' || message.phase === 'final_answer')
    ) {
      turnIds.add(message.turnId)
    }
  }
  return turnIds
}

function isPrunableCompletedActiveTextMessage(message: UiMessage): boolean {
  if (!message.turnId || message.role !== 'assistant') return false
  if (message.messageType === 'reasoning') return true
  if (message.messageType !== 'agentMessage') return false
  if (message.phase === 'final' || message.phase === 'final_answer') return false
  if (message.phase === 'commentary') return true
  return false
}

function prunePreviousMessagesForAuthoritativeTurns(
  previous: UiMessage[],
  incoming: UiMessage[],
  incomingTurnIdsOverride: Iterable<string> = [],
  options: { prunableTurnIds?: Iterable<string> } = {},
): UiMessage[] {
  const { turnIds, turnIndexes } = authoritativeTurnSets(incoming, incomingTurnIdsOverride)
  if (turnIds.size === 0 && turnIndexes.size === 0) return previous

  const prunableTurnIds = new Set(
    Array.from(options.prunableTurnIds ?? [])
      .filter((turnId) => typeof turnId === 'string' && turnId.length > 0),
  )
  if (prunableTurnIds.size === 0) return previous

  const incomingById = new Set(incoming.map((message) => message.id))
  const pruned = previous.filter((message) => {
    if (incomingById.has(message.id)) return true
    if (message.role === 'user' || isOptimisticUserMessage(message)) return true
    if (!message.turnId || !prunableTurnIds.has(message.turnId)) return true
    if (!isPrunableCompletedActiveTextMessage(message)) {
      return true
    }
    return !matchesAuthoritativeTurn(message, turnIds, turnIndexes)
  })
  return pruned.length === previous.length ? previous : pruned
}

function areUiFileChangesEqual(first?: UiFileChange[], second?: UiFileChange[]): boolean {
  if (!first && !second) return true
  if (!first || !second) return false
  if (first.length !== second.length) return false
  for (let index = 0; index < first.length; index += 1) {
    const firstChange = first[index]
    const secondChange = second[index]
    if (
      firstChange.path !== secondChange.path ||
      firstChange.operation !== secondChange.operation ||
      firstChange.movedToPath !== secondChange.movedToPath ||
      firstChange.diff !== secondChange.diff ||
      firstChange.addedLineCount !== secondChange.addedLineCount ||
      firstChange.removedLineCount !== secondChange.removedLineCount
    ) {
      return false
    }
  }
  return true
}

function normalizeMessageText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

function isOptimisticUserMessage(message: UiMessage): boolean {
  return message.messageType === 'userMessage.optimistic'
}

function hasOptimisticUserMessages(messages: UiMessage[]): boolean {
  return messages.some(isOptimisticUserMessage)
}

function fileAttachmentIdentity(message: UiMessage): string[] {
  return (message.fileAttachments ?? []).map((attachment) => (
    `${attachment.label.trim()}\u0000${attachment.path.trim()}`
  ))
}

function skillAttachmentIdentity(message: UiMessage): string[] {
  return (message.skills ?? []).map((skill) => (
    `${skill.name.trim()}\u0000${skill.path.trim()}`
  ))
}

function areEquivalentUserMessages(target: UiMessage, message: UiMessage): boolean {
  if (target.role !== 'user' || message.role !== 'user') return false
  const targetText = normalizeMessageText(target.text)
  const targetImages = Array.isArray(target.images) ? target.images : []
  const targetFiles = fileAttachmentIdentity(target)
  const targetSkills = skillAttachmentIdentity(target)
  const messageText = normalizeMessageText(message.text)
  const messageImages = Array.isArray(message.images) ? message.images : []
  const messageFiles = fileAttachmentIdentity(message)
  const messageSkills = skillAttachmentIdentity(message)
  return (
    messageText === targetText &&
    areStringArraysEqual(messageImages, targetImages) &&
    areStringArraysEqual(messageFiles, targetFiles) &&
    areStringArraysEqual(messageSkills, targetSkills)
  )
}

function hasEquivalentUserMessage(target: UiMessage, messages: UiMessage[]): boolean {
  return messages.some((message) => (
    message !== target
    && !isOptimisticUserMessage(message)
    && areEquivalentUserMessages(target, message)
  ))
}

function countEquivalentUserMessages(target: UiMessage, messages: UiMessage[]): number {
  return messages.reduce((count, message) => (
    hasEquivalentUserMessage(target, [message]) ? count + 1 : count
  ), 0)
}

function removeRedundantLiveAgentMessages(previous: UiMessage[], incoming: UiMessage[]): UiMessage[] {
  const incomingMessageIds = new Set(incoming.map((message) => message.id))
  const incomingAssistantTexts = new Set(
    incoming
      .filter((message) => message.role === 'assistant')
      .map((message) => normalizeMessageText(message.text))
      .filter((text) => text.length > 0),
  )

  const next = previous.filter((message) => {
    if (message.messageType !== 'agentMessage.live') return true
    if (incomingMessageIds.has(message.id)) return false
    const normalized = normalizeMessageText(message.text)
    if (normalized.length === 0) return (message.directives?.length ?? 0) > 0
    return !incomingAssistantTexts.has(normalized)
  })

  return next.length === previous.length ? previous : next
}

function removePersistedLiveMessages(previous: UiMessage[], incoming: UiMessage[]): UiMessage[] {
  const incomingIds = new Set(incoming.map((message) => message.id))
  const next = previous.filter((message) => !incomingIds.has(message.id))
  return next.length === previous.length ? previous : next
}

function upsertMessage(previous: UiMessage[], nextMessage: UiMessage): UiMessage[] {
  const existingIndex = previous.findIndex((message) => message.id === nextMessage.id)
  if (existingIndex < 0) {
    return [...previous, nextMessage]
  }

  const existing = previous[existingIndex]
  if (areMessageFieldsEqual(existing, nextMessage)) {
    return previous
  }

  const next = [...previous]
  next.splice(existingIndex, 1, nextMessage)
  return next
}

type TurnSummaryState = {
  turnId: string
  durationMs: number | null
  status: TurnTerminalStatus
  completedAtMs?: number | null
}

type TurnActivityState = {
  label: string
  details: string[]
}

type TurnErrorState = {
  message: string
  transient: boolean
}

type TurnStartedInfo = {
  threadId: string
  turnId: string
  startedAtMs: number
}

type TurnCompletedInfo = {
  threadId: string
  turnId: string
  status: TurnTerminalStatus
  completedAtMs: number
  startedAtMs?: number
}

const WORKED_MESSAGE_TYPE = 'worked'

function parseIsoTimestamp(value: string): number | null {
  if (!value) return null
  const ms = new Date(value).getTime()
  return Number.isNaN(ms) ? null : ms
}

function formatTurnDuration(durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs)) {
    return ''
  }
  if (durationMs <= 0) {
    return '<1s'
  }

  const totalSeconds = Math.max(1, Math.round(durationMs / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const parts: string[] = []

  if (hours > 0) {
    parts.push(`${hours}h`)
  }

  if (minutes > 0 || hours > 0) {
    parts.push(`${minutes}m`)
  }

  const displaySeconds = seconds > 0 || parts.length === 0 ? seconds : 0
  parts.push(`${displaySeconds}s`)
  return parts.join(' ')
}

function areTurnSummariesEqual(first?: TurnSummaryState, second?: TurnSummaryState): boolean {
  if (!first && !second) return true
  if (!first || !second) return false
  return first.turnId === second.turnId
    && first.durationMs === second.durationMs
    && first.status === second.status
}

function areTurnActivitiesEqual(first?: TurnActivityState, second?: TurnActivityState): boolean {
  if (!first && !second) return true
  if (!first || !second) return false
  if (first.label !== second.label) return false
  if (first.details.length !== second.details.length) return false
  for (let index = 0; index < first.details.length; index += 1) {
    if (first.details[index] !== second.details[index]) return false
  }
  return true
}

function buildTurnSummaryMessage(summary: TurnSummaryState): UiMessage {
  const durationLabel = formatTurnDuration(summary.durationMs)
  const durationSuffix = durationLabel ? ` after ${durationLabel}` : ''
  const workedSuffix = durationLabel ? ` for ${durationLabel}` : ''
  return {
    id: `turn-summary:${summary.turnId}`,
    role: 'system',
    text: summary.status === 'interrupted'
      ? `You stopped${durationSuffix}`
      : `Worked${workedSuffix}`,
    messageType: WORKED_MESSAGE_TYPE,
    turnId: summary.turnId,
    createdAtMs: summary.completedAtMs ?? null,
  }
}

function findLastAssistantMessageIndex(messages: UiMessage[], turnId: string): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'assistant' && messages[index].turnId === turnId) {
      return index
    }
  }
  return -1
}

function insertTurnSummaryMessage(messages: UiMessage[], summary: TurnSummaryState): UiMessage[] {
  const summaryMessageId = `turn-summary:${summary.turnId}`
  const sanitizedMessages = messages.filter((message) => (
    message.id !== summaryMessageId
    && !(message.messageType === WORKED_MESSAGE_TYPE && message.turnId === summary.turnId)
  ))
  if (summary.status === 'interrupted') {
    return sanitizedMessages
  }
  const summaryMessage = buildTurnSummaryMessage(summary)
  const finalAssistantIndex = findLastAssistantMessageIndex(sanitizedMessages, summary.turnId)
  if (finalAssistantIndex >= 0) {
    const next = [...sanitizedMessages]
    next.splice(finalAssistantIndex, 0, summaryMessage)
    return next
  }
  let lastTurnIndex = -1
  for (let index = sanitizedMessages.length - 1; index >= 0; index -= 1) {
    if (sanitizedMessages[index].turnId === summary.turnId) {
      lastTurnIndex = index
      break
    }
  }
  if (lastTurnIndex < 0) {
    const hasTurnMetadata = sanitizedMessages.some((message) => Boolean(message.turnId))
    if (!hasTurnMetadata) {
      let legacyAssistantIndex = -1
      for (let index = sanitizedMessages.length - 1; index >= 0; index -= 1) {
        if (sanitizedMessages[index].role === 'assistant') {
          legacyAssistantIndex = index
          break
        }
      }
      if (legacyAssistantIndex >= 0) {
        const next = [...sanitizedMessages]
        next.splice(legacyAssistantIndex, 0, summaryMessage)
        return next
      }
    }
    return [...sanitizedMessages, summaryMessage]
  }
  const next = [...sanitizedMessages]
  next.splice(lastTurnIndex + 1, 0, summaryMessage)
  return next
}

function insertTurnSummaryMessages(
  messages: UiMessage[],
  summaries: readonly TurnSummaryState[],
): UiMessage[] {
  return summaries.reduce(
    (next, summary) => insertTurnSummaryMessage(next, summary),
    messages,
  )
}

function loadPersistedTurnSummaryMap(): Record<string, Record<string, TurnSummaryState>> {
  if (typeof window === 'undefined') return {}

  try {
    const raw = window.localStorage.getItem(TURN_COMPLETION_SUMMARY_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

    const result: Record<string, Record<string, TurnSummaryState>> = {}
    for (const [threadId, threadValue] of Object.entries(parsed as Record<string, unknown>)) {
      if (!threadId || !threadValue || typeof threadValue !== 'object' || Array.isArray(threadValue)) continue
      const summaries: Record<string, TurnSummaryState> = {}
      for (const [turnId, summaryValue] of Object.entries(threadValue as Record<string, unknown>)) {
        if (!turnId || !summaryValue || typeof summaryValue !== 'object' || Array.isArray(summaryValue)) continue
        const summary = summaryValue as Record<string, unknown>
        const status = typeof summary.status === 'string' ? summary.status.trim() : ''
        const durationMs = summary.durationMs === null
          ? null
          : typeof summary.durationMs === 'number' && Number.isFinite(summary.durationMs)
            ? Math.max(0, summary.durationMs)
            : null
        const completedAtMs = summary.completedAtMs === null
          ? null
          : typeof summary.completedAtMs === 'number' && Number.isFinite(summary.completedAtMs)
            ? Math.max(0, summary.completedAtMs)
            : null
        if (!status) continue
        summaries[turnId] = { turnId, status, durationMs, completedAtMs }
      }
      if (Object.keys(summaries).length > 0) {
        result[threadId] = summaries
      }
    }
    return result
  } catch {
    return {}
  }
}

function savePersistedTurnSummaryMap(
  state: Record<string, Record<string, TurnSummaryState>>,
): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(TURN_COMPLETION_SUMMARY_STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Keep live completion boundaries usable when storage is unavailable.
  }
}

function omitKey<TValue>(record: Record<string, TValue>, key: string): Record<string, TValue> {
  if (!(key in record)) return record
  const next = { ...record }
  delete next[key]
  return next
}

function omitKeys<TValue>(record: Record<string, TValue>, keys: Set<string>): Record<string, TValue> {
  if (keys.size === 0) return record
  let changed = false
  const next: Record<string, TValue> = {}
  for (const [key, value] of Object.entries(record)) {
    if (keys.has(key)) {
      changed = true
      continue
    }
    next[key] = value
  }
  return changed ? next : record
}

function areThreadFieldsEqual(first: UiThread, second: UiThread): boolean {
  return (
    first.id === second.id &&
    first.title === second.title &&
    first.projectName === second.projectName &&
    first.cwd === second.cwd &&
    first.createdAtIso === second.createdAtIso &&
    first.updatedAtIso === second.updatedAtIso &&
    first.preview === second.preview &&
    first.unread === second.unread &&
    first.desktopHasUserEvent === second.desktopHasUserEvent &&
    first.inProgress === second.inProgress &&
    first.pendingRequestState === second.pendingRequestState
  )
}

function areThreadArraysEqual(first: UiThread[], second: UiThread[]): boolean {
  if (first.length !== second.length) return false
  for (let index = 0; index < first.length; index += 1) {
    if (first[index] !== second[index]) return false
  }
  return true
}

function areGroupArraysEqual(first: UiProjectGroup[], second: UiProjectGroup[]): boolean {
  if (first.length !== second.length) return false
  for (let index = 0; index < first.length; index += 1) {
    if (first[index] !== second[index]) return false
  }
  return true
}

function pruneThreadStateMap<T>(stateMap: Record<string, T>, threadIds: Set<string>): Record<string, T> {
  const nextEntries = Object.entries(stateMap).filter(([threadId]) => threadIds.has(threadId))
  if (nextEntries.length === Object.keys(stateMap).length) {
    return stateMap
  }
  return Object.fromEntries(nextEntries) as Record<string, T>
}

export function removeThreadFromGroups(groups: UiProjectGroup[], threadId: string): UiProjectGroup[] {
  const normalizedThreadId = threadId.trim()
  if (!normalizedThreadId) return groups

  let changed = false
  const nextGroups: UiProjectGroup[] = []

  for (const group of groups) {
    const nextThreads = group.threads.filter((thread) => thread.id !== normalizedThreadId)
    const removedFromGroup = nextThreads.length !== group.threads.length
    if (removedFromGroup) {
      changed = true
    }
    if (nextThreads.length > 0) {
      nextGroups.push(removedFromGroup ? { ...group, threads: nextThreads } : group)
    } else if (group.threads.length === 0) {
      nextGroups.push(group)
    }
  }

  return changed ? nextGroups : groups
}

function mergeThreadGroups(
  previous: UiProjectGroup[],
  incoming: UiProjectGroup[],
): UiProjectGroup[] {
  const previousGroupsByName = new Map(previous.map((group) => [group.projectName, group]))
  const mergedGroups: UiProjectGroup[] = incoming.map((incomingGroup) => {
    const previousGroup = previousGroupsByName.get(incomingGroup.projectName)
    const previousThreadsById = new Map(previousGroup?.threads.map((thread) => [thread.id, thread]) ?? [])

    const mergedThreads = incomingGroup.threads.map((incomingThread) => {
      const previousThread = previousThreadsById.get(incomingThread.id)
      if (previousThread && areThreadFieldsEqual(previousThread, incomingThread)) {
        return previousThread
      }
      return incomingThread
    })

    if (
      previousGroup &&
      previousGroup.projectName === incomingGroup.projectName &&
      areThreadArraysEqual(previousGroup.threads, mergedThreads)
    ) {
      return previousGroup
    }

    return {
      projectName: incomingGroup.projectName,
      threads: mergedThreads,
    }
  })

  return areGroupArraysEqual(previous, mergedGroups) ? previous : mergedGroups
}

function mergeIncomingWithLocalInProgressThreads(
  previous: UiProjectGroup[],
  incoming: UiProjectGroup[],
  inProgressById: Record<string, boolean>,
): UiProjectGroup[] {
  const incomingThreadIds = new Set(flattenThreads(incoming).map((thread) => thread.id))
  const localInProgressThreads = flattenThreads(previous).filter(
    (thread) => inProgressById[thread.id] === true && !incomingThreadIds.has(thread.id),
  )

  if (localInProgressThreads.length === 0) {
    return incoming
  }

  const incomingByProjectName = new Map(incoming.map((group) => [group.projectName, group]))
  const merged: UiProjectGroup[] = incoming.map((group) => ({
    projectName: group.projectName,
    threads: [...group.threads],
  }))

  for (const thread of localInProgressThreads) {
    const existingGroup = incomingByProjectName.get(thread.projectName)
    if (existingGroup) {
      const mergedGroupIndex = merged.findIndex((group) => group.projectName === thread.projectName)
      if (mergedGroupIndex >= 0) {
        merged[mergedGroupIndex] = {
          projectName: merged[mergedGroupIndex].projectName,
          threads: [thread, ...merged[mergedGroupIndex].threads],
        }
      }
      continue
    }

    merged.push({
      projectName: thread.projectName,
      threads: [thread],
    })
  }

  return merged
}

function setThreadInProgressInGroups(
  groups: UiProjectGroup[],
  threadId: string,
  inProgress: boolean,
): UiProjectGroup[] {
  let changed = false
  const nextGroups = groups.map((group) => {
    let groupChanged = false
    const nextThreads = group.threads.map((thread) => {
      if (thread.id !== threadId) return thread
      if ((thread.inProgress === true) === inProgress) return thread
      groupChanged = true
      return { ...thread, inProgress }
    })
    if (!groupChanged) return group
    changed = true
    return { ...group, threads: nextThreads }
  })

  return changed ? nextGroups : groups
}

function toProjectNameFromWorkspaceRoot(value: string): string {
  return toProjectName(value)
}

function getRemoteProjectHostLabel(hostId: string): string {
  const normalized = hostId.trim()
  if (!normalized) return ''
  const separatorIndex = normalized.lastIndexOf(':')
  return separatorIndex >= 0 ? normalized.slice(separatorIndex + 1) : normalized
}

function getRemoteProjectDisplayName(remoteProject: NonNullable<WorkspaceRootsState['remoteProjects']>[number]): string {
  const label = remoteProject.label || toProjectName(remoteProject.remotePath) || remoteProject.id
  const hostLabel = getRemoteProjectHostLabel(remoteProject.hostId)
  return hostLabel ? `${label} ${hostLabel}` : label
}

function getRemoteProjectById(rootsState: WorkspaceRootsState | null): Map<string, NonNullable<WorkspaceRootsState['remoteProjects']>[number]> {
  const remoteProjects = rootsState?.remoteProjects ?? []
  return new Map(remoteProjects.map((project) => [project.id, project]))
}

function getWorkspaceProjectOrderPaths(rootsState: WorkspaceRootsState | null): string[] {
  if (!rootsState) return []
  const savedRoots = new Set(rootsState.order)
  const remoteProjectIds = new Set((rootsState.remoteProjects ?? []).map((project) => project.id))
  const orderedRoots = rootsState.projectOrder.filter((item) => savedRoots.has(item) || remoteProjectIds.has(item))
  for (const rootPath of rootsState.order) {
    if (!orderedRoots.includes(rootPath)) orderedRoots.push(rootPath)
  }
  for (const remoteProjectId of remoteProjectIds) {
    if (!orderedRoots.includes(remoteProjectId)) orderedRoots.push(remoteProjectId)
  }
  return orderedRoots
}

function getWorkspaceProjectOrderNames(
  rootsState: WorkspaceRootsState | null,
  duplicateLeafNames: Set<string>,
): string[] {
  const remoteProjectsById = getRemoteProjectById(rootsState)
  return getWorkspaceProjectOrderPaths(rootsState).map((rootPath) => {
    if (remoteProjectsById.has(rootPath)) return rootPath
    const normalizedRootPath = normalizePathForUi(rootPath).trim()
    const leafName = toProjectNameFromWorkspaceRoot(normalizedRootPath)
    return duplicateLeafNames.has(leafName) ? normalizedRootPath : leafName
  })
}

function matchesWorkspaceRootProject(rootPath: string, projectName: string): boolean {
  const normalizedRootPath = normalizePathForUi(rootPath).trim()
  return normalizedRootPath === projectName || toProjectNameFromWorkspaceRoot(rootPath) === projectName
}

export function collectWorkspaceRootPathsForProjectRemoval(
  rootsState: WorkspaceRootsState,
  projectName: string,
): Set<string> {
  const removedRootPaths = new Set<string>()
  for (const rootPath of rootsState.order) {
    if (matchesWorkspaceRootProject(rootPath, projectName)) {
      removedRootPaths.add(rootPath)
    }
  }
  for (const rootPath of rootsState.active) {
    if (matchesWorkspaceRootProject(rootPath, projectName)) {
      removedRootPaths.add(rootPath)
    }
  }
  for (const rootPath of Object.keys(rootsState.labels)) {
    if (matchesWorkspaceRootProject(rootPath, projectName)) {
      removedRootPaths.add(rootPath)
    }
  }
  return removedRootPaths
}

export function buildWorkspaceRootsProjectOrderState(
  rootsState: WorkspaceRootsState,
  orderedProjectNames: string[],
  groups: UiProjectGroup[],
): Pick<WorkspaceRootsState, 'order' | 'active' | 'projectOrder'> {
  const remoteProjectIds = new Set((rootsState.remoteProjects ?? []).map((project) => project.id))
  const rootByProjectName = new Map<string, string>()
  for (const rootPath of rootsState.order) {
    const projectName = toProjectNameFromWorkspaceRoot(rootPath)
    if (!rootByProjectName.has(projectName)) {
      rootByProjectName.set(projectName, rootPath)
    }
  }
  for (const group of groups) {
    const cwd = group.threads[0]?.cwd?.trim() ?? ''
    if (!cwd) continue
    rootByProjectName.set(group.projectName, cwd)
  }

  const nextProjectOrder: string[] = []
  const pushProjectOrderItem = (item: string): void => {
    if (item && !nextProjectOrder.includes(item)) {
      nextProjectOrder.push(item)
    }
  }

  for (const projectName of orderedProjectNames) {
    if (remoteProjectIds.has(projectName)) {
      pushProjectOrderItem(projectName)
      continue
    }
    const rootPath = rootByProjectName.get(projectName)
    if (rootPath) {
      pushProjectOrderItem(rootPath)
    }
  }
  for (const item of getWorkspaceProjectOrderPaths(rootsState)) {
    pushProjectOrderItem(item)
  }

  const nextOrder = nextProjectOrder.filter((item) => rootsState.order.includes(item))
  for (const rootPath of rootsState.order) {
    if (!nextOrder.includes(rootPath)) {
      nextOrder.push(rootPath)
    }
  }

  const nextActive = rootsState.active.filter((rootPath) => nextOrder.includes(rootPath))
  if (nextActive.length === 0 && nextOrder.length > 0) {
    nextActive.push(nextOrder[0])
  }

  return {
    order: nextOrder,
    active: nextActive,
    projectOrder: nextProjectOrder,
  }
}

function orderGroupsByWorkspaceProjectOrder(
  groups: UiProjectGroup[],
  rootsState: WorkspaceRootsState | null,
  duplicateLeafNames: Set<string>,
): UiProjectGroup[] {
  const order = getWorkspaceProjectOrderNames(rootsState, duplicateLeafNames)
  if (order.length === 0) return groups
  const orderIndexByName = new Map(order.map((name, index) => [name, index]))
  return [...groups].sort((first, second) => {
    if (isProjectlessGroup(first) || isProjectlessGroup(second)) return 0
    const firstIndex = orderIndexByName.get(first.projectName) ?? Number.POSITIVE_INFINITY
    const secondIndex = orderIndexByName.get(second.projectName) ?? Number.POSITIVE_INFINITY
    if (firstIndex === secondIndex) return 0
    return firstIndex - secondIndex
  })
}

function collectDuplicateProjectLeafNames(groups: UiProjectGroup[], rootsState: WorkspaceRootsState | null): Set<string> {
  const rootByLeafName = new Map<string, Set<string>>()
  const canonicalWorkspaceRootCountsByLeafName = new Map<string, number>()
  const addPath = (value: string): void => {
    const normalizedPath = normalizePathForUi(value).trim()
    if (!normalizedPath) return
    const leafName = toProjectName(normalizedPath)
    const existing = rootByLeafName.get(leafName) ?? new Set<string>()
    existing.add(normalizedPath)
    rootByLeafName.set(leafName, existing)
  }

  for (const rootPath of rootsState?.order ?? []) {
    const normalizedRootPath = normalizePathForUi(rootPath).trim()
    if (!normalizedRootPath) continue
    const leafName = toProjectName(normalizedRootPath)
    if (!isManagedCodexWorktreePath(normalizedRootPath)) {
      canonicalWorkspaceRootCountsByLeafName.set(leafName, (canonicalWorkspaceRootCountsByLeafName.get(leafName) ?? 0) + 1)
    }
    addPath(rootPath)
  }
  for (const group of groups) {
    for (const thread of group.threads) {
      const normalizedCwd = normalizePathForUi(thread.cwd).trim()
      const leafName = toProjectName(normalizedCwd)
      const isRegisteredRoot = rootsState?.order.some((rootPath) => normalizePathForUi(rootPath).trim() === normalizedCwd) === true
      if (isManagedCodexWorktreePath(normalizedCwd) && !isRegisteredRoot && canonicalWorkspaceRootCountsByLeafName.get(leafName) === 1) continue
      addPath(thread.cwd)
    }
  }

  const duplicateLeafNames = new Set<string>()
  for (const [leafName, paths] of rootByLeafName.entries()) {
    if (paths.size > 1) duplicateLeafNames.add(leafName)
  }
  return duplicateLeafNames
}

function isManagedCodexWorktreePath(value: string): boolean {
  return value.includes('/.codex/worktrees/')
}

function disambiguateProjectGroupsByCwd(
  groups: UiProjectGroup[],
  rootsState: WorkspaceRootsState | null,
): UiProjectGroup[] {
  const duplicateLeafNames = collectDuplicateProjectLeafNames(groups, rootsState)
  if (duplicateLeafNames.size === 0) return groups

  const uniqueCanonicalWorkspaceRootLeafNames = new Set<string>()
  const duplicateCanonicalWorkspaceRootLeafNames = new Set<string>()
  const canonicalWorkspaceRootByLeafName = new Map<string, string>()
  const registeredWorkspaceRoots = new Set<string>()
  for (const rootPath of rootsState?.order ?? []) {
    const normalizedRootPath = normalizePathForUi(rootPath).trim()
    if (!normalizedRootPath) continue
    registeredWorkspaceRoots.add(normalizedRootPath)
    if (isManagedCodexWorktreePath(normalizedRootPath)) continue
    const leafName = toProjectName(normalizedRootPath)
    if (uniqueCanonicalWorkspaceRootLeafNames.has(leafName)) {
      uniqueCanonicalWorkspaceRootLeafNames.delete(leafName)
      duplicateCanonicalWorkspaceRootLeafNames.add(leafName)
      canonicalWorkspaceRootByLeafName.delete(leafName)
    } else if (!duplicateCanonicalWorkspaceRootLeafNames.has(leafName)) {
      uniqueCanonicalWorkspaceRootLeafNames.add(leafName)
      canonicalWorkspaceRootByLeafName.set(leafName, normalizedRootPath)
    }
  }

  const disambiguatedGroups: UiProjectGroup[] = []
  const groupsByProjectName = new Map<string, UiProjectGroup>()
  for (const group of groups) {
    for (const thread of group.threads) {
      const normalizedCwd = normalizePathForUi(thread.cwd).trim()
      const leafName = toProjectName(normalizedCwd)
      const isRegisteredRoot = registeredWorkspaceRoots.has(normalizedCwd)
      const isCanonicalWorktreeThread = isManagedCodexWorktreePath(normalizedCwd)
        && !isRegisteredRoot
        && uniqueCanonicalWorkspaceRootLeafNames.has(leafName)
      let projectName = group.projectName
      if (isCanonicalWorktreeThread && duplicateLeafNames.has(leafName)) {
        projectName = canonicalWorkspaceRootByLeafName.get(leafName) ?? group.projectName
      } else if (normalizedCwd && duplicateLeafNames.has(leafName)) {
        projectName = normalizedCwd
      }
      const nextThread = thread.projectName === projectName ? thread : { ...thread, projectName }
      const existingGroup = groupsByProjectName.get(projectName)
      if (existingGroup) {
        existingGroup.threads.push(nextThread)
      } else {
        const nextGroup = { projectName, threads: [nextThread] }
        groupsByProjectName.set(projectName, nextGroup)
        disambiguatedGroups.push(nextGroup)
      }
    }
  }

  return disambiguatedGroups
}

function addWorkspaceRootPlaceholderGroups(
  groups: UiProjectGroup[],
  rootsState: WorkspaceRootsState | null,
  duplicateLeafNames: Set<string>,
): UiProjectGroup[] {
  if (!rootsState || (rootsState.order.length === 0 && (rootsState.remoteProjects ?? []).length === 0)) return groups
  const existingProjectNames = new Set(groups.map((group) => group.projectName))
  const nextGroups = [...groups]
  const remoteProjectsById = getRemoteProjectById(rootsState)

  for (const rootPath of getWorkspaceProjectOrderPaths(rootsState)) {
    if (remoteProjectsById.has(rootPath)) {
      if (existingProjectNames.has(rootPath)) continue
      nextGroups.push({ projectName: rootPath, threads: [] })
      existingProjectNames.add(rootPath)
      continue
    }
    const normalizedRootPath = normalizePathForUi(rootPath).trim()
    if (!normalizedRootPath) continue
    const leafName = toProjectNameFromWorkspaceRoot(normalizedRootPath)
    const projectName = duplicateLeafNames.has(leafName) ? normalizedRootPath : leafName
    if (existingProjectNames.has(projectName)) continue
    nextGroups.push({ projectName, threads: [] })
    existingProjectNames.add(projectName)
  }

  return nextGroups
}

function toOptimisticThreadTitle(message: string): string {
  const firstLine = message
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)

  if (!firstLine) return 'Untitled thread'
  return firstLine.slice(0, 80)
}

function toForkedThreadTitle(title: string): string {
  const normalizedTitle = title.trim() || 'Untitled thread'
  return /^fork:\s+/iu.test(normalizedTitle) ? normalizedTitle : `Fork: ${normalizedTitle}`
}

function isProjectlessGroup(group: UiProjectGroup): boolean {
  return group.threads.some((thread) => thread.cwd.trim().length === 0 || isProjectlessChatPath(thread.cwd))
}

export function filterGroupsByWorkspaceRoots(
  groups: UiProjectGroup[],
  rootsState: WorkspaceRootsState | null,
): UiProjectGroup[] {
  const duplicateLeafNames = collectDuplicateProjectLeafNames(groups, rootsState)
  const disambiguatedGroups = disambiguateProjectGroupsByCwd(groups, rootsState)
  const groupsWithWorkspaceRoots = addWorkspaceRootPlaceholderGroups(disambiguatedGroups, rootsState, duplicateLeafNames)
  if (!rootsState || (rootsState.order.length === 0 && (rootsState.remoteProjects ?? []).length === 0)) return groupsWithWorkspaceRoots
  const allowedProjectNames = new Set<string>()
  for (const projectName of getWorkspaceProjectOrderNames(rootsState, duplicateLeafNames)) {
    allowedProjectNames.add(projectName)
  }
  const filteredGroups = groupsWithWorkspaceRoots.filter((group) => allowedProjectNames.has(group.projectName) || isProjectlessGroup(group))
  return orderGroupsByWorkspaceProjectOrder(filteredGroups, rootsState, duplicateLeafNames)
}

export function useDesktopState() {
  const projectGroups = ref<UiProjectGroup[]>([])
  const sourceGroups = ref<UiProjectGroup[]>([])
  const selectedThreadId = ref(loadSelectedThreadId())
  const persistedMessagesByThreadId = ref<Record<string, UiMessage[]>>({})
  const optimisticUserMessagesByThreadId = ref<Record<string, OptimisticUserSubmission[]>>({})
  const pendingNewThreadMessages = computed<UiMessage[]>(() => (
    optimisticUserMessagesByThreadId.value[NEW_THREAD_COLLABORATION_MODE_CONTEXT]
      ?.map((submission) => submission.message) ?? []
  ))
  const livePlanMessagesByThreadId = ref<Record<string, UiMessage[]>>({})
  const liveAgentMessagesByThreadId = ref<Record<string, UiMessage[]>>({})
  const liveAgentRawTextByThreadId = new Map<string, Map<string, string>>()
  const liveReasoningTextByThreadId = ref<Record<string, string>>({})
  const liveCommandsByThreadId = ref<Record<string, UiMessage[]>>({})
  const liveFileChangeMessagesByThreadId = ref<Record<string, UiMessage[]>>({})
  const inProgressById = ref<Record<string, boolean>>({})
  type FileAttachment = { label: string; path: string; fsPath: string; uploadHandle?: string }
  type QueuedMessage = {
    id: string
    queueAfterId?: string
    queueBeforeId?: string
    text: string
    imageUrls: string[]
    skills: Array<{ name: string; path: string }>
    fileAttachments: FileAttachment[]
    collaborationMode: CollaborationModeKind
    model: string
    effort: ReasoningEffort | ''
  }
  type PendingTurnRequest = {
    text: string
    imageUrls: string[]
    skills: Array<{ name: string; path: string }>
    fileAttachments: FileAttachment[]
    effort: ReasoningEffort | ''
    collaborationMode: CollaborationModeKind
    fallbackRetried: boolean
  }
  type LocalSubmissionState = {
    generation: number
    optimisticMessageId: string
    turnStartIssued: boolean
    pendingTurnRequest?: PendingTurnRequest
  }
  type PendingStopRequest = {
    generation: number
    promise: Promise<void>
    resolve: () => void
    interruptPromise: Promise<void> | null
    settled: boolean
  }
  type PendingNewThreadSubmission = {
    generation: number
    threadId: string
    stopRequested: boolean
  }
  const queuedMessagesByThreadId = ref<Record<string, QueuedMessage[]>>({})
  const queueProcessingByThreadId = ref<Record<string, boolean>>({})
  const pendingQueueRefreshThreadIds = new Set<string>()
  const pendingQueueAppendMessageIdsByThreadId = new Map<string, Set<string>>()
  const queueRefreshDuringPendingAppendThreadIds = new Set<string>()
  const queuePositionRepairThreadIds = new Set<string>()
  let hasLoadedPersistedQueueState = false
  let queueMutationVersion = 0
  let queueRefreshRequestVersion = 0
  let latestQueueRevision = 0
  const eventUnreadByThreadId = ref<Record<string, boolean>>({})
  const availableModelIds = ref<string[]>([])
  const availableCollaborationModes = ref<CollaborationModeOption[]>([
    { value: 'default', label: 'Default' },
    { value: 'plan', label: 'Plan' },
  ])
  const selectedCollaborationModeByContext = ref<Record<string, CollaborationModeKind>>(
    loadSelectedCollaborationModeMap(),
  )
  const selectedModelIdByContext = ref<Record<string, string>>(loadSelectedModelMap())
  const selectedCollaborationMode = ref<CollaborationModeKind>(
    readSelectedCollaborationMode(selectedCollaborationModeByContext.value, selectedThreadId.value),
  )
  const selectedModelId = ref(readSelectedModel(selectedModelIdByContext.value, selectedThreadId.value))
  const selectedReasoningEffort = ref<ReasoningEffort | ''>('medium')
  const selectedSpeedMode = ref<SpeedMode>(
    isMobileCodexWebClient() ? DEFAULT_CODEX_NEW_THREAD_SPEED_MODE : 'standard',
  )
  const hasUserSelectedSpeedMode = ref(false)
  const activeProviderId = ref('')
  const codexCliMissingError = ref('')
  const readStateByThreadId = ref<Record<string, string>>(loadReadStateMap())
  const unreadCutoffIso = ref(loadUnreadCutoffIso())
  const projectOrder = ref<string[]>(loadProjectOrder())
  const projectDisplayNameById = ref<Record<string, string>>(loadProjectDisplayNames())
  const loadedVersionByThreadId = ref<Record<string, string>>({})
  const loadedMessagesByThreadId = ref<Record<string, boolean>>({})
  const hasMoreOlderMessagesByThreadId = ref<Record<string, boolean>>({})
  const olderTurnCursorByThreadId = ref<Record<string, string | null>>({})
  const activeTextOlderCursorByThreadId = ref<Record<string, string | null>>({})
  const consumedOlderTurnCursorsByThreadId = new Map<string, Set<string>>()
  const loadingOlderMessagesByThreadId = ref<Record<string, boolean>>({})
  const resumedThreadById = ref<Record<string, boolean>>({})
  const turnIndexByTurnIdByThreadId = ref<Record<string, Record<string, number>>>({})
  const turnSummaryByThreadId = ref<Record<string, TurnSummaryState>>({})
  const persistedTurnSummaryByThreadId = ref<Record<string, Record<string, TurnSummaryState>>>(
    loadPersistedTurnSummaryMap(),
  )
  const terminalTurnIdsByThreadId = new Map<string, Set<string>>()
  const recentlyCompletedActiveTurnIdByThreadId = new Map<string, string>()
  const turnActivityByThreadId = ref<Record<string, TurnActivityState>>({})
  const turnErrorByThreadId = ref<Record<string, TurnErrorState>>({})
  const activeTurnIdByThreadId = ref<Record<string, string>>({})
  const runtimeOwnershipByThreadId = ref<Record<string, ThreadRuntimeOwnership>>({})
  const runtimeCanInterruptByThreadId = ref<Record<string, boolean>>({})
  const runtimeCwdByThreadId = ref<Record<string, string>>({})
  const liveAuthorityByThreadId = ref<Record<string, UiThreadLiveAuthority>>({})
  const liveSnapshotByThreadId = ref<Record<string, UiThreadLiveSnapshot | null>>({})
  const projectionKeyByThreadId = ref<Record<string, string>>({})
  const interruptBlockedUntilPersistedByThreadId = ref<Record<string, boolean>>({})
  const threadListedByServerById = ref<Record<string, boolean>>({})
  const persistedUserMessageByThreadId = ref<Record<string, boolean>>({})
  const pendingServerRequestsByThreadId = ref<Record<string, UiServerRequest[]>>({})
  const pendingTurnRequestByThreadId = ref<Record<string, PendingTurnRequest>>({})
  const codexRateLimit = ref<UiRateLimitSnapshot | null>(null)
  const threadTokenUsageByThreadId = ref<Record<string, UiThreadTokenUsage>>(loadThreadTokenUsageMap())
  const terminalOpenByThreadId = ref<Record<string, boolean>>(loadThreadTerminalOpenMap())
  const threadModelProviderByThreadId = ref<Record<string, string>>({})
  const threadReasoningEffortByThreadId = ref<Record<string, ReasoningEffort | ''>>({})
  const threadGoalByThreadId = ref<Record<string, UiThreadGoal>>({})
  const threadGoalSupportByThreadId = ref<Record<string, boolean>>({})
  const updatingThreadGoalByThreadId = ref<Record<string, symbol>>({})

  const threadTitleById = ref<Record<string, string>>({})

  const installedSkills = ref<SkillInfo[]>([])
  const accountRateLimitSnapshots = ref<UiRateLimitSnapshot[]>([])

  const isLoadingThreads = ref(false)
  const isLoadingMessages = ref(false)
  const isThreadListFullyLoaded = ref(false)
  const isSendingMessage = ref(false)
  const isInterruptingTurn = ref(false)
  const pendingStopByThreadId = ref<Record<string, boolean>>({})
  const isPendingNewThreadStop = ref(false)
  const isUpdatingSpeedMode = ref(false)
  const isRollingBack = ref(false)

  const error = ref('')
  const isPolling = ref(false)
  const hasLoadedThreads = ref(false)

  function extractLocalImagePathFromUrl(value: string): string {
    try {
      const parsed = new URL(value, 'http://localhost')
      if (parsed.pathname !== '/codex-local-image') return ''
      return parsed.searchParams.get('path')?.trim() ?? ''
    } catch {
      return ''
    }
  }

  function shouldReuseAttachedImageFromPrompt(promptText: string): boolean {
    const normalized = promptText.trim().toLowerCase()
    if (!normalized) return false
    return /\b(attached image|attached screenshot|save the attached|copy (the )?screenshot|save screenshot)\b/i.test(normalized)
  }

  function findLatestUserLocalImageUrl(threadId: string): string {
    const persisted = persistedMessagesByThreadId.value[threadId] ?? []
    for (let index = persisted.length - 1; index >= 0; index -= 1) {
      const message = persisted[index]
      if (message.role !== 'user' || !Array.isArray(message.images) || message.images.length === 0) continue
      for (let imageIndex = message.images.length - 1; imageIndex >= 0; imageIndex -= 1) {
        const imageUrl = message.images[imageIndex]?.trim() ?? ''
        if (!imageUrl) continue
        if (extractLocalImagePathFromUrl(imageUrl)) return imageUrl
      }
    }
    return ''
  }
  let stopNotificationStream: (() => void) | null = null
  let activeTextNewestRefreshTimer: number | null = null
  let eventSyncTimer: number | null = null
  let rateLimitRefreshTimer: number | null = null
  let externalRuntimeTimer: number | null = null
  let externalRuntimeGeneration = 0
  let externalRuntimeRequest: {
    generation: number
    promise: Promise<void>
    controller: AbortController
    threadId: string
    detailRequestKey: string | null
    detailEpoch: number | null
  } | null = null
  let externalRuntimePollingEnabled = true
  let backgroundRuntimeTimer: number | null = null
  let backgroundRuntimeGeneration = 0
  let backgroundRuntimeRequest: {
    generation: number
    controller: AbortController
    promise: Promise<void>
    threadIds: string[]
  } | null = null
  let backgroundRuntimePollingEnabled = false
  let runtimeVisibilityListenerInstalled = false
  const backgroundExternalThreadIds = new Set<string>()
  const localRuntimeAuthorityVersionByThreadId = new Map<string, number>()
  const selectionVersionByThreadId = new Map<string, number>()
  const isolatedSelectedRuntimeProbeVersionByThreadId = new Map<string, number>()
  const delayedTurnSyncTimerByThreadId = new Map<string, number>()
  const activeTextHydrationByThreadId = new Map<string, ActiveTextHydration>()
  const activeTextHydrationGenerationByThreadId = new Map<string, number>()
  let multiWindowThreadSync = createMultiWindowThreadSync()
  let multiWindowThreadSyncDisposed = false
  const compressedLiveProjectionBackfillKeyByThreadId = new Map<string, string>()
  const compressedLiveProjectionBackfillTimerByThreadId = new Map<string, number>()
  let loadThreadsPromise: Promise<void> | null = null
  const loadMessagePromiseByThreadId = new Map<string, Promise<void>>()
  const rollbackPromiseByThreadId = new Map<string, Promise<void>>()
  const detailRequestEpochByThreadId = new Map<string, number>()
  const threadGoalRequestEpochByThreadId = new Map<string, number>()
  let threadGoalRequestGeneration = 0
  const detailRequestByKey = new Map<string, {
    epoch: number
    kind: ThreadDetailRequestKind
    threadId: string
    promise: Promise<ThreadDetailSnapshot>
    controller?: AbortController
    consumers: number
  }>()
  let refreshSkillsPromise: Promise<void> | null = null
  let lastThreadListLoadAt = 0
  let hasLoadedSkills = false
  let lastSkillsLoadAt = 0
  let lastSkillsLoadKey = ''
  let rateLimitRefreshPromise: Promise<void> | null = null
  let pendingThreadsRefresh = false
  let pendingThreadsRefreshForce = false
  const pendingThreadMessageRefresh = new Set<string>()
  const pendingThreadRuntimeRefresh = new Set<string>()
  const pendingActiveTextNewestRefresh = new Set<string>()
  const pendingActiveTextNewestTurnIdByThreadId = new Map<string, string>()
  const lastMessageLoadAtByThreadId = new Map<string, number>()
  const lastMessageLoadFailureAtByThreadId = new Map<string, number>()
  let threadListNextCursor: string | null = null
  let threadListBackgroundTimer: number | null = null
  let isLoadingRemainingThreadPages = false
  let hasLoadedAllThreadPages = false
  let loadedThreadListGroups: UiProjectGroup[] = []
  let freshThreadListGroupsDuringSnapshotRefresh: UiProjectGroup[] | null = null
  let loadedThreadListRootsState: WorkspaceRootsState | null = null
  let hasLoadedThreadListSnapshotOnly = false
  let hasHydratedWorkspaceRootsState = false
  let threadListMetadataEpoch = 0
  let activeReasoningItemId = ''
  let shouldAutoScrollOnNextAgentEvent = false
  const pendingTurnStartsById = new Map<string, TurnStartedInfo>()

  const cachedThreadGroupsSnapshot = readThreadGroupsSnapshot()
  if (cachedThreadGroupsSnapshot.length > 0) {
    loadedThreadListGroups = cachedThreadGroupsSnapshot
    sourceGroups.value = cachedThreadGroupsSnapshot
    projectGroups.value = cachedThreadGroupsSnapshot
    hasLoadedThreads.value = true
    hasLoadedThreadListSnapshotOnly = true
  }
  const completionReconciliationGenerationByThreadId = new Map<string, number>()
  const localSubmissionByThreadId = new Map<string, LocalSubmissionState>()
  const releasedPendingTurnRequests = new WeakSet<PendingTurnRequest>()
  const pendingStopRequestByThreadId = new Map<string, PendingStopRequest>()
  let pendingNewThreadSubmission: PendingNewThreadSubmission | null = null
  let nextSubmissionGeneration = 0
  const fallbackRetryInFlightThreadIds = new Set<string>()
  const nonSuccessCompletionReadBaselineByThreadId = new Map<string, string>()
  const resolvingServerRequestIds = new Set<number>()


  const allThreads = computed(() => flattenThreads(projectGroups.value))
  const selectedThread = computed(() =>
    allThreads.value.find((thread) => thread.id === selectedThreadId.value) ?? null,
  )
  const selectedThreadRuntimeOwnership = computed<ThreadRuntimeOwnership>(() => {
    const threadId = selectedThreadId.value
    return threadId ? runtimeOwnershipByThreadId.value[threadId] ?? 'idle' : 'idle'
  })
  const selectedThreadTerminalOpen = computed(() => {
    const threadId = selectedThreadId.value
    return Boolean(threadId && terminalOpenByThreadId.value[threadId] === true)
  })
  const isSelectedThreadInterruptPending = computed(() => {
    const threadId = selectedThreadId.value
    if (!threadId) return false
    return pendingStopByThreadId.value[threadId] === true
  })
  const selectedThreadCanInterrupt = computed(() => {
    const threadId = selectedThreadId.value
    return Boolean(threadId && runtimeCanInterruptByThreadId.value[threadId] === true)
  })
  const selectedThreadRuntimeCwd = computed(() => {
    const threadId = selectedThreadId.value
    return threadId ? runtimeCwdByThreadId.value[threadId] ?? '' : ''
  })
  const selectedThreadServerRequests = computed<UiServerRequest[]>(() => {
    const rows: UiServerRequest[] = []
    const selected = selectedThreadId.value
    if (selected && Array.isArray(pendingServerRequestsByThreadId.value[selected])) {
      rows.push(...pendingServerRequestsByThreadId.value[selected])
    }
    if (Array.isArray(pendingServerRequestsByThreadId.value[GLOBAL_SERVER_REQUEST_SCOPE])) {
      rows.push(...pendingServerRequestsByThreadId.value[GLOBAL_SERVER_REQUEST_SCOPE])
    }
    return rows.sort((first, second) => first.receivedAtIso.localeCompare(second.receivedAtIso))
  })
  const selectedLiveOverlay = computed<UiLiveOverlay | null>(() => {
    const threadId = selectedThreadId.value
    if (!threadId) return null

    const isInProgress = inProgressById.value[threadId] === true
    const activity = isInProgress ? turnActivityByThreadId.value[threadId] : undefined
    const reasoningText = isInProgress
      ? filterTitleOnlyReasoningText(liveReasoningTextByThreadId.value[threadId] ?? '')
      : ''
    const liveErrorText = (turnErrorByThreadId.value[threadId]?.message ?? '').trim()
    let latestPersistedTurnErrorText = ''
    if (!isInProgress && liveErrorText) {
      const persistedMessages = persistedMessagesByThreadId.value[threadId] ?? []
      for (let index = persistedMessages.length - 1; index >= 0; index -= 1) {
        const message = persistedMessages[index]
        if (message.messageType !== 'turnError') continue
        latestPersistedTurnErrorText = normalizeMessageText(message.text)
        break
      }
    }
    const errorText =
      !isInProgress && liveErrorText && latestPersistedTurnErrorText === liveErrorText
        ? ''
        : liveErrorText

    if (!isInProgress && !activity && !reasoningText && !errorText) return null
    return {
      activityLabel: activity?.label || 'Thinking',
      activityDetails: activity?.details ?? [],
      reasoningText,
      errorText,
    }
  })
  const selectedLiveAuthority = computed<UiThreadLiveAuthority | null>(() => {
    const threadId = selectedThreadId.value
    return threadId ? liveAuthorityByThreadId.value[threadId] ?? null : null
  })
  const selectedLiveSnapshot = computed<UiThreadLiveSnapshot | null>(() => {
    const threadId = selectedThreadId.value
    return threadId ? liveSnapshotByThreadId.value[threadId] ?? null : null
  })
  const selectedActiveTurnId = computed(() => {
    const threadId = selectedThreadId.value
    return threadId ? activeTurnIdByThreadId.value[threadId] ?? '' : ''
  })
  const selectedThreadGoal = computed<UiThreadGoal | null>(() => {
    const threadId = selectedThreadId.value
    return threadId ? threadGoalByThreadId.value[threadId] ?? null : null
  })
  const selectedThreadGoalSupported = computed(() => {
    const threadId = selectedThreadId.value
    return threadId ? threadGoalSupportByThreadId.value[threadId] !== false : true
  })
  const isUpdatingThreadGoal = computed(() => {
    const threadId = selectedThreadId.value
    return Boolean(threadId && updatingThreadGoalByThreadId.value[threadId] !== undefined)
  })
  const codexQuota = computed<UiRateLimitSnapshot | null>(() => codexRateLimit.value)
  const selectedThreadTokenUsage = computed<UiThreadTokenUsage | null>(() => {
    const threadId = selectedThreadId.value
    if (!threadId) return null
    return threadTokenUsageByThreadId.value[threadId] ?? null
  })
  const messages = computed<UiMessage[]>(() => {
    const threadId = selectedThreadId.value
    if (!threadId) return []

    const persisted = persistedMessagesByThreadId.value[threadId] ?? []
    const optimistic = optimisticUserMessagesByThreadId.value[threadId] ?? []
    const livePlan = livePlanMessagesByThreadId.value[threadId] ?? []
    const liveAgent = liveAgentMessagesByThreadId.value[threadId] ?? []
    const liveCommands = liveCommandsByThreadId.value[threadId] ?? []
    const persistedWithOptimistic = mergeOptimisticSubmissionsForDisplay(persisted, optimistic)
    const combined = [...persistedWithOptimistic, ...livePlan, ...liveCommands, ...liveAgent]
    const ownership = runtimeOwnershipByThreadId.value[threadId] ?? 'idle'
    const isExternal = ownership === 'external'
    const isRunning = inProgressById.value[threadId] === true
    const activeTurnId = activeTurnIdByThreadId.value[threadId] ?? ''
    const visibleCombined = isExternal
      ? combined.filter((message) => (
          message.messageType !== 'reasoning'
          || (isRunning && activeTurnId.length > 0 && message.turnId === activeTurnId)
        ))
      : combined

    const summary = turnSummaryByThreadId.value[threadId]
    if (!summary) return visibleCombined
    return insertTurnSummaryMessage(visibleCombined, summary)
  })
  const hasMoreOlderMessages = computed(() => {
    const threadId = selectedThreadId.value
    return threadId ? hasMoreOlderMessagesByThreadId.value[threadId] === true : false
  })
  const isLoadingOlderMessages = computed(() => {
    const threadId = selectedThreadId.value
    return threadId ? loadingOlderMessagesByThreadId.value[threadId] === true : false
  })

  function getFirstPersistedTurnId(threadId: string): string {
    const persisted = persistedMessagesByThreadId.value[threadId] ?? []
    for (const message of persisted) {
      const turnId = message.turnId?.trim() ?? ''
      if (turnId) return turnId
    }
    return ''
  }

  function readModelIdForThread(threadId: string): string {
    const contextId = toThreadContextId(threadId)
    if (contextId === NEW_THREAD_COLLABORATION_MODE_CONTEXT) {
      const normalizedProviderId = normalizeProviderContextId(activeProviderId.value)
      const providerContextId = toProviderModelContextId(normalizedProviderId)
      const providerModelId = providerContextId
        ? normalizeStoredModelId(selectedModelIdByContext.value[providerContextId])
        : ''
      if (providerModelId) return providerModelId
    }
    return readSelectedModel(selectedModelIdByContext.value, threadId).trim()
  }

  function readProviderIdForThread(threadId: string): string {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) return normalizeProviderContextId(activeProviderId.value)
    return normalizeProviderContextId(threadModelProviderByThreadId.value[normalizedThreadId] ?? activeProviderId.value)
  }

  function readReasoningEffortForThread(threadId: string): ReasoningEffort | '' {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) return selectedReasoningEffort.value
    return threadReasoningEffortByThreadId.value[normalizedThreadId] ?? selectedReasoningEffort.value
  }

  function ensureAvailableModelIds(...modelIds: string[]): void {
    const nextModelIds = [...availableModelIds.value]
    for (const modelId of modelIds) {
      const normalizedModelId = modelId.trim()
      if (normalizedModelId && !nextModelIds.includes(normalizedModelId)) {
        nextModelIds.push(normalizedModelId)
      }
    }
    if (!areStringArraysEqual(availableModelIds.value, nextModelIds)) {
      availableModelIds.value = nextModelIds
    }
  }

  function readProviderCompatibleSelectedModel(modelId: string): string {
    const normalizedModelId = modelId.trim()
    if (availableModelIds.value.length === 0) return normalizedModelId
    if (normalizedModelId && availableModelIds.value.includes(normalizedModelId)) return normalizedModelId
    return availableModelIds.value[0] ?? ''
  }

  function setSelectedThreadId(nextThreadId: string, options: { persist?: boolean } = {}): void {
    if (selectedThreadId.value === nextThreadId) return
    cancelActiveTextHydration(selectedThreadId.value)
    cancelExternalRuntimePolling()
    if (nextThreadId) {
      selectionVersionByThreadId.set(
        nextThreadId,
        (selectionVersionByThreadId.get(nextThreadId) ?? 0) + 1,
      )
    }
    selectedThreadId.value = nextThreadId
    if (options.persist !== false) {
      saveSelectedThreadId(nextThreadId)
    }
    selectedModelId.value = readProviderCompatibleSelectedModel(readModelIdForThread(nextThreadId))
    const threadReasoningEffort = readReasoningEffortForThread(nextThreadId)
    if (threadReasoningEffort) {
      selectedReasoningEffort.value = coerceReasoningEffortForModel(
        selectedModelId.value,
        threadReasoningEffort,
      )
    }
    selectedCollaborationMode.value = readSelectedCollaborationMode(
      selectedCollaborationModeByContext.value,
      nextThreadId,
    )
    activeReasoningItemId = ''
    shouldAutoScrollOnNextAgentEvent = false
    if (
      runtimeOwnershipByThreadId.value[nextThreadId] === 'external' ||
      canStartSelectedLiveProjectionPolling(nextThreadId)
    ) {
      scheduleExternalRuntimePolling(
        nextThreadId,
        runtimeOwnershipByThreadId.value[nextThreadId] === 'external' ? undefined : 0,
      )
    }
  }

  function setSelectedModelIdForThread(threadId: string, modelId: string): void {
    const normalizedThreadId = threadId.trim()
    if (
      normalizedThreadId &&
      normalizedThreadId === selectedThreadId.value.trim() &&
      isExternallyOwned(normalizedThreadId)
    ) return

    const normalizedModelId = modelId.trim()
    const contextId = toThreadContextId(threadId)
    const normalizedProviderId = normalizeProviderContextId(activeProviderId.value)
    const providerContextId =
      contextId === NEW_THREAD_COLLABORATION_MODE_CONTEXT
        ? toProviderModelContextId(normalizedProviderId)
        : ''
    const selectedContextId = providerContextId || contextId
    if (normalizedModelId) {
      const nextModelMap = cloneStringKeyedRecord(selectedModelIdByContext.value)
      nextModelMap[selectedContextId] = normalizedModelId
      if (providerContextId) {
        delete nextModelMap[contextId]
      }
      selectedModelIdByContext.value = nextModelMap
    } else {
      let nextModelMap = omitStringKeyedRecordKey(selectedModelIdByContext.value, selectedContextId)
      if (providerContextId) {
        nextModelMap = omitStringKeyedRecordKey(nextModelMap, contextId)
      }
      selectedModelIdByContext.value = nextModelMap
    }
    if (threadId.trim() === selectedThreadId.value) {
      selectedModelId.value = readModelIdForThread(selectedThreadId.value)
      selectedReasoningEffort.value = coerceReasoningEffortForModel(
        selectedModelId.value,
        selectedReasoningEffort.value,
      )
      ensureAvailableModelIds(selectedModelId.value)
    } else {
      ensureAvailableModelIds(normalizedModelId)
    }
    saveSelectedModelMap(selectedModelIdByContext.value)
  }

  function setSelectedModelId(modelId: string): void {
    setSelectedModelIdForThread(selectedThreadId.value, modelId)
  }

  function setThreadModelId(threadId: string, modelId: string): void {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) return

    const normalizedModelId = modelId.trim()
    if (normalizedModelId) {
      const nextModelMap = cloneStringKeyedRecord(selectedModelIdByContext.value)
      nextModelMap[normalizedThreadId] = normalizedModelId
      selectedModelIdByContext.value = nextModelMap
    } else {
      selectedModelIdByContext.value = omitStringKeyedRecordKey(selectedModelIdByContext.value, normalizedThreadId)
    }
    ensureAvailableModelIds(normalizedModelId)
    if (selectedThreadId.value === normalizedThreadId) {
      selectedModelId.value = readModelIdForThread(selectedThreadId.value)
    }
    saveSelectedModelMap(selectedModelIdByContext.value)
  }

  function setThreadModelProviderId(threadId: string, providerId: string): void {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) return

    const normalizedProviderId = normalizeProviderContextId(providerId)
    if (normalizedProviderId) {
      threadModelProviderByThreadId.value = {
        ...threadModelProviderByThreadId.value,
        [normalizedThreadId]: normalizedProviderId,
      }
    } else if (threadModelProviderByThreadId.value[normalizedThreadId]) {
      threadModelProviderByThreadId.value = omitKey(threadModelProviderByThreadId.value, normalizedThreadId)
    }
  }

  function setThreadReasoningEffort(threadId: string, effort: ReasoningEffort | ''): void {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) return

    const normalizedEffort = effort && REASONING_EFFORT_OPTIONS.includes(effort) ? effort : ''
    if (normalizedEffort) {
      threadReasoningEffortByThreadId.value = {
        ...threadReasoningEffortByThreadId.value,
        [normalizedThreadId]: normalizedEffort,
      }
    } else if (normalizedThreadId in threadReasoningEffortByThreadId.value) {
      threadReasoningEffortByThreadId.value = omitKey(threadReasoningEffortByThreadId.value, normalizedThreadId)
    }

    if (selectedThreadId.value === normalizedThreadId && normalizedEffort) {
      selectedReasoningEffort.value = coerceReasoningEffortForModel(
        readModelIdForThread(normalizedThreadId),
        normalizedEffort,
      )
    }
  }

  function resolveThreadModelForProvider(threadId: string, modelId: string, providerId: string): string {
    const normalizedModelId = modelId.trim()
    const normalizedProviderId = normalizeProviderContextId(providerId)
    if (normalizedProviderId !== 'opencode-zen') {
      return normalizedModelId
    }

    const previousThreadModel = readModelIdForThread(threadId).trim()
    if (previousThreadModel && !/^gpt-/i.test(previousThreadModel)) {
      return previousThreadModel
    }
    if (normalizedModelId && !/^gpt-/i.test(normalizedModelId)) {
      return normalizedModelId
    }
    return OPENCODE_ZEN_DEFAULT_MODEL
  }

  function setThreadTokenUsage(threadId: string, usage: UiThreadTokenUsage | null): void {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) return

    if (!usage) {
      if (!(normalizedThreadId in threadTokenUsageByThreadId.value)) return
      threadTokenUsageByThreadId.value = omitKey(threadTokenUsageByThreadId.value, normalizedThreadId)
      saveThreadTokenUsageMap(threadTokenUsageByThreadId.value)
      return
    }

    const current = threadTokenUsageByThreadId.value[normalizedThreadId]
    if (current && JSON.stringify(current) === JSON.stringify(usage)) return

    threadTokenUsageByThreadId.value = {
      ...threadTokenUsageByThreadId.value,
      [normalizedThreadId]: usage,
    }
    saveThreadTokenUsageMap(threadTokenUsageByThreadId.value)
  }

  function setSelectedCollaborationMode(mode: CollaborationModeKind): void {
    const threadId = selectedThreadId.value.trim()
    if (threadId && isExternallyOwned(threadId)) return
    const nextMode: CollaborationModeKind = mode === 'plan' ? 'plan' : 'default'
    const contextId = toThreadContextId(selectedThreadId.value)
    const currentMode = readSelectedCollaborationMode(selectedCollaborationModeByContext.value, selectedThreadId.value)
    if (currentMode === nextMode && selectedCollaborationMode.value === nextMode) return
    selectedCollaborationMode.value = nextMode
    selectedCollaborationModeByContext.value = writeSelectedCollaborationModeForContext(
      selectedCollaborationModeByContext.value,
      contextId,
      nextMode,
    )
    saveSelectedCollaborationModeMap(selectedCollaborationModeByContext.value)
  }

  function setSelectedCollaborationModeForThread(threadId: string, mode: CollaborationModeKind): void {
    const nextMode = mode === 'plan' ? 'plan' : 'default'
    selectedCollaborationModeByContext.value = writeSelectedCollaborationModeForContext(
      selectedCollaborationModeByContext.value,
      threadId,
      nextMode,
    )
    if (threadId.trim() === selectedThreadId.value) {
      selectedCollaborationMode.value = nextMode
    }
    saveSelectedCollaborationModeMap(selectedCollaborationModeByContext.value)
  }

  function setCodexRateLimit(nextSnapshot: UiRateLimitSnapshot | null): void {
    codexRateLimit.value = nextSnapshot
  }

  async function applyFallbackModelSelection(threadId: string = selectedThreadId.value): Promise<void> {
    if (threadId.trim()) {
      setThreadModelId(threadId, MODEL_FALLBACK_ID)
    } else {
      setSelectedModelId(MODEL_FALLBACK_ID)
    }
    ensureAvailableModelIds(MODEL_FALLBACK_ID)
  }

  function beginLocalSubmission(threadId: string, optimisticMessageId: string): LocalSubmissionState {
    const submission: LocalSubmissionState = {
      generation: ++nextSubmissionGeneration,
      optimisticMessageId,
      turnStartIssued: false,
    }
    localSubmissionByThreadId.set(threadId, submission)
    return submission
  }

  function clearLocalSubmission(threadId: string, generation?: number): void {
    const current = localSubmissionByThreadId.get(threadId)
    if (!current || (generation !== undefined && current.generation !== generation)) return
    localSubmissionByThreadId.delete(threadId)
  }

  function ensureLocalSubmissionOptimisticMessage(
    threadId: string,
    pending: PendingTurnRequest,
  ): void {
    const submission = localSubmissionByThreadId.get(threadId)
    if (!submission) return
    const optimistic = optimisticUserMessagesByThreadId.value[threadId] ?? []
    if (optimistic.some((entry) => entry.message.id === submission.optimisticMessageId)) return
    submission.optimisticMessageId = appendOptimisticUserMessage(
      threadId,
      pending.text,
      pending.imageUrls,
      pending.skills,
      pending.fileAttachments,
    )
  }

  function ensurePendingStopRequest(
    threadId: string,
    generation: number,
  ): PendingStopRequest {
    const existing = pendingStopRequestByThreadId.get(threadId)
    if (existing?.generation === generation) return existing
    if (existing) {
      existing.settled = true
      existing.resolve()
    }

    let resolvePromise!: () => void
    const promise = new Promise<void>((resolve) => {
      resolvePromise = resolve
    })
    const request: PendingStopRequest = {
      generation,
      promise,
      resolve: resolvePromise,
      interruptPromise: null,
      settled: false,
    }
    pendingStopRequestByThreadId.set(threadId, request)
    pendingStopByThreadId.value = {
      ...pendingStopByThreadId.value,
      [threadId]: true,
    }
    return request
  }

  function clearPendingStopRequest(threadId: string, generation?: number): void {
    const request = pendingStopRequestByThreadId.get(threadId)
    if (!request || (generation !== undefined && request.generation !== generation)) return
    pendingStopRequestByThreadId.delete(threadId)
    pendingStopByThreadId.value = omitKey(pendingStopByThreadId.value, threadId)
    if (!request.settled) {
      request.settled = true
      request.resolve()
    }
  }

  async function interruptLatchedTurn(
    threadId: string,
    turnId: string,
    request: PendingStopRequest,
  ): Promise<void> {
    isInterruptingTurn.value = true
    error.value = ''
    try {
      await interruptThreadTurn(threadId, turnId, 'local')
      pendingThreadMessageRefresh.add(threadId)
      pendingThreadsRefresh = true
      await syncFromNotifications()
      if (!request.settled) {
        request.settled = true
        request.resolve()
      }
    } catch (unknownError) {
      clearPendingStopRequest(threadId, request.generation)
      const errorMessage = unknownError instanceof Error ? unknownError.message : 'Failed to interrupt active turn'
      setTurnErrorForThread(threadId, errorMessage)
      error.value = errorMessage
    } finally {
      isInterruptingTurn.value = false
    }
  }

  function consumePendingStopForTurn(threadId: string, turnId: string): Promise<void> | null {
    const request = pendingStopRequestByThreadId.get(threadId)
    const submission = localSubmissionByThreadId.get(threadId)
    if (!request || !submission || request.generation !== submission.generation) return null
    if (!request.interruptPromise) {
      request.interruptPromise = interruptLatchedTurn(threadId, turnId, request)
    }
    return request.promise
  }

  function cancelSubmissionBeforeTurnStart(
    threadId: string,
    submission: LocalSubmissionState,
  ): boolean {
    const request = pendingStopRequestByThreadId.get(threadId)
    if (
      !request
      || request.generation !== submission.generation
      || submission.turnStartIssued
    ) {
      return false
    }

    removeOptimisticUserMessage(threadId, submission.optimisticMessageId)
    releasePendingTurnRequest(threadId, submission.pendingTurnRequest)
    clearLocalSubmission(threadId, submission.generation)
    clearPendingStopRequest(threadId, submission.generation)
    setThreadRuntimeOwnership(threadId, 'idle')
    setThreadInProgress(threadId, false)
    setTurnActivityForThread(threadId, null)
    return true
  }

  function setPendingTurnRequest(
    threadId: string,
    request: PendingTurnRequest,
    submission?: LocalSubmissionState,
  ): void {
    pendingTurnRequestByThreadId.value = {
      ...pendingTurnRequestByThreadId.value,
      [threadId]: request,
    }
    if (submission) {
      submission.pendingTurnRequest = pendingTurnRequestByThreadId.value[threadId]
    }
  }

  function clearPendingTurnRequest(threadId: string): void {
    if (!pendingTurnRequestByThreadId.value[threadId]) return
    pendingTurnRequestByThreadId.value = omitKey(pendingTurnRequestByThreadId.value, threadId)
  }

  function isManagedUploadImageUrl(value: string): boolean {
    try {
      const parsed = new URL(value, 'http://localhost')
      const path = parsed.searchParams.get('path')?.replace(/\\/gu, '/') ?? ''
      return parsed.pathname === '/codex-local-image' && (
        Boolean(parsed.searchParams.get('uploadHandle')?.trim())
        || path.includes('/codex-web-uploads/')
      )
    } catch {
      return false
    }
  }

  function hasManagedUploadCapabilities(
    imageUrls: string[],
    fileAttachments: FileAttachment[],
  ): boolean {
    return imageUrls.some(isManagedUploadImageUrl)
      || fileAttachments.some((attachment) => Boolean(attachment.uploadHandle?.trim())
        || attachment.fsPath.replace(/\\/gu, '/').includes('/codex-web-uploads/')
        || attachment.path.replace(/\\/gu, '/').includes('/codex-web-uploads/'))
  }

  function requireIdleResumeForUserTurn(
    threadId: string,
    resumedThread: Awaited<ReturnType<typeof resumeThread>>,
  ): void {
    if (
      resumedThread.ownership === 'idle'
      && resumedThread.externalRuntimeState === 'idle'
      && resumedThread.inProgress === false
    ) {
      return
    }
    if (resumedThread.ownership === 'local' && resumedThread.inProgress === true) {
      setThreadRuntimeOwnership(threadId, 'local')
      setThreadInProgress(threadId, true)
      if (resumedThread.activeTurnId) {
        activeTurnIdByThreadId.value = {
          ...activeTurnIdByThreadId.value,
          [threadId]: resumedThread.activeTurnId,
        }
      }
      return
    }

    setThreadRuntimeOwnership(threadId, 'external')
    setThreadInProgress(threadId, resumedThread.inProgress)
    if (resumedThread.activeTurnId) {
      activeTurnIdByThreadId.value = {
        ...activeTurnIdByThreadId.value,
        [threadId]: resumedThread.activeTurnId,
      }
    }
    throw new Error('Cannot start a turn because task writer ownership is not idle.')
  }

  function releasePendingTurnRequest(
    threadId: string,
    request: PendingTurnRequest | undefined = pendingTurnRequestByThreadId.value[threadId],
  ): void {
    if (pendingTurnRequestByThreadId.value[threadId] === request) {
      clearPendingTurnRequest(threadId)
    }
    if (
      !request
      || releasedPendingTurnRequests.has(request)
      || !hasManagedUploadCapabilities(request.imageUrls, request.fileAttachments)
    ) return
    releasedPendingTurnRequests.add(request)
    void cleanupManagedUploads(request.imageUrls, request.fileAttachments)
  }

  async function retryPendingTurnWithFallback(threadId: string): Promise<void> {
    if (fallbackRetryInFlightThreadIds.has(threadId)) return
    const pending = pendingTurnRequestByThreadId.value[threadId]
    if (!pending || pending.fallbackRetried) return

    fallbackRetryInFlightThreadIds.add(threadId)
    const fallbackPending: PendingTurnRequest = {
      ...pending,
      fallbackRetried: true,
    }
    const submission = localSubmissionByThreadId.get(threadId)
    setPendingTurnRequest(
      threadId,
      fallbackPending,
      submission?.pendingTurnRequest === pending ? submission : undefined,
    )

    try {
      await applyFallbackModelSelection(threadId)
      // Remove the failed user turn before replaying on fallback model to avoid duplicated user messages.
      try {
        const rolledBackMessages = await rollbackThread(threadId, 1)
        setPersistedMessagesForThread(threadId, rolledBackMessages)
        ensureLocalSubmissionOptimisticMessage(threadId, pending)
        clearLivePlansForThread(threadId)
        setLiveAgentMessagesForThread(threadId, [])
        clearLiveReasoningForThread(threadId)
        if (liveCommandsByThreadId.value[threadId]) {
          liveCommandsByThreadId.value = omitKey(liveCommandsByThreadId.value, threadId)
        }
      } catch {
        // If rollback fails, continue with retry rather than dropping the turn.
      }
      setTurnErrorForThread(threadId, null)
      error.value = ''
      setTurnSummaryForThread(threadId, null)
      setTurnActivityForThread(threadId, {
        label: 'Thinking',
        details: buildPendingTurnDetails(MODEL_FALLBACK_ID, pending.effort, pending.collaborationMode),
      })
      setThreadRuntimeOwnership(threadId, 'local')
      setThreadInProgress(threadId, true)

      if (resumedThreadById.value[threadId] !== true) {
        const resumedThread = await resumeThread(threadId)
        requireIdleResumeForUserTurn(threadId, resumedThread)
        if (resumedThread.model) {
          setThreadModelId(threadId, resolveThreadModelForProvider(threadId, resumedThread.model, resumedThread.modelProvider))
        }
        if (resumedThread.modelProvider) {
          setThreadModelProviderId(threadId, resumedThread.modelProvider)
        }
        resumedThreadById.value = {
          ...resumedThreadById.value,
          [threadId]: true,
        }
      }

      const fallbackTurnId = await startThreadTurn(
        threadId,
        pending.text,
        pending.imageUrls,
        MODEL_FALLBACK_ID,
        pending.effort || undefined,
        pending.skills.length > 0 ? pending.skills : undefined,
        pending.fileAttachments,
        pending.collaborationMode,
      )
      if (fallbackTurnId) {
        activeTurnIdByThreadId.value = {
          ...activeTurnIdByThreadId.value,
          [threadId]: fallbackTurnId,
        }
        setThreadRuntimeOwnership(threadId, 'local')
        maybeUnblockInterruptForActiveTurn(threadId, fallbackTurnId)
        void consumePendingStopForTurn(threadId, fallbackTurnId)
      }

      scheduleRateLimitRefresh()
      pendingThreadMessageRefresh.add(threadId)
      await syncFromNotifications()
    } catch (unknownError) {
      const ambiguousStart = isAmbiguousTurnStartError(unknownError)
      if (!ambiguousStart) {
        releasePendingTurnRequest(threadId)
        clearPendingStopRequest(threadId)
        clearLocalSubmission(threadId)
      }
      const errorMessage = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
      setTurnErrorForThread(threadId, errorMessage, { transient: ambiguousStart })
      error.value = errorMessage
      if (!ambiguousStart && !isExternallyOwned(threadId)) {
        setThreadRuntimeOwnership(threadId, 'idle')
        setThreadInProgress(threadId, false)
        setTurnActivityForThread(threadId, null)
      }
    } finally {
      fallbackRetryInFlightThreadIds.delete(threadId)
    }
  }

  function setSelectedReasoningEffort(effort: ReasoningEffort | ''): void {
    const threadId = selectedThreadId.value.trim()
    if (threadId && isExternallyOwned(threadId)) return
    if (effort && !REASONING_EFFORT_OPTIONS.includes(effort)) {
      return
    }
    if (effort && !isReasoningEffortSupportedByModel(selectedModelId.value, effort)) {
      return
    }
    selectedReasoningEffort.value = effort
    if (threadId) {
      setThreadReasoningEffort(threadId, effort)
    }
  }

  async function updateSelectedSpeedMode(mode: SpeedMode): Promise<void> {
    const threadId = selectedThreadId.value.trim()
    if (threadId && isExternallyOwned(threadId)) return
    const nextMode: SpeedMode = mode === 'fast' ? 'fast' : 'standard'
    if (isUpdatingSpeedMode.value || selectedSpeedMode.value === nextMode) {
      return
    }

    const previousMode = selectedSpeedMode.value
    selectedSpeedMode.value = nextMode
    isUpdatingSpeedMode.value = true
    error.value = ''

    try {
      await setCodexSpeedMode(nextMode)
      hasUserSelectedSpeedMode.value = true
    } catch (unknownError) {
      selectedSpeedMode.value = previousMode
      error.value = unknownError instanceof Error ? unknownError.message : 'Failed to update Fast mode'
    } finally {
      isUpdatingSpeedMode.value = false
    }
  }

  async function refreshCollaborationModes(): Promise<void> {
    try {
      const modes = await getAvailableCollaborationModes()
      availableCollaborationModes.value = modes
      if (!modes.some((mode) => mode.value === selectedCollaborationMode.value)) {
        setSelectedCollaborationModeForThread(selectedThreadId.value, 'default')
      }
    } catch {
      // Keep the last known collaboration mode choices on transient failures.
    }
  }

  function buildPendingTurnDetails(
    modelId: string,
    effort: ReasoningEffort | '',
    collaborationMode: CollaborationModeKind = selectedCollaborationMode.value,
  ): string[] {
    const modelLabel = modelId.trim() || 'default'
    const effortLabel = effort || 'default'
    const modeLabel = collaborationMode === 'plan' ? 'Plan' : 'Default'
    const speedLabel = selectedSpeedMode.value === 'fast' ? 'Fast' : 'Standard'
    return [`Mode: ${modeLabel}`, `Model: ${modelLabel}`, `Thinking: ${effortLabel}`, `Speed: ${speedLabel}`]
  }

  async function refreshModelPreferences(options?: { providerChanged?: boolean; includeProviderModels?: boolean }): Promise<void> {
    codexCliMissingError.value = ''
    try {
      const currentConfig = await getCurrentModelConfig()
      const normalizedConfiguredModelId = currentConfig.model.trim()
      const normalizedProviderId = normalizeProviderContextId(currentConfig.providerId)
      activeProviderId.value = normalizedProviderId
      const targetProviderId = readProviderIdForThread(selectedThreadId.value)
      const isProviderBacked = targetProviderId !== 'codex'
      const normalizedSelectedModelId = readModelIdForThread(selectedThreadId.value)
      const isCodexNewThreadContext = selectedThreadId.value.trim().length === 0 && !isProviderBacked
      const shouldUseMobileFastDefault = !hasUserSelectedSpeedMode.value
        && !isProviderBacked
        && isMobileCodexWebClient()
      const modelIds = await getAvailableModelIds({
        includeProviderModels: isProviderBacked || options?.includeProviderModels !== false,
        requireProviderModels: isProviderBacked,
        providerId: isProviderBacked ? targetProviderId : undefined,
      })
      const providerModelContextId = toProviderModelContextId(targetProviderId)
      const providerScopedModelId = providerModelContextId
        ? normalizeStoredModelId(selectedModelIdByContext.value[providerModelContextId])
        : ''
      const nextModelIds = [...modelIds]
      const defaultCodexNewThreadModelId = isCodexNewThreadContext
        ? pickDefaultCodexNewThreadModel(nextModelIds)
        : ''
      if (
        !options?.providerChanged
        && isProviderBacked
        && targetProviderId === normalizedProviderId
        && normalizedConfiguredModelId
        && !nextModelIds.includes(normalizedConfiguredModelId)
      ) {
        nextModelIds.push(normalizedConfiguredModelId)
      }
      availableModelIds.value = nextModelIds

      const currentModelInNewList = normalizedSelectedModelId && modelIds.includes(normalizedSelectedModelId)
      if (!normalizedSelectedModelId || !currentModelInNewList || options?.providerChanged) {
        if (options?.providerChanged && nextModelIds.length > 0) {
          if (providerScopedModelId && modelIds.includes(providerScopedModelId)) {
            setSelectedModelId(providerScopedModelId)
          } else if (targetProviderId === normalizedProviderId && normalizedConfiguredModelId && nextModelIds.includes(normalizedConfiguredModelId)) {
            setSelectedModelId(normalizedConfiguredModelId)
          } else {
            setSelectedModelId(nextModelIds[0])
          }
        } else if (!normalizedSelectedModelId && defaultCodexNewThreadModelId) {
          setSelectedModelId(defaultCodexNewThreadModelId)
        } else if (targetProviderId === normalizedProviderId && normalizedConfiguredModelId && nextModelIds.includes(normalizedConfiguredModelId)) {
          setSelectedModelId(currentConfig.model)
        } else if (nextModelIds.length > 0) {
          setSelectedModelId(nextModelIds[0])
        } else {
          setSelectedModelId('')
        }
      } else if (selectedModelId.value.trim() !== normalizedSelectedModelId) {
        setSelectedModelId(normalizedSelectedModelId)
      }
      if (providerModelContextId && selectedModelId.value.trim().length > 0) {
        const nextModelMap = cloneStringKeyedRecord(selectedModelIdByContext.value)
        nextModelMap[providerModelContextId] = selectedModelId.value.trim()
        const activeProviderModelContextId = toProviderModelContextId(normalizedProviderId)
        if (
          activeProviderModelContextId
          && activeProviderModelContextId !== providerModelContextId
          && normalizedConfiguredModelId
        ) {
          nextModelMap[activeProviderModelContextId] = normalizedConfiguredModelId
        }
        selectedModelIdByContext.value = nextModelMap
        saveSelectedModelMap(selectedModelIdByContext.value)
      }

      const selectedThreadReasoningEffort = selectedThreadId.value.trim()
        ? threadReasoningEffortByThreadId.value[selectedThreadId.value.trim()]
        : ''
      if (selectedThreadReasoningEffort) {
        selectedReasoningEffort.value = coerceReasoningEffortForModel(
          selectedModelId.value,
          selectedThreadReasoningEffort,
        )
      } else if (
        isCodexNewThreadContext &&
        defaultCodexNewThreadModelId &&
        selectedModelId.value.trim() === defaultCodexNewThreadModelId
      ) {
        selectedReasoningEffort.value = coerceReasoningEffortForModel(
          selectedModelId.value,
          DEFAULT_CODEX_NEW_THREAD_REASONING_EFFORT,
        )
      } else if (
        currentConfig.reasoningEffort &&
        REASONING_EFFORT_OPTIONS.includes(currentConfig.reasoningEffort)
      ) {
        selectedReasoningEffort.value = coerceReasoningEffortForModel(
          selectedModelId.value,
          currentConfig.reasoningEffort,
        )
      }
      if (
        (
          isCodexNewThreadContext &&
          defaultCodexNewThreadModelId &&
          selectedModelId.value.trim() === defaultCodexNewThreadModelId
        ) ||
        shouldUseMobileFastDefault
      ) {
        selectedSpeedMode.value = DEFAULT_CODEX_NEW_THREAD_SPEED_MODE
        if (currentConfig.speedMode !== DEFAULT_CODEX_NEW_THREAD_SPEED_MODE) {
          await setCodexSpeedMode(DEFAULT_CODEX_NEW_THREAD_SPEED_MODE)
        }
      } else {
        selectedSpeedMode.value = currentConfig.speedMode
      }
    } catch (unknownError) {
      if (isCodexCliMissingError(unknownError)) {
        codexCliMissingError.value = CODEX_CLI_MISSING_MESSAGE
      } else {
        codexCliMissingError.value = ''
      }
      // Keep chat UI usable even if model metadata is temporarily unavailable.
    }
  }

  async function refreshRateLimits(): Promise<void> {
    if (rateLimitRefreshPromise) {
      await rateLimitRefreshPromise
      return
    }

    rateLimitRefreshPromise = (async () => {
      try {
        const snapshot = await getAccountRateLimits()
        setCodexRateLimit(snapshot)
        accountRateLimitSnapshots.value = snapshot ? [snapshot] : []
      } catch {
        // Keep the last known rate-limit state if the endpoint is temporarily unavailable.
      } finally {
        rateLimitRefreshPromise = null
      }
    })()

    await rateLimitRefreshPromise
  }

  function scheduleRateLimitRefresh(): void {
    if (typeof window === 'undefined') {
      void refreshRateLimits()
      return
    }

    if (rateLimitRefreshTimer !== null) {
      window.clearTimeout(rateLimitRefreshTimer)
    }

    rateLimitRefreshTimer = window.setTimeout(() => {
      rateLimitRefreshTimer = null
      void refreshRateLimits()
    }, RATE_LIMIT_REFRESH_DEBOUNCE_MS)
  }

  function clearDelayedTurnSync(threadId: string): void {
    if (!threadId || typeof window === 'undefined') return
    const timerId = delayedTurnSyncTimerByThreadId.get(threadId)
    if (timerId === undefined) return
    window.clearTimeout(timerId)
    delayedTurnSyncTimerByThreadId.delete(threadId)
  }

  function scheduleDelayedTurnSync(threadId: string): void {
    if (!threadId || typeof window === 'undefined') return
    clearDelayedTurnSync(threadId)
    const timerId = window.setTimeout(() => {
      delayedTurnSyncTimerByThreadId.delete(threadId)
      pendingThreadMessageRefresh.add(threadId)
      void syncFromNotifications()
    }, TURN_START_FOLLOW_UP_SYNC_DELAY_MS)
    delayedTurnSyncTimerByThreadId.set(threadId, timerId)
  }

  function applyCachedTitlesToGroups(groups: UiProjectGroup[]): UiProjectGroup[] {
    const titles = threadTitleById.value
    if (Object.keys(titles).length === 0) return groups
    return groups.map((group) => ({
      projectName: group.projectName,
      threads: group.threads.map((thread) => {
        const cached = titles[thread.id]
        return cached ? { ...thread, title: cached } : thread
      }),
    }))
  }

  function getThreadPendingRequests(threadId: string): UiServerRequest[] {
    if (!threadId) return []
    return Array.isArray(pendingServerRequestsByThreadId.value[threadId])
      ? pendingServerRequestsByThreadId.value[threadId]
      : []
  }

  function isApprovalRequestMethod(method: string): boolean {
    return (
      method === 'item/commandExecution/requestApproval' ||
      method === 'item/fileChange/requestApproval' ||
      method === 'item/permissions/requestApproval' ||
      method === 'execCommandApproval' ||
      method === 'applyPatchApproval'
    )
  }

  function readPendingRequestState(requests: UiServerRequest[]): UiPendingRequestState | null {
    if (requests.some((request) => isApprovalRequestMethod(request.method))) {
      return 'approval'
    }
    return requests.length > 0 ? 'response' : null
  }

  function applyThreadFlags(): void {
    const withTitles = applyCachedTitlesToGroups(sourceGroups.value)
    let nextEventUnreadByThreadId = eventUnreadByThreadId.value
    const flaggedGroups: UiProjectGroup[] = withTitles.map((group) => ({
      projectName: group.projectName,
      threads: group.threads.map((thread) => {
        const inProgress = thread.inProgress === true || inProgressById.value[thread.id] === true
        const pendingRequestState = readPendingRequestState(getThreadPendingRequests(thread.id))
        const isSelected = selectedThreadId.value === thread.id
        const desktopRead = thread.desktopHasUserEvent === false
        if (desktopRead && nextEventUnreadByThreadId[thread.id] === true) {
          nextEventUnreadByThreadId = omitKey(nextEventUnreadByThreadId, thread.id)
        }
        const unreadByEvent = !desktopRead && nextEventUnreadByThreadId[thread.id] === true
        const unreadByTime = !desktopRead && isThreadUnreadByLastRead(
            thread.updatedAtIso,
            readStateByThreadId.value[thread.id],
            unreadCutoffIso.value,
          )
        const unread = !isSelected && !inProgress && (unreadByEvent || unreadByTime)

        return {
          ...thread,
          inProgress,
          unread,
          pendingRequestState,
        }
      }),
    }))
    if (nextEventUnreadByThreadId !== eventUnreadByThreadId.value) {
      eventUnreadByThreadId.value = nextEventUnreadByThreadId
    }
    projectGroups.value = mergeThreadGroups(projectGroups.value, flaggedGroups)
  }

  function preserveReadWatermarksForMetadataOnlyRefresh(incomingGroups: UiProjectGroup[]): void {
    const previousThreadsById = new Map(flattenThreads(projectGroups.value).map((thread) => [thread.id, thread]))
    if (previousThreadsById.size === 0) return

    let nextReadState = readStateByThreadId.value
    let changed = false
    for (const thread of flattenThreads(incomingGroups)) {
      const previousThread = previousThreadsById.get(thread.id)
      if (!previousThread) continue
      if (previousThread.unread === true) continue
      if (previousThread.inProgress === true || thread.inProgress === true) continue
      if (inProgressById.value[thread.id] === true) continue
      if (eventUnreadByThreadId.value[thread.id] === true) continue
      if (thread.desktopHasUserEvent === true) continue

      const currentReadIso = nextReadState[thread.id] ?? unreadCutoffIso.value
      if (!isThreadUpdatedAfterCutoff(thread.updatedAtIso, currentReadIso)) continue
      nextReadState = {
        ...nextReadState,
        [thread.id]: readThreadReadWatermarkIso(thread.updatedAtIso),
      }
      changed = true
    }

    if (!changed) return
    readStateByThreadId.value = nextReadState
    saveReadStateMap(nextReadState)
  }

  function insertOptimisticThread(threadId: string, cwd: string, firstMessageText: string): void {
    const nowIso = new Date().toISOString()
    const normalizedCwd = normalizePathForUi(cwd)
    const projectName = toProjectName(normalizedCwd)
    const nextThread: UiThread = {
      id: threadId,
      title: toOptimisticThreadTitle(firstMessageText),
      projectName,
      cwd: normalizedCwd,
      hasWorktree: normalizedCwd.includes('/.codex/worktrees/') || normalizedCwd.includes('/.git/worktrees/'),
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
      preview: firstMessageText,
      unread: false,
      inProgress: false,
    }

    const existingGroupIndex = sourceGroups.value.findIndex((group) => group.projectName === projectName)
    if (existingGroupIndex >= 0) {
      const existingGroup = sourceGroups.value[existingGroupIndex]
      const remainingThreads = existingGroup.threads.filter((thread) => thread.id !== threadId)
      const nextGroup: UiProjectGroup = {
        projectName,
        threads: [nextThread, ...remainingThreads],
      }
      const nextGroups = [...sourceGroups.value]
      nextGroups.splice(existingGroupIndex, 1, nextGroup)
      sourceGroups.value = nextGroups
    } else {
      sourceGroups.value = [{ projectName, threads: [nextThread] }, ...sourceGroups.value]
    }

    const nextProjectOrder = mergeProjectOrder(projectOrder.value, sourceGroups.value)
    if (!areStringArraysEqual(projectOrder.value, nextProjectOrder)) {
      projectOrder.value = nextProjectOrder
      saveProjectOrder(projectOrder.value)
    }
    applyThreadFlags()
  }

  function rollbackOptimisticNewThread(threadId: string, fallbackSelectedThreadId: string): void {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) return

    loadedThreadListGroups = removeThreadFromGroups(loadedThreadListGroups, normalizedThreadId)
    sourceGroups.value = removeThreadFromGroups(sourceGroups.value, normalizedThreadId)
    projectGroups.value = removeThreadFromGroups(projectGroups.value, normalizedThreadId)

    persistedMessagesByThreadId.value = omitKey(persistedMessagesByThreadId.value, normalizedThreadId)
    optimisticUserMessagesByThreadId.value = omitKey(
      optimisticUserMessagesByThreadId.value,
      normalizedThreadId,
    )
    loadedMessagesByThreadId.value = omitKey(loadedMessagesByThreadId.value, normalizedThreadId)
    loadedVersionByThreadId.value = omitKey(loadedVersionByThreadId.value, normalizedThreadId)
    olderTurnCursorByThreadId.value = omitKey(olderTurnCursorByThreadId.value, normalizedThreadId)
    activeTextOlderCursorByThreadId.value = omitKey(activeTextOlderCursorByThreadId.value, normalizedThreadId)
    hasMoreOlderMessagesByThreadId.value = omitKey(hasMoreOlderMessagesByThreadId.value, normalizedThreadId)
    consumedOlderTurnCursorsByThreadId.delete(normalizedThreadId)
    resumedThreadById.value = omitKey(resumedThreadById.value, normalizedThreadId)
    turnIndexByTurnIdByThreadId.value = omitKey(turnIndexByTurnIdByThreadId.value, normalizedThreadId)
    turnSummaryByThreadId.value = omitKey(turnSummaryByThreadId.value, normalizedThreadId)
    terminalTurnIdsByThreadId.delete(normalizedThreadId)
    recentlyCompletedActiveTurnIdByThreadId.delete(normalizedThreadId)
    turnActivityByThreadId.value = omitKey(turnActivityByThreadId.value, normalizedThreadId)
    turnErrorByThreadId.value = omitKey(turnErrorByThreadId.value, normalizedThreadId)
    activeTurnIdByThreadId.value = omitKey(activeTurnIdByThreadId.value, normalizedThreadId)
    runtimeOwnershipByThreadId.value = omitKey(runtimeOwnershipByThreadId.value, normalizedThreadId)
    runtimeCanInterruptByThreadId.value = omitKey(runtimeCanInterruptByThreadId.value, normalizedThreadId)
    runtimeCwdByThreadId.value = omitKey(runtimeCwdByThreadId.value, normalizedThreadId)
    liveAuthorityByThreadId.value = omitKey(liveAuthorityByThreadId.value, normalizedThreadId)
    liveSnapshotByThreadId.value = omitKey(liveSnapshotByThreadId.value, normalizedThreadId)
    projectionKeyByThreadId.value = omitKey(projectionKeyByThreadId.value, normalizedThreadId)
    interruptBlockedUntilPersistedByThreadId.value = omitKey(interruptBlockedUntilPersistedByThreadId.value, normalizedThreadId)
    threadListedByServerById.value = omitKey(threadListedByServerById.value, normalizedThreadId)
    persistedUserMessageByThreadId.value = omitKey(persistedUserMessageByThreadId.value, normalizedThreadId)
    threadModelProviderByThreadId.value = omitKey(threadModelProviderByThreadId.value, normalizedThreadId)
    threadReasoningEffortByThreadId.value = omitKey(threadReasoningEffortByThreadId.value, normalizedThreadId)
    threadTitleById.value = omitKey(threadTitleById.value, normalizedThreadId)
    threadTokenUsageByThreadId.value = omitKey(threadTokenUsageByThreadId.value, normalizedThreadId)
    eventUnreadByThreadId.value = omitKey(eventUnreadByThreadId.value, normalizedThreadId)
    inProgressById.value = omitKey(inProgressById.value, normalizedThreadId)
    pendingTurnRequestByThreadId.value = omitKey(pendingTurnRequestByThreadId.value, normalizedThreadId)
    clearPendingStopRequest(normalizedThreadId)
    clearLocalSubmission(normalizedThreadId)
    completionReconciliationGenerationByThreadId.delete(normalizedThreadId)
    selectedModelIdByContext.value = omitKey(selectedModelIdByContext.value, normalizedThreadId)
    selectedCollaborationModeByContext.value = omitKey(selectedCollaborationModeByContext.value, normalizedThreadId)
    clearLiveAgentRawTextForThread(normalizedThreadId)
    clearLiveReasoningForThread(normalizedThreadId)
    clearLivePlansForThread(normalizedThreadId)
    clearDelayedTurnSync(normalizedThreadId)
    pendingThreadMessageRefresh.delete(normalizedThreadId)
    backgroundExternalThreadIds.delete(normalizedThreadId)
    localRuntimeAuthorityVersionByThreadId.delete(normalizedThreadId)
    selectionVersionByThreadId.delete(normalizedThreadId)
    isolatedSelectedRuntimeProbeVersionByThreadId.delete(normalizedThreadId)

    if (selectedThreadId.value === normalizedThreadId) {
      setSelectedThreadId(fallbackSelectedThreadId)
    }
  }

  function pruneThreadScopedState(flatThreads: UiThread[]): void {
    const activeThreadIds = new Set(flatThreads.map((thread) => thread.id))
    for (const threadId of backgroundExternalThreadIds) {
      if (!activeThreadIds.has(threadId)) backgroundExternalThreadIds.delete(threadId)
    }
    for (const threadId of localRuntimeAuthorityVersionByThreadId.keys()) {
      if (!activeThreadIds.has(threadId)) localRuntimeAuthorityVersionByThreadId.delete(threadId)
    }
    for (const threadId of selectionVersionByThreadId.keys()) {
      if (!activeThreadIds.has(threadId)) selectionVersionByThreadId.delete(threadId)
    }
    for (const threadId of isolatedSelectedRuntimeProbeVersionByThreadId.keys()) {
      if (!activeThreadIds.has(threadId)) isolatedSelectedRuntimeProbeVersionByThreadId.delete(threadId)
    }
    for (const threadId of terminalTurnIdsByThreadId.keys()) {
      if (!activeThreadIds.has(threadId)) terminalTurnIdsByThreadId.delete(threadId)
    }
    const currentThreadId = selectedThreadId.value.trim()
    if (currentThreadId) {
      activeThreadIds.add(currentThreadId)
    }
    const nextSelectedModelMap = pruneThreadContextStateMap(selectedModelIdByContext.value, activeThreadIds)
    if (nextSelectedModelMap !== selectedModelIdByContext.value) {
      selectedModelIdByContext.value = nextSelectedModelMap
      selectedModelId.value = readProviderCompatibleSelectedModel(readModelIdForThread(selectedThreadId.value))
      saveSelectedModelMap(nextSelectedModelMap)
    }
    const nextSelectedCollaborationModeMap = pruneThreadContextStateMap(
      selectedCollaborationModeByContext.value,
      activeThreadIds,
    )
    if (nextSelectedCollaborationModeMap !== selectedCollaborationModeByContext.value) {
      selectedCollaborationModeByContext.value = nextSelectedCollaborationModeMap
      selectedCollaborationMode.value = readSelectedCollaborationMode(
        nextSelectedCollaborationModeMap,
        selectedThreadId.value,
      )
      saveSelectedCollaborationModeMap(nextSelectedCollaborationModeMap)
    }
    const nextReadState = pruneThreadStateMap(readStateByThreadId.value, activeThreadIds)
    if (nextReadState !== readStateByThreadId.value) {
      readStateByThreadId.value = nextReadState
      saveReadStateMap(nextReadState)
    }
    loadedMessagesByThreadId.value = pruneThreadStateMap(loadedMessagesByThreadId.value, activeThreadIds)
    loadedVersionByThreadId.value = pruneThreadStateMap(loadedVersionByThreadId.value, activeThreadIds)
    olderTurnCursorByThreadId.value = pruneThreadStateMap(olderTurnCursorByThreadId.value, activeThreadIds)
    activeTextOlderCursorByThreadId.value = pruneThreadStateMap(
      activeTextOlderCursorByThreadId.value,
      activeThreadIds,
    )
    hasMoreOlderMessagesByThreadId.value = pruneThreadStateMap(
      hasMoreOlderMessagesByThreadId.value,
      activeThreadIds,
    )
    for (const threadId of consumedOlderTurnCursorsByThreadId.keys()) {
      if (!activeThreadIds.has(threadId)) consumedOlderTurnCursorsByThreadId.delete(threadId)
    }
    resumedThreadById.value = pruneThreadStateMap(resumedThreadById.value, activeThreadIds)
    turnIndexByTurnIdByThreadId.value = pruneThreadStateMap(turnIndexByTurnIdByThreadId.value, activeThreadIds)
    persistedMessagesByThreadId.value = pruneThreadStateMap(persistedMessagesByThreadId.value, activeThreadIds)
    optimisticUserMessagesByThreadId.value = pruneThreadStateMap(
      optimisticUserMessagesByThreadId.value,
      activeThreadIds,
    )
    pruneLiveAgentRawText(activeThreadIds)
    liveAgentMessagesByThreadId.value = pruneThreadStateMap(liveAgentMessagesByThreadId.value, activeThreadIds)
    liveReasoningTextByThreadId.value = pruneThreadStateMap(liveReasoningTextByThreadId.value, activeThreadIds)
    liveCommandsByThreadId.value = pruneThreadStateMap(liveCommandsByThreadId.value, activeThreadIds)
    liveFileChangeMessagesByThreadId.value = pruneThreadStateMap(liveFileChangeMessagesByThreadId.value, activeThreadIds)
    turnSummaryByThreadId.value = pruneThreadStateMap(turnSummaryByThreadId.value, activeThreadIds)
    for (const threadId of recentlyCompletedActiveTurnIdByThreadId.keys()) {
      if (!activeThreadIds.has(threadId)) recentlyCompletedActiveTurnIdByThreadId.delete(threadId)
    }
    turnActivityByThreadId.value = pruneThreadStateMap(turnActivityByThreadId.value, activeThreadIds)
    turnErrorByThreadId.value = pruneThreadStateMap(turnErrorByThreadId.value, activeThreadIds)
    activeTurnIdByThreadId.value = pruneThreadStateMap(activeTurnIdByThreadId.value, activeThreadIds)
    runtimeOwnershipByThreadId.value = pruneThreadStateMap(runtimeOwnershipByThreadId.value, activeThreadIds)
    runtimeCanInterruptByThreadId.value = pruneThreadStateMap(runtimeCanInterruptByThreadId.value, activeThreadIds)
    runtimeCwdByThreadId.value = pruneThreadStateMap(runtimeCwdByThreadId.value, activeThreadIds)
    liveAuthorityByThreadId.value = pruneThreadStateMap(liveAuthorityByThreadId.value, activeThreadIds)
    liveSnapshotByThreadId.value = pruneThreadStateMap(liveSnapshotByThreadId.value, activeThreadIds)
    projectionKeyByThreadId.value = pruneThreadStateMap(projectionKeyByThreadId.value, activeThreadIds)
    interruptBlockedUntilPersistedByThreadId.value = pruneThreadStateMap(
      interruptBlockedUntilPersistedByThreadId.value,
      activeThreadIds,
    )
    threadListedByServerById.value = pruneThreadStateMap(threadListedByServerById.value, activeThreadIds)
    persistedUserMessageByThreadId.value = pruneThreadStateMap(persistedUserMessageByThreadId.value, activeThreadIds)
    threadModelProviderByThreadId.value = pruneThreadStateMap(threadModelProviderByThreadId.value, activeThreadIds)
    threadReasoningEffortByThreadId.value = pruneThreadStateMap(threadReasoningEffortByThreadId.value, activeThreadIds)
    const nextQueuedMessages = pruneThreadStateMap(queuedMessagesByThreadId.value, activeThreadIds)
    if (nextQueuedMessages !== queuedMessagesByThreadId.value) {
      queuedMessagesByThreadId.value = nextQueuedMessages
      queueMutationVersion += 1
    }
    threadTokenUsageByThreadId.value = pruneThreadStateMap(threadTokenUsageByThreadId.value, activeThreadIds)
    eventUnreadByThreadId.value = pruneThreadStateMap(eventUnreadByThreadId.value, activeThreadIds)
    inProgressById.value = pruneThreadStateMap(inProgressById.value, activeThreadIds)
    const nextPending: Record<string, UiServerRequest[]> = {}
    for (const [threadId, requests] of Object.entries(pendingServerRequestsByThreadId.value)) {
      if (threadId === GLOBAL_SERVER_REQUEST_SCOPE || activeThreadIds.has(threadId)) {
        nextPending[threadId] = requests
      }
    }
    pendingServerRequestsByThreadId.value = nextPending
  }

  function pruneThreadScopedStateAfterCompleteDirectory(): void {
    if (!hasLoadedAllThreadPages) return
    pruneThreadScopedState(flattenThreads(projectGroups.value))
  }

  function markThreadAsRead(threadId: string): void {
    const thread = flattenThreads(sourceGroups.value).find((row) => row.id === threadId)
    const readWatermarkIso = readThreadReadWatermarkIso(thread?.updatedAtIso ?? '')

    readStateByThreadId.value = {
      ...readStateByThreadId.value,
      [threadId]: readWatermarkIso,
    }
    saveReadStateMap(readStateByThreadId.value)
    if (eventUnreadByThreadId.value[threadId]) {
      eventUnreadByThreadId.value = omitKey(eventUnreadByThreadId.value, threadId)
    }
    applyThreadFlags()
  }

  function suppressUnreadForNonSuccessCompletion(threadId: string): void {
    const thread = flattenThreads(sourceGroups.value).find((row) => row.id === threadId)
    const currentUpdatedAtIso = thread?.updatedAtIso ?? ''
    if (currentUpdatedAtIso) {
      const readWatermarkIso = readThreadReadWatermarkIso(currentUpdatedAtIso)
      readStateByThreadId.value = {
        ...readStateByThreadId.value,
        [threadId]: readWatermarkIso,
      }
      saveReadStateMap(readStateByThreadId.value)
    }
    nonSuccessCompletionReadBaselineByThreadId.set(threadId, currentUpdatedAtIso)
  }

  function syncNonSuccessCompletionReadWatermarks(
    incomingGroups: UiProjectGroup[],
    activeThreadIds: Set<string>,
  ): void {
    if (nonSuccessCompletionReadBaselineByThreadId.size === 0) return

    let nextReadState = readStateByThreadId.value
    let readStateChanged = false
    for (const thread of flattenThreads(incomingGroups)) {
      const baseline = nonSuccessCompletionReadBaselineByThreadId.get(thread.id)
      if (baseline === undefined) continue
      const summaryAdvanced = baseline
        ? isThreadUpdatedAfterCutoff(thread.updatedAtIso, baseline)
        : Boolean(thread.updatedAtIso)
      if (!summaryAdvanced) continue
      if (nextReadState[thread.id] !== thread.updatedAtIso) {
        nextReadState = {
          ...nextReadState,
          [thread.id]: thread.updatedAtIso,
        }
        readStateChanged = true
      }
      nonSuccessCompletionReadBaselineByThreadId.delete(thread.id)
    }

    for (const threadId of nonSuccessCompletionReadBaselineByThreadId.keys()) {
      if (!activeThreadIds.has(threadId)) {
        nonSuccessCompletionReadBaselineByThreadId.delete(threadId)
      }
    }
    if (readStateChanged) {
      readStateByThreadId.value = nextReadState
      saveReadStateMap(nextReadState)
    }
  }

  function setTurnSummaryForThread(threadId: string, summary: TurnSummaryState | null): void {
    if (!threadId) return

    const previous = turnSummaryByThreadId.value[threadId]
    if (summary) {
      rememberTerminalTurnForThread(threadId, summary.turnId)
      if (areTurnSummariesEqual(previous, summary)) return
      turnSummaryByThreadId.value = {
        ...turnSummaryByThreadId.value,
        [threadId]: summary,
      }
    } else {
      if (previous) {
        turnSummaryByThreadId.value = omitKey(turnSummaryByThreadId.value, threadId)
      }
    }
  }

  function persistTurnSummaryForThread(threadId: string, summary: TurnSummaryState): void {
    if (!threadId || !summary.turnId) return
    rememberTerminalTurnForThread(threadId, summary.turnId)
    const previousThreadSummaries = persistedTurnSummaryByThreadId.value[threadId] ?? {}
    const nextThreadEntries = Object.entries({
      ...previousThreadSummaries,
      [summary.turnId]: summary,
    }).slice(-50)
    const nextThreadSummaries = Object.fromEntries(nextThreadEntries) as Record<string, TurnSummaryState>
    const nextEntries = Object.entries({
      ...persistedTurnSummaryByThreadId.value,
      [threadId]: nextThreadSummaries,
    }).slice(-100)
    persistedTurnSummaryByThreadId.value = Object.fromEntries(nextEntries) as Record<
      string,
      Record<string, TurnSummaryState>
    >
    savePersistedTurnSummaryMap(persistedTurnSummaryByThreadId.value)
  }

  function rememberTerminalTurnForThread(threadId: string, turnId: string): void {
    if (!threadId || !turnId) return
    const existing = terminalTurnIdsByThreadId.get(threadId) ?? new Set<string>()
    existing.add(turnId)
    while (existing.size > 50) {
      const oldestTurnId = existing.values().next().value
      if (typeof oldestTurnId !== 'string') break
      existing.delete(oldestTurnId)
    }
    terminalTurnIdsByThreadId.set(threadId, existing)
  }

  function rememberTerminalSummariesForThread(
    threadId: string,
    summaries: readonly TurnSummaryState[],
  ): void {
    for (const summary of summaries) {
      rememberTerminalTurnForThread(threadId, summary.turnId)
    }
  }

  function isKnownTerminalTurnRuntime(threadId: string, turnId: string): boolean {
    if (!threadId || !turnId) return false
    if (turnSummaryByThreadId.value[threadId]?.turnId === turnId) return true
    if (persistedTurnSummaryByThreadId.value[threadId]?.[turnId]) return true
    return terminalTurnIdsByThreadId.get(threadId)?.has(turnId) === true
  }

  function mergeTurnSummariesWithPersistedDurations(
    threadId: string,
    summaries: readonly TurnSummaryState[],
  ): TurnSummaryState[] {
    const persisted = persistedTurnSummaryByThreadId.value[threadId] ?? {}
    return summaries.map((summary) => {
      const persistedSummary = persisted[summary.turnId]
      if (summary.durationMs !== null || persistedSummary?.durationMs === null || !persistedSummary) {
        return summary
      }
      return {
        ...summary,
        durationMs: persistedSummary.durationMs,
        completedAtMs: summary.completedAtMs ?? persistedSummary.completedAtMs,
      }
    })
  }

  function isCurrentThreadDetailEpoch(threadId: string, epoch: number): boolean {
    return (detailRequestEpochByThreadId.get(threadId) ?? 0) === epoch
  }

  function isAbortLikeError(unknownError: unknown): boolean {
    return unknownError instanceof Error && unknownError.name === 'AbortError'
  }

  function threadDetailRequestKey(
    threadId: string,
    kind: ThreadDetailRequestKind = 'detail',
    cacheKey = '',
  ): string {
    return `${kind}\u0000${threadId}\u0000${cacheKey}`
  }

  function hasThreadDetailRequest(
    threadId: string,
    kind?: ThreadDetailRequestKind,
  ): boolean {
    for (const request of detailRequestByKey.values()) {
      if (request.threadId === threadId && (kind === undefined || request.kind === kind)) {
        return true
      }
    }
    return false
  }

  function scheduleCompressedLiveProjectionBackfill(threadId: string, projectionKey: string): void {
    if (!threadId || !projectionKey || typeof window === 'undefined') return
    if (selectedThreadId.value !== threadId) return
    if (compressedLiveProjectionBackfillKeyByThreadId.get(threadId) === projectionKey) return

    const existingTimer = compressedLiveProjectionBackfillTimerByThreadId.get(threadId)
    if (existingTimer !== undefined) {
      window.clearTimeout(existingTimer)
      compressedLiveProjectionBackfillTimerByThreadId.delete(threadId)
    }

    compressedLiveProjectionBackfillKeyByThreadId.set(threadId, projectionKey)
    const timer = window.setTimeout(() => {
      compressedLiveProjectionBackfillTimerByThreadId.delete(threadId)
      if (selectedThreadId.value !== threadId) return
      const currentProjectionKey = projectionKeyByThreadId.value[threadId] ?? ''
      if (currentProjectionKey && currentProjectionKey !== projectionKey) return

      void loadMessages(threadId, {
        silent: true,
        force: true,
        bypassRecentReuse: true,
      }).catch(() => {
        if (compressedLiveProjectionBackfillKeyByThreadId.get(threadId) === projectionKey) {
          compressedLiveProjectionBackfillKeyByThreadId.delete(threadId)
        }
      })
    }, 0)
    compressedLiveProjectionBackfillTimerByThreadId.set(threadId, timer)
  }

  function acquireThreadDetailRequest(
    threadId: string,
    request: () => Promise<ThreadDetailSnapshot>,
    controller?: AbortController,
    options: { kind?: ThreadDetailRequestKind; cacheKey?: string } = {},
  ): ThreadDetailRequestLease {
    const kind = options.kind ?? 'detail'
    const requestKey = threadDetailRequestKey(threadId, kind, options.cacheKey ?? '')
    const existing = detailRequestByKey.get(requestKey)
    if (existing) {
      existing.consumers += 1
      return { epoch: existing.epoch, ownsRequest: false, requestKey, promise: existing.promise }
    }

    const epoch = (detailRequestEpochByThreadId.get(threadId) ?? 0) + 1
    detailRequestEpochByThreadId.set(threadId, epoch)
    const promise = request()
    detailRequestByKey.set(requestKey, { epoch, kind, threadId, promise, controller, consumers: 1 })
    return { epoch, ownsRequest: true, requestKey, promise }
  }

  function invalidateThreadDetailRequest(threadId: string): void {
    let invalidated = false
    let nextEpoch = (detailRequestEpochByThreadId.get(threadId) ?? 0) + 1
    for (const [requestKey, current] of detailRequestByKey.entries()) {
      if (current.threadId !== threadId) continue
      invalidated = true
      nextEpoch = Math.max(nextEpoch, current.epoch + 1)
      detailRequestByKey.delete(requestKey)
      current.controller?.abort()
    }
    if (invalidated) {
      detailRequestEpochByThreadId.set(threadId, nextEpoch)
    }
  }

  function releaseThreadDetailRequest(threadId: string, lease: ThreadDetailRequestLease): void {
    const current = detailRequestByKey.get(lease.requestKey)
    if (
      !current
      || current.threadId !== threadId
      || current.epoch !== lease.epoch
      || current.promise !== lease.promise
    ) return
    current.consumers -= 1
    if (current.consumers <= 0) detailRequestByKey.delete(lease.requestKey)
  }

  function invalidateOwnedThreadDetailRequest(
    threadId: string,
    requestKey: string | null,
    epoch: number | null,
  ): void {
    if (requestKey === null || epoch === null) return
    const current = detailRequestByKey.get(requestKey)
    if (!current || current.threadId !== threadId || current.epoch !== epoch) return
    detailRequestByKey.delete(requestKey)
    detailRequestEpochByThreadId.set(
      threadId,
      Math.max((detailRequestEpochByThreadId.get(threadId) ?? 0) + 1, current.epoch + 1),
    )
    current.controller?.abort()
  }

  function cancelExternalRuntimePolling(): void {
    externalRuntimeGeneration += 1
    if (externalRuntimeTimer !== null && typeof window !== 'undefined') {
      window.clearTimeout(externalRuntimeTimer)
    }
    externalRuntimeTimer = null
    const request = externalRuntimeRequest
    externalRuntimeRequest = null
    if (request) {
      invalidateOwnedThreadDetailRequest(request.threadId, request.detailRequestKey, request.detailEpoch)
    }
    request?.controller.abort()
  }

  function clearExternalRuntimeTimer(): void {
    if (externalRuntimeTimer !== null && typeof window !== 'undefined') {
      window.clearTimeout(externalRuntimeTimer)
    }
    externalRuntimeTimer = null
  }

  function backgroundRuntimeCandidateIds(): string[] {
    const selectedId = selectedThreadId.value
    const ids: string[] = []
    const addedIds = new Set<string>()
    const loadedThreads = flattenThreads(sourceGroups.value)
    const loadedThreadsById = new Map(loadedThreads.map((thread) => [thread.id, thread]))
    const flaggedThreadsById = new Map(
      flattenThreads(projectGroups.value).map((thread) => [thread.id, thread]),
    )

    const addCandidate = (threadId: string): void => {
      if (!threadId || ids.length >= BACKGROUND_RUNTIME_BATCH_LIMIT) return
      const isLoadedThread = loadedThreadsById.has(threadId)
      const isLoadedSelectedThread =
        threadId === selectedId && loadedMessagesByThreadId.value[threadId] === true
      if (addedIds.has(threadId) || (!isLoadedThread && !isLoadedSelectedThread)) return
      if (
        threadId === selectedId &&
        (runtimeOwnershipByThreadId.value[threadId] ?? 'idle') !== 'external' &&
        isThreadDetailLoadActive(threadId)
      ) return
      const ownership = runtimeOwnershipByThreadId.value[threadId] ?? 'idle'
      ids.push(threadId)
      addedIds.add(threadId)
      if (ownership === 'external') backgroundExternalThreadIds.add(threadId)
    }

    if (
      selectedId &&
      (loadedThreadsById.has(selectedId) || loadedMessagesByThreadId.value[selectedId] === true)
    ) {
      const selectedOwnership = runtimeOwnershipByThreadId.value[selectedId] ?? 'idle'
      if (selectedOwnership === 'external' || !isThreadDetailLoadActive(selectedId)) {
        addCandidate(selectedId)
      }
    }

    for (const thread of flaggedThreadsById.values()) {
      if (
        thread.unread === true ||
        Boolean(thread.pendingRequestState) ||
        thread.inProgress === true
      ) {
        addCandidate(thread.id)
      }
    }

    for (const threadId of backgroundExternalThreadIds) {
      addCandidate(threadId)
    }
    for (const [threadId, ownership] of Object.entries(runtimeOwnershipByThreadId.value)) {
      if (ownership === 'external') addCandidate(threadId)
    }
    for (const [threadId, inProgress] of Object.entries(inProgressById.value)) {
      if (inProgress === true) addCandidate(threadId)
    }
    for (const threadId of Object.keys(activeTurnIdByThreadId.value)) {
      addCandidate(threadId)
    }

    const visibleLimit = Math.max(
      0,
      Math.min(getBackgroundThreadListLimit(), BACKGROUND_RUNTIME_BATCH_LIMIT),
    )
    for (const thread of loadedThreads.slice(0, visibleLimit)) {
      addCandidate(thread.id)
    }
    return ids
  }

  function cancelBackgroundRuntimeRequest(): void {
    backgroundRuntimeGeneration += 1
    if (backgroundRuntimeTimer !== null && typeof window !== 'undefined') {
      window.clearTimeout(backgroundRuntimeTimer)
    }
    backgroundRuntimeTimer = null
    backgroundRuntimeRequest?.controller.abort()
    backgroundRuntimeRequest = null
  }

  function clearBackgroundRuntimeTimer(): void {
    if (backgroundRuntimeTimer !== null && typeof window !== 'undefined') {
      window.clearTimeout(backgroundRuntimeTimer)
    }
    backgroundRuntimeTimer = null
  }

  function isThreadDetailLoadActive(threadId: string): boolean {
    return hasThreadDetailRequest(threadId) || loadMessagePromiseByThreadId.has(threadId)
  }

  function isSelectedLiveProjectionPollingEligible(threadId: string): boolean {
    if (!threadId || selectedThreadId.value !== threadId) return false
    if (runtimeOwnershipByThreadId.value[threadId] === 'local') return false
    return loadedMessagesByThreadId.value[threadId] === true
  }

  function canStartSelectedLiveProjectionPolling(threadId: string): boolean {
    return isSelectedLiveProjectionPollingEligible(threadId) && !isThreadDetailLoadActive(threadId)
  }

  function isSelectedRuntimeProbeInFlight(threadId: string): boolean {
    return Boolean(
      threadId &&
      selectedThreadId.value === threadId &&
      runtimeOwnershipByThreadId.value[threadId] !== 'external' &&
      backgroundRuntimeRequest?.threadIds.includes(threadId),
    )
  }

  function hasPendingLocalTurnOwnership(threadId: string): boolean {
    return localSubmissionByThreadId.has(threadId) ||
      Boolean(pendingTurnRequestByThreadId.value[threadId]) ||
      fallbackRetryInFlightThreadIds.has(threadId)
  }

  function scheduleBackgroundRuntimePolling(delayMs = BACKGROUND_RUNTIME_POLL_MS): void {
    if (!backgroundRuntimePollingEnabled || typeof window === 'undefined') return
    if (backgroundRuntimeTimer !== null || backgroundRuntimeRequest !== null) return
    if (isLoadingThreads.value || loadThreadsPromise !== null) {
      backgroundRuntimeTimer = window.setTimeout(() => {
        backgroundRuntimeTimer = null
        scheduleBackgroundRuntimePolling(0)
      }, Math.max(delayMs, BACKGROUND_RUNTIME_POLL_MS))
      return
    }
    backgroundRuntimeTimer = window.setTimeout(() => {
      backgroundRuntimeTimer = null
      const selectedId = selectedThreadId.value
      const allCandidateThreadIds = backgroundRuntimeCandidateIds()
      const candidateThreadIds =
        typeof document !== 'undefined' && document.visibilityState === 'hidden'
          ? (selectedId && allCandidateThreadIds.includes(selectedId) ? [selectedId] : [])
          : allCandidateThreadIds
      if (candidateThreadIds.length === 0) {
        scheduleBackgroundRuntimePolling()
        return
      }
      const selectedVersion = selectedId ? selectionVersionByThreadId.get(selectedId) ?? 0 : 0
      const shouldIsolateSelectedProbe =
        selectedId.length > 0
        && candidateThreadIds.length > 1
        && candidateThreadIds.includes(selectedId)
        && (runtimeOwnershipByThreadId.value[selectedId] ?? 'idle') === 'idle'
        && loadedMessagesByThreadId.value[selectedId] === true
        && isolatedSelectedRuntimeProbeVersionByThreadId.get(selectedId) !== selectedVersion
      const threadIds = shouldIsolateSelectedProbe ? [selectedId] : candidateThreadIds
      if (shouldIsolateSelectedProbe) {
        isolatedSelectedRuntimeProbeVersionByThreadId.set(selectedId, selectedVersion)
      }
      const generation = backgroundRuntimeGeneration
      const controller = new AbortController()
      const localAuthorityVersions = new Map(
        threadIds.map((threadId) => [
          threadId,
          localRuntimeAuthorityVersionByThreadId.get(threadId) ?? 0,
        ]),
      )
      const selectionVersions = new Map(
        threadIds.map((threadId) => [
          threadId,
          selectionVersionByThreadId.get(threadId) ?? 0,
        ]),
      )
      const requestedSelectedThreadId = selectedThreadId.value
      const promise = pollBackgroundRuntimeStates(
        threadIds,
        requestedSelectedThreadId,
        localAuthorityVersions,
        selectionVersions,
        generation,
        controller.signal,
      )
      backgroundRuntimeRequest = { generation, controller, promise, threadIds }
      void promise.finally(() => {
        if (backgroundRuntimeRequest?.promise !== promise) return
        backgroundRuntimeRequest = null
        if (generation === backgroundRuntimeGeneration) scheduleBackgroundRuntimePolling()
      })
    }, delayMs)
  }

  function onRuntimeVisibilityChange(): void {
    if (typeof document === 'undefined') return
    multiWindowThreadSync.setVisible(document.visibilityState === 'visible')
    clearBackgroundRuntimeTimer()
    clearExternalRuntimeTimer()
    if (document.visibilityState !== 'visible') {
      if (threadListBackgroundTimer !== null && typeof window !== 'undefined') {
        window.clearTimeout(threadListBackgroundTimer)
        threadListBackgroundTimer = null
      }
      scheduleBackgroundRuntimePolling(0)
      const selectedId = selectedThreadId.value
      if (
        selectedId &&
        (
          runtimeOwnershipByThreadId.value[selectedId] === 'external' ||
          canStartSelectedLiveProjectionPolling(selectedId)
        )
      ) {
        scheduleExternalRuntimePolling(selectedId, 0)
      }
      return
    }
    resumeActiveTextHydration()
    scheduleRemainingThreadPages(loadedThreadListRootsState)
    scheduleBackgroundRuntimePolling(0)
    const selectedId = selectedThreadId.value
    if (
      selectedId &&
      (
        runtimeOwnershipByThreadId.value[selectedId] === 'external' ||
        canStartSelectedLiveProjectionPolling(selectedId)
      )
    ) {
      scheduleExternalRuntimePolling(selectedId, 0)
    }
  }

  async function pollBackgroundRuntimeStates(
    requestedThreadIds: readonly string[],
    requestedSelectedThreadId: string,
    requestedLocalAuthorityVersions: ReadonlyMap<string, number>,
    requestedSelectionVersions: ReadonlyMap<string, number>,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    let states: Awaited<ReturnType<typeof getThreadRuntimeStates>>
    try {
      states = await getThreadRuntimeStates(requestedThreadIds, signal)
    } catch {
      return
    }
    if (generation !== backgroundRuntimeGeneration) return
    const loadedThreadsById = new Map(flattenThreads(sourceGroups.value).map((thread) => [thread.id, thread]))
    const loadedIds = new Set(loadedThreadsById.keys())
    let shouldRefreshThreads = false

    for (const threadId of requestedThreadIds) {
      const wasSelectedAtRequest = requestedSelectedThreadId === threadId
      const isSelectedNow = selectedThreadId.value === threadId
      const isLoadedThread = loadedIds.has(threadId)
      if (!isLoadedThread && !wasSelectedAtRequest) continue
      if (wasSelectedAtRequest !== isSelectedNow) continue
      const requestedSelectionVersion = requestedSelectionVersions.get(threadId) ?? 0
      const currentSelectionVersion = selectionVersionByThreadId.get(threadId) ?? 0
      if (currentSelectionVersion !== requestedSelectionVersion) continue
      const requestedLocalAuthorityVersion = requestedLocalAuthorityVersions.get(threadId) ?? 0
      const currentLocalAuthorityVersion = localRuntimeAuthorityVersionByThreadId.get(threadId) ?? 0
      if (currentLocalAuthorityVersion !== requestedLocalAuthorityVersion) {
        backgroundExternalThreadIds.delete(threadId)
        continue
      }
      const runtime = states[threadId] ?? { state: 'unknown' }
      if (runtime.state === 'running' && isKnownTerminalTurnRuntime(threadId, runtime.turnId)) {
        backgroundExternalThreadIds.delete(threadId)
        setThreadRuntimeOwnership(threadId, 'idle', { canInterrupt: false })
        setThreadInProgress(threadId, false)
        setLoadedThreadMetadataInProgress(threadId, false)
        shouldRefreshThreads = shouldRefreshThreads || isLoadedThread
        continue
      }
      if (runtime.state === 'running' && runtime.source === 'local-app-server') {
        activeTurnIdByThreadId.value = {
          ...activeTurnIdByThreadId.value,
          [threadId]: runtime.turnId,
        }
        backgroundExternalThreadIds.delete(threadId)
        setThreadRuntimeOwnership(threadId, 'local')
        setThreadInProgress(threadId, true)
        continue
      }

      const ownership = runtimeOwnershipByThreadId.value[threadId] ?? 'idle'
      const locallyRunning = inProgressById.value[threadId] === true && ownership !== 'external'
      const listedRunning = loadedThreadsById.get(threadId)?.inProgress === true
      if (
        runtime.state === 'running'
        && isSelectedNow
        && (ownership === 'local' || locallyRunning)
        && !hasPendingLocalTurnOwnership(threadId)
      ) {
        activeTurnIdByThreadId.value = {
          ...activeTurnIdByThreadId.value,
          [threadId]: runtime.turnId,
        }
        backgroundExternalThreadIds.delete(threadId)
        setThreadRuntimeOwnership(threadId, 'external', {
          externalPollDelayMs: 0,
          canInterrupt: runtime.interruptible === true,
        })
        setThreadInProgress(threadId, true)
        continue
      }
      if (runtime.state === 'idle' && ownership === 'external') {
        backgroundExternalThreadIds.delete(threadId)

        if (isSelectedNow) {
          cancelExternalRuntimePolling()
          const detailRequest = acquireThreadDetailRequest(
            threadId,
            () => getThreadDetail(threadId, signal),
          )
          try {
            const detail = await detailRequest.promise
            if (generation !== backgroundRuntimeGeneration) continue
            if (selectedThreadId.value !== threadId) continue
            if (!isCurrentThreadDetailEpoch(threadId, detailRequest.epoch)) continue
            if ((selectionVersionByThreadId.get(threadId) ?? 0) !== requestedSelectionVersion) continue

            reconcileThreadDetailSnapshot(threadId, detail, {
              preserveMissing: true,
              markRead: true,
              requestedVersion: '',
              detailEpoch: detailRequest.epoch,
            })
            shouldRefreshThreads = shouldRefreshThreads || (
              isLoadedThread
              && (
                runtimeOwnershipByThreadId.value[threadId] !== 'external'
                || inProgressById.value[threadId] !== true
              )
            )
          } catch {
            // Retain the established external lease until detail confirms terminal text.
          } finally {
            releaseThreadDetailRequest(threadId, detailRequest)
          }
        } else {
          setThreadRuntimeOwnership(threadId, 'idle')
          setThreadInProgress(threadId, false)
          setLoadedThreadMetadataInProgress(threadId, false)
          shouldRefreshThreads = shouldRefreshThreads || isLoadedThread
        }
        continue
      }
      if (runtime.state === 'idle' && ownership === 'local') {
        if (!isSelectedNow) {
          clearCompletedTurnLiveState(threadId)
          setThreadRuntimeOwnership(threadId, 'idle')
          setThreadInProgress(threadId, false)
          setLoadedThreadMetadataInProgress(threadId, false)
          shouldRefreshThreads = shouldRefreshThreads || isLoadedThread
          continue
        }

        const detailRequest = acquireThreadDetailRequest(
          threadId,
          () => getThreadDetail(threadId, signal),
        )
        try {
          const detail = await detailRequest.promise
          if (generation !== backgroundRuntimeGeneration) continue
          if (selectedThreadId.value !== threadId) continue
          if (!isCurrentThreadDetailEpoch(threadId, detailRequest.epoch)) continue
          if ((selectionVersionByThreadId.get(threadId) ?? 0) !== requestedSelectionVersion) continue
          if (
            (localRuntimeAuthorityVersionByThreadId.get(threadId) ?? 0)
            !== requestedLocalAuthorityVersion
          ) continue
          if (runtimeOwnershipByThreadId.value[threadId] !== 'local') continue

          reconcileThreadDetailSnapshot(threadId, detail, {
            preserveMissing: true,
            markRead: true,
            requestedVersion: '',
            detailEpoch: detailRequest.epoch,
            allowIdleLocalLeaseRelease: true,
          })
        } catch {
          // Keep the local lease until a later batch can confirm and load terminal detail.
        } finally {
          releaseThreadDetailRequest(threadId, detailRequest)
        }
        continue
      }
      if (runtime.state === 'idle' && ownership === 'idle' && (locallyRunning || listedRunning)) {
        backgroundExternalThreadIds.delete(threadId)
        clearCompletedTurnLiveState(threadId)
        setThreadRuntimeOwnership(threadId, 'idle')
        setThreadInProgress(threadId, false)
        setLoadedThreadMetadataInProgress(threadId, false)
        shouldRefreshThreads = shouldRefreshThreads || isLoadedThread

        if (isSelectedNow) {
          const detailRequest = acquireThreadDetailRequest(
            threadId,
            () => getThreadDetail(threadId, signal),
          )
          try {
            const detail = await detailRequest.promise
            if (generation !== backgroundRuntimeGeneration) continue
            if (selectedThreadId.value !== threadId) continue
            if (!isCurrentThreadDetailEpoch(threadId, detailRequest.epoch)) continue
            if ((selectionVersionByThreadId.get(threadId) ?? 0) !== requestedSelectionVersion) continue

            reconcileThreadDetailSnapshot(threadId, detail, {
              preserveMissing: true,
              markRead: true,
              requestedVersion: '',
              detailEpoch: detailRequest.epoch,
            })
          } catch {
            // The runtime state is already idle; a later metadata/detail refresh can recover final text.
          } finally {
            releaseThreadDetailRequest(threadId, detailRequest)
          }
        }
        continue
      }
      if (ownership === 'local' || locallyRunning || (isSelectedNow && ownership === 'external')) {
        backgroundExternalThreadIds.delete(threadId)
        continue
      }
      if (runtime.state === 'running') {
        activeTurnIdByThreadId.value = {
          ...activeTurnIdByThreadId.value,
          [threadId]: runtime.turnId,
        }
        if (!isSelectedNow) backgroundExternalThreadIds.add(threadId)
        setThreadRuntimeOwnership(threadId, 'external', {
          externalPollDelayMs: isSelectedNow ? 0 : undefined,
          canInterrupt: runtime.interruptible === true,
        })
        setThreadInProgress(threadId, true)
        continue
      }
      if (runtime.state === 'idle' && backgroundExternalThreadIds.has(threadId)) {
        backgroundExternalThreadIds.delete(threadId)
        setThreadRuntimeOwnership(threadId, 'idle')
        setThreadInProgress(threadId, false)
        setLoadedThreadMetadataInProgress(threadId, false)
        shouldRefreshThreads = shouldRefreshThreads || isLoadedThread
      }
    }

    if (shouldRefreshThreads) {
      pendingThreadsRefresh = true
      pendingThreadsRefreshForce = true
      await syncFromNotifications()
    }
  }

  function scheduleExternalRuntimePolling(
    threadId: string,
    delayMs = SELECTED_EXTERNAL_LIVE_PROJECTION_POLL_MS,
  ): void {
    if (!externalRuntimePollingEnabled || typeof window === 'undefined') return
    if (!threadId || selectedThreadId.value !== threadId) return
    if (
      runtimeOwnershipByThreadId.value[threadId] !== 'external' &&
      !canStartSelectedLiveProjectionPolling(threadId)
    ) return
    if (isSelectedRuntimeProbeInFlight(threadId)) return
    if (externalRuntimeTimer !== null || externalRuntimeRequest !== null) return

    externalRuntimeTimer = window.setTimeout(() => {
      externalRuntimeTimer = null
      if (isSelectedRuntimeProbeInFlight(threadId)) return
      const generation = externalRuntimeGeneration
      const controller = new AbortController()
      const knownProjectionKey = projectionKeyByThreadId.value[threadId] ?? undefined
      const detailRequest = acquireThreadDetailRequest(
        threadId,
        () => getExternalThreadLiveSnapshot(threadId, controller.signal, knownProjectionKey),
        controller,
        { kind: 'live', cacheKey: knownProjectionKey ?? '' },
      )
      const request = pollExternalRuntime(threadId, generation, detailRequest)
      externalRuntimeRequest = {
        generation,
        promise: request,
        controller,
        threadId,
        detailRequestKey: detailRequest.ownsRequest ? detailRequest.requestKey : null,
        detailEpoch: detailRequest.ownsRequest ? detailRequest.epoch : null,
      }
      void request.finally(() => {
        if (
          externalRuntimeRequest?.promise !== request
          || externalRuntimeRequest.generation !== generation
        ) return
        externalRuntimeRequest = null
        if (generation !== externalRuntimeGeneration) return
        const selectedId = selectedThreadId.value
        if (
          selectedId &&
          (
            runtimeOwnershipByThreadId.value[selectedId] === 'external' ||
            canStartSelectedLiveProjectionPolling(selectedId)
          )
        ) {
          scheduleExternalRuntimePolling(
            selectedId,
            runtimeOwnershipByThreadId.value[selectedId] === 'external'
              ? undefined
              : SELECTED_IDLE_LIVE_PROJECTION_POLL_MS,
          )
        }
      })
    }, delayMs)
  }

  async function pollExternalRuntime(
    threadId: string,
    generation: number,
    detailRequest: ThreadDetailRequestLease,
  ): Promise<void> {
    let shouldRefreshThreadsAfterPoll = false
    try {
      const detail = await detailRequest.promise
      if (generation !== externalRuntimeGeneration) return
      if (selectedThreadId.value !== threadId) return
      const ownershipBeforePoll = runtimeOwnershipByThreadId.value[threadId] ?? 'idle'
      if (ownershipBeforePoll !== 'external' && !isSelectedLiveProjectionPollingEligible(threadId)) return

      if (
        detail.inProgress === true
        && detail.activeTurnId
        && isKnownTerminalTurnRuntime(threadId, detail.activeTurnId)
      ) {
        clearCompletedTurnLiveState(threadId)
        setThreadRuntimeOwnership(threadId, 'idle', { canInterrupt: false })
        setThreadInProgress(threadId, false)
        setLoadedThreadMetadataInProgress(threadId, false)
        shouldRefreshThreadsAfterPoll = true
      } else {
        reconcileThreadDetailSnapshot(threadId, detail, {
          preserveMissing: true,
          markRead: true,
          requestedVersion: '',
          detailEpoch: detailRequest.epoch,
          allowIdleExternalLeaseRelease:
            ownershipBeforePoll === 'external'
            && detail.isLiveProjection === true
            && detail.ownership === 'idle'
            && detail.externalRuntimeState === 'idle',
        })
        shouldRefreshThreadsAfterPoll = ownershipBeforePoll === 'external'
          && (
            runtimeOwnershipByThreadId.value[threadId] !== 'external'
            || inProgressById.value[threadId] !== true
          )
      }
    } catch {
      // Abort and read failures retain the confirmed external lease, output, and summary.
    } finally {
      releaseThreadDetailRequest(threadId, detailRequest)
    }
    if (!shouldRefreshThreadsAfterPoll) return
    pendingThreadsRefresh = true
    pendingThreadsRefreshForce = true
    if (typeof window !== 'undefined' && eventSyncTimer === null) {
      eventSyncTimer = window.setTimeout(() => {
        eventSyncTimer = null
        void syncFromNotifications()
      }, EVENT_SYNC_DEBOUNCE_MS)
    }
  }

  function clearPersistedExternalReasoning(threadId: string): void {
    const persisted = persistedMessagesByThreadId.value[threadId] ?? []
    const activeTurnId = activeTurnIdByThreadId.value[threadId]?.trim()
    const withoutReasoning = finalizeHydratedTurnText(
      persisted,
      activeTurnId || undefined,
    )
    if (withoutReasoning.length === persisted.length) return
    setPersistedMessagesForThread(threadId, withoutReasoning)
  }

  function setThreadRuntimeOwnership(
    threadId: string,
    ownership: ThreadRuntimeOwnership,
    options: { externalPollDelayMs?: number; canInterrupt?: boolean } = {},
  ): void {
    if (!threadId) return
    const currentOwnership = runtimeOwnershipByThreadId.value[threadId] ?? 'idle'
    const nextCanInterrupt = ownership === 'idle'
      ? false
      : options.canInterrupt ?? ownership === 'local'
    if ((runtimeCanInterruptByThreadId.value[threadId] === true) !== nextCanInterrupt) {
      runtimeCanInterruptByThreadId.value = nextCanInterrupt
        ? { ...runtimeCanInterruptByThreadId.value, [threadId]: true }
        : omitKey(runtimeCanInterruptByThreadId.value, threadId)
    }
    if (currentOwnership === 'external' && ownership !== 'external') {
      clearPersistedExternalReasoning(threadId)
    }
    if (ownership !== 'external') {
      clearThreadLiveAuthority(threadId)
    }
    if (ownership === 'local' && currentOwnership !== 'local') {
      localRuntimeAuthorityVersionByThreadId.set(
        threadId,
        (localRuntimeAuthorityVersionByThreadId.get(threadId) ?? 0) + 1,
      )
      backgroundExternalThreadIds.delete(threadId)
    }
    if (currentOwnership !== ownership) {
      runtimeOwnershipByThreadId.value = ownership === 'idle'
        ? omitKey(runtimeOwnershipByThreadId.value, threadId)
        : { ...runtimeOwnershipByThreadId.value, [threadId]: ownership }
    }

    if (selectedThreadId.value !== threadId) return
    if (ownership === 'external') {
      scheduleExternalRuntimePolling(threadId, options.externalPollDelayMs)
    } else if (ownership === 'local') {
      cancelExternalRuntimePolling()
    } else if (currentOwnership === 'external') {
      if (canStartSelectedLiveProjectionPolling(threadId)) {
        scheduleExternalRuntimePolling(threadId, options.externalPollDelayMs)
      } else {
        cancelExternalRuntimePolling()
      }
    }
  }

  function isExternallyOwned(threadId: string): boolean {
    return runtimeOwnershipByThreadId.value[threadId] === 'external'
  }

  function setLoadedThreadMetadataInProgress(threadId: string, inProgress: boolean): void {
    if (!threadId) return
    const nextLoadedGroups = setThreadInProgressInGroups(loadedThreadListGroups, threadId, inProgress)
    const nextSourceGroups = setThreadInProgressInGroups(sourceGroups.value, threadId, inProgress)
    if (nextLoadedGroups === loadedThreadListGroups && nextSourceGroups === sourceGroups.value) return

    loadedThreadListGroups = nextLoadedGroups
    sourceGroups.value = nextSourceGroups
    applyThreadFlags()
  }

  function setThreadInProgress(threadId: string, nextInProgress: boolean): void {
    if (!threadId) return
    const currentValue = inProgressById.value[threadId] === true
    if (currentValue === nextInProgress) return
    if (nextInProgress) {
      inProgressById.value = {
        ...inProgressById.value,
        [threadId]: true,
      }
    } else {
      if (runtimeOwnershipByThreadId.value[threadId] === 'external') {
        clearPersistedExternalReasoning(threadId)
      }
      inProgressById.value = omitKey(inProgressById.value, threadId)
      clearThreadLiveAuthority(threadId)
      clearCompletedTurnLiveState(threadId)
      clearInterruptPersistenceGate(threadId)
    }
    applyThreadFlags()
    if (!nextInProgress && !hasActiveInProgressThreads() && threadListNextCursor) {
      scheduleRemainingThreadPages()
    }
  }

  function clearInterruptPersistenceGate(threadId: string): void {
    if (!threadId) return
    if (interruptBlockedUntilPersistedByThreadId.value[threadId]) {
      interruptBlockedUntilPersistedByThreadId.value = omitKey(interruptBlockedUntilPersistedByThreadId.value, threadId)
    }
    if (threadListedByServerById.value[threadId]) {
      threadListedByServerById.value = omitKey(threadListedByServerById.value, threadId)
    }
    if (persistedUserMessageByThreadId.value[threadId]) {
      persistedUserMessageByThreadId.value = omitKey(persistedUserMessageByThreadId.value, threadId)
    }
  }

  function blockInterruptUntilThreadIsPersisted(threadId: string): void {
    if (!threadId) return
    interruptBlockedUntilPersistedByThreadId.value = {
      ...interruptBlockedUntilPersistedByThreadId.value,
      [threadId]: true,
    }
    if (threadListedByServerById.value[threadId]) {
      threadListedByServerById.value = omitKey(threadListedByServerById.value, threadId)
    }
    if (persistedUserMessageByThreadId.value[threadId]) {
      persistedUserMessageByThreadId.value = omitKey(persistedUserMessageByThreadId.value, threadId)
    }
  }

  function maybeUnblockInterruptForPersistedThread(threadId: string): void {
    if (!threadId) return
    if (interruptBlockedUntilPersistedByThreadId.value[threadId] !== true) return
    if (threadListedByServerById.value[threadId] !== true) return
    if (persistedUserMessageByThreadId.value[threadId] !== true) return
    clearInterruptPersistenceGate(threadId)
  }

  function maybeUnblockInterruptForActiveTurn(threadId: string, turnId: string): void {
    if (!threadId || !turnId) return
    if (interruptBlockedUntilPersistedByThreadId.value[threadId] !== true) return
    clearInterruptPersistenceGate(threadId)
  }

  function markServerListedThreads(serverThreadIds: Set<string>): void {
    const pendingThreadIds = Object.keys(interruptBlockedUntilPersistedByThreadId.value)
    if (pendingThreadIds.length === 0) return

    let nextListedState = threadListedByServerById.value
    let changed = false
    for (const threadId of pendingThreadIds) {
      if (!serverThreadIds.has(threadId) || nextListedState[threadId] === true) continue
      nextListedState = {
        ...nextListedState,
        [threadId]: true,
      }
      changed = true
    }

    if (!changed) return
    threadListedByServerById.value = nextListedState
    for (const threadId of pendingThreadIds) {
      maybeUnblockInterruptForPersistedThread(threadId)
    }
  }

  function markThreadMessagesPersisted(threadId: string, messages: UiMessage[]): void {
    if (!threadId) return
    if (interruptBlockedUntilPersistedByThreadId.value[threadId] !== true) return
    if (!messages.some((message) => message.role === 'user')) return
    if (persistedUserMessageByThreadId.value[threadId] !== true) {
      persistedUserMessageByThreadId.value = {
        ...persistedUserMessageByThreadId.value,
        [threadId]: true,
      }
    }
    maybeUnblockInterruptForPersistedThread(threadId)
  }

  function markThreadUnreadByEvent(threadId: string): void {
    if (!threadId) return
    if (threadId === selectedThreadId.value) return
    if (eventUnreadByThreadId.value[threadId] === true) return
    eventUnreadByThreadId.value = {
      ...eventUnreadByThreadId.value,
      [threadId]: true,
    }
    applyThreadFlags()
  }

  function setTurnActivityForThread(threadId: string, activity: TurnActivityState | null): void {
    if (!threadId) return

    const previous = turnActivityByThreadId.value[threadId]
    if (!activity) {
      if (previous) {
        turnActivityByThreadId.value = omitKey(turnActivityByThreadId.value, threadId)
      }
      return
    }

    const normalizedLabel = sanitizeDisplayText(activity.label) || 'Thinking'
    const incomingDetails = activity.details
      .map((line) => sanitizeDisplayText(line))
      .filter((line) => line.length > 0 && line !== normalizedLabel)
    const mergedDetails = Array.from(new Set([...(previous?.details ?? []), ...incomingDetails])).slice(-3)
    const nextActivity: TurnActivityState = {
      label: normalizedLabel,
      details: mergedDetails,
    }

    if (areTurnActivitiesEqual(previous, nextActivity)) return
    turnActivityByThreadId.value = {
      ...turnActivityByThreadId.value,
      [threadId]: nextActivity,
    }
  }

  function setTurnErrorForThread(
    threadId: string,
    message: string | null,
    options: { transient?: boolean } = {},
  ): void {
    if (!threadId) return

    const previous = turnErrorByThreadId.value[threadId]
    const normalizedMessage = message ? normalizeMessageText(message) : ''
    if (!normalizedMessage) {
      if (previous) {
        turnErrorByThreadId.value = omitKey(turnErrorByThreadId.value, threadId)
      }
      return
    }

    const transient = options.transient === true
    if (previous?.message === normalizedMessage && previous.transient === transient) return

    turnErrorByThreadId.value = {
      ...turnErrorByThreadId.value,
      [threadId]: { message: normalizedMessage, transient },
    }
  }

  function clearTransientTurnErrorForThread(threadId: string): void {
    if (!threadId) return
    if (!turnErrorByThreadId.value[threadId]?.transient) return
    setTurnErrorForThread(threadId, null)
  }

  function clearAllTransientTurnErrors(): void {
    const transientThreadIds = Object.entries(turnErrorByThreadId.value)
      .filter(([, state]) => state?.transient)
      .map(([threadId]) => threadId)
    if (transientThreadIds.length === 0) return

    let nextState = turnErrorByThreadId.value
    for (const threadId of transientThreadIds) {
      nextState = omitKey(nextState, threadId)
    }
    turnErrorByThreadId.value = nextState
  }

  function currentThreadVersion(threadId: string): string {
    const thread = flattenThreads(sourceGroups.value).find((row) => row.id === threadId)
    return thread?.updatedAtIso ?? ''
  }

  function setThreadTerminalOpen(threadId: string, isOpen: boolean): void {
    if (!threadId) return
    const next = { ...terminalOpenByThreadId.value }
    if (isOpen) {
      next[threadId] = true
    } else {
      delete next[threadId]
    }
    terminalOpenByThreadId.value = next
    saveThreadTerminalOpenMap(next)
  }

  function toggleSelectedThreadTerminal(): void {
    const threadId = selectedThreadId.value
    if (!threadId) return
    setThreadTerminalOpen(threadId, !selectedThreadTerminalOpen.value)
  }

  function setPersistedMessagesForThread(threadId: string, nextMessages: UiMessage[]): void {
    const previous = persistedMessagesByThreadId.value[threadId] ?? []
    if (!areMessageArraysEqual(previous, nextMessages)) {
      persistedMessagesByThreadId.value = {
        ...persistedMessagesByThreadId.value,
        [threadId]: nextMessages,
      }
    }
    reconcileOptimisticUserMessages(threadId, nextMessages)
  }

  function activeTextOlderCursorForThread(threadId: string): string | null {
    if (!threadId) return null
    const cursor = activeTextOlderCursorByThreadId.value[threadId] ?? null
    return cursor && cursor.trim().length > 0 ? cursor : null
  }

  function olderTurnCursorForThread(threadId: string): string | null {
    if (!threadId) return null
    const cursor = olderTurnCursorByThreadId.value[threadId] ?? null
    return cursor && cursor.trim().length > 0 ? cursor : null
  }

  function updateHasMoreOlderMessagesForThread(threadId: string): void {
    if (!threadId) return
    const nextValue = activeTextOlderCursorForThread(threadId) !== null
      || olderTurnCursorForThread(threadId) !== null
    if (hasMoreOlderMessagesByThreadId.value[threadId] === nextValue) return
    hasMoreOlderMessagesByThreadId.value = {
      ...hasMoreOlderMessagesByThreadId.value,
      [threadId]: nextValue,
    }
  }

  function setActiveTextOlderCursorForThread(threadId: string, cursor: string | null): void {
    if (!threadId) return
    const nextCursor = cursor && cursor.trim().length > 0 ? cursor : null
    if ((activeTextOlderCursorByThreadId.value[threadId] ?? null) !== nextCursor) {
      activeTextOlderCursorByThreadId.value = nextCursor === null
        ? omitKey(activeTextOlderCursorByThreadId.value, threadId)
        : {
            ...activeTextOlderCursorByThreadId.value,
            [threadId]: nextCursor,
          }
    }
    updateHasMoreOlderMessagesForThread(threadId)
  }

  function setOlderTurnCursorForThread(threadId: string, cursor: string | null): void {
    if (!threadId) return
    const nextCursor = cursor && cursor.trim().length > 0 ? cursor : null
    if ((olderTurnCursorByThreadId.value[threadId] ?? null) !== nextCursor) {
      olderTurnCursorByThreadId.value = nextCursor === null
        ? omitKey(olderTurnCursorByThreadId.value, threadId)
        : {
            ...olderTurnCursorByThreadId.value,
            [threadId]: nextCursor,
          }
    }
    updateHasMoreOlderMessagesForThread(threadId)
  }

  function recordActiveTextOlderCursorFromPage(
    threadId: string,
    hydration: ActiveTextHydration,
    page: ThreadTextPageSnapshot,
    options: { preserveExistingOnNotModified?: boolean } = {},
  ): void {
    const pageCursor = page.hasMoreOlder === true ? page.nextOlderCursor ?? null : null
    if (
      page.notModified === true
      && options.preserveExistingOnNotModified === true
      && pageCursor === null
      && hydration.nextOlderCursor !== null
    ) {
      setActiveTextOlderCursorForThread(threadId, hydration.nextOlderCursor)
      return
    }
    hydration.nextOlderCursor = pageCursor
    setActiveTextOlderCursorForThread(threadId, pageCursor)
  }

  function cancelActiveTextHydration(threadId: string): void {
    const hydration = activeTextHydrationByThreadId.get(threadId)
    if (!hydration) {
      setActiveTextOlderCursorForThread(threadId, null)
      return
    }
    hydration.controller?.abort()
    activeTextHydrationByThreadId.delete(threadId)
    setActiveTextOlderCursorForThread(threadId, null)
    activeTextHydrationGenerationByThreadId.set(
      threadId,
      (activeTextHydrationGenerationByThreadId.get(threadId) ?? 0) + 1,
    )
  }

  function pauseActiveTextHydration(threadId: string): void {
    const hydration = activeTextHydrationByThreadId.get(threadId)
    if (!hydration?.controller) return
    hydration.controller.abort()
    hydration.controller = null
    activeTextHydrationGenerationByThreadId.set(
      threadId,
      (activeTextHydrationGenerationByThreadId.get(threadId) ?? 0) + 1,
    )
  }

  function isActiveTextHydrationCurrent(
    threadId: string,
    hydration: ActiveTextHydration,
    generation: number,
  ): boolean {
    return selectedThreadId.value === threadId
      && activeTurnIdByThreadId.value[threadId] === hydration.turnId
      && activeTextHydrationByThreadId.get(threadId) === hydration
      && activeTextHydrationGenerationByThreadId.get(threadId) === generation
  }

  function isActiveTextHydrationConflictBlocked(
    threadId: string,
    hydration: ActiveTextHydration,
  ): boolean {
    return hydration.recoverableConflictProjectionKey !== undefined
      && hydration.recoverableConflictProjectionKey === (projectionKeyByThreadId.value[threadId] ?? '')
  }

  function publishActiveTextHydration(threadId: string, hydration: ActiveTextHydration): void {
    const transcript = persistedMessagesByThreadId.value[threadId] ?? []
    const nextTranscript = mergeHydratedTurnTextIntoTranscript(
      transcript,
      hydration.messages,
      hydration.turnId,
    )
    setPersistedMessagesForThread(
      threadId,
      nextTranscript,
    )
    removeLiveAgentMessagesPersistedIn(threadId, nextTranscript)
  }

  function newestHydratedSessionOrder(messages: UiMessage[]): number | undefined {
    const newest = messages.reduce((maximum, message) => {
      if (typeof message.sessionOrder !== 'number' || !Number.isFinite(message.sessionOrder)) {
        return maximum
      }
      return Math.max(maximum, message.sessionOrder)
    }, Number.NEGATIVE_INFINITY)
    return Number.isFinite(newest) ? newest : undefined
  }

  function activeTextPageRequestKey(
    cursor: string | undefined,
    tailOptions: { knownTailSignature?: string; afterSessionOrder?: number } | undefined,
  ): string {
    if (cursor) return `cursor:${cursor}`
    const rawAfterSessionOrder = tailOptions?.afterSessionOrder
    const afterSessionOrder = typeof rawAfterSessionOrder === 'number'
      && Number.isFinite(rawAfterSessionOrder)
      ? Math.max(0, Math.floor(rawAfterSessionOrder))
      : ''
    if (!tailOptions?.knownTailSignature) {
      return afterSessionOrder === ''
        ? 'newest:full:limit=default'
        : `newest:after=${afterSessionOrder}:limit=default`
    }
    return `newest:tail:${tailOptions.knownTailSignature}:after=${afterSessionOrder}:limit=default`
  }

  async function continueActiveTextHydration(
    threadId: string,
    hydration: ActiveTextHydration,
    generation: number,
  ): Promise<void> {
    if (!hydration.hasMoreOlder || !isActiveTextHydrationCurrent(threadId, hydration, generation)) return
    if (isActiveTextHydrationConflictBlocked(threadId, hydration)) return

    const cursor = hydration.consumedCursors.size === 0
      ? undefined
      : hydration.nextOlderCursor ?? undefined
    const cursorKey = cursor ?? ''
    if (hydration.consumedCursors.has(cursorKey)) return

    const controller = new AbortController()
    hydration.controller = controller
    try {
      const requestHadTailSignature = Boolean(hydration.tailSignature)
      const newestSessionOrder = !cursor
        ? newestHydratedSessionOrder(hydration.messages)
        : undefined
      const tailOptions = !cursor && (
        hydration.tailSignature
        || newestSessionOrder !== undefined
      )
        ? {
            ...(hydration.tailSignature ? { knownTailSignature: hydration.tailSignature } : {}),
            ...(newestSessionOrder !== undefined ? { afterSessionOrder: newestSessionOrder } : {}),
          }
        : undefined
      const loadPage = (): Promise<ThreadTextPageSnapshot> => tailOptions
        ? getThreadTextPage(
            threadId,
            hydration.turnId,
            cursor,
            undefined,
            controller.signal,
            tailOptions,
          )
        : getThreadTextPage(
            threadId,
            hydration.turnId,
            cursor,
            undefined,
            controller.signal,
          )
      const page = await multiWindowThreadSync.loadActiveTextPage({
        threadId,
        turnId: hydration.turnId,
        requestKey: activeTextPageRequestKey(cursor, tailOptions),
        signal: controller.signal,
        load: loadPage,
      })
      if (!isActiveTextHydrationCurrent(threadId, hydration, generation)) return

      hydration.consumedCursors.add(cursorKey)
      if (!cursor && page.tailSignature) {
        hydration.tailSignature = page.tailSignature
        hydration.lastUnsignedTailProbeAt = undefined
      } else if (!cursor && !requestHadTailSignature) {
        hydration.lastUnsignedTailProbeAt = Date.now()
      }
      if (page.notModified === true) {
        recordActiveTextOlderCursorFromPage(threadId, hydration, page, {
          preserveExistingOnNotModified: cursor === undefined,
        })
        hydration.hasMoreOlder = false
        return
      }
      hydration.messages = mergeThreadTextPage(hydration.messages, page.messages)
      recordActiveTextOlderCursorFromPage(threadId, hydration, page)
      hydration.hasMoreOlder = false
      publishActiveTextHydration(threadId, hydration)
    } catch (error) {
      if (
        isActiveTextHydrationCurrent(threadId, hydration, generation)
        && error instanceof CodexApiError
        && (error.status === 400 || error.status === 409)
      ) {
        hydration.nextOlderCursor = null
        hydration.hasMoreOlder = true
        hydration.consumedCursors.clear()
        hydration.recoverableConflictProjectionKey = projectionKeyByThreadId.value[threadId] ?? ''
        setActiveTextOlderCursorForThread(threadId, null)
      }
    } finally {
      if (hydration.controller === controller) {
        hydration.controller = null
      }
    }
  }

  function ensureActiveTextHydration(
    threadId: string,
    turnId: string,
    options: {
      refreshExhausted?: boolean
      forceRefreshExhausted?: boolean
      forceRefreshNewest?: boolean
    } = {},
  ): void {
    if (selectedThreadId.value !== threadId || !turnId) return

    let hydration = activeTextHydrationByThreadId.get(threadId)
    let createdHydration = false
    if (hydration && hydration.turnId !== turnId) {
      cancelActiveTextHydration(threadId)
      hydration = undefined
    } else if (hydration && options.forceRefreshNewest === true) {
      hydration.controller?.abort()
      hydration.controller = null
      hydration.nextOlderCursor = null
      hydration.hasMoreOlder = true
      hydration.consumedCursors.clear()
      hydration.recoverableConflictProjectionKey = undefined
      hydration.lastUnsignedTailProbeAt = undefined
      activeTextHydrationGenerationByThreadId.set(
        threadId,
        (activeTextHydrationGenerationByThreadId.get(threadId) ?? 0) + 1,
      )
    } else if (
      hydration
      && options.refreshExhausted === true
      && hydration.controller === null
      && hydration.hasMoreOlder === false
      && (
        options.forceRefreshExhausted === true
        || hydration.messages.length === 0
      )
    ) {
      hydration.nextOlderCursor = null
      hydration.hasMoreOlder = true
      hydration.consumedCursors.clear()
      hydration.recoverableConflictProjectionKey = undefined
      hydration.lastUnsignedTailProbeAt = undefined
      activeTextHydrationGenerationByThreadId.set(
        threadId,
        (activeTextHydrationGenerationByThreadId.get(threadId) ?? 0) + 1,
      )
    }
    if (!hydration) {
      hydration = {
        turnId,
        messages: [],
        nextOlderCursor: null,
        hasMoreOlder: true,
        consumedCursors: new Set<string>(),
        controller: null,
      }
      createdHydration = true
    }

    activeTextHydrationByThreadId.set(threadId, hydration)
    if (createdHydration) {
      activeTextHydrationGenerationByThreadId.set(
        threadId,
        (activeTextHydrationGenerationByThreadId.get(threadId) ?? 0) + 1,
      )
    }
    const currentGeneration = activeTextHydrationGenerationByThreadId.get(threadId) ?? 0
    if (hydration.controller === null && hydration.hasMoreOlder) {
      void continueActiveTextHydration(threadId, hydration, currentGeneration)
    }
  }

  function resumeActiveTextHydrationForTurn(threadId: string, turnId: string): void {
    if (selectedThreadId.value !== threadId) return
    const hydration = activeTextHydrationByThreadId.get(threadId)
    if (
      !hydration
      || hydration.turnId !== turnId
      || hydration.controller !== null
      || !hydration.hasMoreOlder
    ) return
    const generation = activeTextHydrationGenerationByThreadId.get(threadId) ?? 0
    void continueActiveTextHydration(threadId, hydration, generation)
  }

  function resumeActiveTextHydration(): void {
    const threadId = selectedThreadId.value
    const hydration = activeTextHydrationByThreadId.get(threadId)
    if (!hydration) return
    resumeActiveTextHydrationForTurn(threadId, hydration.turnId)
  }

  function reconcileOptimisticUserMessages(threadId: string, persisted: UiMessage[]): void {
    const pending = optimisticUserMessagesByThreadId.value[threadId] ?? []
    if (pending.length === 0) return
    const remaining = pending.filter(
      (submission) => (
        countEquivalentUserMessages(submission.message, persisted)
        < submission.expectedPersistedOccurrence
      ),
    )
    if (remaining.length === pending.length) return
    optimisticUserMessagesByThreadId.value = remaining.length > 0
      ? {
          ...optimisticUserMessagesByThreadId.value,
          [threadId]: remaining,
        }
      : omitKey(optimisticUserMessagesByThreadId.value, threadId)
  }

  function appendOptimisticUserMessage(
    threadId: string,
    text: string,
    imageUrls: string[] = [],
    skills: Array<{ name: string; path: string }> = [],
    fileAttachments: FileAttachment[] = [],
  ): string {
    const existing = optimisticUserMessagesByThreadId.value[threadId] ?? []
    const persisted = persistedMessagesByThreadId.value[threadId] ?? []
    const managedImageTokens: string[] = []
    const previewImageUrls: string[] = []
    for (const imageUrl of imageUrls) {
      if (!isManagedUploadImageUrl(imageUrl)) {
        previewImageUrls.push(imageUrl)
        continue
      }
      try {
        const parsed = new URL(imageUrl, 'http://localhost')
        const imagePath = parsed.searchParams.get('path')?.replace(/\\/gu, '/') ?? ''
        const label = imagePath.split('/').filter(Boolean).at(-1)?.trim() ?? ''
        if (label) managedImageTokens.push(`@${label}`)
      } catch {
        // Managed URL validation already succeeded; an unreadable label stays hidden.
      }
    }
    const tokenPrefix = managedImageTokens.join(' ')
    const optimisticText = tokenPrefix
      ? (text.trim() ? `${tokenPrefix}\n\n${text}` : tokenPrefix)
      : text
    const messageId = `optimistic-user:${threadId}:${Date.now()}`
    const nextMessage: UiMessage = {
      id: messageId,
      role: 'user',
      text: optimisticText,
      images: previewImageUrls.length > 0 ? previewImageUrls : undefined,
      skills: skills.length > 0 ? skills.map((skill) => ({ name: skill.name, path: skill.path })) : undefined,
      fileAttachments: fileAttachments.length > 0 ? fileAttachments.map((file) => ({ ...file })) : undefined,
      messageType: 'userMessage.optimistic',
    }
    const afterMessageId = existing.at(-1)?.message.id ?? persisted.at(-1)?.id ?? ''
    const expectedPersistedOccurrence = countEquivalentUserMessages(nextMessage, persisted)
      + existing.filter((submission) => areEquivalentUserMessages(nextMessage, submission.message)).length
      + 1
    optimisticUserMessagesByThreadId.value = {
      ...optimisticUserMessagesByThreadId.value,
      [threadId]: [...existing, { message: nextMessage, afterMessageId, expectedPersistedOccurrence }],
    }
    return messageId
  }

  function moveOptimisticUserMessage(
    fromThreadId: string,
    toThreadId: string,
    messageId: string,
  ): string {
    const source = optimisticUserMessagesByThreadId.value[fromThreadId] ?? []
    const submission = source.find((entry) => entry.message.id === messageId)
    if (!submission) return ''
    const target = optimisticUserMessagesByThreadId.value[toThreadId] ?? []
    const persisted = persistedMessagesByThreadId.value[toThreadId] ?? []
    const movedMessageId = `optimistic-user:${toThreadId}:${Date.now()}`
    const movedMessage = { ...submission.message, id: movedMessageId }
    const movedSubmission: OptimisticUserSubmission = {
      message: movedMessage,
      afterMessageId: target.at(-1)?.message.id ?? persisted.at(-1)?.id ?? '',
      expectedPersistedOccurrence: countEquivalentUserMessages(movedMessage, persisted)
        + target.filter((entry) => areEquivalentUserMessages(movedMessage, entry.message)).length
        + 1,
    }
    const remainingSource = source.filter((entry) => entry.message.id !== messageId)
    optimisticUserMessagesByThreadId.value = {
      ...optimisticUserMessagesByThreadId.value,
      ...(remainingSource.length > 0 ? { [fromThreadId]: remainingSource } : {}),
      [toThreadId]: [...target, movedSubmission],
    }
    if (remainingSource.length === 0) {
      optimisticUserMessagesByThreadId.value = omitKey(
        optimisticUserMessagesByThreadId.value,
        fromThreadId,
      )
    }
    return movedMessageId
  }

  function removeOptimisticUserMessage(threadId: string, messageId: string): void {
    if (!threadId || !messageId) return
    const existing = optimisticUserMessagesByThreadId.value[threadId] ?? []
    const next = existing.filter((submission) => submission.message.id !== messageId)
    if (next.length === existing.length) return
    optimisticUserMessagesByThreadId.value = next.length > 0
      ? {
          ...optimisticUserMessagesByThreadId.value,
          [threadId]: next,
        }
      : omitKey(optimisticUserMessagesByThreadId.value, threadId)
  }

  function readLiveAgentRawText(threadId: string, messageId: string, fallback: string): string {
    const threadMessages = liveAgentRawTextByThreadId.get(threadId)
    return threadMessages?.has(messageId) ? threadMessages.get(messageId) ?? '' : fallback
  }

  function writeLiveAgentRawText(threadId: string, messageId: string, text: string): void {
    let threadMessages = liveAgentRawTextByThreadId.get(threadId)
    if (!threadMessages) {
      threadMessages = new Map<string, string>()
      liveAgentRawTextByThreadId.set(threadId, threadMessages)
    }
    threadMessages.set(messageId, text)
  }

  function clearLiveAgentRawText(threadId: string, messageId: string): void {
    const threadMessages = liveAgentRawTextByThreadId.get(threadId)
    if (!threadMessages) return
    threadMessages.delete(messageId)
    if (threadMessages.size === 0) {
      liveAgentRawTextByThreadId.delete(threadId)
    }
  }

  function clearLiveAgentRawTextForThread(threadId: string): void {
    liveAgentRawTextByThreadId.delete(threadId)
  }

  function pruneLiveAgentRawText(activeThreadIds: Set<string>): void {
    for (const threadId of liveAgentRawTextByThreadId.keys()) {
      if (!activeThreadIds.has(threadId)) {
        liveAgentRawTextByThreadId.delete(threadId)
      }
    }
  }

  function setLiveAgentMessagesForThread(threadId: string, nextMessages: UiMessage[]): void {
    const previous = liveAgentMessagesByThreadId.value[threadId] ?? []
    if (areMessageArraysEqual(previous, nextMessages)) return
    liveAgentMessagesByThreadId.value = {
      ...liveAgentMessagesByThreadId.value,
      [threadId]: nextMessages,
    }
  }

  function clearLiveAgentMessagesForThread(threadId: string): void {
    if (!threadId) return
    clearLiveAgentRawTextForThread(threadId)
    if (!(threadId in liveAgentMessagesByThreadId.value)) return
    liveAgentMessagesByThreadId.value = omitKey(liveAgentMessagesByThreadId.value, threadId)
  }

  function setLiveFileChangeMessagesForThread(threadId: string, nextMessages: UiMessage[]): void {
    const previous = liveFileChangeMessagesByThreadId.value[threadId] ?? []
    if (areMessageArraysEqual(previous, nextMessages)) return
    liveFileChangeMessagesByThreadId.value = {
      ...liveFileChangeMessagesByThreadId.value,
      [threadId]: nextMessages,
    }
  }

  function setLivePlanMessagesForThread(threadId: string, nextMessages: UiMessage[]): void {
    const previous = livePlanMessagesByThreadId.value[threadId] ?? []
    if (areMessageArraysEqual(previous, nextMessages)) return
    livePlanMessagesByThreadId.value = {
      ...livePlanMessagesByThreadId.value,
      [threadId]: nextMessages,
    }
  }

  function upsertLivePlanMessage(threadId: string, nextMessage: UiMessage): void {
    const previous = livePlanMessagesByThreadId.value[threadId] ?? []
    const next = upsertMessage(previous, nextMessage)
    setLivePlanMessagesForThread(threadId, next)
  }

  function upsertLiveAgentMessage(threadId: string, nextMessage: UiMessage): void {
    const previous = liveAgentMessagesByThreadId.value[threadId] ?? []
    const next = upsertMessage(previous, nextMessage)
    setLiveAgentMessagesForThread(threadId, next)
  }

  function upsertLiveFileChangeMessage(threadId: string, nextMessage: UiMessage): void {
    const previous = liveFileChangeMessagesByThreadId.value[threadId] ?? []
    const next = upsertMessage(previous, nextMessage)
    setLiveFileChangeMessagesForThread(threadId, next)
  }

  function setLiveReasoningText(threadId: string, text: string): void {
    if (!threadId) return
    const nextText = text.trimStart()
    const previous = liveReasoningTextByThreadId.value[threadId] ?? ''
    if (nextText.trim().length === 0) {
      if (!previous) return
      liveReasoningTextByThreadId.value = omitKey(liveReasoningTextByThreadId.value, threadId)
      return
    }
    if (previous === nextText) return
    liveReasoningTextByThreadId.value = {
      ...liveReasoningTextByThreadId.value,
      [threadId]: nextText,
    }
  }

  function appendLiveReasoningText(threadId: string, delta: string): void {
    if (!threadId) return
    const previous = liveReasoningTextByThreadId.value[threadId] ?? ''
    setLiveReasoningText(threadId, `${previous}${delta}`)
  }

  function clearLiveReasoningForThread(threadId: string): void {
    if (!threadId) return
    if (!(threadId in liveReasoningTextByThreadId.value)) return
    liveReasoningTextByThreadId.value = omitKey(liveReasoningTextByThreadId.value, threadId)
  }

  function clearLivePlansForThread(threadId: string): void {
    if (!threadId) return
    if (!(threadId in livePlanMessagesByThreadId.value)) return
    livePlanMessagesByThreadId.value = omitKey(livePlanMessagesByThreadId.value, threadId)
  }

  function clearLiveFileChangesForThread(threadId: string): void {
    if (!threadId) return
    if (!(threadId in liveFileChangeMessagesByThreadId.value)) return
    liveFileChangeMessagesByThreadId.value = omitKey(liveFileChangeMessagesByThreadId.value, threadId)
  }

  function clearCompletedTurnLiveState(threadId: string): void {
    if (!threadId) return
    clearLivePlansForThread(threadId)
    clearLiveReasoningForThread(threadId)
    setTurnActivityForThread(threadId, null)
    if (threadId === selectedThreadId.value) {
      activeReasoningItemId = ''
    }
    if (liveCommandsByThreadId.value[threadId]) {
      liveCommandsByThreadId.value = omitKey(liveCommandsByThreadId.value, threadId)
    }
    if (activeTurnIdByThreadId.value[threadId]) {
      activeTurnIdByThreadId.value = omitKey(activeTurnIdByThreadId.value, threadId)
    }
    releasePendingTurnRequest(threadId)
  }

  async function reconcileMismatchedLocalCompletion(
    threadId: string,
    expectedActiveTurnId: string,
  ): Promise<void> {
    const generation = (completionReconciliationGenerationByThreadId.get(threadId) ?? 0) + 1
    completionReconciliationGenerationByThreadId.set(threadId, generation)
    const authorityVersion = localRuntimeAuthorityVersionByThreadId.get(threadId) ?? 0
    const detailRequest = acquireThreadDetailRequest(threadId, () => getThreadDetail(threadId))
    try {
      const detail = await detailRequest.promise
      if (completionReconciliationGenerationByThreadId.get(threadId) !== generation) return
      if ((localRuntimeAuthorityVersionByThreadId.get(threadId) ?? 0) !== authorityVersion) return
      if ((activeTurnIdByThreadId.value[threadId] ?? '') !== expectedActiveTurnId) return
      if (runtimeOwnershipByThreadId.value[threadId] === 'external') return

      reconcileThreadDetailSnapshot(threadId, detail, {
        preserveMissing: true,
        markRead: threadId === selectedThreadId.value,
        requestedVersion: '',
        detailEpoch: detailRequest.epoch,
        allowIdleLocalLeaseRelease: true,
      })
    } catch {
      // A later notification or runtime poll will retry authoritative convergence.
    } finally {
      releaseThreadDetailRequest(threadId, detailRequest)
    }
  }

  function normalizePlanStepStatus(value: unknown): UiPlanStep['status'] {
    if (value === 'completed') return 'completed'
    if (value === 'inProgress' || value === 'in_progress') return 'inProgress'
    return 'pending'
  }

  function buildPlanMessageText(plan: UiPlanData): string {
    const lines: string[] = []
    if (plan.explanation?.trim()) {
      lines.push(plan.explanation.trim())
    }
    for (const step of plan.steps) {
      const marker = step.status === 'completed' ? 'x' : step.status === 'inProgress' ? '~' : ' '
      lines.push(`- [${marker}] ${step.step}`)
    }
    return lines.join('\n').trim()
  }

  function readPlanUpdate(notification: RpcNotification): { threadId: string; message: UiMessage } | null {
    if (notification.method !== 'turn/plan/updated') return null
    const params = asRecord(notification.params)
    const threadId = extractThreadIdFromNotification(notification)
    const turnId = readString(params?.turnId) || readString(params?.turn_id)
    const rawSteps = Array.isArray(params?.plan) ? params?.plan : []
    const steps: UiPlanStep[] = rawSteps
      .map((row) => asRecord(row))
      .map((row) => ({
        step: readString(row?.step),
        status: normalizePlanStepStatus(row?.status),
      }))
      .filter((row) => row.step.length > 0)

    if (!threadId || !turnId) return null

    const explanation = readString(params?.explanation).trim()
    const plan: UiPlanData = {
      explanation: explanation || undefined,
      steps,
      isStreaming: true,
    }

    return {
      threadId,
      message: {
        id: `${turnId}:plan`,
        role: 'assistant',
        text: buildPlanMessageText(plan),
        messageType: 'plan.live',
        plan,
      },
    }
  }

  function readPlanDelta(notification: RpcNotification): { threadId: string; message: UiMessage } | null {
    if (notification.method !== 'item/plan/delta') return null
    const params = asRecord(notification.params)
    const threadId = extractThreadIdFromNotification(notification)
    const turnId = readString(params?.turnId) || readString(params?.turn_id)
    const delta = readString(params?.delta)
    if (!threadId || !turnId || !delta) return null

    const messageId = `${turnId}:plan`
    const existing = (livePlanMessagesByThreadId.value[threadId] ?? []).find((message) => message.id === messageId)
    const nextText = `${existing?.text ?? ''}${delta}`
    const nextPlan: UiPlanData | undefined = existing?.plan
      ? { ...existing.plan, isStreaming: true }
      : undefined

    return {
      threadId,
      message: {
        id: messageId,
        role: 'assistant',
        text: nextText,
        messageType: 'plan.live',
        plan: nextPlan,
      },
    }
  }

  function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  }

  function readString(value: unknown): string {
    return typeof value === 'string' ? value : ''
  }

  function readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  }

  function readThreadGoal(value: unknown): UiThreadGoal | null {
    const record = asRecord(value)
    if (!record) return null
    const status = readString(record.status) as UiThreadGoalStatus
    const updatedAt = readNumber(record.updatedAt)
    const timeUsedSeconds = readNumber(record.timeUsedSeconds)
    const tokensUsed = readNumber(record.tokensUsed)
    const tokenBudget = record.tokenBudget === null ? null : readNumber(record.tokenBudget)
    if (
      !THREAD_GOAL_STATUSES.has(status)
      || updatedAt === null
      || timeUsedSeconds === null
      || tokensUsed === null
      || (record.tokenBudget !== null && tokenBudget === null)
    ) return null
    return {
      objective: readString(record.objective),
      status,
      updatedAt,
      timeUsedSeconds,
      tokensUsed,
      tokenBudget,
    }
  }

  function isThreadGoalUnsupportedError(value: unknown): boolean {
    const message = value instanceof Error ? value.message : String(value ?? '')
    return value instanceof CodexApiError && value.status === 404
      || /(?:method|rpc).*(?:not found|unknown|unsupported)|-32601|thread\/goal.*(?:not found|unsupported)/iu.test(message)
  }

  function invalidateThreadGoalRequest(threadId: string): number {
    const requestEpoch = (threadGoalRequestEpochByThreadId.get(threadId) ?? 0) + 1
    threadGoalRequestEpochByThreadId.set(threadId, requestEpoch)
    return requestEpoch
  }

  function isCurrentThreadGoalRequest(
    threadId: string,
    requestEpoch: number,
    requestGeneration: number,
  ): boolean {
    return requestGeneration === threadGoalRequestGeneration
      && threadGoalRequestEpochByThreadId.get(threadId) === requestEpoch
  }

  function acquireThreadGoalMutation(threadId: string): symbol | null {
    if (updatingThreadGoalByThreadId.value[threadId] !== undefined) return null
    const owner = Symbol(threadId)
    updatingThreadGoalByThreadId.value = {
      ...updatingThreadGoalByThreadId.value,
      [threadId]: owner,
    }
    return owner
  }

  function releaseThreadGoalMutation(threadId: string, owner: symbol): void {
    if (updatingThreadGoalByThreadId.value[threadId] !== owner) return
    updatingThreadGoalByThreadId.value = omitKey(updatingThreadGoalByThreadId.value, threadId)
  }

  async function refreshThreadGoal(threadId: string): Promise<void> {
    const generation = threadGoalRequestGeneration
    const requestEpoch = invalidateThreadGoalRequest(threadId)
    const isCurrentRequest = () => isCurrentThreadGoalRequest(threadId, requestEpoch, generation)
    try {
      const goal = await getThreadGoal(threadId)
      if (!isCurrentRequest()) return
      threadGoalSupportByThreadId.value = {
        ...threadGoalSupportByThreadId.value,
        [threadId]: true,
      }
      if (goal) {
        threadGoalByThreadId.value = {
          ...threadGoalByThreadId.value,
          [threadId]: goal,
        }
      } else {
        threadGoalByThreadId.value = omitKey(threadGoalByThreadId.value, threadId)
      }
    } catch (goalError) {
      if (!isCurrentRequest()) return
      if (isThreadGoalUnsupportedError(goalError)) {
        threadGoalSupportByThreadId.value = {
          ...threadGoalSupportByThreadId.value,
          [threadId]: false,
        }
        threadGoalByThreadId.value = omitKey(threadGoalByThreadId.value, threadId)
      }
    }
  }

  function getRateLimitSnapshotKey(snapshot: UiRateLimitSnapshot): string {
    return snapshot.limitId?.trim() || snapshot.limitName?.trim() || '__default__'
  }

  function normalizeRateLimitWindow(value: unknown): UiRateLimitSnapshot['primary'] {
    const record = asRecord(value)
    if (!record) return null

    const windowValue = readNumber(record.windowDurationMins)
    return {
      usedPercent: clamp(readNumber(record.usedPercent) ?? 0, 0, 100),
      windowDurationMins: windowValue,
      windowMinutes: windowValue,
      resetsAt: readNumber(record.resetsAt),
    }
  }

  function normalizeRateLimitSnapshot(value: unknown): UiRateLimitSnapshot | null {
    const record = asRecord(value)
    if (!record) return null

    const credits = asRecord(record.credits)
    return {
      limitId: readString(record.limitId) || null,
      limitName: readString(record.limitName) || null,
      primary: normalizeRateLimitWindow(record.primary),
      secondary: normalizeRateLimitWindow(record.secondary),
      credits: credits
        ? {
            hasCredits: credits.hasCredits === true,
            unlimited: credits.unlimited === true,
            balance: readString(credits.balance) || null,
          }
        : null,
      planType: readString(record.planType) || null,
    }
  }

  function normalizeRateLimitSnapshotsPayload(value: unknown): UiRateLimitSnapshot[] {
    const record = asRecord(value)
    if (!record) return []

    const next: UiRateLimitSnapshot[] = []
    const seen = new Set<string>()
    const pushSnapshot = (snapshot: UiRateLimitSnapshot | null): void => {
      if (!snapshot) return
      const key = getRateLimitSnapshotKey(snapshot)
      if (seen.has(key)) return
      seen.add(key)
      next.push(snapshot)
    }

    pushSnapshot(normalizeRateLimitSnapshot(record.rateLimits))

    const byLimitId = asRecord(record.rateLimitsByLimitId)
    if (byLimitId) {
      for (const snapshot of Object.values(byLimitId)) {
        pushSnapshot(normalizeRateLimitSnapshot(snapshot))
      }
    }

    return next
  }

  function normalizeTokenUsageBreakdown(value: unknown): UiTokenUsageBreakdown | null {
    const record = asRecord(value)
    if (!record) return null

    const totalTokens = readNumber(record.totalTokens ?? record.total_tokens)
    const inputTokens = readNumber(record.inputTokens ?? record.input_tokens)
    const cachedInputTokens = readNumber(record.cachedInputTokens ?? record.cached_input_tokens)
    const outputTokens = readNumber(record.outputTokens ?? record.output_tokens)
    const reasoningOutputTokens = readNumber(record.reasoningOutputTokens ?? record.reasoning_output_tokens)
    if (
      totalTokens === null ||
      inputTokens === null ||
      cachedInputTokens === null ||
      outputTokens === null ||
      reasoningOutputTokens === null
    ) {
      return null
    }

    return {
      totalTokens,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningOutputTokens,
    }
  }

  function normalizeThreadTokenUsage(value: unknown): UiThreadTokenUsage | null {
    const record = asRecord(value)
    if (!record) return null

    const total = normalizeTokenUsageBreakdown(record.total)
    const last = normalizeTokenUsageBreakdown(record.last)
    if (!total || !last) return null

    const modelContextWindow = readNumber(record.modelContextWindow ?? record.model_context_window)
    const currentContextTokens = last.totalTokens
    const remainingContextTokens = typeof modelContextWindow === 'number'
      ? Math.max(modelContextWindow - currentContextTokens, 0)
      : null
    const remainingContextPercent = typeof modelContextWindow === 'number' && modelContextWindow > 0
      ? clamp(Math.round((remainingContextTokens ?? 0) / modelContextWindow * 100), 0, 100)
      : null

    return {
      total,
      last,
      modelContextWindow,
      currentContextTokens,
      remainingContextTokens,
      remainingContextPercent,
    }
  }

  function readThreadTokenUsageUpdate(notification: RpcNotification): { threadId: string; usage: UiThreadTokenUsage } | null {
    if (notification.method !== 'thread/tokenUsage/updated') return null
    const params = asRecord(notification.params)
    const threadId = extractThreadIdFromNotification(notification)
    const usage = normalizeThreadTokenUsage(params?.tokenUsage ?? params?.token_usage)
    if (!threadId || !usage) return null
    return { threadId, usage }
  }

  function extractThreadIdFromNotification(notification: RpcNotification): string {
    const params = asRecord(notification.params)
    if (!params) return ''

    const directThreadId = readString(params.threadId)
    if (directThreadId) return directThreadId
    const snakeThreadId = readString(params.thread_id)
    if (snakeThreadId) return snakeThreadId

    const conversationId = readString(params.conversationId)
    if (conversationId) return conversationId
    const snakeConversationId = readString(params.conversation_id)
    if (snakeConversationId) return snakeConversationId

    const thread = asRecord(params.thread)
    const nestedThreadId = readString(thread?.id)
    if (nestedThreadId) return nestedThreadId

    const turn = asRecord(params.turn)
    const turnThreadId = readString(turn?.threadId)
    if (turnThreadId) return turnThreadId
    const turnSnakeThreadId = readString(turn?.thread_id)
    if (turnSnakeThreadId) return turnSnakeThreadId

    const item = asRecord(params.item)
    const itemThreadId = readString(item?.threadId)
    if (itemThreadId) return itemThreadId
    const itemSnakeThreadId = readString(item?.thread_id)
    if (itemSnakeThreadId) return itemSnakeThreadId

    const itemTurn = asRecord(item?.turn)
    const itemTurnThreadId = readString(itemTurn?.threadId)
    if (itemTurnThreadId) return itemTurnThreadId
    const itemTurnSnakeThreadId = readString(itemTurn?.thread_id)
    if (itemTurnSnakeThreadId) return itemTurnSnakeThreadId

    const turnId = extractTurnIdFromNotification(notification)
    if (turnId) {
      for (const [knownThreadId, knownTurnId] of Object.entries(activeTurnIdByThreadId.value)) {
        if (knownTurnId === turnId) return knownThreadId
      }
    }

    return ''
  }

  function extractTurnIdFromNotification(notification: RpcNotification): string {
    const params = asRecord(notification.params)
    if (!params) return ''

    const directTurnId = readString(params.turnId)
    if (directTurnId) return directTurnId
    const snakeTurnId = readString(params.turn_id)
    if (snakeTurnId) return snakeTurnId

    const turn = asRecord(params.turn)
    const nestedTurnId = readString(turn?.id)
    if (nestedTurnId) return nestedTurnId

    const item = asRecord(params.item)
    const itemTurnId = readString(item?.turnId)
    if (itemTurnId) return itemTurnId
    const itemSnakeTurnId = readString(item?.turn_id)
    if (itemSnakeTurnId) return itemSnakeTurnId

    const itemTurn = asRecord(item?.turn)
    const nestedItemTurnId = readString(itemTurn?.id)
    if (nestedItemTurnId) return nestedItemTurnId

    return ''
  }

  function readTurnErrorMessage(notification: RpcNotification): string {
    if (notification.method !== 'turn/completed') return ''
    const params = asRecord(notification.params)
    const turn = asRecord(params?.turn)
    if (!turn || turn.status !== 'failed') return ''
    const errorPayload = asRecord(turn.error)
    return readString(errorPayload?.message)
  }

  function readNotificationErrorState(notification: RpcNotification): { message: string; transient: boolean } | null {
    if (notification.method !== 'error') return null
    const params = asRecord(notification.params)
    const message = (
      readString(params?.message) ||
      readString(asRecord(params?.error)?.message)
    )
    if (!message) return null

    return {
      message,
      transient: params?.willRetry === true,
    }
  }

  function normalizeServerRequest(params: unknown): UiServerRequest | null {
    const row = asRecord(params)
    if (!row) return null

    const id = row.id
    const rawMethod = readString(row.method)
    const requestParams = row.params
    if (typeof id !== 'number' || !Number.isInteger(id) || !rawMethod) {
      return null
    }

    const requestParamRecord = asRecord(requestParams)
    const method = normalizePendingServerRequestMethod(rawMethod, requestParamRecord)
    if (method === 'item/tool/call') {
      return null
    }
    const threadId = (
      readString(requestParamRecord?.threadId) ||
      readString(requestParamRecord?.thread_id) ||
      readString(requestParamRecord?.conversationId) ||
      readString(requestParamRecord?.conversation_id) ||
      GLOBAL_SERVER_REQUEST_SCOPE
    )
    const turnId = readString(requestParamRecord?.turnId) || readString(requestParamRecord?.turn_id)
    const itemId = (
      readString(requestParamRecord?.itemId) ||
      readString(requestParamRecord?.item_id) ||
      readString(requestParamRecord?.callId) ||
      readString(requestParamRecord?.call_id)
    )
    const receivedAtIso = readString(row.receivedAtIso) || new Date().toISOString()

    return {
      id,
      method,
      threadId,
      turnId,
      itemId,
      receivedAtIso,
      params: requestParams ?? null,
    }
  }

  function normalizePendingServerRequestMethod(
    method: string,
    params: Record<string, unknown> | null,
  ): string {
    const normalized = method.trim()
    if (!normalized) return normalized

    if (
      normalized === 'item/commandExecution/requestApproval' ||
      normalized === 'execCommandApproval' ||
      normalized === 'exec_approval_request' ||
      looksLikeExecApprovalRequest(params)
    ) {
      return 'item/commandExecution/requestApproval'
    }

    if (
      normalized === 'item/fileChange/requestApproval' ||
      normalized === 'applyPatchApproval' ||
      normalized === 'apply_patch_approval_request' ||
      looksLikePatchApprovalRequest(params)
    ) {
      return 'item/fileChange/requestApproval'
    }

    if (
      normalized === 'item/tool/requestUserInput' ||
      normalized === 'request_user_input' ||
      looksLikeToolUserInputRequest(params)
    ) {
      return 'item/tool/requestUserInput'
    }

    if (
      normalized === 'mcpServer/elicitation/request' ||
      normalized === 'elicitation_request' ||
      looksLikeMcpServerElicitationRequest(params)
    ) {
      return 'mcpServer/elicitation/request'
    }

    if (normalized === 'item/permissions/requestApproval' || looksLikePermissionsApprovalRequest(params)) {
      return 'item/permissions/requestApproval'
    }

    if (
      normalized === 'item/tool/call' ||
      normalized === 'dynamic_tool_call_request' ||
      looksLikeToolCallRequest(params)
    ) {
      return 'item/tool/call'
    }

    return normalized
  }

  function looksLikeExecApprovalRequest(params: Record<string, unknown> | null): boolean {
    if (!params) return false
    const command = params.command
    if (Array.isArray(command) && command.some((part) => typeof part === 'string' && part.trim().length > 0)) {
      return true
    }
    if (typeof command === 'string' && command.trim().length > 0) {
      return true
    }
    return Array.isArray(params.commandActions)
  }

  function looksLikePatchApprovalRequest(params: Record<string, unknown> | null): boolean {
    if (!params) return false
    if (typeof params.grantRoot === 'string' && params.grantRoot.trim().length > 0) return true
    if (typeof params.grant_root === 'string' && params.grant_root.trim().length > 0) return true
    if (asRecord(params.fileChanges)) return true
    return asRecord(params.changes) !== null
  }

  function looksLikeToolUserInputRequest(params: Record<string, unknown> | null): boolean {
    return Boolean(params && Array.isArray(params.questions))
  }

  function looksLikeToolCallRequest(params: Record<string, unknown> | null): boolean {
    if (!params) return false
    return (
      typeof params.toolName === 'string' ||
      typeof params.tool_name === 'string' ||
      typeof params.name === 'string' ||
      Array.isArray(params.arguments)
    )
  }

  function looksLikeMcpServerElicitationRequest(params: Record<string, unknown> | null): boolean {
    if (!params) return false
    const mode = readString(params.mode)
    return (
      typeof params.serverName === 'string' &&
      typeof params.threadId === 'string' &&
      typeof params.message === 'string' &&
      (mode === 'form' || mode === 'url')
    )
  }

  function looksLikePermissionsApprovalRequest(params: Record<string, unknown> | null): boolean {
    if (!params) return false
    return (
      typeof params.threadId === 'string' &&
      typeof params.turnId === 'string' &&
      typeof params.itemId === 'string' &&
      asRecord(params.permissions) !== null
    )
  }

  function readToolRequestUserInputQuestionIds(request: UiServerRequest): string[] {
    if (request.method !== 'item/tool/requestUserInput') return []
    const params = asRecord(request.params)
    const questions = Array.isArray(params?.questions) ? params.questions : []
    const questionIds: string[] = []

    for (const row of questions) {
      const question = asRecord(row)
      const id = readString(question?.id).trim()
      if (id) {
        questionIds.push(id)
      }
    }

    return questionIds
  }

  function upsertPendingServerRequest(request: UiServerRequest): void {
    const threadId = request.threadId || GLOBAL_SERVER_REQUEST_SCOPE
    const current = pendingServerRequestsByThreadId.value[threadId] ?? []
    const index = current.findIndex((row) => row.id === request.id)
    const nextRows = [...current]
    if (index >= 0) {
      nextRows.splice(index, 1, request)
    } else {
      nextRows.push(request)
    }

    pendingServerRequestsByThreadId.value = {
      ...pendingServerRequestsByThreadId.value,
      [threadId]: nextRows.sort((first, second) => first.receivedAtIso.localeCompare(second.receivedAtIso)),
    }
    applyThreadFlags()
  }

  function removePendingServerRequestById(requestId: number): void {
    const next: Record<string, UiServerRequest[]> = {}
    for (const [threadId, requests] of Object.entries(pendingServerRequestsByThreadId.value)) {
      const filtered = requests.filter((request) => request.id !== requestId)
      if (filtered.length > 0) {
        next[threadId] = filtered
      }
    }
    pendingServerRequestsByThreadId.value = next
    applyThreadFlags()
  }

  function findPendingServerRequestScope(requestId: number): string {
    let matchedScope = ''
    for (const [scope, requests] of Object.entries(pendingServerRequestsByThreadId.value)) {
      if (!requests.some((request) => request.id === requestId)) continue
      if (matchedScope && matchedScope !== scope) return ''
      matchedScope = scope
    }
    return matchedScope
  }

  function replacePendingServerRequests(requests: UiServerRequest[]): void {
    const next: Record<string, UiServerRequest[]> = {}
    for (const request of requests) {
      const threadId = request.threadId || GLOBAL_SERVER_REQUEST_SCOPE
      const current = next[threadId] ?? []
      current.push(request)
      next[threadId] = current
    }

    for (const rows of Object.values(next)) {
      rows.sort((first, second) => first.receivedAtIso.localeCompare(second.receivedAtIso))
    }

    pendingServerRequestsByThreadId.value = next
  }

  function handleServerRequestNotification(notification: RpcNotification): boolean {
    if (notification.method === 'server/request') {
      const request = normalizeServerRequest(notification.params)
      if (!request) return true
      upsertPendingServerRequest(request)
      return true
    }

    if (notification.method === 'server/request/resolved') {
      const row = asRecord(notification.params)
      const id = row?.id
      if (typeof id === 'number' && Number.isInteger(id)) {
        removePendingServerRequestById(id)
      }
      return true
    }

    return false
  }

  function sanitizeDisplayText(value: string): string {
    return value.replace(/\s+/gu, ' ').trim()
  }

  function readTurnActivity(notification: RpcNotification): { threadId: string; activity: TurnActivityState } | null {
    const threadId = extractThreadIdFromNotification(notification)
    if (!threadId) return null

    if (notification.method === 'turn/started') {
      return {
        threadId,
        activity: {
          label: 'Thinking',
          details: [],
        },
      }
    }

    if (notification.method === 'item/started') {
      const params = asRecord(notification.params)
      const item = asRecord(params?.item)
      const itemType = readString(item?.type).toLowerCase()
      if (itemType === 'reasoning') {
        return {
          threadId,
          activity: {
            label: 'Thinking',
            details: [],
          },
        }
      }
      if (itemType === 'agentmessage') {
        return {
          threadId,
          activity: {
            label: 'Writing response',
            details: [],
          },
        }
      }
      if (itemType === 'commandexecution') {
        const cmd = readString(item?.command)
        return {
          threadId,
          activity: {
            label: 'Running command',
            details: cmd ? [cmd] : [],
          },
        }
      }
      if (itemType === 'filechange') {
        const changes = Array.isArray(item?.changes) ? item.changes : []
        const firstChange = changes[0] as Record<string, unknown> | undefined
        const path = readString(firstChange?.path)
        return {
          threadId,
          activity: {
            label: 'Applying changes',
            details: path ? [path] : [],
          },
        }
      }
    }

    if (notification.method === 'item/commandExecution/outputDelta') {
      return {
        threadId,
        activity: {
          label: 'Running command',
          details: [],
        },
      }
    }

    if (
      notification.method === 'item/reasoning/summaryTextDelta' ||
      notification.method === 'item/reasoning/summaryPartAdded' ||
      notification.method === 'item/reasoning/textDelta'
    ) {
      return {
        threadId,
        activity: {
          label: 'Thinking',
          details: [],
        },
      }
    }

    if (notification.method === 'item/agentMessage/delta') {
      return {
        threadId,
        activity: {
          label: 'Writing response',
          details: [],
        },
      }
    }

    return null
  }

  function readTurnStartedInfo(notification: RpcNotification): TurnStartedInfo | null {
    if (notification.method !== 'turn/started') {
      return null
    }

    const params = asRecord(notification.params)
    if (!params) return null
    const threadId = extractThreadIdFromNotification(notification)
    if (!threadId) return null

    const turnPayload = asRecord(params.turn)
    const turnId =
      readString(turnPayload?.id) ||
      readString(params.turnId) ||
      `${threadId}:unknown`
    if (!turnId) return null

    const startedAtMs =
      parseIsoTimestamp(readString(turnPayload?.startedAt)) ??
      parseIsoTimestamp(readString(params.startedAt)) ??
      parseIsoTimestamp(notification.atIso) ??
      Date.now()

    return {
      threadId,
      turnId,
      startedAtMs,
    }
  }

  function readTurnCompletedInfo(notification: RpcNotification): TurnCompletedInfo | null {
    if (notification.method !== 'turn/completed') {
      return null
    }

    const params = asRecord(notification.params)
    if (!params) return null
    const threadId = extractThreadIdFromNotification(notification)
    if (!threadId) return null

    const turnPayload = asRecord(params.turn)
    const turnId =
      readString(turnPayload?.id) ||
      readString(params.turnId) ||
      `${threadId}:unknown`
    if (!turnId) return null

    const completedAtMs =
      parseIsoTimestamp(readString(turnPayload?.completedAt)) ??
      parseIsoTimestamp(readString(params.completedAt)) ??
      parseIsoTimestamp(notification.atIso) ??
      Date.now()

    const startedAtMs =
      parseIsoTimestamp(readString(turnPayload?.startedAt)) ??
      parseIsoTimestamp(readString(params.startedAt)) ??
      undefined

    return {
      threadId,
      turnId,
      status: readString(turnPayload?.status),
      completedAtMs,
      startedAtMs,
    }
  }

  function liveReasoningMessageId(reasoningItemId: string): string {
    return `${reasoningItemId}:live-reasoning`
  }

  function inferNextTurnIndex(threadId: string): number {
    const persisted = persistedMessagesByThreadId.value[threadId] ?? []
    let maxTurnIndex = -1
    for (const message of persisted) {
      if (typeof message.turnIndex === 'number' && Number.isFinite(message.turnIndex)) {
        maxTurnIndex = Math.max(maxTurnIndex, message.turnIndex)
      }
    }
    return maxTurnIndex + 1
  }

  function setTurnIndexForThread(threadId: string, turnId: string, turnIndex: number): void {
    if (!threadId || !turnId || !Number.isInteger(turnIndex) || turnIndex < 0) return
    const previous = turnIndexByTurnIdByThreadId.value[threadId] ?? {}
    if (previous[turnId] === turnIndex) return
    turnIndexByTurnIdByThreadId.value = {
      ...turnIndexByTurnIdByThreadId.value,
      [threadId]: {
        ...previous,
        [turnId]: turnIndex,
      },
    }
  }

  function replaceTurnIndexLookupForThread(threadId: string, nextLookup: Record<string, number>): void {
    const previous = turnIndexByTurnIdByThreadId.value[threadId] ?? {}
    const previousEntries = Object.entries(previous)
    const nextEntries = Object.entries(nextLookup)
    if (
      previousEntries.length === nextEntries.length
      && previousEntries.every(([turnId, turnIndex]) => nextLookup[turnId] === turnIndex)
    ) {
      return
    }

    turnIndexByTurnIdByThreadId.value = {
      ...turnIndexByTurnIdByThreadId.value,
      [threadId]: { ...nextLookup },
    }
  }

  function rebindLiveFileChangeTurnIndices(threadId: string): void {
    const current = liveFileChangeMessagesByThreadId.value[threadId]
    if (!current || current.length === 0) return

    const turnIndexByTurnId = turnIndexByTurnIdByThreadId.value[threadId] ?? {}
    let changed = false
    const next = current.map((message) => {
      if (typeof message.turnIndex === 'number' || !message.turnId) {
        return message
      }
      const turnIndex = turnIndexByTurnId[message.turnId]
      if (typeof turnIndex !== 'number') return message
      changed = true
      return { ...message, turnIndex }
    })

    if (!changed) return
    liveFileChangeMessagesByThreadId.value = {
      ...liveFileChangeMessagesByThreadId.value,
      [threadId]: next,
    }
  }

  function readReasoningStartedItemId(notification: RpcNotification): string {
    const params = asRecord(notification.params)
    if (!params) return ''

    if (notification.method === 'item/started') {
      const item = asRecord(params.item)
      if (!item || item.type !== 'reasoning') return ''
      return readString(item.id)
    }

    return ''
  }

  function readReasoningDelta(notification: RpcNotification): { messageId: string; delta: string } | null {
    const params = asRecord(notification.params)
    if (!params) return null

    // Канонический источник дельт для UI — уже нормализованный item/*.
    if (notification.method === 'item/reasoning/summaryTextDelta') {
      const itemId = readString(params.itemId)
      const delta = readString(params.delta)
      if (!itemId || !delta) return null
      return { messageId: liveReasoningMessageId(itemId), delta }
    }

    // codex also emits the full reasoning-chain stream as item/reasoning/textDelta
    // (alongside the summary stream). Without handling it, reasoning text the
    // model streams via this channel is dropped and the UI shows only the
    // summary, making long thinking phases look like a stall.
    if (notification.method === 'item/reasoning/textDelta') {
      const itemId = readString(params.itemId)
      const delta = readString(params.delta)
      if (!itemId || !delta) return null
      return { messageId: liveReasoningMessageId(itemId), delta }
    }

    return null
  }

  function readReasoningSectionBreakMessageId(notification: RpcNotification): string {
    const params = asRecord(notification.params)
    if (!params) return ''

    // Канонический source для section break — item/*
    if (notification.method === 'item/reasoning/summaryPartAdded') {
      const itemId = readString(params.itemId)
      if (!itemId) return ''
      return liveReasoningMessageId(itemId)
    }

    return ''
  }

  function readReasoningCompletedId(notification: RpcNotification): string {
    const params = asRecord(notification.params)
    if (!params) return ''

    if (notification.method === 'item/completed') {
      const item = asRecord(params.item)
      if (!item || item.type !== 'reasoning') return ''
      return liveReasoningMessageId(readString(item.id))
    }

    return ''
  }

  function readAgentMessageStartedId(notification: RpcNotification): string {
    const params = asRecord(notification.params)
    if (!params) return ''

    if (notification.method === 'item/started') {
      const item = asRecord(params.item)
      if (!item || item.type !== 'agentMessage') return ''
      return readString(item.id)
    }

    return ''
  }

  function readAgentMessageDelta(notification: RpcNotification): { messageId: string; delta: string } | null {
    const params = asRecord(notification.params)
    if (!params) return null

    // Канонический live-канал агентского текста.
    if (notification.method === 'item/agentMessage/delta') {
      const messageId = readString(params.itemId)
      const delta = readString(params.delta)
      if (!messageId || !delta) return null
      return { messageId, delta }
    }

    return null
  }

  function readAgentMessageCompleted(notification: RpcNotification): UiMessage | null {
    const params = asRecord(notification.params)
    if (!params) return null

    if (notification.method === 'item/completed') {
      const item = asRecord(params.item)
      if (!item || item.type !== 'agentMessage') return null
      const id = readString(item.id)
      const text = readString(item.text)
      if (!id) return null
      const parsed = parseCodexDirectiveText(text)
      return {
        id,
        role: 'assistant',
        text: parsed.text,
        directives: parsed.directives.length > 0 ? parsed.directives : undefined,
        messageType: 'agentMessage.live',
      }
    }

    return null
  }

  function toLocalImageUrl(path: string): string {
    return `/codex-local-image?path=${encodeURIComponent(path)}`
  }

  function toImageGenerationUrl(value: string): string {
    const trimmed = value.trim()
    if (!trimmed) return ''
    if (
      trimmed.startsWith('data:') ||
      trimmed.startsWith('http://') ||
      trimmed.startsWith('https://') ||
      trimmed.startsWith('/codex-local-image?')
    ) {
      return trimmed
    }
    const compact = trimmed.replace(/\s+/gu, '')
    if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(compact)) return ''
    return `data:image/png;base64,${compact}`
  }

  function readCompletedImageView(notification: RpcNotification): UiMessage | null {
    if (notification.method !== 'item/completed') return null
    const params = asRecord(notification.params)
    const item = asRecord(params?.item)
    if (!item) return null
    const id = readString(item.id)
    if (!id) return null
    if (item.type === 'imageView') {
      const path = readString(item.path)
      if (!path) return null
      return {
        id,
        role: 'assistant',
        text: 'Viewed an image',
        images: [toLocalImageUrl(path)],
        messageType: 'imageView',
      }
    }
    if (item.type !== 'imageGeneration' && item.type !== 'image_generation') return null
    const result = readString(item.result)
    const imageUrl = result ? toImageGenerationUrl(result) : ''
    if (!imageUrl) return null
    return {
      id,
      role: 'assistant',
      text: 'Viewed an image',
      images: [imageUrl],
      messageType: 'imageView',

    }
  }

  function readCommandExecutionStarted(notification: RpcNotification): UiMessage | null {
    if (notification.method !== 'item/started') return null
    const params = asRecord(notification.params)
    const item = asRecord(params?.item)
    if (!item || item.type !== 'commandExecution') return null
    const id = readString(item.id)
    const command = readString(item.command)
    if (!id) return null
    const cwd = typeof item.cwd === 'string' ? item.cwd : null
    const threadId = extractThreadIdFromNotification(notification)
    const turnId = readString(params?.turnId) || readString(params?.turn_id)
    const turnIndex = threadId && turnId
      ? turnIndexByTurnIdByThreadId.value[threadId]?.[turnId]
      : undefined
    return {
      id,
      role: 'system',
      text: command,
      messageType: 'commandExecution',
      commandExecution: {
        command,
        cwd,
        status: 'inProgress',
        aggregatedOutput: '',
        exitCode: null,
        displayLabel: commandDisplayLabel(command, item.commandActions),
      },
      turnId: turnId || undefined,
      turnIndex: typeof turnIndex === 'number' ? turnIndex : undefined,
    }
  }

  function readCommandOutputDelta(notification: RpcNotification): { itemId: string; delta: string } | null {
    if (notification.method !== 'item/commandExecution/outputDelta') return null
    const params = asRecord(notification.params)
    if (!params) return null
    const itemId = readString(params.itemId)
    const delta = readString(params.delta)
    if (!itemId || !delta) return null
    return { itemId, delta }
  }

  function readCommandExecutionCompleted(notification: RpcNotification): UiMessage | null {
    if (notification.method !== 'item/completed') return null
    const params = asRecord(notification.params)
    const item = asRecord(params?.item)
    if (!item || item.type !== 'commandExecution') return null
    const id = readString(item.id)
    const command = readString(item.command)
    if (!id) return null
    const cwd = typeof item.cwd === 'string' ? item.cwd : null
    const statusRaw = readString(item.status)
    const status: CommandExecutionData['status'] =
      statusRaw === 'failed' ? 'failed' : statusRaw === 'declined' ? 'declined' : statusRaw === 'interrupted' ? 'interrupted' : 'completed'
    const aggregatedOutput = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : ''
    const exitCode = typeof item.exitCode === 'number' ? item.exitCode : null
    const threadId = extractThreadIdFromNotification(notification)
    const turnId = readString(params?.turnId) || readString(params?.turn_id)
    const turnIndex = threadId && turnId
      ? turnIndexByTurnIdByThreadId.value[threadId]?.[turnId]
      : undefined
    return {
      id,
      role: 'system',
      text: command,
      messageType: 'commandExecution',
      commandExecution: {
        command,
        cwd,
        status,
        aggregatedOutput,
        exitCode,
        displayLabel: commandDisplayLabel(command, item.commandActions),
      },
      turnId: turnId || undefined,
      turnIndex: typeof turnIndex === 'number' ? turnIndex : undefined,
    }
  }

  function readCompletedFileChange(notification: RpcNotification): UiMessage | null {
    void notification
    return null
  }

  function upsertLiveCommand(threadId: string, msg: UiMessage): void {
    const previous = liveCommandsByThreadId.value[threadId] ?? []
    const next = upsertMessage(previous, msg)
    if (next === previous) return
    liveCommandsByThreadId.value = { ...liveCommandsByThreadId.value, [threadId]: next }
  }

  function removeLiveAgentMessagesPersistedIn(threadId: string, persistedMessages: UiMessage[]): void {
    const current = liveAgentMessagesByThreadId.value[threadId]
    if (!current || current.length === 0) return
    const next = removeRedundantLiveAgentMessages(current, persistedMessages)
    if (next === current) return
    const nextIds = new Set(next.map((message) => message.id))
    for (const message of current) {
      if (!nextIds.has(message.id)) {
        clearLiveAgentRawText(threadId, message.id)
      }
    }
    if (next.length === 0) {
      clearLiveAgentMessagesForThread(threadId)
    } else {
      setLiveAgentMessagesForThread(threadId, next)
    }
  }

  function removeLiveCommandsPersistedIn(threadId: string, persistedMessages: UiMessage[]): void {
    const current = liveCommandsByThreadId.value[threadId]
    if (!current || current.length === 0) return
    const persistedIds = new Set(persistedMessages.map((m) => m.id))
    const next = current.filter((m) => !persistedIds.has(m.id))
    if (next.length === current.length) return
    if (next.length === 0) {
      liveCommandsByThreadId.value = omitKey(liveCommandsByThreadId.value, threadId)
    } else {
      liveCommandsByThreadId.value = { ...liveCommandsByThreadId.value, [threadId]: next }
    }
  }

  function removeLiveFileChangesPersistedIn(threadId: string, persistedMessages: UiMessage[]): void {
    const current = liveFileChangeMessagesByThreadId.value[threadId]
    if (!current || current.length === 0) return
    const persistedIds = new Set(persistedMessages.map((message) => message.id))
    const persistedTurnIds = new Set(
      persistedMessages
        .filter((message) => message.messageType === 'fileChange' && typeof message.turnId === 'string' && message.turnId.length > 0)
        .map((message) => message.turnId as string),
    )
    const persistedTurnIndices = new Set(
      persistedMessages
        .filter((message) => message.messageType === 'fileChange' && typeof message.turnIndex === 'number')
        .map((message) => message.turnIndex as number),
    )
    const next = current.filter((message) => (
      !persistedIds.has(message.id)
      && !(message.turnId && persistedTurnIds.has(message.turnId))
      && !(typeof message.turnIndex === 'number' && persistedTurnIndices.has(message.turnIndex))
    ))
    if (next.length === current.length) return
    if (next.length === 0) {
      liveFileChangeMessagesByThreadId.value = omitKey(liveFileChangeMessagesByThreadId.value, threadId)
    } else {
      liveFileChangeMessagesByThreadId.value = { ...liveFileChangeMessagesByThreadId.value, [threadId]: next }
    }
  }

  function isAgentContentEvent(notification: RpcNotification): boolean {
    if (notification.method === 'item/agentMessage/delta') {
      return true
    }

    const params = asRecord(notification.params)
    if (!params) return false

    if (notification.method === 'item/completed') {
      const item = asRecord(params.item)
      return item?.type === 'agentMessage'
    }

    return false
  }

  function applyRealtimeUpdates(notification: RpcNotification): void {
    if (handleServerRequestNotification(notification)) {
      return
    }

    if (notification.method === 'account/rateLimits/updated') {
      scheduleRateLimitRefresh()
    }

    if (notification.method === 'thread/name/updated') {
      const params = asRecord(notification.params)
      const threadId = readString(params?.threadId)
      const threadName = readString(params?.threadName)
      if (threadId && threadName) {
        threadTitleById.value = { ...threadTitleById.value, [threadId]: threadName }
        applyThreadFlags()
        void persistThreadTitle(threadId, threadName)
      }
    }

    if (notification.method === 'account/rateLimits/updated') {
      setCodexRateLimit(pickCodexRateLimitSnapshot(notification.params))
      return
    }

    if (notification.method === 'thread/goal/updated') {
      const params = asRecord(notification.params)
      const threadId = extractThreadIdFromNotification(notification)
      const goal = readThreadGoal(params?.goal ?? notification.params)
      if (threadId && goal) {
        invalidateThreadGoalRequest(threadId)
        threadGoalByThreadId.value = {
          ...threadGoalByThreadId.value,
          [threadId]: goal,
        }
        threadGoalSupportByThreadId.value = {
          ...threadGoalSupportByThreadId.value,
          [threadId]: true,
        }
      }
      return
    }

    if (notification.method === 'thread/goal/cleared') {
      const threadId = extractThreadIdFromNotification(notification)
      if (threadId) {
        invalidateThreadGoalRequest(threadId)
        threadGoalByThreadId.value = omitKey(threadGoalByThreadId.value, threadId)
        threadGoalSupportByThreadId.value = {
          ...threadGoalSupportByThreadId.value,
          [threadId]: true,
        }
      }
      return
    }

    const tokenUsageUpdate = readThreadTokenUsageUpdate(notification)
    if (tokenUsageUpdate) {
      setThreadTokenUsage(tokenUsageUpdate.threadId, tokenUsageUpdate.usage)
      return
    }

    const turnActivity = readTurnActivity(notification)
    if (turnActivity) {
      setTurnActivityForThread(turnActivity.threadId, turnActivity.activity)
    }

    const notificationThreadId = extractThreadIdFromNotification(notification)
    const notificationErrorState = readNotificationErrorState(notification)
    if (!notificationErrorState && notificationThreadId && notification.method !== 'turn/completed') {
      clearTransientTurnErrorForThread(notificationThreadId)
    }

    const startedTurn = readTurnStartedInfo(notification)
    if (startedTurn) {
      nonSuccessCompletionReadBaselineByThreadId.delete(startedTurn.threadId)
      pendingTurnStartsById.set(startedTurn.turnId, startedTurn)
      setTurnIndexForThread(startedTurn.threadId, startedTurn.turnId, inferNextTurnIndex(startedTurn.threadId))
      activeTurnIdByThreadId.value = {
        ...activeTurnIdByThreadId.value,
        [startedTurn.threadId]: startedTurn.turnId,
      }
      if (runtimeOwnershipByThreadId.value[startedTurn.threadId] === 'local') {
        localRuntimeAuthorityVersionByThreadId.set(
          startedTurn.threadId,
          (localRuntimeAuthorityVersionByThreadId.get(startedTurn.threadId) ?? 0) + 1,
        )
      }
      setThreadRuntimeOwnership(startedTurn.threadId, 'local')
      maybeUnblockInterruptForActiveTurn(startedTurn.threadId, startedTurn.turnId)
      clearLivePlansForThread(startedTurn.threadId)
      clearLiveFileChangesForThread(startedTurn.threadId)
      recentlyCompletedActiveTurnIdByThreadId.delete(startedTurn.threadId)
      setTurnSummaryForThread(startedTurn.threadId, null)
      setTurnErrorForThread(startedTurn.threadId, null)
      setThreadInProgress(startedTurn.threadId, true)
      void consumePendingStopForTurn(startedTurn.threadId, startedTurn.turnId)
      scheduleQueueStateRefresh(startedTurn.threadId)
      if (eventUnreadByThreadId.value[startedTurn.threadId]) {
        eventUnreadByThreadId.value = omitKey(eventUnreadByThreadId.value, startedTurn.threadId)
      }
    }

    const completedTurn = readTurnCompletedInfo(notification)
    const turnErrorMessage = readTurnErrorMessage(notification)
    const completedThreadId = completedTurn?.threadId ?? extractThreadIdFromNotification(notification)
    const completedThreadModelId = completedThreadId ? readModelIdForThread(completedThreadId) : ''
    const shouldRetryWithFallback =
      Boolean(completedThreadId) &&
      Boolean(turnErrorMessage) &&
      completedThreadModelId !== MODEL_FALLBACK_ID &&
      isUnsupportedChatGptModelError(new Error(turnErrorMessage))
    const hasUnlatchedLocalSubmission = Boolean(
      completedThreadId
      && localSubmissionByThreadId.has(completedThreadId)
      && !activeTurnIdByThreadId.value[completedThreadId],
    )
    const activeLeaseTurnId = completedTurn
      ? activeTurnIdByThreadId.value[completedTurn.threadId] ?? ''
      : ''
    const matchesActiveLease = Boolean(
      completedTurn
      && activeLeaseTurnId
      && activeLeaseTurnId === completedTurn.turnId,
    )
    const completionDisposition = completedTurn
      ? isExternallyOwned(completedTurn.threadId) && !matchesActiveLease
        ? { ownsActiveLease: false, keepRunning: true, markUnread: false }
        : hasUnlatchedLocalSubmission && !matchesActiveLease
          ? { ownsActiveLease: false, keepRunning: true, markUnread: false }
        : resolveTurnCompletionDisposition(
            completedTurn.status,
            shouldRetryWithFallback,
            completedTurn.threadId === selectedThreadId.value,
            activeLeaseTurnId,
            completedTurn.turnId,
          )
      : null
    if (completedTurn && completionDisposition) {
      const pendingTurnRequest = pendingTurnRequestByThreadId.value[completedTurn.threadId]
      const startedTurnState = pendingTurnStartsById.get(completedTurn.turnId)
      if (startedTurnState) {
        pendingTurnStartsById.delete(completedTurn.turnId)
      }

      const rawDurationMs =
        readNumber(asRecord(notification.params)?.durationMs) ??
        readNumber(asRecord(asRecord(notification.params)?.turn)?.durationMs) ??
        (typeof completedTurn.startedAtMs === 'number'
          ? completedTurn.completedAtMs - completedTurn.startedAtMs
          : null) ??
        (startedTurnState ? completedTurn.completedAtMs - startedTurnState.startedAtMs : null)

      const durationMs = typeof rawDurationMs === 'number' ? Math.max(0, rawDurationMs) : null
      const summary: TurnSummaryState = {
        turnId: completedTurn.turnId,
        durationMs,
        status: completedTurn.status,
        completedAtMs: completedTurn.completedAtMs,
      }
      persistTurnSummaryForThread(completedTurn.threadId, summary)
      if (completionDisposition.ownsActiveLease) {
        recentlyCompletedActiveTurnIdByThreadId.set(completedTurn.threadId, completedTurn.turnId)
        if (!shouldRetryWithFallback) {
          const activeTextHydration = activeTextHydrationByThreadId.get(completedTurn.threadId)
          if (activeTextHydration?.turnId === completedTurn.turnId) {
            const persistedMessages =
              persistedMessagesByThreadId.value[completedTurn.threadId] ?? []
            const messagesWithHydratedText = mergeHydratedTurnTextIntoTranscript(
              persistedMessages,
              activeTextHydration.messages,
              activeTextHydration.turnId,
            )
            setPersistedMessagesForThread(
              completedTurn.threadId,
              finalizeHydratedTurnText(messagesWithHydratedText, completedTurn.turnId),
            )
            cancelActiveTextHydration(completedTurn.threadId)
          }
          clearPendingStopRequest(completedTurn.threadId)
          clearLocalSubmission(completedTurn.threadId)
        }
        const persistedMessages = persistedMessagesByThreadId.value[completedTurn.threadId] ?? []
        setPersistedMessagesForThread(
          completedTurn.threadId,
          insertTurnSummaryMessage(persistedMessages, summary),
        )
        setTurnSummaryForThread(completedTurn.threadId, summary)
        if (activeTurnIdByThreadId.value[completedTurn.threadId]) {
          activeTurnIdByThreadId.value = omitKey(activeTurnIdByThreadId.value, completedTurn.threadId)
        }
        if (!completionDisposition.keepRunning) {
          setThreadRuntimeOwnership(completedTurn.threadId, 'idle')
        }
        clearDelayedTurnSync(completedTurn.threadId)
        if (!shouldRetryWithFallback && completedTurn.status !== 'completed') {
          suppressUnreadForNonSuccessCompletion(completedTurn.threadId)
        }
        if (!completionDisposition.keepRunning) {
          releasePendingTurnRequest(completedTurn.threadId, pendingTurnRequest)
          setThreadInProgress(completedTurn.threadId, false)
          setTurnActivityForThread(completedTurn.threadId, null)
        }
        if (completionDisposition.markUnread) {
          markThreadUnreadByEvent(completedTurn.threadId)
        }
        if (!shouldRetryWithFallback) {
          scheduleQueueStateRefresh(completedTurn.threadId)
        }
      } else if (!isExternallyOwned(completedTurn.threadId)) {
        const expectedActiveTurnId = activeTurnIdByThreadId.value[completedTurn.threadId] ?? ''
        if (expectedActiveTurnId) {
          void reconcileMismatchedLocalCompletion(
            completedTurn.threadId,
            expectedActiveTurnId,
          )
        }
      }
    }

    if (turnErrorMessage) {
      const failedThreadId = completedTurn?.threadId || extractThreadIdFromNotification(notification)
      if (completionDisposition?.ownsActiveLease !== false) {
        if (failedThreadId) {
          setTurnErrorForThread(failedThreadId, turnErrorMessage)
        }
        error.value = turnErrorMessage
        if (failedThreadId && shouldRetryWithFallback) {
          void retryPendingTurnWithFallback(failedThreadId)
        }
      }
    } else if (completedTurn && completionDisposition?.ownsActiveLease) {
      setTurnErrorForThread(completedTurn.threadId, null)
    }

    if (notificationErrorState) {
      const errorThreadId = notificationThreadId
      const errorThreadModelId = errorThreadId ? readModelIdForThread(errorThreadId) : selectedModelId.value.trim()
      if (errorThreadId) {
        setTurnErrorForThread(errorThreadId, notificationErrorState.message, {
          transient: notificationErrorState.transient,
        })
      }
      error.value = notificationErrorState.message
      if (errorThreadModelId !== MODEL_FALLBACK_ID && isUnsupportedChatGptModelError(new Error(notificationErrorState.message))) {
        if (errorThreadId) {
          void retryPendingTurnWithFallback(errorThreadId)
        } else {
          void applyFallbackModelSelection()
        }
      }
    }

    const planUpdate = readPlanUpdate(notification)
    if (planUpdate) {
      upsertLivePlanMessage(planUpdate.threadId, planUpdate.message)
      setTurnActivityForThread(planUpdate.threadId, {
        label: 'Planning',
        details: planUpdate.message.plan?.steps.map((step) => step.step).slice(0, 2) ?? [],
      })
    }

    const planDelta = readPlanDelta(notification)
    if (planDelta) {
      upsertLivePlanMessage(planDelta.threadId, planDelta.message)
      setTurnActivityForThread(planDelta.threadId, {
        label: 'Planning',
        details: [],
      })
    }

    const completedAgentMessage = readAgentMessageCompleted(notification)
    if (notificationThreadId && completedAgentMessage) {
      clearLiveAgentRawText(notificationThreadId, completedAgentMessage.id)
    }

    if (!notificationThreadId || notificationThreadId !== selectedThreadId.value) return

    const startedAgentMessageId = readAgentMessageStartedId(notification)
    if (startedAgentMessageId) {
      activeReasoningItemId = ''
    }

    const liveAgentMessageDelta = readAgentMessageDelta(notification)
    if (liveAgentMessageDelta) {
      const existing = (liveAgentMessagesByThreadId.value[notificationThreadId] ?? [])
        .find((message) => message.id === liveAgentMessageDelta.messageId)
      const previousRawText = readLiveAgentRawText(
        notificationThreadId,
        liveAgentMessageDelta.messageId,
        existing?.text ?? '',
      )
      const nextRawText = `${previousRawText}${liveAgentMessageDelta.delta}`
      writeLiveAgentRawText(notificationThreadId, liveAgentMessageDelta.messageId, nextRawText)
      const parsed = parseCodexDirectiveText(nextRawText, {
        suppressIncompleteTrailingDirective: true,
      })
      upsertLiveAgentMessage(notificationThreadId, {
        id: liveAgentMessageDelta.messageId,
        role: 'assistant',
        text: parsed.text,
        directives: parsed.directives.length > 0 ? parsed.directives : undefined,
        messageType: 'agentMessage.live',
      })
    }

    if (completedAgentMessage) {
      upsertLiveAgentMessage(notificationThreadId, completedAgentMessage)
    }

    const completedImageView = readCompletedImageView(notification)
    if (completedImageView) {
      upsertLiveAgentMessage(notificationThreadId, completedImageView)

    }

    const startedReasoningItemId = readReasoningStartedItemId(notification)
    if (startedReasoningItemId) {
      const current = liveReasoningTextByThreadId.value[notificationThreadId] ?? ''
      if (
        startedReasoningItemId !== activeReasoningItemId
        && current.trim().length > 0
        && !current.endsWith('\n\n')
      ) {
        setLiveReasoningText(notificationThreadId, `${current}\n\n`)
      }
      activeReasoningItemId = startedReasoningItemId
    }

    const liveReasoningDelta = readReasoningDelta(notification)
    if (liveReasoningDelta) {
      appendLiveReasoningText(notificationThreadId, liveReasoningDelta.delta)
    }

    const sectionBreakMessageId = readReasoningSectionBreakMessageId(notification)
    if (sectionBreakMessageId) {
      const current = liveReasoningTextByThreadId.value[notificationThreadId] ?? ''
      if (current.trim().length > 0 && !current.endsWith('\n\n')) {
        setLiveReasoningText(notificationThreadId, `${current}\n\n`)
      }
    }

    const completedReasoningMessageId = readReasoningCompletedId(notification)
    if (completedReasoningMessageId) {
      if (completedReasoningMessageId === liveReasoningMessageId(activeReasoningItemId)) {
        activeReasoningItemId = ''
      }
    }

    const commandStarted = readCommandExecutionStarted(notification)
    if (commandStarted) {
      upsertLiveCommand(notificationThreadId, commandStarted)
      setTurnActivityForThread(notificationThreadId, { label: 'Running command', details: [commandStarted.commandExecution?.command ?? ''] })
    }

    const commandDelta = readCommandOutputDelta(notification)
    if (commandDelta) {
      const current = (liveCommandsByThreadId.value[notificationThreadId] ?? []).find((m) => m.id === commandDelta.itemId)
      if (current?.commandExecution) {
        upsertLiveCommand(notificationThreadId, {
          ...current,
          commandExecution: { ...current.commandExecution, aggregatedOutput: `${current.commandExecution.aggregatedOutput}${commandDelta.delta}` },
        })
      }
    }

    const commandCompleted = readCommandExecutionCompleted(notification)
    if (commandCompleted) {
      upsertLiveCommand(notificationThreadId, commandCompleted)
    }

    if (isAgentContentEvent(notification)) {
      activeReasoningItemId = ''
    }

    if (notification.method === 'turn/completed' && completionDisposition?.ownsActiveLease !== false) {
      activeReasoningItemId = ''
      shouldAutoScrollOnNextAgentEvent = false
      clearLiveReasoningForThread(notificationThreadId)
      if (liveCommandsByThreadId.value[notificationThreadId]) {
        liveCommandsByThreadId.value = omitKey(liveCommandsByThreadId.value, notificationThreadId)
      }
    }

  }

  function isThreadListStructureNotification(notification: RpcNotification): boolean {
    return THREAD_LIST_STRUCTURE_NOTIFICATION_METHODS.has(notification.method)
  }

  function shouldRefreshActiveTextNewestForNotification(notification: RpcNotification): boolean {
    if (ACTIVE_TEXT_NEWEST_REFRESH_NOTIFICATION_METHODS.has(notification.method)) return true
    if (
      notification.method !== 'item/started' &&
      notification.method !== 'item/completed' &&
      notification.method !== 'thread/realtime/itemAdded'
    ) {
      return false
    }
    const params = asRecord(notification.params)
    const item = asRecord(params?.item)
    const itemType = readString(item?.type) || readString(params?.itemType) || readString(params?.item_type)
    return ACTIVE_TEXT_ITEM_NOTIFICATION_TYPES.has(itemType)
  }

  function shouldRefreshRuntimeForNotification(notification: RpcNotification): boolean {
    return notification.method === 'turn/started' ||
      notification.method === 'turn/completed' ||
      notification.method === 'error' ||
      notification.method === 'thread/runtime/updated' ||
      notification.method === 'thread/status/updated' ||
      notification.method === 'thread/status/changed'
  }

  function queueEventDrivenSync(notification: RpcNotification): void {
    if (notification.method === 'thread/tokenUsage/updated') return

    const method = notification.method
    const threadId = extractThreadIdFromNotification(notification)
    const turnId = extractTurnIdFromNotification(notification)
    const shouldRefreshMessages = shouldRefreshMessagesForNotification(notification)
    const shouldRefreshRuntime = Boolean(threadId) && shouldRefreshRuntimeForNotification(notification)
    const shouldRefreshActiveTextNewest = Boolean(threadId)
      && threadId === selectedThreadId.value
      && shouldRefreshActiveTextNewestForNotification(notification)
    const shouldRefreshThreads =
      isThreadListStructureNotification(notification) ||
      (!threadId && (method.startsWith('thread/') || method === 'turn/completed'))

    if (!shouldRefreshMessages && !shouldRefreshThreads && !shouldRefreshRuntime && !shouldRefreshActiveTextNewest) return

    if (threadId && shouldRefreshMessages) {
      pendingThreadMessageRefresh.add(threadId)
    }
    if (threadId && shouldRefreshRuntime) {
      pendingThreadRuntimeRefresh.add(threadId)
    }
    if (threadId && shouldRefreshActiveTextNewest) {
      pendingActiveTextNewestRefresh.add(threadId)
      if (turnId) {
        pendingActiveTextNewestTurnIdByThreadId.set(threadId, turnId)
      }
    }
    const scheduledSelectedActiveTextNewestRefresh = shouldRefreshActiveTextNewest
      ? scheduleSelectedActiveTextNewestRefresh()
      : false

    if (shouldRefreshThreads) {
      pendingThreadsRefresh = true
      pendingThreadsRefreshForce = true
    }

    if (
      scheduledSelectedActiveTextNewestRefresh
      && !shouldRefreshMessages
      && !shouldRefreshThreads
      && !shouldRefreshRuntime
    ) {
      return
    }

    if (typeof window === 'undefined') return
    const shouldFastDrainSelectedCompletion =
      method === 'turn/completed'
      && threadId.length > 0
      && threadId === selectedThreadId.value
      && turnId.length > 0
      && turnId === (activeTurnIdByThreadId.value[threadId] ?? '')
    if (shouldFastDrainSelectedCompletion) {
      cancelExternalRuntimePolling()
      if (eventSyncTimer !== null) {
        window.clearTimeout(eventSyncTimer)
        eventSyncTimer = null
      }
    }
    if (eventSyncTimer !== null) return
    eventSyncTimer = window.setTimeout(() => {
      eventSyncTimer = null
      void syncFromNotifications()
    }, shouldFastDrainSelectedCompletion ? 0 : EVENT_SYNC_DEBOUNCE_MS)
  }

  function refreshSelectedActiveTextNewest(
    threadIdsToRefresh: Set<string>,
    turnIdsByThreadId: Map<string, string>,
  ): void {
    const threadId = selectedThreadId.value
    if (!threadId || !threadIdsToRefresh.has(threadId)) return
    const turnId = activeTurnIdByThreadId.value[threadId] || turnIdsByThreadId.get(threadId) || ''
    if (!turnId) return
    threadIdsToRefresh.delete(threadId)
    turnIdsByThreadId.delete(threadId)
    ensureActiveTextHydration(threadId, turnId, {
      refreshExhausted: true,
      forceRefreshExhausted: true,
      forceRefreshNewest: true,
    })
  }

  function flushSelectedActiveTextNewestRefresh(): boolean {
    const threadId = selectedThreadId.value
    if (!threadId || !pendingActiveTextNewestRefresh.has(threadId)) return false
    const turnId = activeTurnIdByThreadId.value[threadId] || pendingActiveTextNewestTurnIdByThreadId.get(threadId) || ''
    if (!turnId) return false

    pendingActiveTextNewestRefresh.delete(threadId)
    pendingActiveTextNewestTurnIdByThreadId.delete(threadId)
    ensureActiveTextHydration(threadId, turnId, {
      refreshExhausted: true,
      forceRefreshExhausted: true,
      forceRefreshNewest: true,
    })
    return true
  }

  function scheduleSelectedActiveTextNewestRefresh(): boolean {
    if (typeof window === 'undefined') return false
    const threadId = selectedThreadId.value
    if (!threadId || !pendingActiveTextNewestRefresh.has(threadId)) return false
    const turnId = activeTurnIdByThreadId.value[threadId] || pendingActiveTextNewestTurnIdByThreadId.get(threadId) || ''
    if (!turnId) return false
    if (activeTextNewestRefreshTimer !== null) return true

    activeTextNewestRefreshTimer = window.setTimeout(() => {
      activeTextNewestRefreshTimer = null
      flushSelectedActiveTextNewestRefresh()
    }, ACTIVE_TEXT_NEWEST_REFRESH_DEBOUNCE_MS)
    return true
  }

  async function hydrateWorkspaceRootsStateIfNeeded(
    groups: UiProjectGroup[],
    rootsState: WorkspaceRootsState | null,
  ): Promise<void> {
    if (hasHydratedWorkspaceRootsState) return
    hasHydratedWorkspaceRootsState = true

    try {
      if (!rootsState) return
      const hydratedOrder: string[] = []
      for (const rootPath of getWorkspaceProjectOrderPaths(rootsState)) {
        const projectName = toProjectNameFromWorkspaceRoot(rootPath)
        if (hydratedOrder.includes(projectName)) continue
        hydratedOrder.push(projectName)
      }

      if (hydratedOrder.length > 0) {
        const mergedOrder = rootsState.projectOrder.length > 0
          ? mergeProjectOrder(hydratedOrder, groups)
          : mergeProjectOrder(projectOrder.value, groups)
        if (!areStringArraysEqual(projectOrder.value, mergedOrder)) {
          projectOrder.value = mergedOrder
        }
      }

      if (Object.keys(rootsState.labels).length > 0 || (rootsState.remoteProjects ?? []).length > 0) {
        const nextLabels = { ...projectDisplayNameById.value }
        let changed = false
        for (const [rootPath, label] of Object.entries(rootsState.labels)) {
          const normalizedRootPath = normalizePathForUi(rootPath).trim()
          const projectNames = [toProjectNameFromWorkspaceRoot(rootPath)]
          if (normalizedRootPath) projectNames.push(normalizedRootPath)
          for (const projectName of projectNames) {
            if (nextLabels[projectName] === label) continue
            nextLabels[projectName] = label
            changed = true
          }
        }
        for (const rootPath of rootsState.order) {
          const leafName = toProjectNameFromWorkspaceRoot(rootPath)
          const parentLeafName = toProjectName(getPathParent(rootPath))
          if (!parentLeafName.startsWith('.') || parentLeafName === leafName) continue
          const displayName = `${leafName} ${parentLeafName}`
          if (nextLabels[leafName] !== undefined || nextLabels[leafName] === displayName) continue
          nextLabels[leafName] = displayName
          changed = true
        }
        for (const remoteProject of rootsState.remoteProjects ?? []) {
          const label = getRemoteProjectDisplayName(remoteProject)
          if (nextLabels[remoteProject.id] === label) continue
          nextLabels[remoteProject.id] = label
          changed = true
        }
        if (changed) {
          projectDisplayNameById.value = nextLabels
        }
      }
    } catch {
      // Keep local storage fallback when global state is unavailable.
    }
  }

  async function loadThreadTitleCacheIfNeeded(options: { force?: boolean } = {}): Promise<void> {
    if (options.force !== true && Object.keys(threadTitleById.value).length > 0) return
    try {
      const cache = await getThreadTitleCache()
      if (Object.keys(cache.titles).length > 0) {
        threadTitleById.value = cache.titles
      }
    } catch {
      // Title cache is optional; keep UI functional.
    }
  }

  async function loadWorkspaceRootsStateForThreadList(): Promise<WorkspaceRootsState | null> {
    try {
      return await getWorkspaceRootsState()
    } catch {
      return null
    }
  }

  async function refreshThreadListMetadataAfterFirstPage(options: { force?: boolean } = {}): Promise<void> {
    const epoch = threadListMetadataEpoch + 1
    threadListMetadataEpoch = epoch

    const [rootsState] = await Promise.all([
      loadWorkspaceRootsStateForThreadList(),
      loadThreadTitleCacheIfNeeded({ force: options.force === true }),
    ])
    if (epoch !== threadListMetadataEpoch) return

    loadedThreadListRootsState = rootsState
    await hydrateWorkspaceRootsStateIfNeeded(loadedThreadListGroups, rootsState)
    applyThreadGroups(loadedThreadListGroups, rootsState)
  }

  async function requestThreadTitleGeneration(threadId: string, prompt: string, cwd: string | null): Promise<void> {
    if (threadTitleById.value[threadId]) return
    const trimmed = prompt.trim()
    if (!trimmed) return
    const truncated = trimmed.length > 300 ? trimmed.slice(0, 300) : trimmed
    try {
      const title = await generateThreadTitle(truncated, cwd)
      if (!title || threadTitleById.value[threadId]) return
      threadTitleById.value = { ...threadTitleById.value, [threadId]: title }
      applyThreadFlags()
      void persistThreadTitle(threadId, title)
    } catch {
      // Title generation is best-effort.
    }
  }

  function filterGroupsByWorkspaceRoots(
    groups: UiProjectGroup[],
    rootsState: WorkspaceRootsState | null,
  ): UiProjectGroup[] {
    const duplicateLeafNames = collectDuplicateProjectLeafNames(groups, rootsState)
    const disambiguatedGroups = disambiguateProjectGroupsByCwd(groups, rootsState)
    const groupsWithWorkspaceRoots = addWorkspaceRootPlaceholderGroups(disambiguatedGroups, rootsState, duplicateLeafNames)
    if (!rootsState || (rootsState.order.length === 0 && (rootsState.remoteProjects ?? []).length === 0)) return groupsWithWorkspaceRoots
    const allowedProjectNames = new Set<string>()
    for (const projectName of getWorkspaceProjectOrderNames(rootsState, duplicateLeafNames)) {
      allowedProjectNames.add(projectName)
    }
    const filteredGroups = groupsWithWorkspaceRoots.filter((group) => {
      if (allowedProjectNames.has(group.projectName)) return true
      return isProjectlessGroup(group)
    })
    return orderGroupsByWorkspaceProjectOrder(filteredGroups, rootsState, duplicateLeafNames)
  }

  function applyThreadGroups(groups: UiProjectGroup[], rootsState: WorkspaceRootsState | null): void {
    const visibleGroups = filterGroupsByWorkspaceRoots(groups, rootsState)
    const hasWorkspaceRootsState = Boolean(
      rootsState && (rootsState.order.length > 0 || rootsState.projectOrder.length > 0 || (rootsState.remoteProjects ?? []).length > 0),
    )

    const nextProjectOrder = rootsState?.projectOrder.length
      ? mergeProjectOrder(
        getWorkspaceProjectOrderNames(rootsState, collectDuplicateProjectLeafNames(groups, rootsState)),
        visibleGroups,
      )
      : mergeProjectOrder(projectOrder.value, visibleGroups)
    if (!areStringArraysEqual(projectOrder.value, nextProjectOrder)) {
      projectOrder.value = nextProjectOrder
      if (!hasWorkspaceRootsState) {
        saveProjectOrder(projectOrder.value)
      }
    }

    const orderedGroups = orderGroupsByProjectOrder(visibleGroups, projectOrder.value)
    preserveReadWatermarksForMetadataOnlyRefresh(orderedGroups)
    markServerListedThreads(new Set(flattenThreads(orderedGroups).map((thread) => thread.id)))
    const mergedWithInProgress = mergeIncomingWithLocalInProgressThreads(
      sourceGroups.value,
      orderedGroups,
      inProgressById.value,
    )
    sourceGroups.value = mergeThreadGroups(sourceGroups.value, mergedWithInProgress)
    const activeThreadIds = new Set(flattenThreads(sourceGroups.value).map((thread) => thread.id))
    syncNonSuccessCompletionReadWatermarks(orderedGroups, activeThreadIds)
    inProgressById.value = pruneThreadStateMap(
      inProgressById.value,
      activeThreadIds,
    )
    applyThreadFlags()
  }

  function normalizeQueuedCollaborationMode(
    collaborationModeOverride?: CollaborationModeKind,
  ): CollaborationModeKind {
    return collaborationModeOverride === 'plan'
      ? 'plan'
      : collaborationModeOverride === 'default'
        ? 'default'
        : selectedCollaborationMode.value
  }

  function enqueueThreadMessage(
    threadId: string,
    nextText: string,
    imageUrls: string[],
    skills: Array<{ name: string; path: string }>,
    fileAttachments: FileAttachment[],
    collaborationModeOverride?: CollaborationModeKind,
    queueInsertIndex?: number,
  ): QueuedMessage {
    const queue = queuedMessagesByThreadId.value[threadId] ?? []
    const id = `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const nextQueue = [...queue]
    const insertIndex = typeof queueInsertIndex === 'number'
      ? Math.max(0, Math.min(queueInsertIndex, nextQueue.length))
      : nextQueue.length
    const queuedMessage: QueuedMessage = {
      id,
      ...(nextQueue[insertIndex - 1]?.id ? { queueAfterId: nextQueue[insertIndex - 1].id } : {}),
      ...(nextQueue[insertIndex]?.id ? { queueBeforeId: nextQueue[insertIndex].id } : {}),
      text: nextText,
      imageUrls,
      skills,
      fileAttachments,
      collaborationMode: normalizeQueuedCollaborationMode(collaborationModeOverride),
      model: readModelIdForThread(threadId),
      effort: readReasoningEffortForThread(threadId),
    }
    nextQueue.splice(insertIndex, 0, queuedMessage)
    queuedMessagesByThreadId.value = {
      ...queuedMessagesByThreadId.value,
      [threadId]: nextQueue,
    }
    queueMutationVersion += 1
    return queuedMessage
  }

  function removeLocallyQueuedMessage(threadId: string, messageId: string): void {
    const queue = queuedMessagesByThreadId.value[threadId] ?? []
    const nextQueue = queue.filter((message) => message.id !== messageId)
    if (nextQueue.length === queue.length) return
    queuedMessagesByThreadId.value = nextQueue.length > 0
      ? { ...queuedMessagesByThreadId.value, [threadId]: nextQueue }
      : omitKey(queuedMessagesByThreadId.value, threadId)
    queueMutationVersion += 1
  }

  function setQueueAppendPending(threadId: string, messageId: string, pending: boolean): void {
    const ids = pendingQueueAppendMessageIdsByThreadId.get(threadId) ?? new Set<string>()
    if (pending) {
      ids.add(messageId)
      pendingQueueAppendMessageIdsByThreadId.set(threadId, ids)
      return
    }
    ids.delete(messageId)
    if (ids.size > 0) pendingQueueAppendMessageIdsByThreadId.set(threadId, ids)
    else pendingQueueAppendMessageIdsByThreadId.delete(threadId)
  }

  function mergePendingQueueAppends(refreshedState: Record<string, QueuedMessage[]>): Record<string, QueuedMessage[]> {
    let mergedState = refreshedState
    for (const [threadId, pendingIds] of pendingQueueAppendMessageIdsByThreadId) {
      const localQueue = queuedMessagesByThreadId.value[threadId] ?? []
      const pendingMessages = localQueue.filter((message) => pendingIds.has(message.id))
      if (pendingMessages.length === 0) continue
      const nextQueue = [...(mergedState[threadId] ?? [])]
      for (const message of pendingMessages) {
        if (nextQueue.some((queuedMessage) => queuedMessage.id === message.id)) continue
        const localIndex = localQueue.findIndex((queuedMessage) => queuedMessage.id === message.id)
        nextQueue.splice(Math.max(0, Math.min(localIndex, nextQueue.length)), 0, message)
      }
      mergedState = { ...mergedState, [threadId]: nextQueue }
    }
    return mergedState
  }

  function isAmbiguousQueueAppendError(queueError: unknown): boolean {
    return queueError instanceof TypeError
      || (queueError instanceof Error && queueError.name === 'ThreadQueueAppendAmbiguousError')
  }

  async function persistQueuedMessageUntilConfirmed(
    threadId: string,
    queuedMessage: QueuedMessage,
    queueInsertIndex?: number,
  ): Promise<void> {
    let ambiguousAttempts = 0
    while (true) {
      try {
        await appendThreadQueuedMessage(threadId, queuedMessage, queueInsertIndex)
        return
      } catch (queueError) {
        if (!isAmbiguousQueueAppendError(queueError)) throw queueError
        ambiguousAttempts += 1
        if (ambiguousAttempts >= 2) {
          try {
            if (await getThreadQueueAppendReceipt(threadId, queuedMessage.id)) return
          } catch {
            // Keep the optimistic row pending and retry the idempotent append.
          }
        }
        if (ambiguousAttempts >= 2) {
          await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 250))
        }
      }
    }
  }

  async function enqueueThreadMessageDurably(
    threadId: string,
    nextText: string,
    imageUrls: string[],
    skills: Array<{ name: string; path: string }>,
    fileAttachments: FileAttachment[],
    collaborationModeOverride?: CollaborationModeKind,
    queueInsertIndex?: number,
  ): Promise<QueuedMessage | null> {
    const queuedMessage = enqueueThreadMessage(
      threadId,
      nextText,
      imageUrls,
      skills,
      fileAttachments,
      collaborationModeOverride,
      queueInsertIndex,
    )
    setQueueAppendPending(threadId, queuedMessage.id, true)
    try {
      await persistQueuedMessageUntilConfirmed(threadId, queuedMessage, queueInsertIndex)
      return queuedMessage
    } catch (queueError) {
      removeLocallyQueuedMessage(threadId, queuedMessage.id)
      queuePositionRepairThreadIds.add(threadId)
      const message = queueError instanceof Error ? queueError.message : 'Failed to append thread queue message'
      setTurnErrorForThread(threadId, message)
      error.value = message
      return null
    } finally {
      setQueueAppendPending(threadId, queuedMessage.id, false)
      if (
        queuePositionRepairThreadIds.has(threadId)
        && (pendingQueueAppendMessageIdsByThreadId.get(threadId)?.size ?? 0) === 0
      ) {
        queuePositionRepairThreadIds.delete(threadId)
        try {
          const revision = await reorderThreadQueuedMessagesOnServer(
            threadId,
            (queuedMessagesByThreadId.value[threadId] ?? []).map((message) => message.id),
          )
          latestQueueRevision = Math.max(latestQueueRevision, revision)
        } catch {
          void processQueuedMessages(threadId)
        }
      }
      queueMutationVersion += 1
      const needsSettledRefresh = queueRefreshDuringPendingAppendThreadIds.delete(threadId)
      if (queueProcessingByThreadId.value[threadId] === true) {
        pendingQueueRefreshThreadIds.add(threadId)
      } else if (needsSettledRefresh) {
        void processQueuedMessages(threadId)
      }
    }
  }

  async function enqueueExternalTextOnlyThreadMessage(
    threadId: string,
    nextText: string,
    collaborationModeOverride?: CollaborationModeKind,
    queueInsertIndex?: number,
  ): Promise<QueuedMessage | null> {
    const textOnly = nextText.trim()
    if (!textOnly) return null
    return enqueueThreadMessageDurably(
      threadId,
      textOnly,
      [],
      [],
      [],
      collaborationModeOverride,
      queueInsertIndex,
    )
  }

  async function loadPersistedQueueStateIfNeeded(): Promise<void> {
    if (hasLoadedPersistedQueueState) return
    hasLoadedPersistedQueueState = true
    try {
      const snapshot = await getThreadQueueSnapshot()
      queuedMessagesByThreadId.value = snapshot.state
      latestQueueRevision = snapshot.revision
    } catch {
      // Backend queue state is optional during startup.
    }
  }

  function removeArchivedThreadFromLoadedLists(threadId: string): void {
    loadedThreadListGroups = removeThreadFromGroups(loadedThreadListGroups, threadId)
    sourceGroups.value = removeThreadFromGroups(sourceGroups.value, threadId)
    inProgressById.value = omitKey(inProgressById.value, threadId)
    applyThreadFlags()
  }

  function mergeThreadGroupPages(previous: UiProjectGroup[], incoming: UiProjectGroup[]): UiProjectGroup[] {
    if (previous.length === 0) return incoming
    if (incoming.length === 0) return previous

    const threadById = new Map<string, UiThread>()
    for (const thread of flattenThreads(previous)) {
      threadById.set(thread.id, thread)
    }
    for (const thread of flattenThreads(incoming)) {
      threadById.set(thread.id, thread)
    }
    const groupsByProject = new Map<string, UiThread[]>()
    for (const thread of threadById.values()) {
      const existing = groupsByProject.get(thread.projectName)
      if (existing) existing.push(thread)
      else groupsByProject.set(thread.projectName, [thread])
    }

    return Array.from(groupsByProject.entries())
      .map(([projectName, threads]) => ({
        projectName,
        threads: threads.sort(
          (first, second) => new Date(second.updatedAtIso).getTime() - new Date(first.updatedAtIso).getTime(),
        ),
      }))
      .sort((first, second) => {
        const firstUpdated = new Date(first.threads[0]?.updatedAtIso ?? 0).getTime()
        const secondUpdated = new Date(second.threads[0]?.updatedAtIso ?? 0).getTime()
        return secondUpdated - firstUpdated
      })
  }

  function hasActiveInProgressThreads(): boolean {
    return Object.values(inProgressById.value).some((value) => value === true)
  }

  function scheduleRemainingThreadPages(rootsState: WorkspaceRootsState | null = loadedThreadListRootsState): void {
    if (!ENABLE_AUTOMATIC_BACKGROUND_THREAD_PAGINATION) {
      loadedThreadListRootsState = rootsState
      return
    }
    if (!threadListNextCursor || isLoadingRemainingThreadPages) return

    loadedThreadListRootsState = rootsState
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return

    if (typeof window === 'undefined') {
      void loadRemainingThreadPages(rootsState)
      return
    }

    if (threadListBackgroundTimer !== null) {
      window.clearTimeout(threadListBackgroundTimer)
    }

    threadListBackgroundTimer = window.setTimeout(() => {
      threadListBackgroundTimer = null
      if (!threadListNextCursor) return
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      void loadRemainingThreadPages(loadedThreadListRootsState)
    }, BACKGROUND_THREAD_PAGINATION_DELAY_MS)
  }

  async function loadRemainingThreadPages(rootsState: WorkspaceRootsState | null): Promise<void> {
    if (isLoadingRemainingThreadPages || !threadListNextCursor) return
    isLoadingRemainingThreadPages = true

    try {
      const page = await getThreadGroupsPage(threadListNextCursor, getBackgroundThreadListLimit())
      threadListNextCursor = page.nextCursor
      hasLoadedAllThreadPages = page.nextCursor === null
      isThreadListFullyLoaded.value = hasLoadedAllThreadPages
      if (freshThreadListGroupsDuringSnapshotRefresh) {
        freshThreadListGroupsDuringSnapshotRefresh = mergeThreadGroupPages(
          freshThreadListGroupsDuringSnapshotRefresh,
          page.groups,
        )
      }
      loadedThreadListGroups = mergeThreadGroupPages(loadedThreadListGroups, page.groups)
      if (hasLoadedAllThreadPages && freshThreadListGroupsDuringSnapshotRefresh) {
        loadedThreadListGroups = freshThreadListGroupsDuringSnapshotRefresh
        freshThreadListGroupsDuringSnapshotRefresh = null
      }
      applyThreadGroups(loadedThreadListGroups, rootsState)
      if (hasLoadedAllThreadPages) {
        saveThreadGroupsSnapshot(loadedThreadListGroups)
      }
      pruneThreadScopedStateAfterCompleteDirectory()
    } catch {
      // Keep the first page usable; a later refresh can retry remaining pages.
    } finally {
      isLoadingRemainingThreadPages = false
      if (threadListNextCursor) {
        scheduleRemainingThreadPages(rootsState)
      }
    }
  }

  async function loadThreads(options: { force?: boolean } = {}) {
    if (loadThreadsPromise) {
      await loadThreadsPromise
      return
    }
    if (
      options.force !== true &&
      !hasLoadedThreadListSnapshotOnly &&
      hasLoadedThreads.value &&
      Date.now() - lastThreadListLoadAt < RECENT_THREAD_LIST_LOAD_REUSE_MS
    ) {
      return
    }

    loadThreadsPromise = (async () => {
    if (!hasLoadedThreads.value) {
      isLoadingThreads.value = true
    }

    try {
      const shouldAwaitMetadata = options.force === true || hasLoadedThreads.value
      const replacingStartupSnapshot = hasLoadedThreadListSnapshotOnly
      const shouldForceFreshThreadList = options.force === true && !replacingStartupSnapshot
      const page = shouldForceFreshThreadList
        ? await getThreadGroupsPage(
          undefined,
          replacingStartupSnapshot ? getBackgroundThreadListLimit() : undefined,
          { forceFresh: true },
        )
        : await getThreadGroupsPage()
      const rootsState = loadedThreadListRootsState
      const groups = page.groups
      if (replacingStartupSnapshot && page.nextCursor !== null) {
        freshThreadListGroupsDuringSnapshotRefresh = groups
        loadedThreadListGroups = mergeThreadGroupPages(loadedThreadListGroups, groups)
      } else {
        freshThreadListGroupsDuringSnapshotRefresh = null
        loadedThreadListGroups = hasLoadedThreads.value && !replacingStartupSnapshot
          ? mergeThreadGroupPages(loadedThreadListGroups, groups)
          : groups
        if (replacingStartupSnapshot) {
          sourceGroups.value = []
        }
      }
      hasLoadedThreadListSnapshotOnly = false
      threadListNextCursor = hasLoadedThreads.value && !hasLoadedAllThreadPages && !replacingStartupSnapshot
        ? threadListNextCursor
        : page.nextCursor
      hasLoadedAllThreadPages = page.nextCursor === null
      isThreadListFullyLoaded.value = hasLoadedAllThreadPages

      applyThreadGroups(loadedThreadListGroups, rootsState)
      if (hasLoadedAllThreadPages) {
        saveThreadGroupsSnapshot(loadedThreadListGroups)
      }
      hasLoadedThreads.value = true
      lastThreadListLoadAt = Date.now()
      if (!hasLoadedAllThreadPages) {
        scheduleRemainingThreadPages(rootsState)
      }

      const metadataRefresh = refreshThreadListMetadataAfterFirstPage({ force: options.force === true })
        .catch(() => {})
      if (shouldAwaitMetadata) {
        await metadataRefresh
      }

      const flatThreads = flattenThreads(projectGroups.value)
      pruneThreadScopedStateAfterCompleteDirectory()

      const currentExists = flatThreads.some((thread) => thread.id === selectedThreadId.value)

      if (!currentExists && !selectedThreadId.value) {
        setSelectedThreadId(flatThreads[0]?.id ?? '')
      }
    } finally {
      isLoadingThreads.value = false
    }
    })().finally(() => {
      loadThreadsPromise = null
    })

    await loadThreadsPromise
  }

  function clearThreadLiveAuthority(threadId: string): void {
    if (!threadId) return
    if (liveAuthorityByThreadId.value[threadId]) {
      liveAuthorityByThreadId.value = omitKey(liveAuthorityByThreadId.value, threadId)
    }
    if (threadId in liveSnapshotByThreadId.value) {
      liveSnapshotByThreadId.value = omitKey(liveSnapshotByThreadId.value, threadId)
    }
    if (projectionKeyByThreadId.value[threadId]) {
      projectionKeyByThreadId.value = omitKey(projectionKeyByThreadId.value, threadId)
    }
  }

  function reconcileThreadDetailSnapshot(
    threadId: string,
    detail: ThreadDetailSnapshot,
    options: {
      preserveMissing: boolean
      markRead: boolean
      requestedVersion: string
      detailEpoch: number
      allowIdleLocalLeaseRelease?: boolean
      allowIdleExternalLeaseRelease?: boolean
    },
  ): void {
    if (!isCurrentThreadDetailEpoch(threadId, options.detailEpoch)) return
    if (detail.modelProvider) {
      setThreadModelProviderId(threadId, detail.modelProvider)
    }
    if (detail.model) {
      setThreadModelId(threadId, resolveThreadModelForProvider(threadId, detail.model, detail.modelProvider))
    }
    if (detail.reasoningEffort) {
      setThreadReasoningEffort(threadId, detail.reasoningEffort)
    }

    const {
      messages: detailMessages,
      completionSummaries = [],
      inProgress: serverInProgress,
      activeTurnId,
      turnIndexByTurnId: detailTurnIndexByTurnId,
    } = detail
    if (serverInProgress === true && activeTurnId && isKnownTerminalTurnRuntime(threadId, activeTurnId)) {
      clearCompletedTurnLiveState(threadId)
      setThreadRuntimeOwnership(threadId, 'idle', { canInterrupt: false })
      setThreadInProgress(threadId, false)
      setLoadedThreadMetadataInProgress(threadId, false)
      return
    }
    const isLiveProjection = detail.isLiveProjection === true
    const isPartialTurnProjection = detail.isPartialTurnProjection === true
    const isPagedProjection = detail.isPagedProjection === true
    const isIncrementalProjection = isLiveProjection || isPagedProjection
    const hadLoadedMessages = loadedMessagesByThreadId.value[threadId] === true
    let reconciledTurnIndexByTurnId = detailTurnIndexByTurnId
    let reconciledDetailMessages = detailMessages
    if (isIncrementalProjection) {
      const existingLookup = turnIndexByTurnIdByThreadId.value[threadId] ?? {}
      const pagedTurnIds = Object.entries(detailTurnIndexByTurnId)
        .sort((left, right) => left[1] - right[1])
        .map(([turnId]) => turnId)
      const nextLookup = isPagedProjection
        ? mergePagedTurnIndexLookup(existingLookup, pagedTurnIds, {
            prependUnanchored: shouldPrependUnanchoredDelegationPage(
              hadLoadedMessages,
              serverInProgress === true,
              existingLookup,
              pagedTurnIds,
              detailMessages,
            ),
          })
        : (() => {
            const appendedLookup = { ...existingLookup }
            let nextTurnIndex = Object.values(existingLookup).reduce(
              (maximum, turnIndex) => Math.max(maximum, turnIndex),
              -1,
            ) + 1
            for (const turnId of pagedTurnIds) {
              if (appendedLookup[turnId] !== undefined) continue
              appendedLookup[turnId] = nextTurnIndex
              nextTurnIndex += 1
            }
            return appendedLookup
          })()
      reconciledTurnIndexByTurnId = nextLookup
      reconciledDetailMessages = reindexMessagesByTurnLookup(detailMessages, nextLookup)
    }
    const mergedCompletionSummaries = mergeTurnSummariesWithPersistedDurations(
      threadId,
      completionSummaries,
    )
    rememberTerminalSummariesForThread(threadId, mergedCompletionSummaries)
    const nextMessages = reindexMessagesByTurnLookup(
      insertTurnSummaryMessages(
        reconciledDetailMessages,
        mergedCompletionSummaries,
      ),
      reconciledTurnIndexByTurnId,
    )
    let previousPersisted = reindexMessagesByTurnLookup(
      persistedMessagesByThreadId.value[threadId] ?? [],
      reconciledTurnIndexByTurnId,
    )
    const localActiveTurnId = runtimeOwnershipByThreadId.value[threadId] === 'local'
      ? activeTurnIdByThreadId.value[threadId] ?? ''
      : ''
    const externalActiveTurnId = runtimeOwnershipByThreadId.value[threadId] === 'external'
      ? activeTurnIdByThreadId.value[threadId] ?? ''
      : ''
    const detailOwnership: ThreadRuntimeOwnership = detail.ownership === 'external'
      ? 'external'
      : detail.ownership === 'local' || serverInProgress
        ? 'local'
        : 'idle'
    const hasTerminalSummaryForExternalActiveTurn =
      externalActiveTurnId.length > 0
      && (
        isKnownTerminalTurnRuntime(threadId, externalActiveTurnId)
        || mergedCompletionSummaries.some((summary) => summary.turnId === externalActiveTurnId)
      )
    const previousExternalActiveById = new Map(
      externalActiveTurnId.length > 0
        ? previousPersisted
            .filter((message) => message.turnId === externalActiveTurnId)
            .map((message) => [message.id, message])
        : [],
    )
    const previousExternalMaxSessionOrder = previousPersisted.reduce((maxOrder, message) => {
      if (message.turnId !== externalActiveTurnId) return maxOrder
      if (typeof message.sessionOrder !== 'number' || !Number.isFinite(message.sessionOrder)) {
        return maxOrder
      }
      return Math.max(maxOrder, message.sessionOrder)
    }, Number.NEGATIVE_INFINITY)
    const detailProvidesExternalActiveTerminalText =
      externalActiveTurnId.length > 0
      && nextMessages.some((message) => {
        if (message.turnId !== externalActiveTurnId) return false
        if (message.role !== 'assistant') return false
        if (message.messageType !== 'agentMessage') return false
        if (!message.text.trim()) return false
        if (message.phase === 'final' || message.phase === 'final_answer') return true
        if (typeof message.sessionOrder !== 'number' || !Number.isFinite(message.sessionOrder)) {
          return false
        }
        const previousMessage = previousExternalActiveById.get(message.id)
        if (!previousMessage) return message.sessionOrder > previousExternalMaxSessionOrder
        if (
          typeof previousMessage.sessionOrder !== 'number'
          || !Number.isFinite(previousMessage.sessionOrder)
        ) {
          return false
        }
        if (message.text === previousMessage.text) return false
        return message.sessionOrder > previousMessage.sessionOrder
      })
    const allowLocalLeaseRelease = options.allowIdleLocalLeaseRelease === true
      && detailOwnership === 'idle'
    const allowExternalLeaseRelease = options.allowIdleExternalLeaseRelease === true
      && detailOwnership === 'idle'
    const retainLocal =
      !allowLocalLeaseRelease
      && (
        localActiveTurnId.length > 0
        || (
          inProgressById.value[threadId] === true
          && pendingTurnRequestByThreadId.value[threadId]?.fallbackRetried === true
        )
      )
    const retainEstablishedExternal =
      !retainLocal &&
      !allowExternalLeaseRelease &&
      runtimeOwnershipByThreadId.value[threadId] === 'external' &&
      detailOwnership === 'idle' &&
      externalActiveTurnId.length > 0 &&
      !hasTerminalSummaryForExternalActiveTurn &&
      !detailProvidesExternalActiveTerminalText
    const ownership = retainLocal
      ? 'local'
      : retainEstablishedExternal
        ? 'external'
        : detailOwnership
    const inProgress = retainLocal || retainEstablishedExternal || detail.inProgress
    if (retainEstablishedExternal) {
      setThreadRuntimeOwnership(threadId, 'external', {
        canInterrupt: detail.canInterrupt === true || runtimeCanInterruptByThreadId.value[threadId] === true,
      })
      setThreadInProgress(threadId, true)
      setLoadedThreadMetadataInProgress(threadId, true)
      activeTurnIdByThreadId.value = {
        ...activeTurnIdByThreadId.value,
        [threadId]: externalActiveTurnId,
      }
      ensureActiveTextHydration(threadId, externalActiveTurnId, {
        refreshExhausted: true,
        forceRefreshExhausted: true,
      })
      if (
        externalRuntimePollingEnabled
        && selectedThreadId.value === threadId
      ) {
        scheduleExternalRuntimePolling(threadId)
      }
      return
    }
    const runtimeCwd = typeof detail.runtimeCwd === 'string'
      ? normalizePathForUi(detail.runtimeCwd).trim()
      : ''
    if (runtimeCwd) {
      runtimeCwdByThreadId.value = {
        ...runtimeCwdByThreadId.value,
        [threadId]: runtimeCwd,
      }
    } else if (!inProgress || ownership !== 'external') {
      runtimeCwdByThreadId.value = omitKey(runtimeCwdByThreadId.value, threadId)
    }
    const previousProjectionKey = projectionKeyByThreadId.value[threadId] ?? ''
    const liveProjectionKeyChanged = isLiveProjection
      && typeof detail.projectionKey === 'string'
      && detail.projectionKey.length > 0
      && previousProjectionKey.length > 0
      && detail.projectionKey !== previousProjectionKey
    const shouldProbeSelectedActiveTextTail = selectedThreadId.value === threadId
      && inProgress
      && ownership === 'external'
    if (isLiveProjection) {
      liveAuthorityByThreadId.value = {
        ...liveAuthorityByThreadId.value,
        [threadId]: detail.liveAuthority ?? 'persisted',
      }
      liveSnapshotByThreadId.value = {
        ...liveSnapshotByThreadId.value,
        [threadId]: detail.liveSnapshot ?? null,
      }
      if (detail.projectionKey) {
        projectionKeyByThreadId.value = {
          ...projectionKeyByThreadId.value,
          [threadId]: detail.projectionKey,
        }
      }
    } else if (ownership !== 'external' || !inProgress) {
      clearThreadLiveAuthority(threadId)
    }
    if (isLiveProjection && detail.notModified === true) {
      if (inProgress && activeTurnId) {
        activeTurnIdByThreadId.value = {
          ...activeTurnIdByThreadId.value,
          [threadId]: activeTurnId,
        }
        const activeTailHydration = activeTextHydrationByThreadId.get(threadId)
        const activeTailHasSignature = typeof activeTailHydration?.tailSignature === 'string'
          && activeTailHydration.tailSignature.length > 0
        const activeTailCanProbeWithoutSignature = activeTailHydration?.turnId === activeTurnId
          && !activeTailHasSignature
          && activeTailHydration.controller === null
          && activeTailHydration.hasMoreOlder === false
          && activeTailHydration.nextOlderCursor === null
          && newestHydratedSessionOrder(activeTailHydration.messages) !== undefined
          && (
            Date.now() - (activeTailHydration.lastUnsignedTailProbeAt ?? Number.NEGATIVE_INFINITY)
          ) >= UNSIGNED_ACTIVE_TEXT_TAIL_POLL_MS
        const shouldForceSelectedTailProbe = shouldProbeSelectedActiveTextTail
          && activeTailHydration?.turnId === activeTurnId
          && !isActiveTextHydrationConflictBlocked(threadId, activeTailHydration)
          && (
            activeTailHasSignature
            || activeTailCanProbeWithoutSignature
          )
        ensureActiveTextHydration(threadId, activeTurnId, {
          refreshExhausted: true,
          forceRefreshExhausted: liveProjectionKeyChanged || shouldForceSelectedTailProbe,
          forceRefreshNewest: liveProjectionKeyChanged,
        })
      }
      if (inProgress) {
        setThreadRuntimeOwnership(threadId, ownership, {
          canInterrupt: detail.canInterrupt === true || ownership === 'local',
        })
        setThreadInProgress(threadId, true)
      } else {
        setThreadInProgress(threadId, false)
        setThreadRuntimeOwnership(threadId, ownership, { canInterrupt: false })
      }
      return
    }
    if (!isIncrementalProjection || !hadLoadedMessages) {
      setOlderTurnCursorForThread(
        threadId,
        detail.hasMoreOlder === true ? detail.olderCursor ?? null : null,
      )
    }
    markThreadMessagesPersisted(threadId, nextMessages)
    replaceTurnIndexLookupForThread(threadId, isIncrementalProjection
      ? reconciledTurnIndexByTurnId
      : detailTurnIndexByTurnId)
    rebindLiveFileChangeTurnIndices(threadId)
    let activeTextHydration = activeTextHydrationByThreadId.get(threadId)
    if (
      inProgress
      && activeTurnId
      && activeTextHydration
      && activeTextHydration.turnId !== activeTurnId
    ) {
      const previousHydratedTurnId = activeTextHydration.turnId
      previousPersisted = previousPersisted.filter(
        (message) => (
          message.turnId !== previousHydratedTurnId
          || message.messageType !== 'reasoning'
        ),
      )
      cancelActiveTextHydration(threadId)
      activeTextHydration = undefined
    }
    const rawLiveProjectionHasAuthoritativeTurnIndices = isLiveProjection
      && detailMessages.length > 0
      && detailMessages.every((message) => (
        typeof message.turnIndex === 'number'
        && Number.isFinite(message.turnIndex)
      ))
    const liveProjectionHasOrderedActiveTextRows = isLiveProjection
      && inProgress
      && activeTurnId.length > 0
      && detailMessages.some((message) => (
        message.turnId === activeTurnId
        && typeof message.sessionOrder === 'number'
        && Number.isFinite(message.sessionOrder)
      ))
    // A running live projection without absolute turn indices is a bounded,
    // append-style view of an active writer. Rollout rows with `sessionOrder`
    // are also incremental even when the projection carries a rebased
    // `turnIndex`; treating those as authoritative replacements can briefly
    // erase already hydrated transcript rows until the text page catches up.
    // Paged projections without ordered active text remain authoritative so
    // stale rebased rows can still be dropped.
    const shouldPreserveLiveProjection = isLiveProjection
      && inProgress
      && (
        isPartialTurnProjection
        || (
          !rawLiveProjectionHasAuthoritativeTurnIndices
          || liveProjectionHasOrderedActiveTextRows
        )
      )
    const shouldPreserveLoadedIdleOrderedRows = hadLoadedMessages && !inProgress
    const shouldAllowEqualOrderTextGrowth =
      shouldPreserveLoadedIdleOrderedRows && mergedCompletionSummaries.length > 0
    const shouldUseAuthoritativeIdleMerge = !inProgress && hadLoadedMessages && !shouldPreserveLiveProjection
    const authoritativeIdleTurnIds = shouldUseAuthoritativeIdleMerge
      ? Object.keys(detailTurnIndexByTurnId)
      : []
    const authoritativeIdlePrunableTurnIds = shouldUseAuthoritativeIdleMerge
      ? uniqueTurnIds([
          activeTextHydration?.turnId ?? '',
          externalActiveTurnId,
          recentlyCompletedActiveTurnIdByThreadId.get(threadId) ?? '',
          activeTurnIdByThreadId.value[threadId] ?? '',
          activeTurnId,
        ])
      : []
    const effectiveNextMessages = shouldUseAuthoritativeIdleMerge
      ? filterStaleAuthoritativeIncomingMessages(
          previousPersisted,
          nextMessages,
          authoritativeIdleTurnIds,
          { allowEqualOrderTextGrowth: shouldAllowEqualOrderTextGrowth },
        )
      : nextMessages
    const previousForAuthoritativeIdleMerge = shouldUseAuthoritativeIdleMerge
      ? prunePreviousMessagesForAuthoritativeTurns(
          previousPersisted,
          effectiveNextMessages,
          authoritativeIdleTurnIds,
          { prunableTurnIds: authoritativeIdlePrunableTurnIds },
        )
      : previousPersisted
    const mergedMessages = shouldPreserveLiveProjection
      ? mergeMessages(previousPersisted, nextMessages, { preserveMissing: true })
      : isIncrementalProjection
        ? shouldPreserveLoadedIdleOrderedRows
          ? mergeMessages(previousForAuthoritativeIdleMerge, effectiveNextMessages, {
              preserveMissing: true,
              preserveOrderedRows: true,
              allowEqualOrderTextGrowth: shouldAllowEqualOrderTextGrowth,
            })
          : mergeLiveProjectionMessages(
              previousPersisted,
              nextMessages,
              isPagedProjection ? Object.keys(detailTurnIndexByTurnId) : [],
            )
      : mergeMessages(previousForAuthoritativeIdleMerge, effectiveNextMessages, {
          preserveMissing: options.preserveMissing || hasOptimisticUserMessages(previousPersisted),
          preserveOrderedRows: shouldPreserveLoadedIdleOrderedRows,
          allowEqualOrderTextGrowth: shouldAllowEqualOrderTextGrowth,
        })
    const messagesWithHydratedText = activeTextHydration && inProgress
      ? mergeHydratedTurnTextIntoTranscript(
          mergedMessages,
          activeTextHydration.messages,
          activeTextHydration.turnId,
        )
      : mergedMessages
    const finalizedMessages = !inProgress && activeTextHydration
      ? finalizeHydratedTurnText(messagesWithHydratedText, activeTextHydration.turnId)
      : messagesWithHydratedText
    setPersistedMessagesForThread(threadId, finalizedMessages)

    const previousLiveAgent = liveAgentMessagesByThreadId.value[threadId] ?? []
    if (inProgress) {
      const nextLiveAgent = removeRedundantLiveAgentMessages(previousLiveAgent, nextMessages)
      setLiveAgentMessagesForThread(threadId, nextLiveAgent)
    } else {
      clearLiveAgentMessagesForThread(threadId)
    }
    removeLiveCommandsPersistedIn(threadId, nextMessages)
    removeLiveFileChangesPersistedIn(threadId, nextMessages)

    loadedMessagesByThreadId.value = {
      ...loadedMessagesByThreadId.value,
      [threadId]: true,
    }
    lastMessageLoadAtByThreadId.set(threadId, Date.now())
    lastMessageLoadFailureAtByThreadId.delete(threadId)

    if (options.requestedVersion) {
      loadedVersionByThreadId.value = {
        ...loadedVersionByThreadId.value,
        [threadId]: options.requestedVersion,
      }
    }
    if (inProgress) {
      setThreadRuntimeOwnership(threadId, ownership, {
        canInterrupt: detail.canInterrupt === true || ownership === 'local',
      })
      setThreadInProgress(threadId, true)
    } else {
      setThreadRuntimeOwnership(threadId, ownership, { canInterrupt: false })
      setThreadInProgress(threadId, false)
    }
    if (inProgress && activeTurnId) {
      activeTurnIdByThreadId.value = {
        ...activeTurnIdByThreadId.value,
        [threadId]: activeTurnId,
      }
    }
    if (!inProgress) {
      recentlyCompletedActiveTurnIdByThreadId.delete(threadId)
      clearTransientTurnErrorForThread(threadId)
      clearCompletedTurnLiveState(threadId)
      if (activeTextHydration) {
        cancelActiveTextHydration(threadId)
      }
    }
    const previousActiveMessageById = new Map(
      previousPersisted
        .filter((message) => message.turnId === activeTurnId)
        .map((message) => [message.id, message]),
    )
    const previousActiveMaxSessionOrder = previousPersisted.reduce((maxOrder, message) => {
      if (message.turnId !== activeTurnId) return maxOrder
      if (typeof message.sessionOrder !== 'number' || !Number.isFinite(message.sessionOrder)) {
        return maxOrder
      }
      return Math.max(maxOrder, message.sessionOrder)
    }, Number.NEGATIVE_INFINITY)
    const liveProjectionAdvancesActiveText = nextMessages.some((message) => {
      if (message.turnId !== activeTurnId) return false
      const previousMessage = previousActiveMessageById.get(message.id)
      if (!previousMessage) return true
      if (message.text !== previousMessage.text) return true
      return (
        typeof message.sessionOrder === 'number'
        && Number.isFinite(message.sessionOrder)
        && message.sessionOrder > previousActiveMaxSessionOrder
      )
    })
    const shouldRefreshChangedFullLiveProjection = liveProjectionKeyChanged
      && isLiveProjection
      && !isPartialTurnProjection
      && !liveProjectionAdvancesActiveText
    const shouldRefreshChangedPartialLiveProjection = liveProjectionKeyChanged
      && isLiveProjection
      && isPartialTurnProjection
    const previousMessageIds = new Set(previousPersisted.map((message) => message.id))
    const compressedLiveProjectionHasNewRows = isLiveProjection
      && isPartialTurnProjection
      && nextMessages.some((message) => !previousMessageIds.has(message.id))
    if (
      !inProgress
      && hadLoadedMessages
      && selectedThreadId.value === threadId
      && compressedLiveProjectionHasNewRows
      && typeof detail.projectionKey === 'string'
      && detail.projectionKey.length > 0
    ) {
      scheduleCompressedLiveProjectionBackfill(threadId, detail.projectionKey)
    }
    if (
      inProgress
      && activeTurnId.length > 0
      && (
        isPartialTurnProjection
        || shouldRefreshChangedFullLiveProjection
      )
    ) {
      const refreshedHydration = activeTextHydrationByThreadId.get(threadId)
      if (refreshedHydration?.turnId === activeTurnId) {
        refreshedHydration.recoverableConflictProjectionKey = undefined
      }
      ensureActiveTextHydration(threadId, activeTurnId, {
        refreshExhausted: isLiveProjection,
        forceRefreshExhausted: shouldRefreshChangedFullLiveProjection || shouldRefreshChangedPartialLiveProjection,
        forceRefreshNewest: shouldRefreshChangedFullLiveProjection || shouldRefreshChangedPartialLiveProjection,
      })
    }
    if (options.markRead) {
      markThreadAsRead(threadId)
    }
    if (
      externalRuntimePollingEnabled &&
      selectedThreadId.value === threadId &&
      (
        runtimeOwnershipByThreadId.value[threadId] === 'external' ||
        canStartSelectedLiveProjectionPolling(threadId)
      )
    ) {
      scheduleExternalRuntimePolling(threadId, runtimeOwnershipByThreadId.value[threadId] === 'external' ? undefined : 0)
    }
  }

  async function loadMessages(
    threadId: string,
    options: { silent?: boolean; force?: boolean; bypassRecentReuse?: boolean } = {},
  ) {
    if (!threadId) {
      return
    }
    const recentLoadFailure =
      Date.now() - (lastMessageLoadFailureAtByThreadId.get(threadId) ?? 0) < RECENT_THREAD_MESSAGE_LOAD_REUSE_MS
    if (
      options.force !== true &&
      turnErrorByThreadId.value[threadId]?.transient &&
      (options.silent === true || recentLoadFailure)
    ) {
      return
    }

    const existingLoad = loadMessagePromiseByThreadId.get(threadId)
    if (existingLoad) {
      if (options.force === true) {
        invalidateThreadDetailRequest(threadId)
        loadMessagePromiseByThreadId.delete(threadId)
      } else {
        await existingLoad
        return
      }
    }

    const alreadyLoaded = loadedMessagesByThreadId.value[threadId] === true
    const shouldShowLoading = options.silent !== true && !alreadyLoaded
    if (shouldShowLoading) {
      isLoadingMessages.value = true
    }

    let loadPromise!: Promise<void>
    loadPromise = (async () => {
      try {
        if (!(threadId in threadGoalSupportByThreadId.value)) {
          void refreshThreadGoal(threadId)
        }
        const version = currentThreadVersion(threadId)
        const loadedVersion = loadedVersionByThreadId.value[threadId] ?? ''
        const loadedRecently =
          Date.now() - (lastMessageLoadAtByThreadId.get(threadId) ?? 0) < RECENT_THREAD_MESSAGE_LOAD_REUSE_MS
        const canReuseLoadedMessages =
          options.force !== true &&
          options.bypassRecentReuse !== true &&
          alreadyLoaded &&
          (
            loadedRecently ||
            (
              (version.length === 0 || loadedVersion === version) &&
              inProgressById.value[threadId] !== true
            )
          )

        if (canReuseLoadedMessages) {
          markThreadAsRead(threadId)
          return
        }

        const controller = new AbortController()
        const detailRequest = acquireThreadDetailRequest(
          threadId,
          () => getThreadDetail(threadId, controller.signal),
          controller,
        )
        try {
          const detail = await detailRequest.promise

          reconcileThreadDetailSnapshot(threadId, detail, {
            preserveMissing: options.silent === true,
            markRead: true,
            requestedVersion: version,
            detailEpoch: detailRequest.epoch,
          })
        } finally {
          releaseThreadDetailRequest(threadId, detailRequest)
        }
      } catch (unknownError) {
        if (isAbortLikeError(unknownError)) return
        const message = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
        if (selectedThreadId.value === threadId) {
          setTurnErrorForThread(threadId, message, { transient: true })
        }
        lastMessageLoadFailureAtByThreadId.set(threadId, Date.now())
        throw unknownError
      } finally {
        if (shouldShowLoading && loadMessagePromiseByThreadId.get(threadId) === loadPromise) {
          isLoadingMessages.value = false
        }
      }
    })().finally(() => {
      if (loadMessagePromiseByThreadId.get(threadId) === loadPromise) {
        loadMessagePromiseByThreadId.delete(threadId)
      }
    })

    loadMessagePromiseByThreadId.set(threadId, loadPromise)
    await loadPromise
  }

  async function loadOlderActiveTextMessages(threadId: string): Promise<boolean> {
    const hydration = activeTextHydrationByThreadId.get(threadId)
    const cursor = activeTextOlderCursorForThread(threadId) ?? hydration?.nextOlderCursor ?? null
    if (!hydration || !cursor) return false
    if (!isActiveTextHydrationCurrent(
      threadId,
      hydration,
      activeTextHydrationGenerationByThreadId.get(threadId) ?? 0,
    )) {
      setActiveTextOlderCursorForThread(threadId, null)
      return false
    }
    if (hydration.controller !== null) return true
    if (hydration.consumedCursors.has(cursor)) {
      setActiveTextOlderCursorForThread(threadId, null)
      return false
    }

    const generation = activeTextHydrationGenerationByThreadId.get(threadId) ?? 0
    const controller = new AbortController()
    hydration.controller = controller
    try {
      const page = await multiWindowThreadSync.loadActiveTextPage({
        threadId,
        turnId: hydration.turnId,
        requestKey: activeTextPageRequestKey(cursor, undefined),
        signal: controller.signal,
        load: () => getThreadTextPage(
          threadId,
          hydration.turnId,
          cursor,
          undefined,
          controller.signal,
        ),
      })
      if (!isActiveTextHydrationCurrent(threadId, hydration, generation)) return true

      hydration.consumedCursors.add(cursor)
      if (page.notModified === true) {
        recordActiveTextOlderCursorFromPage(threadId, hydration, page)
        hydration.hasMoreOlder = false
        return true
      }
      hydration.messages = mergeThreadTextPage(hydration.messages, page.messages)
      recordActiveTextOlderCursorFromPage(threadId, hydration, page)
      hydration.hasMoreOlder = false
      publishActiveTextHydration(threadId, hydration)
      return true
    } catch (loadError) {
      if (
        isActiveTextHydrationCurrent(threadId, hydration, generation)
        && loadError instanceof CodexApiError
        && (loadError.status === 400 || loadError.status === 409)
      ) {
        hydration.nextOlderCursor = null
        hydration.hasMoreOlder = false
        hydration.consumedCursors.clear()
        hydration.recoverableConflictProjectionKey = projectionKeyByThreadId.value[threadId] ?? ''
        setActiveTextOlderCursorForThread(threadId, null)
      }
      throw loadError
    } finally {
      if (hydration.controller === controller) {
        hydration.controller = null
      }
    }
  }

  async function loadOlderMessages(threadId: string = selectedThreadId.value): Promise<void> {
    if (!threadId) return
    if (loadingOlderMessagesByThreadId.value[threadId] === true) return
    if (hasMoreOlderMessagesByThreadId.value[threadId] !== true) {
      updateHasMoreOlderMessagesForThread(threadId)
      if (
        activeTextOlderCursorForThread(threadId) === null
        && olderTurnCursorForThread(threadId) === null
      ) return
    }

    loadingOlderMessagesByThreadId.value = {
      ...loadingOlderMessagesByThreadId.value,
      [threadId]: true,
    }

    try {
      if (await loadOlderActiveTextMessages(threadId)) return

      const cursor = olderTurnCursorForThread(threadId)
      if (!cursor) {
        updateHasMoreOlderMessagesForThread(threadId)
        return
      }

      const page = await getOlderThreadMessages(threadId, cursor)
      const consumedCursors = consumedOlderTurnCursorsByThreadId.get(threadId) ?? new Set<string>()
      if (
        page.nextCursor !== null
        && (page.nextCursor === cursor || consumedCursors.has(page.nextCursor))
      ) {
        consumedCursors.add(cursor)
        consumedOlderTurnCursorsByThreadId.set(threadId, consumedCursors)
        setOlderTurnCursorForThread(threadId, null)
        return
      }
      const currentLookup = turnIndexByTurnIdByThreadId.value[threadId] ?? {}
      const newTurnIds = page.turnIds.filter((turnId) => !(turnId in currentLookup))
      const shift = newTurnIds.length
      const shiftMessages = (messages: UiMessage[]): UiMessage[] => (
        shift === 0
          ? messages
          : messages.map((message) => (
              typeof message.turnIndex === 'number'
                ? { ...message, turnIndex: message.turnIndex + shift }
                : message
            ))
      )
      const previousPersisted = shiftMessages(persistedMessagesByThreadId.value[threadId] ?? [])
      if (shift > 0) {
        setPersistedMessagesForThread(threadId, previousPersisted)
        optimisticUserMessagesByThreadId.value = {
          ...optimisticUserMessagesByThreadId.value,
          [threadId]: (optimisticUserMessagesByThreadId.value[threadId] ?? []).map((submission) => ({
            ...submission,
            message: shiftMessages([submission.message])[0] ?? submission.message,
          })),
        }
        livePlanMessagesByThreadId.value = {
          ...livePlanMessagesByThreadId.value,
          [threadId]: shiftMessages(livePlanMessagesByThreadId.value[threadId] ?? []),
        }
        liveAgentMessagesByThreadId.value = {
          ...liveAgentMessagesByThreadId.value,
          [threadId]: shiftMessages(liveAgentMessagesByThreadId.value[threadId] ?? []),
        }
        liveCommandsByThreadId.value = {
          ...liveCommandsByThreadId.value,
          [threadId]: shiftMessages(liveCommandsByThreadId.value[threadId] ?? []),
        }
        liveFileChangeMessagesByThreadId.value = {
          ...liveFileChangeMessagesByThreadId.value,
          [threadId]: shiftMessages(liveFileChangeMessagesByThreadId.value[threadId] ?? []),
        }
      }
      const shiftedLookup = Object.fromEntries(
        Object.entries(currentLookup).map(([turnId, turnIndex]) => [turnId, turnIndex + shift]),
      )
      const prependedLookup = Object.fromEntries(newTurnIds.map((turnId, index) => [turnId, index]))
      const reconciledLookup = {
        ...shiftedLookup,
        ...prependedLookup,
      }
      const reconciledPageMessages = page.messages.map((message) => {
        if (!message.turnId) return message
        const turnIndex = reconciledLookup[message.turnId]
        return typeof turnIndex === 'number' && message.turnIndex !== turnIndex
          ? { ...message, turnIndex }
          : message
      })
      const pageCompletionSummaries = mergeTurnSummariesWithPersistedDurations(
        threadId,
        page.completionSummaries,
      )
      rememberTerminalSummariesForThread(threadId, pageCompletionSummaries)
      const pageMessages = insertTurnSummaryMessages(
        reconciledPageMessages,
        pageCompletionSummaries,
      )
      const mergedMessages = mergeMessages(pageMessages, previousPersisted, { preserveMissing: true })
      setPersistedMessagesForThread(threadId, mergedMessages)
      replaceTurnIndexLookupForThread(threadId, reconciledLookup)
      rebindLiveFileChangeTurnIndices(threadId)
      consumedCursors.add(cursor)
      consumedOlderTurnCursorsByThreadId.set(threadId, consumedCursors)
      setOlderTurnCursorForThread(threadId, page.nextCursor)
    } catch (loadError) {
      error.value = loadError instanceof Error ? loadError.message : 'Failed to load earlier messages'
      throw loadError
    } finally {
      loadingOlderMessagesByThreadId.value = {
        ...loadingOlderMessagesByThreadId.value,
        [threadId]: false,
      }
    }
  }

  async function ensureThreadMessagesLoaded(threadId: string, options: { silent?: boolean } = {}): Promise<void> {
    if (!threadId) return
    if (loadedMessagesByThreadId.value[threadId] === true) return
    if (options.silent === true && turnErrorByThreadId.value[threadId]?.transient) return
    await loadMessages(threadId, options)
  }

  async function refreshSkills(options: { force?: boolean } = {}): Promise<void> {
    const selectedCwd = selectedThread.value?.cwd?.trim() ?? ''
    const skillsLoadKey = selectedCwd || '__global__'
    if (refreshSkillsPromise) {
      await refreshSkillsPromise
      return
    }
    if (
      options.force !== true &&
      hasLoadedSkills &&
      lastSkillsLoadKey === skillsLoadKey &&
      Date.now() - lastSkillsLoadAt < RECENT_SKILLS_LOAD_REUSE_MS
    ) {
      return
    }

    refreshSkillsPromise = (async () => {
      try {
        installedSkills.value = await getSkillsList(selectedCwd ? [selectedCwd] : undefined)
        hasLoadedSkills = true
        lastSkillsLoadAt = Date.now()
        lastSkillsLoadKey = skillsLoadKey
      } catch {
        // keep previous skills on failure
      } finally {
        refreshSkillsPromise = null
      }
    })()

    await refreshSkillsPromise
  }

  async function refreshAncillaryState(
    options: { providerChanged?: boolean; includeProviderModels?: boolean } = {},
  ): Promise<void> {
    await Promise.allSettled([
      refreshModelPreferences({
        providerChanged: options.providerChanged,
        includeProviderModels: options.includeProviderModels,
      }),
      refreshRateLimits(),
      refreshCollaborationModes(),
      refreshSkills(),
    ])
  }

  function scheduleAncillaryStateRefresh(
    options: { providerChanged?: boolean; includeProviderModels?: boolean } = {},
  ): void {
    const run = () => {
      void refreshAncillaryState(options)
    }

    if (typeof window === 'undefined') {
      run()
      return
    }

    window.setTimeout(run, 0)
  }

  async function refreshAll(
    options: { includeSelectedThreadMessages?: boolean; awaitAncillaryRefreshes?: boolean; providerChanged?: boolean; forceThreadRefresh?: boolean } = {},
  ) {
    error.value = ''
    codexCliMissingError.value = ''
    const includeSelectedThreadMessages = options.includeSelectedThreadMessages !== false
    const awaitAncillaryRefreshes = options.awaitAncillaryRefreshes === true

    try {
      await loadPersistedQueueStateIfNeeded()
      const selectedThreadIdAtStart = selectedThreadId.value.trim()
      const selectedThreadLoad = includeSelectedThreadMessages
        && selectedThreadIdAtStart.length > 0
        && runtimeOwnershipByThreadId.value[selectedThreadIdAtStart] !== 'external'
        ? loadMessages(selectedThreadIdAtStart).catch((unknownError) => {
            if (selectedThreadId.value !== selectedThreadIdAtStart) return
            error.value = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
          })
        : null
      const threadListLoad = loadThreads({ force: options.forceThreadRefresh === true })
        .then(() => null)
        .catch((unknownError: unknown) => unknownError)
      if (selectedThreadLoad) {
        void threadListLoad.then((threadListError) => {
          if (!threadListError) return
          const message = threadListError instanceof Error ? threadListError.message : 'Unknown application error'
          error.value = message
          codexCliMissingError.value = isCodexCliMissingError(threadListError)
            ? CODEX_CLI_MISSING_MESSAGE
            : ''
        })
      } else {
        const threadListError = await threadListLoad
        if (threadListError) {
          throw threadListError
        }
      }
      if (selectedThreadLoad) {
        await selectedThreadLoad
        if (selectedThreadId.value === selectedThreadIdAtStart) {
          markThreadAsRead(selectedThreadIdAtStart)
        }
      }
      const selectedThreadStillNeedsLoad =
        includeSelectedThreadMessages
        && selectedThreadId.value.length > 0
        && selectedThreadId.value !== selectedThreadIdAtStart
        && runtimeOwnershipByThreadId.value[selectedThreadId.value] !== 'external'
      if (selectedThreadStillNeedsLoad) {
        try {
          await loadMessages(selectedThreadId.value)
        } catch (unknownError) {
          error.value = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
        }
      }
      if (awaitAncillaryRefreshes) {
        await refreshAncillaryState({
          providerChanged: options.providerChanged,
          includeProviderModels: options.providerChanged === true || awaitAncillaryRefreshes,
        })
      } else {
        scheduleAncillaryStateRefresh({
          providerChanged: options.providerChanged,
          includeProviderModels: false,
        })
      }
    } catch (unknownError) {
      error.value = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
      if (isCodexCliMissingError(unknownError)) {
        codexCliMissingError.value = CODEX_CLI_MISSING_MESSAGE
      } else {
        codexCliMissingError.value = ''
      }
    }
  }

  async function selectThread(threadId: string): Promise<SelectThreadResult> {
    setSelectedThreadId(threadId)
    void refreshModelPreferences({ includeProviderModels: true })
    void refreshSkills()

    const hasCachedMessages =
      loadedMessagesByThreadId.value[threadId] === true
      || (persistedMessagesByThreadId.value[threadId]?.length ?? 0) > 0

    if (hasCachedMessages) {
      markThreadAsRead(threadId)
      void loadMessages(threadId, { silent: true, force: true }).catch((unknownError) => {
        if (selectedThreadId.value !== threadId) return
        const message = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
        error.value = message
        if (threadId.trim()) {
          setTurnErrorForThread(threadId, message, { transient: true })
        }
      })
      return 'ok'
    }

    try {
      await loadMessages(threadId, { force: true })
      return 'ok'
    } catch (unknownError) {
      const message = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
      error.value = message
      const result = isThreadNotFoundError(unknownError) ? 'not-found' : 'error'
      if (threadId.trim()) {
        setTurnErrorForThread(threadId, message, { transient: true })
      }
      return result
    }
  }

  async function archiveThreadById(threadId: string) {
    const wasSelectedThread = selectedThreadId.value === threadId
    const nextSelectedThreadId = wasSelectedThread
      ? findAdjacentThreadId(flattenThreads(projectGroups.value), threadId)
      : ''

    if (wasSelectedThread) {
      setSelectedThreadId(nextSelectedThreadId)
      if (nextSelectedThreadId) {
        void loadMessages(nextSelectedThreadId, { silent: true })
      }
    }

    try {
      await archiveThread(threadId)
      removeArchivedThreadFromLoadedLists(threadId)
      await loadThreads()

      if (wasSelectedThread && nextSelectedThreadId && selectedThreadId.value === nextSelectedThreadId) {
        await ensureThreadMessagesLoaded(nextSelectedThreadId, { silent: true })
      }
    } catch (unknownError) {
      error.value = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
    }
  }

  async function renameThreadById(threadId: string, threadName: string) {
    const normalizedName = threadName.trim()
    if (!threadId || !normalizedName) return

    try {
      await renameThread(threadId, normalizedName)
      threadTitleById.value = { ...threadTitleById.value, [threadId]: normalizedName }
      applyThreadFlags()
      void persistThreadTitle(threadId, normalizedName)
    } catch (unknownError) {
      error.value = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
    }
  }

  async function forkThreadById(threadId: string): Promise<string> {
    const sourceThreadId = threadId.trim()
    if (!sourceThreadId) return ''

    const sourceThread = flattenThreads(sourceGroups.value).find((row) => row.id === sourceThreadId)
    const sourceCwd = sourceThread?.cwd?.trim() ?? ''
    const sourceTitle = sourceThread?.title?.trim() ?? 'Forked chat'
    const selectedModel = readModelIdForThread(sourceThreadId)
    error.value = ''

    try {
      const forkedThread = await forkThread(sourceThreadId, sourceCwd || undefined, selectedModel || undefined)
      const nextThreadId = forkedThread.threadId.trim()
      if (!nextThreadId) return ''

      insertOptimisticThread(nextThreadId, sourceCwd, sourceTitle)
      setThreadModelId(nextThreadId, forkedThread.model)
      resumedThreadById.value = {
        ...resumedThreadById.value,
        [nextThreadId]: true,
      }
      setSelectedThreadId(nextThreadId)
      await loadThreads()
      await loadMessages(nextThreadId)
      return nextThreadId
    } catch (unknownError) {
      error.value = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
      return ''
    }
  }

  async function forkThreadFromTurn(threadId: string, turnIndex: number): Promise<string> {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId || !Number.isInteger(turnIndex) || turnIndex < 0) return ''

    if (inProgressById.value[normalizedThreadId] === true) {
      error.value = 'Finish the current turn before forking from a response.'
      return ''
    }

    if (loadedMessagesByThreadId.value[normalizedThreadId] !== true) {
      try {
        await loadMessages(normalizedThreadId)
      } catch (unknownError) {
        error.value = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
        return ''
      }
    }

    const sourceMessages = persistedMessagesByThreadId.value[normalizedThreadId] ?? []
    let lastTurnIndex = -1
    for (const message of sourceMessages) {
      if (typeof message.turnIndex === 'number' && Number.isFinite(message.turnIndex)) {
        lastTurnIndex = Math.max(lastTurnIndex, message.turnIndex)
      }
    }

    if (lastTurnIndex >= 0 && turnIndex > lastTurnIndex) return ''

    const sourceThread = flattenThreads(sourceGroups.value).find((row) => row.id === normalizedThreadId) ?? null

    try {
      error.value = ''
      const forked = await forkThread(normalizedThreadId)
      const forkedThreadId = forked.threadId.trim()
      if (!forkedThreadId) return ''

      const forkedCwd = forked.cwd.trim() || sourceThread?.cwd?.trim() || ''
      const forkedThreadTitle = toForkedThreadTitle(sourceThread?.title || sourceThread?.preview || 'Untitled thread')
      insertOptimisticThread(forkedThreadId, forkedCwd, forkedThreadTitle)
      setThreadModelId(forkedThreadId, forked.model)
      setPersistedMessagesForThread(forkedThreadId, forked.messages)
      loadedMessagesByThreadId.value = {
        ...loadedMessagesByThreadId.value,
        [forkedThreadId]: true,
      }
      resumedThreadById.value = {
        ...resumedThreadById.value,
        [forkedThreadId]: true,
      }
      clearLivePlansForThread(forkedThreadId)
      setLiveAgentMessagesForThread(forkedThreadId, [])
      clearLiveReasoningForThread(forkedThreadId)
      if (liveCommandsByThreadId.value[forkedThreadId]) {
        liveCommandsByThreadId.value = omitKey(liveCommandsByThreadId.value, forkedThreadId)
      }
      setTurnSummaryForThread(forkedThreadId, null)
      setTurnActivityForThread(forkedThreadId, null)
      setTurnErrorForThread(forkedThreadId, null)
      setThreadInProgress(forkedThreadId, false)

      const turnsToRollback = lastTurnIndex - turnIndex
      if (turnsToRollback > 0) {
        const rolledBackMessages = await rollbackThread(forkedThreadId, turnsToRollback)
        setPersistedMessagesForThread(forkedThreadId, rolledBackMessages)
      }

      await renameThreadById(forkedThreadId, forkedThreadTitle)
      setSelectedThreadId(forkedThreadId)
      void loadThreads().catch(() => {})
      return forkedThreadId
    } catch (unknownError) {
      error.value = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
      return ''
    }
  }

  async function maybeReplyToPendingUserInputRequest(
    threadId: string,
    text: string,
    imageUrls: string[] = [],
    skills: Array<{ name: string; path: string }> = [],
    fileAttachments: FileAttachment[] = [],
  ): Promise<boolean> {
    if (!threadId || !text.trim()) return false
    if (imageUrls.length > 0 || skills.length > 0 || fileAttachments.length > 0) return false

    const requests = pendingServerRequestsByThreadId.value[threadId] ?? []
    const userInputRequests = requests.filter((request) => request.method === 'item/tool/requestUserInput')
    if (userInputRequests.length !== 1) return false

    const [request] = userInputRequests
    const questionIds = readToolRequestUserInputQuestionIds(request)
    if (questionIds.length !== 1) return false

    return respondToPendingServerRequest({
      id: request.id,
      result: {
        answers: {
          [questionIds[0]]: {
            answers: [text.trim()],
          },
        },
      },
    })
  }

  async function sendMessageToSelectedThread(
    text: string,
    imageUrls: string[] = [],
    skills: Array<{ name: string; path: string }> = [],
    mode: 'steer' | 'queue' = 'steer',
    fileAttachments: FileAttachment[] = [],
    queueInsertIndex?: number,
    collaborationModeOverride?: CollaborationModeKind,
  ): Promise<void> {
    const uploadLease = createManagedUploadLease(imageUrls, fileAttachments)
    if (isUpdatingSpeedMode.value) {
      await uploadLease.release()
      return
    }

    const threadId = selectedThreadId.value
    const nextText = text.trim()
    if (!threadId) {
      await uploadLease.release()
      return
    }
    if (!nextText && imageUrls.length === 0 && fileAttachments.length === 0) {
      await uploadLease.release()
      return
    }
    if (isExternallyOwned(threadId)) {
      await enqueueExternalTextOnlyThreadMessage(
        threadId,
        nextText,
        collaborationModeOverride,
        queueInsertIndex,
      )
      await uploadLease.release()
      return
    }

    const pendingRollback = rollbackPromiseByThreadId.get(threadId)
    if (pendingRollback) {
      await pendingRollback
      if (selectedThreadId.value !== threadId) {
        await uploadLease.release()
        return
      }
      if (isExternallyOwned(threadId)) {
        await enqueueExternalTextOnlyThreadMessage(
          threadId,
          nextText,
          collaborationModeOverride,
          queueInsertIndex,
        )
        await uploadLease.release()
        return
      }
    }

    if (await maybeReplyToPendingUserInputRequest(threadId, nextText, imageUrls, skills, fileAttachments)) {
      await uploadLease.release()
      return
    }

    const isInProgress = inProgressById.value[threadId] === true

    if (isInProgress && mode === 'queue') {
      const queuedMessage = await enqueueThreadMessageDurably(
        threadId,
        nextText,
        imageUrls,
        skills,
        fileAttachments,
        collaborationModeOverride,
        queueInsertIndex,
      )
      if (queuedMessage) uploadLease.transfer()
      await uploadLease.release()
      return
    }

    if (isInProgress) {
      shouldAutoScrollOnNextAgentEvent = true
      const optimisticMessageId = appendOptimisticUserMessage(
        threadId,
        nextText,
        imageUrls,
        skills,
        fileAttachments,
      )
      const submission = beginLocalSubmission(threadId, optimisticMessageId)
      void startTurnForThread(
        threadId,
        nextText,
        imageUrls,
        skills,
        fileAttachments,
        collaborationModeOverride,
        uploadLease.transfer,
        submission,
      ).catch(async (unknownError) => {
        if (isWriterOwnershipNotIdleError(unknownError)) {
          const pendingTurnRequest = submission.pendingTurnRequest
          clearPendingStopRequest(threadId, submission.generation)
          clearLocalSubmission(threadId, submission.generation)
          releasePendingTurnRequest(threadId, pendingTurnRequest)
          removeOptimisticUserMessage(threadId, optimisticMessageId)
          const queuedMessage = await enqueueExternalTextOnlyThreadMessage(
            threadId,
            nextText,
            collaborationModeOverride,
            queueInsertIndex,
          )
          setThreadRuntimeOwnership(threadId, 'external', { externalPollDelayMs: 0 })
          setThreadInProgress(threadId, true)
          if (queuedMessage) {
            setTurnErrorForThread(threadId, null)
            error.value = ''
          }
          return
        }
        if (!isAmbiguousTurnStartError(unknownError)) {
          removeOptimisticUserMessage(threadId, optimisticMessageId)
          clearPendingStopRequest(threadId, submission.generation)
          clearLocalSubmission(threadId, submission.generation)
        }
        const errorMessage = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
        setTurnErrorForThread(threadId, errorMessage)
        error.value = errorMessage
      })
      await uploadLease.release()
      return
    }

    error.value = ''
    shouldAutoScrollOnNextAgentEvent = true
    setTurnSummaryForThread(threadId, null)
    setTurnActivityForThread(
      threadId,
      {
        label: 'Thinking',
        details: buildPendingTurnDetails(
          readModelIdForThread(threadId),
          selectedReasoningEffort.value,
          collaborationModeOverride === 'plan'
            ? 'plan'
            : collaborationModeOverride === 'default'
              ? 'default'
              : selectedCollaborationMode.value,
        ),
      },
    )
    setTurnErrorForThread(threadId, null)
    setThreadRuntimeOwnership(threadId, 'local')
    setThreadInProgress(threadId, true)
    const optimisticMessageId = appendOptimisticUserMessage(
      threadId,
      nextText,
      imageUrls,
      skills,
      fileAttachments,
    )
    const submission = beginLocalSubmission(threadId, optimisticMessageId)

    try {
      await startTurnForThread(
        threadId,
        nextText,
        imageUrls,
        skills,
        fileAttachments,
        collaborationModeOverride,
        uploadLease.transfer,
        submission,
      )
      await uploadLease.release()
    } catch (unknownError) {
      if (isWriterOwnershipNotIdleError(unknownError)) {
        const pendingTurnRequest = submission.pendingTurnRequest
        releasePendingTurnRequest(threadId, pendingTurnRequest)
        await uploadLease.release()
        clearPendingStopRequest(threadId, submission.generation)
        clearLocalSubmission(threadId, submission.generation)
        removeOptimisticUserMessage(threadId, optimisticMessageId)
        const queuedMessage = await enqueueExternalTextOnlyThreadMessage(
          threadId,
          nextText,
          collaborationModeOverride,
          queueInsertIndex,
        )
        setThreadRuntimeOwnership(threadId, 'external', { externalPollDelayMs: 0 })
        setThreadInProgress(threadId, true)
        setTurnActivityForThread(threadId, null)
        if (queuedMessage) setTurnErrorForThread(threadId, null)
        shouldAutoScrollOnNextAgentEvent = true
        if (queuedMessage) error.value = ''
        return
      }
      await uploadLease.release()
      const ambiguousStart = isAmbiguousTurnStartError(unknownError)
      shouldAutoScrollOnNextAgentEvent = ambiguousStart
      if (!ambiguousStart && !isExternallyOwned(threadId)) {
        setThreadRuntimeOwnership(threadId, 'idle')
        setThreadInProgress(threadId, false)
        setTurnActivityForThread(threadId, null)
      }
      if (!ambiguousStart) {
        removeOptimisticUserMessage(threadId, optimisticMessageId)
        clearPendingStopRequest(threadId, submission.generation)
        clearLocalSubmission(threadId, submission.generation)
      }
      const errorMessage = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
      setTurnErrorForThread(threadId, errorMessage)
      error.value = errorMessage
      throw unknownError
    }
  }

  async function sendMessageToNewThread(
    text: string,
    cwd: string,
    imageUrls: string[] = [],
    skills: Array<{ name: string; path: string }> = [],
    fileAttachments: FileAttachment[] = [],
  ): Promise<string> {
    const uploadLease = createManagedUploadLease(imageUrls, fileAttachments)
    if (isUpdatingSpeedMode.value) {
      await uploadLease.release()
      return ''
    }

    const nextText = text.trim()
    const targetCwd = cwd.trim()
    const selectedModel = readModelIdForThread(NEW_THREAD_COLLABORATION_MODE_CONTEXT).trim()
    const selectedMode = selectedCollaborationMode.value
    if (!nextText && imageUrls.length === 0 && fileAttachments.length === 0) {
      await uploadLease.release()
      return ''
    }

    const newThreadGeneration = ++nextSubmissionGeneration
    optimisticUserMessagesByThreadId.value = omitKey(
      optimisticUserMessagesByThreadId.value,
      NEW_THREAD_COLLABORATION_MODE_CONTEXT,
    )
    const pendingOptimisticMessageId = appendOptimisticUserMessage(
      NEW_THREAD_COLLABORATION_MODE_CONTEXT,
      nextText,
      imageUrls,
      skills,
      fileAttachments,
    )
    pendingNewThreadSubmission = {
      generation: newThreadGeneration,
      threadId: '',
      stopRequested: false,
    }
    isPendingNewThreadStop.value = false
    isSendingMessage.value = true
    error.value = ''
    let threadId = ''
    let optimisticThreadInserted = false
    const previousSelectedThreadId = selectedThreadId.value

    try {
      try {
        const startedThread = await startThread(targetCwd || undefined, selectedModel || undefined)
        threadId = startedThread.threadId
        setThreadModelId(threadId, startedThread.model)
        setThreadModelProviderId(threadId, startedThread.modelProvider || activeProviderId.value)
        setSelectedCollaborationModeForThread(threadId, selectedMode)
      } catch (unknownError) {
        if (selectedModel && selectedModel !== MODEL_FALLBACK_ID && isUnsupportedChatGptModelError(unknownError)) {
          await applyFallbackModelSelection()
          const fallbackThread = await startThread(targetCwd || undefined, MODEL_FALLBACK_ID)
          threadId = fallbackThread.threadId
          setThreadModelId(threadId, fallbackThread.model)
          setThreadModelProviderId(threadId, fallbackThread.modelProvider || activeProviderId.value)
          setSelectedCollaborationModeForThread(threadId, selectedMode)
        } else {
          throw unknownError
        }
      }
      if (!threadId) {
        removeOptimisticUserMessage(
          NEW_THREAD_COLLABORATION_MODE_CONTEXT,
          pendingOptimisticMessageId,
        )
        await uploadLease.release()
        if (pendingNewThreadSubmission?.generation === newThreadGeneration) {
          pendingNewThreadSubmission = null
          isPendingNewThreadStop.value = false
        }
        isSendingMessage.value = false
        return ''
      }

      insertOptimisticThread(threadId, targetCwd, nextText || '[Image]')
      optimisticThreadInserted = true
      const optimisticMessageId = moveOptimisticUserMessage(
        NEW_THREAD_COLLABORATION_MODE_CONTEXT,
        threadId,
        pendingOptimisticMessageId,
      )
      const submission = beginLocalSubmission(threadId, optimisticMessageId)
      blockInterruptUntilThreadIsPersisted(threadId)
      resumedThreadById.value = {
        ...resumedThreadById.value,
        [threadId]: true,
      }
      setSelectedThreadId(threadId)
      shouldAutoScrollOnNextAgentEvent = true
      setTurnSummaryForThread(threadId, null)
      setTurnActivityForThread(
        threadId,
        {
          label: 'Thinking',
          details: buildPendingTurnDetails(
            readModelIdForThread(threadId),
            selectedReasoningEffort.value,
            selectedMode,
          ),
        },
      )
      setTurnErrorForThread(threadId, null)
      setThreadRuntimeOwnership(threadId, 'local')
      setThreadInProgress(threadId, true)
      if (pendingNewThreadSubmission?.generation === newThreadGeneration) {
        pendingNewThreadSubmission.threadId = threadId
        if (pendingNewThreadSubmission.stopRequested) {
          pendingNewThreadSubmission = null
          isPendingNewThreadStop.value = false
          isSendingMessage.value = false
          clearLocalSubmission(threadId, submission.generation)
          setThreadRuntimeOwnership(threadId, 'idle')
          setThreadInProgress(threadId, false)
          setTurnActivityForThread(threadId, null)
          await uploadLease.release()
          return threadId
        }
      }
      const capturedThreadId = threadId
      const capturedCwd = targetCwd || null
      const capturedPrompt = nextText
      await startTurnForThread(
        threadId,
        nextText,
        imageUrls,
        skills,
        fileAttachments,
        selectedMode,
        uploadLease.transfer,
        submission,
      )
      await uploadLease.release()
      void requestThreadTitleGeneration(capturedThreadId, capturedPrompt, capturedCwd)
      if (pendingNewThreadSubmission?.generation === newThreadGeneration) {
        pendingNewThreadSubmission = null
        isPendingNewThreadStop.value = false
      }
      isSendingMessage.value = false
      return threadId
    } catch (unknownError) {
      await uploadLease.release()
      const ambiguousStart = threadId
        && optimisticThreadInserted
        && isAmbiguousTurnStartError(unknownError)
      if (ambiguousStart) {
        const errorMessage = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
        setTurnErrorForThread(threadId, errorMessage, { transient: true })
        error.value = errorMessage
        if (pendingNewThreadSubmission?.generation === newThreadGeneration) {
          pendingNewThreadSubmission = null
          isPendingNewThreadStop.value = false
        }
        void requestThreadTitleGeneration(threadId, nextText, targetCwd || null)
        isSendingMessage.value = false
        return threadId
      }
      shouldAutoScrollOnNextAgentEvent = false
      if (threadId && optimisticThreadInserted) {
        rollbackOptimisticNewThread(threadId, previousSelectedThreadId)
        clearPendingStopRequest(threadId)
        clearLocalSubmission(threadId)
      } else if (threadId) {
        setThreadRuntimeOwnership(threadId, 'idle')
        setThreadInProgress(threadId, false)
        setTurnActivityForThread(threadId, null)
      }
      removeOptimisticUserMessage(
        NEW_THREAD_COLLABORATION_MODE_CONTEXT,
        pendingOptimisticMessageId,
      )
      if (pendingNewThreadSubmission?.generation === newThreadGeneration) {
        pendingNewThreadSubmission = null
        isPendingNewThreadStop.value = false
      }
      const errorMessage = unknownError instanceof Error ? unknownError.message : 'Unknown application error'
      if (threadId && !optimisticThreadInserted) {
        setTurnErrorForThread(threadId, errorMessage)
      }
      error.value = errorMessage
      isSendingMessage.value = false
      throw unknownError
    }
  }

  async function startTurnForThread(
    threadId: string,
    nextText: string,
    imageUrls: string[] = [],
    skills: Array<{ name: string; path: string }> = [],
    fileAttachments: FileAttachment[] = [],
    collaborationModeOverride?: CollaborationModeKind,
    onPendingTurnEstablished?: () => void,
    submission?: LocalSubmissionState,
  ): Promise<void> {
    const requestedModelId = readModelIdForThread(threadId)
    const reasoningEffort = readReasoningEffortForThread(threadId)
    const collaborationMode = collaborationModeOverride === 'plan' ? 'plan' : collaborationModeOverride === 'default'
      ? 'default'
      : selectedCollaborationMode.value
    const normalizedText = nextText.trim()
    const normalizedImageUrls = [...imageUrls]
    if (
      normalizedImageUrls.length === 0
      && shouldReuseAttachedImageFromPrompt(normalizedText)
    ) {
      const latestAttachedImageUrl = findLatestUserLocalImageUrl(threadId)
      if (latestAttachedImageUrl) {
        normalizedImageUrls.push(latestAttachedImageUrl)
      }
    }
    const normalizedSkills = skills.map((skill) => ({ name: skill.name, path: skill.path }))
    const normalizedFileAttachments = fileAttachments.map((file) => ({ ...file }))

    setPendingTurnRequest(threadId, {
      text: normalizedText,
      imageUrls: [...normalizedImageUrls],
      skills: normalizedSkills,
      fileAttachments: normalizedFileAttachments,
      effort: reasoningEffort,
      collaborationMode,
      fallbackRetried: false,
    }, submission)
    onPendingTurnEstablished?.()

    try {
      if (resumedThreadById.value[threadId] !== true) {
        const resumedThread = await resumeThread(threadId)
        requireIdleResumeForUserTurn(threadId, resumedThread)
        if (resumedThread.model && !requestedModelId) {
          setThreadModelId(threadId, resolveThreadModelForProvider(threadId, resumedThread.model, resumedThread.modelProvider))
        }
        if (resumedThread.modelProvider) {
          setThreadModelProviderId(threadId, resumedThread.modelProvider)
        }
        resumedThreadById.value = {
          ...resumedThreadById.value,
          [threadId]: true,
        }
      }
      const modelId = requestedModelId || readModelIdForThread(threadId)

      if (submission && cancelSubmissionBeforeTurnStart(threadId, submission)) {
        return
      }
      if (submission) {
        submission.turnStartIssued = true
      }
      let startedTurnId = ''
      try {
        startedTurnId = await startThreadTurn(
          threadId,
          nextText,
          normalizedImageUrls,
          modelId || undefined,
          reasoningEffort || undefined,
          skills.length > 0 ? skills : undefined,
          fileAttachments,
          collaborationMode,
        )
      } catch (unknownError) {
        if (modelId && modelId !== MODEL_FALLBACK_ID && isUnsupportedChatGptModelError(unknownError)) {
          await applyFallbackModelSelection(threadId)
          setPendingTurnRequest(threadId, {
            text: normalizedText,
            imageUrls: [...normalizedImageUrls],
            skills: normalizedSkills,
            fileAttachments: normalizedFileAttachments,
            effort: reasoningEffort,
            collaborationMode,
            fallbackRetried: true,
          }, submission)
          startedTurnId = await startThreadTurn(
            threadId,
            nextText,
            normalizedImageUrls,
            MODEL_FALLBACK_ID,
            reasoningEffort || undefined,
            skills.length > 0 ? skills : undefined,
            fileAttachments,
            collaborationMode,
          )
        } else {
          throw unknownError
        }
      }

      const currentSubmission = localSubmissionByThreadId.get(threadId)
      const canAdoptStartedTurn = !submission
        || currentSubmission?.generation === submission.generation
      if (startedTurnId && canAdoptStartedTurn) {
        activeTurnIdByThreadId.value = {
          ...activeTurnIdByThreadId.value,
          [threadId]: startedTurnId,
        }
        setThreadRuntimeOwnership(threadId, 'local')
        maybeUnblockInterruptForActiveTurn(threadId, startedTurnId)
        void consumePendingStopForTurn(threadId, startedTurnId)
      }

      pendingThreadMessageRefresh.add(threadId)
      await syncFromNotifications()
      scheduleDelayedTurnSync(threadId)
    } catch (unknownError) {
      if (!isAmbiguousTurnStartError(unknownError) && !isWriterOwnershipNotIdleError(unknownError)) {
        if (submission) {
          releasePendingTurnRequest(threadId, submission.pendingTurnRequest)
        } else {
          releasePendingTurnRequest(threadId)
        }
      }
      throw unknownError
    }
  }

  async function processQueuedMessages(
    threadId: string,
    scheduledMutationVersion = queueMutationVersion,
  ): Promise<void> {
    const refreshRequestVersion = ++queueRefreshRequestVersion
    if (queueMutationVersion !== scheduledMutationVersion) return
    if ((pendingQueueAppendMessageIdsByThreadId.get(threadId)?.size ?? 0) > 0) {
      queueRefreshDuringPendingAppendThreadIds.add(threadId)
    }
    if (queueProcessingByThreadId.value[threadId] === true) {
      pendingQueueRefreshThreadIds.add(threadId)
      return
    }
    queueProcessingByThreadId.value = {
      ...queueProcessingByThreadId.value,
      [threadId]: true,
    }
    const mutationVersionAtStart = queueMutationVersion
    try {
      const snapshot = await getThreadQueueSnapshot()
      if (queueRefreshRequestVersion !== refreshRequestVersion) {
        pendingQueueRefreshThreadIds.add(threadId)
      } else if (
        queueMutationVersion === mutationVersionAtStart
        && snapshot.revision >= latestQueueRevision
      ) {
        queuedMessagesByThreadId.value = mergePendingQueueAppends(snapshot.state)
        latestQueueRevision = snapshot.revision
      } else {
        pendingQueueRefreshThreadIds.add(threadId)
      }
    } catch {
      // Backend queue state is optional during transient bridge failures.
    } finally {
      queueProcessingByThreadId.value = omitKey(queueProcessingByThreadId.value, threadId)
      if (pendingQueueRefreshThreadIds.delete(threadId)) {
        void processQueuedMessages(threadId)
      }
    }
  }

  function scheduleQueueStateRefresh(threadId: string): void {
    const scheduledMutationVersion = queueMutationVersion
    void processQueuedMessages(threadId, scheduledMutationVersion)
    if (typeof window === 'undefined') return
    window.setTimeout(() => {
      void processQueuedMessages(threadId)
    }, 650)
  }

  function getInterruptibleTurnFromDetail(detail: ThreadDetailSnapshot): {
    turnId: string
    ownership: 'local' | 'external'
  } | null {
    const detailTurnId = detail.activeTurnId.trim()
    if (
      detail.inProgress !== true ||
      detailTurnId.length === 0
    ) {
      return null
    }
    if (detail.canInterrupt === true && detail.ownership === 'local') {
      return { turnId: detailTurnId, ownership: 'local' }
    }
    if (detail.canInterrupt === true && detail.ownership === 'external') {
      return { turnId: detailTurnId, ownership: 'external' }
    }
    return null
  }

  function getExternalProbeTurnFromDetail(detail: ThreadDetailSnapshot): {
    turnId: string
    ownership: 'external'
    canInterrupt: boolean
  } | null {
    const detailTurnId = detail.activeTurnId.trim()
    if (
      detail.inProgress !== true ||
      detail.ownership !== 'external' ||
      detailTurnId.length === 0
    ) {
      return null
    }
    return {
      turnId: detailTurnId,
      ownership: 'external',
      canInterrupt: detail.canInterrupt === true,
    }
  }

  async function reconcileMissingInterruptTarget(
    threadId: string,
    options: { allowExternalProbe?: boolean } = {},
  ): Promise<{
    idle: boolean
    turnId: string
    ownership?: 'local' | 'external'
    canInterrupt?: boolean
  }> {
    const detailRequest = acquireThreadDetailRequest(threadId, () => getThreadDetail(threadId))
    try {
      const detail = await detailRequest.promise
      if (
        selectedThreadId.value !== threadId ||
        !isCurrentThreadDetailEpoch(threadId, detailRequest.epoch)
      ) {
        return { idle: false, turnId: '' }
      }
      reconcileThreadDetailSnapshot(threadId, detail, {
        preserveMissing: true,
        markRead: true,
        requestedVersion: '',
        detailEpoch: detailRequest.epoch,
        allowIdleLocalLeaseRelease: true,
      })
      const refreshedTurn = getInterruptibleTurnFromDetail(detail)
      if (refreshedTurn) {
        activeTurnIdByThreadId.value = {
          ...activeTurnIdByThreadId.value,
          [threadId]: refreshedTurn.turnId,
        }
        setThreadRuntimeOwnership(threadId, refreshedTurn.ownership, { canInterrupt: true })
        setThreadInProgress(threadId, true)
        return {
          idle: false,
          turnId: refreshedTurn.turnId,
          ownership: refreshedTurn.ownership,
          canInterrupt: true,
        }
      }
      const externalProbeTurn = options.allowExternalProbe
        ? getExternalProbeTurnFromDetail(detail)
        : null
      if (externalProbeTurn) {
        activeTurnIdByThreadId.value = {
          ...activeTurnIdByThreadId.value,
          [threadId]: externalProbeTurn.turnId,
        }
        setThreadRuntimeOwnership(threadId, 'external', {
          externalPollDelayMs: 0,
          canInterrupt: externalProbeTurn.canInterrupt,
        })
        setThreadInProgress(threadId, true)
        return {
          idle: false,
          turnId: externalProbeTurn.turnId,
          ownership: 'external',
          canInterrupt: externalProbeTurn.canInterrupt,
        }
      }
      return { idle: detail.inProgress !== true, turnId: '' }
    } catch {
      return { idle: false, turnId: '' }
    } finally {
      releaseThreadDetailRequest(threadId, detailRequest)
    }
  }

  async function interruptSelectedThreadTurn(): Promise<void> {
    const threadId = selectedThreadId.value
    if (!threadId) return
    if (inProgressById.value[threadId] !== true) return
    let turnId = activeTurnIdByThreadId.value[threadId]
    if (turnId) {
      const ownership = runtimeOwnershipByThreadId.value[threadId] ?? 'idle'
      const hasConfirmedExternalInterrupt =
        ownership === 'external' &&
        runtimeCanInterruptByThreadId.value[threadId] === true
      if (ownership !== 'local' && !hasConfirmedExternalInterrupt) {
        const reconciled = await reconcileMissingInterruptTarget(threadId)
        if (reconciled.idle) {
          error.value = ''
          return
        }
        if (!reconciled.turnId) return
        turnId = reconciled.turnId
      }
    } else {
      const submission = localSubmissionByThreadId.get(threadId)
      if (submission) {
        const pendingStop = ensurePendingStopRequest(threadId, submission.generation)
        return pendingStop.promise
      }
      const fallbackGeneration = externalRuntimeGeneration
      const activeTurnIdAtFallbackStart = activeTurnIdByThreadId.value[threadId] ?? ''
      const detailRequest = acquireThreadDetailRequest(threadId, () => getThreadDetail(threadId))
      let detail: ThreadDetailSnapshot | null = null
      try {
        detail = await detailRequest.promise
        if (
          selectedThreadId.value !== threadId ||
          !isCurrentThreadDetailEpoch(threadId, detailRequest.epoch) ||
          (activeTurnIdByThreadId.value[threadId] ?? '') !== activeTurnIdAtFallbackStart
        ) {
          return
        }
        reconcileThreadDetailSnapshot(threadId, detail, {
          preserveMissing: true,
          markRead: true,
          requestedVersion: '',
          detailEpoch: detailRequest.epoch,
          allowIdleLocalLeaseRelease: true,
        })
      } finally {
        releaseThreadDetailRequest(threadId, detailRequest)
      }
      if (!detail) return
      const fallbackTurn = getInterruptibleTurnFromDetail(detail)
      const canUseFallback =
        fallbackTurn !== null &&
        (fallbackTurn.ownership !== 'external' || externalRuntimeGeneration === fallbackGeneration) &&
        selectedThreadId.value === threadId &&
        inProgressById.value[threadId] === true &&
        !activeTurnIdAtFallbackStart.trim()
      if (!canUseFallback) return

      turnId = fallbackTurn.turnId
      activeTurnIdByThreadId.value = {
        ...activeTurnIdByThreadId.value,
        [threadId]: turnId,
      }
      setThreadRuntimeOwnership(threadId, fallbackTurn.ownership, { canInterrupt: true })
    }
    if (!turnId) {
      throw new Error('Could not determine active turn id for interrupt')
    }

    const submission = localSubmissionByThreadId.get(threadId)
    if (submission) {
      const pendingStop = ensurePendingStopRequest(threadId, submission.generation)
      void consumePendingStopForTurn(threadId, turnId)
      return pendingStop.promise
    }

    isInterruptingTurn.value = true
    error.value = ''
    try {
      const ownership = runtimeOwnershipByThreadId.value[threadId] ?? 'idle'
      await interruptThreadTurn(threadId, turnId, ownership === 'external' ? 'external' : 'local')
      pendingThreadMessageRefresh.add(threadId)
      pendingThreadsRefresh = true
      await syncFromNotifications()
    } catch (unknownError) {
      let errorToReport = unknownError
      if (isRecoverableInterruptTargetError(unknownError)) {
        const reconciled = await reconcileMissingInterruptTarget(threadId, {
          allowExternalProbe: isThreadNotFoundInterruptError(unknownError),
        })
        if (reconciled.idle) {
          error.value = ''
          return
        }
        if (reconciled.turnId) {
          try {
            const ownership = reconciled.ownership ?? runtimeOwnershipByThreadId.value[threadId] ?? 'idle'
            await interruptThreadTurn(threadId, reconciled.turnId, ownership === 'external' ? 'external' : 'local')
            pendingThreadMessageRefresh.add(threadId)
            pendingThreadsRefresh = true
            await syncFromNotifications()
            return
          } catch (retryError) {
            errorToReport = retryError
          }
        }
      }
      const errorMessage = errorToReport instanceof Error ? errorToReport.message : 'Failed to interrupt active turn'
      setTurnErrorForThread(threadId, errorMessage)
      error.value = errorMessage
    } finally {
      isInterruptingTurn.value = false
    }
  }

  function interruptPendingNewThreadSubmission(): void {
    const pending = pendingNewThreadSubmission
    if (!pending) return
    pending.stopRequested = true
    isPendingNewThreadStop.value = true
    if (!pending.threadId) return

    const submission = localSubmissionByThreadId.get(pending.threadId)
    if (!submission) return
    ensurePendingStopRequest(pending.threadId, submission.generation)
    const turnId = activeTurnIdByThreadId.value[pending.threadId]
    if (turnId) {
      void consumePendingStopForTurn(pending.threadId, turnId)
    }
  }

  async function rollbackSelectedThread(turnId: string): Promise<void> {
    const threadId = selectedThreadId.value
    if (!threadId || isExternallyOwned(threadId)) return
    if (isRollingBack.value) return
    if (!turnId.trim()) return

    const persisted = persistedMessagesByThreadId.value[threadId] ?? []
    const matchedMessage = persisted.find((message) => message.turnId === turnId)
    const turnIndex = typeof matchedMessage?.turnIndex === 'number' ? matchedMessage.turnIndex : -1
    if (turnIndex < 0) return
    const maxTurnIndex = persisted.reduce((max, m) => (typeof m.turnIndex === 'number' && m.turnIndex > max ? m.turnIndex : max), -1)
    if (maxTurnIndex < 0 || turnIndex > maxTurnIndex) return
    const numTurns = maxTurnIndex - turnIndex + 1
    if (numTurns < 1) return

    isRollingBack.value = true
    error.value = ''
    const rollbackPromise = (async () => {
      try {
        const threadCwd = selectedThread.value?.cwd?.trim() ?? ''
        if (threadCwd) {
          await revertThreadFileChanges(threadId, turnId, threadCwd)
        }
        const nextMessages = await rollbackThread(threadId, numTurns)
        setPersistedMessagesForThread(threadId, nextMessages)
        setLiveAgentMessagesForThread(threadId, [])
        clearLiveReasoningForThread(threadId)
        if (liveCommandsByThreadId.value[threadId]) {
          liveCommandsByThreadId.value = omitKey(liveCommandsByThreadId.value, threadId)
        }
        setTurnSummaryForThread(threadId, null)
        setTurnActivityForThread(threadId, null)
        setTurnErrorForThread(threadId, null)
        pendingThreadsRefresh = true
        await syncFromNotifications()
      } catch (unknownError) {
        error.value = unknownError instanceof Error ? unknownError.message : 'Failed to rollback thread'
      }
    })()
    rollbackPromiseByThreadId.set(threadId, rollbackPromise)
    try {
      await rollbackPromise
    } finally {
      if (rollbackPromiseByThreadId.get(threadId) === rollbackPromise) {
        rollbackPromiseByThreadId.delete(threadId)
      }
      isRollingBack.value = false
    }
  }

  let renameProjectTimer: ReturnType<typeof setTimeout> | null = null

  async function persistProjectLabelToGlobalState(projectName: string, displayName: string): Promise<void> {
    try {
      const rootsState = await getWorkspaceRootsState()
      const nextLabels = { ...rootsState.labels }
      let changed = false
      for (const rootPath of rootsState.order) {
        if (!matchesWorkspaceRootProject(rootPath, projectName)) continue
        const trimmed = displayName.trim()
        if (trimmed.length === 0) {
          if (nextLabels[rootPath] !== undefined) {
            delete nextLabels[rootPath]
            changed = true
          }
        } else if (nextLabels[rootPath] !== trimmed) {
          nextLabels[rootPath] = trimmed
          changed = true
        }
      }
      if (changed) {
        await setWorkspaceRootsState({
          order: rootsState.order,
          labels: nextLabels,
          active: rootsState.active,
          projectOrder: rootsState.projectOrder,
        })
      }
    } catch {
      // Keep localStorage-only rename when global state is unavailable.
    }
  }

  function renameProject(projectName: string, displayName: string): void {
    if (projectName.length === 0) return

    const currentValue = projectDisplayNameById.value[projectName] ?? ''
    if (currentValue === displayName) return

    projectDisplayNameById.value = {
      ...projectDisplayNameById.value,
      [projectName]: displayName,
    }
    saveProjectDisplayNames(projectDisplayNameById.value)

    if (renameProjectTimer !== null) clearTimeout(renameProjectTimer)
    renameProjectTimer = setTimeout(() => {
      renameProjectTimer = null
      void persistProjectLabelToGlobalState(projectName, displayName)
    }, 500)
  }

  async function removeProject(projectName: string): Promise<void> {
    if (projectName.length === 0) return

    const nextProjectOrder = projectOrder.value.filter((name) => name !== projectName)
    if (!areStringArraysEqual(projectOrder.value, nextProjectOrder)) {
      projectOrder.value = nextProjectOrder
      saveProjectOrder(projectOrder.value)
    }

    sourceGroups.value = sourceGroups.value.filter((group) => group.projectName !== projectName)

    if (projectDisplayNameById.value[projectName] !== undefined) {
      const nextDisplayNames = { ...projectDisplayNameById.value }
      delete nextDisplayNames[projectName]
      projectDisplayNameById.value = nextDisplayNames
      saveProjectDisplayNames(nextDisplayNames)
    }

    applyThreadFlags()

    const flatThreads = flattenThreads(projectGroups.value)
    pruneThreadScopedState(flatThreads)

    const currentExists = flatThreads.some((thread) => thread.id === selectedThreadId.value)
    if (!currentExists) {
      setSelectedThreadId(flatThreads[0]?.id ?? '')
    }

    const removedRootPaths = new Set<string>()
    try {
      const rootsState = await getWorkspaceRootsState()
      collectWorkspaceRootPathsForProjectRemoval(rootsState, projectName).forEach((rootPath) => {
        removedRootPaths.add(rootPath)
      })
    } catch {
      // Keep local-only removal when global state is unavailable.
    }

    if (removedRootPaths.size > 0) {
      try {
        const rootsState = await getWorkspaceRootsState()
        const nextOrder = rootsState.order.filter((rootPath) => !removedRootPaths.has(rootPath))
        const nextActive = rootsState.active.filter((rootPath) => !removedRootPaths.has(rootPath))
        const fallbackActive = nextActive.length === 0 && nextOrder.length > 0
          ? [nextOrder[0]]
          : nextActive
        await setWorkspaceRootsState({
          order: nextOrder,
          labels: omitKeys(rootsState.labels, removedRootPaths),
          active: fallbackActive,
          projectOrder: rootsState.projectOrder.filter((item) => item !== projectName && !removedRootPaths.has(item)),
        })
        return
      } catch {
        // Fall back to order-only persistence if direct removal fails.
      }
    }

    await persistProjectOrderToWorkspaceRoots()
  }

  function reorderProject(projectName: string, toIndex: number): void {
    if (projectName.length === 0) return
    if (sourceGroups.value.length === 0) return

    const visibleOrder = sourceGroups.value.map((group) => group.projectName)
    const fromIndex = visibleOrder.indexOf(projectName)
    if (fromIndex === -1) return

    const clampedToIndex = Math.max(0, Math.min(toIndex, visibleOrder.length - 1))
    const reorderedVisibleOrder = reorderStringArray(visibleOrder, fromIndex, clampedToIndex)
    if (reorderedVisibleOrder === visibleOrder) return

    const normalizedProjectOrder = mergeProjectOrder(reorderedVisibleOrder, sourceGroups.value)
    projectOrder.value = normalizedProjectOrder
    saveProjectOrder(projectOrder.value)

    const orderedGroups = orderGroupsByProjectOrder(sourceGroups.value, projectOrder.value)
    sourceGroups.value = mergeThreadGroups(sourceGroups.value, orderedGroups)
    applyThreadFlags()
    void persistProjectOrderToWorkspaceRoots()
  }

  function pinProjectToTop(projectName: string): void {
    const normalizedName = projectName.trim()
    if (!normalizedName) return
    const nextOrder = [normalizedName, ...projectOrder.value.filter((name) => name !== normalizedName)]
    if (areStringArraysEqual(projectOrder.value, nextOrder)) return
    projectOrder.value = nextOrder
    saveProjectOrder(projectOrder.value)

    const orderedGroups = orderGroupsByProjectOrder(sourceGroups.value, projectOrder.value)
    sourceGroups.value = mergeThreadGroups(sourceGroups.value, orderedGroups)
    applyThreadFlags()
    void persistProjectOrderToWorkspaceRoots()
  }

  async function persistProjectOrderToWorkspaceRoots(): Promise<void> {
    try {
      const rootsState = await getWorkspaceRootsState()
      const nextState = buildWorkspaceRootsProjectOrderState(rootsState, projectOrder.value, sourceGroups.value)

      await setWorkspaceRootsState({
        order: nextState.order,
        labels: rootsState.labels,
        active: nextState.active,
        projectOrder: nextState.projectOrder,
      })
    } catch {
      // Keep local project order when global state persistence is unavailable.
    }
  }

  async function syncThreadStatus(): Promise<void> {
    if (isPolling.value) return
    isPolling.value = true

    try {
      const selectedBeforeList = selectedThreadId.value
      if (selectedBeforeList) {
        const currentVersion = currentThreadVersion(selectedBeforeList)
        const loadedVersion = loadedVersionByThreadId.value[selectedBeforeList] ?? ''
        const hasVersionChange = currentVersion.length > 0 && currentVersion !== loadedVersion
        const isInProgress = inProgressById.value[selectedBeforeList] === true

        if (isInProgress || hasVersionChange) {
          await loadMessages(selectedBeforeList, {
            silent: true,
            bypassRecentReuse: hasVersionChange,
          })
        }
      }

      await loadThreads()

      if (!selectedThreadId.value) return

      const threadId = selectedThreadId.value
      const currentVersion = currentThreadVersion(threadId)
      const loadedVersion = loadedVersionByThreadId.value[threadId] ?? ''
      const hasVersionChange = currentVersion.length > 0 && currentVersion !== loadedVersion
      const isInProgress = inProgressById.value[threadId] === true

      if (isInProgress || hasVersionChange) {
        await loadMessages(threadId, {
          silent: true,
          bypassRecentReuse: hasVersionChange,
        })
      }
    } catch {
      // ignore poll failures and keep last known state
    } finally {
      isPolling.value = false
    }
  }

  async function refreshRuntimeStatesForChangedThreads(threadIds: ReadonlySet<string>): Promise<void> {
    const loadedIds = new Set(flattenThreads(sourceGroups.value).map((thread) => thread.id))
    const selectedId = selectedThreadId.value
    const requestedThreadIds = Array.from(threadIds)
      .filter((threadId) => threadId && (
        loadedIds.has(threadId) ||
        (threadId === selectedId && loadedMessagesByThreadId.value[threadId] === true)
      ))
      .slice(0, BACKGROUND_RUNTIME_BATCH_LIMIT)
    if (requestedThreadIds.length === 0) return

    let states: Awaited<ReturnType<typeof getThreadRuntimeStates>>
    try {
      states = await getThreadRuntimeStates(requestedThreadIds)
    } catch {
      return
    }

    for (const threadId of requestedThreadIds) {
      const runtime = states[threadId] ?? { state: 'unknown' }
      if (runtime.state === 'unknown') continue
      const isSelectedNow = selectedThreadId.value === threadId

      if (runtime.state === 'running' && isKnownTerminalTurnRuntime(threadId, runtime.turnId)) {
        backgroundExternalThreadIds.delete(threadId)
        setThreadRuntimeOwnership(threadId, 'idle', { canInterrupt: false })
        setThreadInProgress(threadId, false)
        setLoadedThreadMetadataInProgress(threadId, false)
        continue
      }

      if (runtime.state === 'running' && runtime.source === 'local-app-server') {
        activeTurnIdByThreadId.value = {
          ...activeTurnIdByThreadId.value,
          [threadId]: runtime.turnId,
        }
        backgroundExternalThreadIds.delete(threadId)
        setThreadRuntimeOwnership(threadId, 'local')
        setThreadInProgress(threadId, true)
        continue
      }

      if (runtime.state === 'running') {
        activeTurnIdByThreadId.value = {
          ...activeTurnIdByThreadId.value,
          [threadId]: runtime.turnId,
        }
        if (!isSelectedNow) backgroundExternalThreadIds.add(threadId)
        setThreadRuntimeOwnership(threadId, 'external', {
          externalPollDelayMs: isSelectedNow ? 0 : undefined,
          canInterrupt: runtime.interruptible === true,
        })
        setThreadInProgress(threadId, true)
        continue
      }

      if (runtime.state === 'idle') {
        backgroundExternalThreadIds.delete(threadId)
        if (!isSelectedNow) clearCompletedTurnLiveState(threadId)
        setThreadRuntimeOwnership(threadId, 'idle')
        setThreadInProgress(threadId, false)
        setTurnActivityForThread(threadId, null)
      }
    }
  }

  async function syncFromNotifications(): Promise<void> {
    if (isPolling.value) {
      if (typeof window !== 'undefined' && eventSyncTimer === null) {
        eventSyncTimer = window.setTimeout(() => {
          eventSyncTimer = null
          void syncFromNotifications()
        }, EVENT_SYNC_DEBOUNCE_MS)
      }
      return
    }

    isPolling.value = true

    const shouldRefreshThreads = pendingThreadsRefresh
    const shouldForceThreadRefresh = pendingThreadsRefreshForce
    const threadIdsToRefresh = new Set(pendingThreadMessageRefresh)
    const runtimeThreadIdsToRefresh = new Set(pendingThreadRuntimeRefresh)
    const activeTextNewestThreadIdsToRefresh = new Set(pendingActiveTextNewestRefresh)
    const activeTextNewestTurnIdsByThreadId = new Map(pendingActiveTextNewestTurnIdByThreadId)
    pendingThreadsRefresh = false
    pendingThreadsRefreshForce = false
    pendingThreadMessageRefresh.clear()
    pendingThreadRuntimeRefresh.clear()
    pendingActiveTextNewestRefresh.clear()
    pendingActiveTextNewestTurnIdByThreadId.clear()

    let activeThreadLoadBeforeList: Promise<void> | null = null
    let activeThreadLoadBeforeListThreadId = ''
    let activeThreadLoadBeforeListSucceeded = false

    try {
      const activeThreadIdBeforeList = selectedThreadId.value
      if (activeThreadIdBeforeList) {
        const isActiveDirty = threadIdsToRefresh.has(activeThreadIdBeforeList)
        const needsActiveTextNewest = activeTextNewestThreadIdsToRefresh.has(activeThreadIdBeforeList)
        const activeTextTurnId = activeTurnIdByThreadId.value[activeThreadIdBeforeList]
          || activeTextNewestTurnIdsByThreadId.get(activeThreadIdBeforeList)
          || ''
        const isInProgress = inProgressById.value[activeThreadIdBeforeList] === true
        const currentVersion = currentThreadVersion(activeThreadIdBeforeList)
        const loadedVersion = loadedVersionByThreadId.value[activeThreadIdBeforeList] ?? ''
        const hasVersionChange = currentVersion.length > 0 && currentVersion !== loadedVersion

        const shouldRefreshActiveThread =
          hasVersionChange ||
          isActiveDirty ||
          (needsActiveTextNewest && !activeTextTurnId) ||
          (isInProgress && loadedMessagesByThreadId.value[activeThreadIdBeforeList] !== true) ||
          (shouldRefreshThreads && loadedMessagesByThreadId.value[activeThreadIdBeforeList] !== true)

        if (shouldRefreshActiveThread) {
          activeThreadLoadBeforeListThreadId = activeThreadIdBeforeList
          activeThreadLoadBeforeList = loadMessages(activeThreadIdBeforeList, {
            silent: true,
            bypassRecentReuse: hasVersionChange || isActiveDirty,
          })
            .then(() => {
              activeThreadLoadBeforeListSucceeded = true
            })
            .catch(() => {
              // Keep thread-list/event reconciliation moving even if active detail is slow or fails.
            })
        }
      }

      if (shouldRefreshThreads) {
        await loadThreads({ force: shouldForceThreadRefresh })
      }

      if (activeThreadLoadBeforeList) {
        await activeThreadLoadBeforeList
        if (activeThreadLoadBeforeListSucceeded && activeThreadLoadBeforeListThreadId) {
          threadIdsToRefresh.delete(activeThreadLoadBeforeListThreadId)
        }
      }
      refreshSelectedActiveTextNewest(
        activeTextNewestThreadIdsToRefresh,
        activeTextNewestTurnIdsByThreadId,
      )

      await refreshRuntimeStatesForChangedThreads(runtimeThreadIdsToRefresh)

      const activeThreadId = selectedThreadId.value
      if (!activeThreadId) return

      const isActiveDirty = threadIdsToRefresh.has(activeThreadId)
      const needsActiveTextNewest = activeTextNewestThreadIdsToRefresh.has(activeThreadId)
      const activeTextTurnId = activeTurnIdByThreadId.value[activeThreadId]
        || activeTextNewestTurnIdsByThreadId.get(activeThreadId)
        || ''
      const isInProgress = inProgressById.value[activeThreadId] === true
      const currentVersion = currentThreadVersion(activeThreadId)
      const loadedVersion = loadedVersionByThreadId.value[activeThreadId] ?? ''
      const hasVersionChange = currentVersion.length > 0 && currentVersion !== loadedVersion

      const shouldRefreshActiveThread =
        hasVersionChange ||
        isActiveDirty ||
        (needsActiveTextNewest && !activeTextTurnId) ||
        (isInProgress && loadedMessagesByThreadId.value[activeThreadId] !== true) ||
        (shouldRefreshThreads && loadedMessagesByThreadId.value[activeThreadId] !== true)

      if (shouldRefreshActiveThread) {
        await loadMessages(activeThreadId, {
          silent: true,
          bypassRecentReuse: hasVersionChange || isActiveDirty,
        })
      }
      refreshSelectedActiveTextNewest(
        activeTextNewestThreadIdsToRefresh,
        activeTextNewestTurnIdsByThreadId,
      )
    } catch {
      // Keep UI stable on transient event sync failures.
    } finally {
      isPolling.value = false

      if (
        (
          pendingThreadsRefresh ||
          pendingThreadMessageRefresh.size > 0 ||
          pendingThreadRuntimeRefresh.size > 0 ||
          pendingActiveTextNewestRefresh.size > 0
        ) &&
        typeof window !== 'undefined' &&
        eventSyncTimer === null
      ) {
        eventSyncTimer = window.setTimeout(() => {
          eventSyncTimer = null
          void syncFromNotifications()
        }, EVENT_SYNC_DEBOUNCE_MS)
      }
    }
  }

  async function recoverBridgeState(): Promise<void> {
    await loadPendingServerRequestsFromBridge()
    pendingThreadsRefresh = !hasLoadedThreads.value
    if (
      selectedThreadId.value &&
      loadedMessagesByThreadId.value[selectedThreadId.value] !== true
    ) {
      pendingThreadMessageRefresh.add(selectedThreadId.value)
    }
    await syncFromNotifications()
    const selectedId = selectedThreadId.value
    if (
      selectedId &&
      (
        runtimeOwnershipByThreadId.value[selectedId] === 'external' ||
        canStartSelectedLiveProjectionPolling(selectedId)
      )
    ) {
      scheduleExternalRuntimePolling(
        selectedId,
        runtimeOwnershipByThreadId.value[selectedId] === 'external' ? undefined : 0,
      )
    }
  }

  function startPolling(): void {
    if (typeof window === 'undefined') return

    if (multiWindowThreadSyncDisposed) {
      multiWindowThreadSync = createMultiWindowThreadSync()
      multiWindowThreadSyncDisposed = false
      if (typeof document !== 'undefined') {
        multiWindowThreadSync.setVisible(document.visibilityState === 'visible')
      }
    }
    externalRuntimePollingEnabled = true
    backgroundRuntimePollingEnabled = true
    if (typeof document !== 'undefined' && !runtimeVisibilityListenerInstalled) {
      document.addEventListener('visibilitychange', onRuntimeVisibilityChange)
      runtimeVisibilityListenerInstalled = true
    }
    scheduleBackgroundRuntimePolling(0)
    const selectedId = selectedThreadId.value
    if (
      selectedId &&
      (
        runtimeOwnershipByThreadId.value[selectedId] === 'external' ||
        canStartSelectedLiveProjectionPolling(selectedId)
      )
    ) {
      scheduleExternalRuntimePolling(
        selectedId,
        runtimeOwnershipByThreadId.value[selectedId] === 'external' ? undefined : 0,
      )
    }
    if (stopNotificationStream) return
    void loadPendingServerRequestsFromBridge()
    stopNotificationStream = subscribeCodexNotifications((notification) => {
      if (notification.method === 'ready') {
        clearAllTransientTurnErrors()
        void recoverBridgeState()
        return
      }
      if (notification.method === 'thread/queue/updated') {
        const params = asRecord(notification.params)
        const revision = readNumber(params?.revision)
        if (revision !== null && Number.isSafeInteger(revision) && revision >= 0) {
          latestQueueRevision = Math.max(latestQueueRevision, revision)
        }
        const threadIds = Array.isArray(params?.threadIds)
          ? params.threadIds.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
          : []
        for (const threadId of threadIds) {
          void processQueuedMessages(threadId)
        }
        return
      }
      queueEventDrivenSync(notification)
      applyRealtimeUpdates(notification)
    })
  }

  async function loadPendingServerRequestsFromBridge(): Promise<void> {
    try {
      const rows = await getPendingServerRequests()
      const normalizedRequests = rows
        .map((row) => normalizeServerRequest(row))
        .filter((request): request is UiServerRequest => request !== null)
      replacePendingServerRequests(normalizedRequests)
    } catch {
      // Keep UI usable when pending request endpoint is temporarily unavailable.
    }
  }

  async function respondToPendingServerRequest(reply: UiServerRequestReply): Promise<boolean> {
    if (resolvingServerRequestIds.has(reply.id)) return false
    const requestScope = findPendingServerRequestScope(reply.id)
    if (!requestScope) return false
    if (requestScope !== GLOBAL_SERVER_REQUEST_SCOPE && isExternallyOwned(requestScope)) return false
    resolvingServerRequestIds.add(reply.id)
    try {
      await replyToServerRequest(reply.id, {
        result: reply.result,
        error: reply.error,
      })
      removePendingServerRequestById(reply.id)
      return true
    } catch (unknownError) {
      error.value = unknownError instanceof Error ? unknownError.message : 'Failed to reply to server request'
      void loadPendingServerRequestsFromBridge()
      return false
    } finally {
      resolvingServerRequestIds.delete(reply.id)
    }
  }

  function stopPolling(): void {
    threadGoalRequestGeneration += 1
    threadGoalRequestEpochByThreadId.clear()
    externalRuntimePollingEnabled = false
    cancelExternalRuntimePolling()
    backgroundRuntimePollingEnabled = false
    cancelBackgroundRuntimeRequest()
    backgroundExternalThreadIds.clear()
    localRuntimeAuthorityVersionByThreadId.clear()
    selectionVersionByThreadId.clear()
    isolatedSelectedRuntimeProbeVersionByThreadId.clear()
    for (const timer of compressedLiveProjectionBackfillTimerByThreadId.values()) {
      window.clearTimeout(timer)
    }
    compressedLiveProjectionBackfillTimerByThreadId.clear()
    compressedLiveProjectionBackfillKeyByThreadId.clear()
    for (const threadId of activeTextHydrationByThreadId.keys()) {
      cancelActiveTextHydration(threadId)
    }
    multiWindowThreadSync.dispose()
    multiWindowThreadSyncDisposed = true
    if (typeof document !== 'undefined' && runtimeVisibilityListenerInstalled) {
      document.removeEventListener('visibilitychange', onRuntimeVisibilityChange)
      runtimeVisibilityListenerInstalled = false
    }
    if (stopNotificationStream) {
      stopNotificationStream()
      stopNotificationStream = null
    }

    pendingThreadsRefresh = false
    pendingThreadMessageRefresh.clear()
    pendingThreadRuntimeRefresh.clear()
    pendingActiveTextNewestRefresh.clear()
    pendingActiveTextNewestTurnIdByThreadId.clear()
    pendingTurnStartsById.clear()
    completionReconciliationGenerationByThreadId.clear()
    localSubmissionByThreadId.clear()
    for (const request of pendingStopRequestByThreadId.values()) {
      if (!request.settled) request.resolve()
    }
    pendingStopRequestByThreadId.clear()
    pendingStopByThreadId.value = {}
    pendingNewThreadSubmission = null
    isPendingNewThreadStop.value = false
    nonSuccessCompletionReadBaselineByThreadId.clear()
    resolvingServerRequestIds.clear()
    if (eventSyncTimer !== null && typeof window !== 'undefined') {
      window.clearTimeout(eventSyncTimer)
      eventSyncTimer = null
    }
    if (activeTextNewestRefreshTimer !== null && typeof window !== 'undefined') {
      window.clearTimeout(activeTextNewestRefreshTimer)
      activeTextNewestRefreshTimer = null
    }
    if (rateLimitRefreshTimer !== null && typeof window !== 'undefined') {
      window.clearTimeout(rateLimitRefreshTimer)
      rateLimitRefreshTimer = null
    }
    if (threadListBackgroundTimer !== null && typeof window !== 'undefined') {
      window.clearTimeout(threadListBackgroundTimer)
      threadListBackgroundTimer = null
    }
    if (typeof window !== 'undefined') {
      for (const timerId of delayedTurnSyncTimerByThreadId.values()) {
        window.clearTimeout(timerId)
      }
    }
    delayedTurnSyncTimerByThreadId.clear()
    activeReasoningItemId = ''
    shouldAutoScrollOnNextAgentEvent = false
    persistedMessagesByThreadId.value = {}
    optimisticUserMessagesByThreadId.value = {}
    livePlanMessagesByThreadId.value = {}
    liveAgentMessagesByThreadId.value = {}
    liveAgentRawTextByThreadId.clear()
    liveReasoningTextByThreadId.value = {}
    liveCommandsByThreadId.value = {}
    liveFileChangeMessagesByThreadId.value = {}
    turnIndexByTurnIdByThreadId.value = {}
    olderTurnCursorByThreadId.value = {}
    activeTextOlderCursorByThreadId.value = {}
    hasMoreOlderMessagesByThreadId.value = {}
    consumedOlderTurnCursorsByThreadId.clear()
    turnActivityByThreadId.value = {}
    turnSummaryByThreadId.value = {}
    terminalTurnIdsByThreadId.clear()
    turnErrorByThreadId.value = {}
    activeTurnIdByThreadId.value = {}
    runtimeOwnershipByThreadId.value = {}
    runtimeCanInterruptByThreadId.value = {}
    liveAuthorityByThreadId.value = {}
    liveSnapshotByThreadId.value = {}
    projectionKeyByThreadId.value = {}
    interruptBlockedUntilPersistedByThreadId.value = {}
    threadListedByServerById.value = {}
    persistedUserMessageByThreadId.value = {}
    queuedMessagesByThreadId.value = {}
    queueProcessingByThreadId.value = {}
    pendingQueueRefreshThreadIds.clear()
    pendingQueueAppendMessageIdsByThreadId.clear()
    queueRefreshDuringPendingAppendThreadIds.clear()
    queuePositionRepairThreadIds.clear()
    queueRefreshRequestVersion = 0
    latestQueueRevision = 0
    codexRateLimit.value = null
    threadTokenUsageByThreadId.value = {}
    threadGoalByThreadId.value = {}
    threadGoalSupportByThreadId.value = {}
    updatingThreadGoalByThreadId.value = {}
  }

  const selectedThreadQueuedMessages = computed<QueuedMessage[]>(() => {
    const threadId = selectedThreadId.value
    if (!threadId) return []
    return queuedMessagesByThreadId.value[threadId] ?? []
  })

  async function removeQueuedMessage(
    messageId: string,
    transferManagedUploads = false,
    allowExternallyOwned = false,
  ): Promise<void> {
    const threadId = selectedThreadId.value
    if (!threadId || (isExternallyOwned(threadId) && !allowExternallyOwned)) return
    const queue = queuedMessagesByThreadId.value[threadId]
    if (!queue) return
    const next = queue.filter((m) => m.id !== messageId)
    queuedMessagesByThreadId.value = next.length > 0
      ? { ...queuedMessagesByThreadId.value, [threadId]: next }
      : omitKey(queuedMessagesByThreadId.value, threadId)
    queueMutationVersion += 1
    try {
      const revision = await removeThreadQueuedMessageFromServer(threadId, messageId, { transferManagedUploads })
      latestQueueRevision = Math.max(latestQueueRevision, revision)
    } catch {
      void processQueuedMessages(threadId)
    }
  }

  async function reorderQueuedMessage(draggedId: string, targetId: string): Promise<void> {
    const threadId = selectedThreadId.value
    if (!threadId || isExternallyOwned(threadId)) return
    const queue = queuedMessagesByThreadId.value[threadId]
    if (!queue) return

    const fromIndex = queue.findIndex((m) => m.id === draggedId)
    const toIndex = queue.findIndex((m) => m.id === targetId)
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return

    const next = [...queue]
    const [moved] = next.splice(fromIndex, 1)
    next.splice(toIndex, 0, moved)
    queuedMessagesByThreadId.value = {
      ...queuedMessagesByThreadId.value,
      [threadId]: next,
    }
    queueMutationVersion += 1
    try {
      const revision = await reorderThreadQueuedMessagesOnServer(threadId, next.map((message) => message.id))
      latestQueueRevision = Math.max(latestQueueRevision, revision)
    } catch {
      void processQueuedMessages(threadId)
    }
  }

  async function steerQueuedMessage(messageId: string): Promise<void> {
    const threadId = selectedThreadId.value
    if (!threadId) return
    const queue = queuedMessagesByThreadId.value[threadId]
    if (!queue) return
    const msg = queue.find((m) => m.id === messageId)
    if (!msg) return
    if (isExternallyOwned(threadId)) return
    await removeQueuedMessage(messageId, true)
    setSelectedCollaborationMode(msg.collaborationMode)
    void sendMessageToSelectedThread(msg.text, msg.imageUrls, msg.skills, 'steer', msg.fileAttachments)
  }

  async function updateSelectedThreadGoal(input: {
    objective?: string
    status: UiThreadGoalStatus
  }): Promise<boolean> {
    const threadId = selectedThreadId.value.trim()
    if (
      !threadId ||
      isExternallyOwned(threadId) ||
      threadGoalSupportByThreadId.value[threadId] === false
    ) {
      return false
    }
    const mutationOwner = acquireThreadGoalMutation(threadId)
    if (!mutationOwner) return false
    const requestGeneration = threadGoalRequestGeneration
    const requestEpoch = invalidateThreadGoalRequest(threadId)
    try {
      const goal = await setThreadGoal({
        threadId,
        objective: input.objective,
        status: input.status,
      })
      if (!isCurrentThreadGoalRequest(threadId, requestEpoch, requestGeneration)) return true
      threadGoalByThreadId.value = {
        ...threadGoalByThreadId.value,
        [threadId]: goal,
      }
      threadGoalSupportByThreadId.value = {
        ...threadGoalSupportByThreadId.value,
        [threadId]: true,
      }
      return true
    } catch (goalError) {
      if (!isCurrentThreadGoalRequest(threadId, requestEpoch, requestGeneration)) return false
      if (isThreadGoalUnsupportedError(goalError)) {
        threadGoalSupportByThreadId.value = {
          ...threadGoalSupportByThreadId.value,
          [threadId]: false,
        }
      }
      error.value = goalError instanceof Error ? goalError.message : 'Unable to update thread goal'
      return false
    } finally {
      releaseThreadGoalMutation(threadId, mutationOwner)
    }
  }

  async function clearSelectedThreadGoal(): Promise<boolean> {
    const threadId = selectedThreadId.value.trim()
    if (
      !threadId ||
      isExternallyOwned(threadId) ||
      threadGoalSupportByThreadId.value[threadId] === false
    ) {
      return false
    }
    const mutationOwner = acquireThreadGoalMutation(threadId)
    if (!mutationOwner) return false
    const requestGeneration = threadGoalRequestGeneration
    const requestEpoch = invalidateThreadGoalRequest(threadId)
    try {
      await clearThreadGoal(threadId)
      if (!isCurrentThreadGoalRequest(threadId, requestEpoch, requestGeneration)) return true
      threadGoalByThreadId.value = omitKey(threadGoalByThreadId.value, threadId)
      threadGoalSupportByThreadId.value = {
        ...threadGoalSupportByThreadId.value,
        [threadId]: true,
      }
      return true
    } catch (goalError) {
      if (!isCurrentThreadGoalRequest(threadId, requestEpoch, requestGeneration)) return false
      if (isThreadGoalUnsupportedError(goalError)) {
        threadGoalSupportByThreadId.value = {
          ...threadGoalSupportByThreadId.value,
          [threadId]: false,
        }
      }
      error.value = goalError instanceof Error ? goalError.message : 'Unable to clear thread goal'
      return false
    } finally {
      releaseThreadGoalMutation(threadId, mutationOwner)
    }
  }

  function primeSelectedThread(threadId: string, options: { persist?: boolean } = {}): void {
    setSelectedThreadId(threadId, options)
  }

  return {
    projectGroups,
    projectDisplayNameById,
    selectedThread,
    selectedThreadRuntimeOwnership,
    selectedThreadCanInterrupt,
    selectedThreadRuntimeCwd,
    selectedThreadTokenUsage,
    selectedThreadTerminalOpen,
    isSelectedThreadInterruptPending,
    selectedThreadServerRequests,
    selectedLiveOverlay,
    selectedLiveAuthority,
    selectedLiveSnapshot,
    selectedActiveTurnId,
    selectedThreadGoal,
    selectedThreadGoalSupported,
    codexQuota,
    selectedThreadId,
    availableCollaborationModes,
    availableModelIds,
    selectedCollaborationMode,
    selectedModelId,
    selectedReasoningEffort,
    selectedSpeedMode,
    codexCliMissingError,
    installedSkills,
    accountRateLimitSnapshots,
    messages,
    pendingNewThreadMessages,
    hasMoreOlderMessages,
    isLoadingThreads,
    isThreadListFullyLoaded,
    isLoadingMessages,
    isLoadingOlderMessages,
    isSendingMessage,
    isInterruptingTurn,
    isPendingNewThreadStop,
    isUpdatingSpeedMode,
    isUpdatingThreadGoal,
    isRollingBack,

    error,
    refreshAll,
    refreshSkills,
    selectThread,
    loadMessages,
    loadOlderMessages,
    ensureThreadMessagesLoaded,
    setThreadTerminalOpen,
    toggleSelectedThreadTerminal,
    archiveThreadById,
    renameThreadById,
    forkThreadById,
    forkThreadFromTurn,
    rollbackSelectedThread,

    sendMessageToSelectedThread,
    sendMessageToNewThread,
    interruptSelectedThreadTurn,
    interruptPendingNewThreadSubmission,
    selectedThreadQueuedMessages,
    removeQueuedMessage,
    reorderQueuedMessage,
    steerQueuedMessage,
    updateSelectedThreadGoal,
    clearSelectedThreadGoal,
    setSelectedCollaborationMode,
    readModelIdForThread,
    setSelectedModelIdForThread,
    setSelectedModelId,

    setSelectedReasoningEffort,
    updateSelectedSpeedMode,
    respondToPendingServerRequest,
    renameProject,
    removeProject,
    reorderProject,
    pinProjectToTop,
    startPolling,
    stopPolling,
    primeSelectedThread,
  }
}
