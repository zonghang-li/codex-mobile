export type MultiWindowThreadSyncChannel = {
  postMessage: (message: unknown) => void
  addEventListener: (eventName: 'message', listener: (event: { data: unknown }) => void) => void
  removeEventListener: (eventName: 'message', listener: (event: { data: unknown }) => void) => void
  close: () => void
}

type MultiWindowThreadSyncMessage =
  | {
      type: 'claim'
      instanceId: string
      threadId: string
      turnId: string
      requestKey: string
      visible: boolean
      atMs: number
    }
  | {
      type: 'page'
      instanceId: string
      threadId: string
      turnId: string
      requestKey: string
      page: unknown
      atMs: number
    }
  | {
      type: 'retire'
      instanceId: string
      atMs: number
    }
  | {
      type: 'release'
      instanceId: string
      threadId: string
      turnId: string
      requestKey: string
      atMs: number
    }

type Waiter<T> = {
  resolve: (page: T) => void
  reject: (error: unknown) => void
}

type PageCacheEntry = {
  page: unknown
  expiresAtMs: number
}

export type MultiWindowThreadSyncOptions = {
  instanceId?: string
  channelName?: string
  leaderSettleMs?: number
  followerTimeoutMs?: number
  pageCacheTtlMs?: number
  claimTtlMs?: number
  channelFactory?: (name: string) => MultiWindowThreadSyncChannel
  now?: () => number
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void
}

export type ActiveTextPageEvent<T = unknown> = {
  threadId: string
  turnId: string
  requestKey: string
  page: T
}

export type MultiWindowThreadSync = {
  loadActiveTextPage: <T>(input: {
    threadId: string
    turnId: string
    requestKey: string
    load: () => Promise<T>
    signal?: AbortSignal
  }) => Promise<T>
  onActiveTextPage: <T>(handler: (event: ActiveTextPageEvent<T>) => void) => () => void
  setVisible: (visible: boolean) => void
  dispose: () => void
}

const DEFAULT_CHANNEL_NAME = 'codex-mobile-thread-sync'
const DEFAULT_LEADER_SETTLE_MS = 16
const DEFAULT_FOLLOWER_TIMEOUT_MS = 900
const DEFAULT_PAGE_CACHE_TTL_MS = 500
const DEFAULT_CLAIM_TTL_MS = 1_200
const CLAIMS_CHANGED = Symbol('claims-changed')

function randomInstanceId(): string {
  const cryptoObject = typeof globalThis.crypto === 'object' ? globalThis.crypto : null
  if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
    return cryptoObject.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readMessage(value: unknown): MultiWindowThreadSyncMessage | null {
  const record = asRecord(value)
  if (!record) return null
  const type = typeof record.type === 'string' ? record.type : ''
  const instanceId = typeof record.instanceId === 'string' ? record.instanceId : ''
  const atMs = typeof record.atMs === 'number' && Number.isFinite(record.atMs) ? record.atMs : 0
  if (!type || !instanceId) return null
  if (type === 'retire') return { type, instanceId, atMs }

  const threadId = typeof record.threadId === 'string' ? record.threadId : ''
  const turnId = typeof record.turnId === 'string' ? record.turnId : ''
  const requestKey = typeof record.requestKey === 'string' ? record.requestKey : ''
  if (!threadId || !turnId || !requestKey) return null
  if (type === 'claim') {
    return {
      type,
      instanceId,
      threadId,
      turnId,
      requestKey,
      visible: record.visible === true,
      atMs,
    }
  }
  if (type === 'release') {
    return {
      type,
      instanceId,
      threadId,
      turnId,
      requestKey,
      atMs,
    }
  }
  if (type === 'page') {
    return {
      type,
      instanceId,
      threadId,
      turnId,
      requestKey,
      page: record.page,
      atMs,
    }
  }
  return null
}

function requestIdentity(threadId: string, turnId: string, requestKey: string): string {
  return `${threadId}\0${turnId}\0${requestKey}`
}

function makeAbortError(): Error {
  const error = new Error('Thread text sync aborted')
  error.name = 'AbortError'
  return error
}

export function createMultiWindowThreadSync(
  options: MultiWindowThreadSyncOptions = {},
): MultiWindowThreadSync {
  const instanceId = options.instanceId ?? randomInstanceId()
  const leaderSettleMs = options.leaderSettleMs ?? DEFAULT_LEADER_SETTLE_MS
  const followerTimeoutMs = options.followerTimeoutMs ?? DEFAULT_FOLLOWER_TIMEOUT_MS
  const pageCacheTtlMs = options.pageCacheTtlMs ?? DEFAULT_PAGE_CACHE_TTL_MS
  const claimTtlMs = options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS
  const now = options.now ?? (() => Date.now())
  const setTimer = options.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const clearTimer = options.clearTimeout ?? ((handle) => clearTimeout(handle))
  const browserBroadcastChannel = typeof window !== 'undefined'
    ? (window as typeof window & { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel
    : undefined
  const factory = options.channelFactory
    ?? (typeof browserBroadcastChannel === 'function'
      ? (name: string) => new browserBroadcastChannel(name) as MultiWindowThreadSyncChannel
      : null)
  const channel = factory ? factory(options.channelName ?? DEFAULT_CHANNEL_NAME) : null
  const claimsByRequest = new Map<string, Map<string, MultiWindowThreadSyncMessage & { type: 'claim' }>>()
  const waitersByRequest = new Map<string, Set<Waiter<unknown>>>()
  const claimChangeWaitersByRequest = new Map<string, Set<Waiter<void>>>()
  const pageCacheByRequest = new Map<string, PageCacheEntry>()
  const pageHandlers = new Set<(event: ActiveTextPageEvent) => void>()
  let visible = true
  let disposed = false

  function prunePageCache(): void {
    const current = now()
    for (const [key, entry] of pageCacheByRequest) {
      if (entry.expiresAtMs <= current) pageCacheByRequest.delete(key)
    }
  }

  function post(message: MultiWindowThreadSyncMessage): void {
    if (!channel || disposed) return
    channel.postMessage(message)
  }

  function publishPage<T>(threadId: string, turnId: string, requestKey: string, page: T): void {
    const key = requestIdentity(threadId, turnId, requestKey)
    pageCacheByRequest.set(key, {
      page,
      expiresAtMs: now() + pageCacheTtlMs,
    })
    post({
      type: 'page',
      instanceId,
      threadId,
      turnId,
      requestKey,
      page,
      atMs: now(),
    })
  }

  function resolveWaiters(message: MultiWindowThreadSyncMessage & { type: 'page' }): void {
    const key = requestIdentity(message.threadId, message.turnId, message.requestKey)
    pageCacheByRequest.set(key, {
      page: message.page,
      expiresAtMs: now() + pageCacheTtlMs,
    })
    const waiters = waitersByRequest.get(key)
    if (waiters) {
      waitersByRequest.delete(key)
      for (const waiter of waiters) {
        waiter.resolve(message.page)
      }
    }
    for (const handler of pageHandlers) {
      handler({
        threadId: message.threadId,
        turnId: message.turnId,
        requestKey: message.requestKey,
        page: message.page,
      })
    }
  }

  function handleMessage(event: { data: unknown }): void {
    const message = readMessage(event.data)
    if (!message || message.instanceId === instanceId) return
    if (message.type === 'retire') {
      for (const key of removeClaimsForInstance(message.instanceId)) {
        notifyClaimsChanged(key)
      }
      return
    }
    if (message.type === 'claim') {
      const key = requestIdentity(message.threadId, message.turnId, message.requestKey)
      const claims = claimsByRequest.get(key) ?? new Map<string, MultiWindowThreadSyncMessage & { type: 'claim' }>()
      claims.set(message.instanceId, message)
      claimsByRequest.set(key, claims)
      return
    }
    if (message.type === 'release') {
      const key = requestIdentity(message.threadId, message.turnId, message.requestKey)
      const leaderBeforeRelease = leaderForRequest(key)
      const removed = removeClaimForRequest(key, message.instanceId)
      if (removed && leaderBeforeRelease === message.instanceId) {
        notifyClaimsChanged(key)
      }
      return
    }
    resolveWaiters(message)
  }

  channel?.addEventListener('message', handleMessage)

  function notifyClaimsChanged(key: string): void {
    const waiters = claimChangeWaitersByRequest.get(key)
    if (!waiters) return
    claimChangeWaitersByRequest.delete(key)
    for (const waiter of waiters) {
      waiter.resolve(undefined)
    }
  }

  function removeClaimsForInstance(retiredInstanceId: string): string[] {
    const affectedLeaderKeys: string[] = []
    for (const [key, claims] of claimsByRequest) {
      const leaderBeforeRetire = leaderForRequest(key)
      const removed = claims.delete(retiredInstanceId)
      if (claims.size === 0) claimsByRequest.delete(key)
      if (removed && leaderBeforeRetire === retiredInstanceId) {
        affectedLeaderKeys.push(key)
      }
    }
    return affectedLeaderKeys
  }

  function retireOwnClaims(): void {
    for (const key of removeClaimsForInstance(instanceId)) {
      notifyClaimsChanged(key)
    }
    post({ type: 'retire', instanceId, atMs: now() })
  }

  function removeClaimForRequest(key: string, releasedInstanceId: string): boolean {
    const claims = claimsByRequest.get(key)
    if (!claims) return false
    const removed = claims.delete(releasedInstanceId)
    if (claims.size === 0) claimsByRequest.delete(key)
    return removed
  }

  function releaseOwnClaim(threadId: string, turnId: string, requestKey: string, key: string): void {
    const leaderBeforeRelease = leaderForRequest(key)
    const removed = removeClaimForRequest(key, instanceId)
    if (removed && leaderBeforeRelease === instanceId) {
      notifyClaimsChanged(key)
    }
    post({
      type: 'release',
      instanceId,
      threadId,
      turnId,
      requestKey,
      atMs: now(),
    })
  }

  function recordOwnClaim(threadId: string, turnId: string, requestKey: string): string {
    const key = requestIdentity(threadId, turnId, requestKey)
    const claim: MultiWindowThreadSyncMessage & { type: 'claim' } = {
      type: 'claim',
      instanceId,
      threadId,
      turnId,
      requestKey,
      visible,
      atMs: now(),
    }
    const claims = claimsByRequest.get(key) ?? new Map<string, MultiWindowThreadSyncMessage & { type: 'claim' }>()
    claims.set(instanceId, claim)
    claimsByRequest.set(key, claims)
    post(claim)
    return key
  }

  function leaderForRequest(key: string): string {
    const claims = claimsByRequest.get(key)
    if (claims) {
      const oldestRetainedAtMs = now() - claimTtlMs
      for (const [candidateInstanceId, claim] of claims) {
        if (claim.atMs < oldestRetainedAtMs) claims.delete(candidateInstanceId)
      }
      if (claims.size === 0) claimsByRequest.delete(key)
    }
    const candidates = [...(claims?.values() ?? [])]
      .filter((claim) => claim.visible)
      .map((claim) => claim.instanceId)
      .sort()
    return candidates[0] ?? instanceId
  }

  function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(makeAbortError())
    return new Promise((resolve, reject) => {
      const timer = setTimer(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, delayMs)
      const onAbort = (): void => {
        clearTimer(timer)
        signal?.removeEventListener('abort', onAbort)
        reject(makeAbortError())
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  function waitForPage<T>(key: string, signal?: AbortSignal): Promise<T> {
    const cached = pageCacheByRequest.get(key)
    if (cached && cached.expiresAtMs > now()) return Promise.resolve(cached.page as T)
    if (signal?.aborted) return Promise.reject(makeAbortError())

    return new Promise((resolve, reject) => {
      const waiter: Waiter<unknown> = {
        resolve: (page) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(page as T)
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
      }
      const waiters = waitersByRequest.get(key) ?? new Set<Waiter<unknown>>()
      waiters.add(waiter)
      waitersByRequest.set(key, waiters)
      const onAbort = (): void => {
        waiters.delete(waiter)
        if (waiters.size === 0) waitersByRequest.delete(key)
        reject(makeAbortError())
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  function waitForClaimsChanged(key: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(makeAbortError())

    return new Promise((resolve, reject) => {
      const waiter: Waiter<void> = {
        resolve: () => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
      }
      const waiters = claimChangeWaitersByRequest.get(key) ?? new Set<Waiter<void>>()
      waiters.add(waiter)
      claimChangeWaitersByRequest.set(key, waiters)
      const onAbort = (): void => {
        waiters.delete(waiter)
        if (waiters.size === 0) claimChangeWaitersByRequest.delete(key)
        reject(makeAbortError())
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  async function loadActiveTextPage<T>(input: {
    threadId: string
    turnId: string
    requestKey: string
    load: () => Promise<T>
    signal?: AbortSignal
  }): Promise<T> {
    if (!channel || disposed || !visible) return input.load()
    prunePageCache()
    const key = recordOwnClaim(input.threadId, input.turnId, input.requestKey)
    try {
      while (true) {
        const cached = pageCacheByRequest.get(key)
        if (cached && cached.expiresAtMs > now()) return cached.page as T

        await wait(leaderSettleMs, input.signal)
        if (!visible) throw makeAbortError()
        const settledCached = pageCacheByRequest.get(key)
        if (settledCached && settledCached.expiresAtMs > now()) return settledCached.page as T
        if (leaderForRequest(key) === instanceId) {
          const page = await input.load()
          publishPage(input.threadId, input.turnId, input.requestKey, page)
          return page
        }

        try {
          return await Promise.race([
            waitForPage<T>(key, input.signal),
            waitForClaimsChanged(key, input.signal).then(() => {
              throw CLAIMS_CHANGED
            }),
            wait(followerTimeoutMs, input.signal).then(() => {
              throw new Error('Timed out waiting for active text page leader')
            }),
          ])
        } catch (error) {
          if (input.signal?.aborted) throw error
          if (!visible) throw makeAbortError()
          if (error === CLAIMS_CHANGED) continue
          const page = await input.load()
          publishPage(input.threadId, input.turnId, input.requestKey, page)
          return page
        }
      }
    } finally {
      releaseOwnClaim(input.threadId, input.turnId, input.requestKey, key)
    }
  }

  return {
    loadActiveTextPage,
    onActiveTextPage<T>(handler: (event: ActiveTextPageEvent<T>) => void): () => void {
      const erased = handler as (event: ActiveTextPageEvent) => void
      pageHandlers.add(erased)
      return () => {
        pageHandlers.delete(erased)
      }
    },
    setVisible(nextVisible: boolean): void {
      if (visible === nextVisible) return
      visible = nextVisible
      if (!visible) retireOwnClaims()
    },
    dispose(): void {
      if (disposed) return
      retireOwnClaims()
      disposed = true
      channel?.removeEventListener('message', handleMessage)
      channel?.close()
      for (const waiters of waitersByRequest.values()) {
        for (const waiter of waiters) {
          waiter.reject(makeAbortError())
        }
      }
      waitersByRequest.clear()
      for (const waiters of claimChangeWaitersByRequest.values()) {
        for (const waiter of waiters) {
          waiter.reject(makeAbortError())
        }
      }
      claimChangeWaitersByRequest.clear()
      claimsByRequest.clear()
      pageHandlers.clear()
      pageCacheByRequest.clear()
    },
  }
}
