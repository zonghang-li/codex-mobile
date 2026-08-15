export function reconcilePinnedThreadIds(
  pinnedThreadIds: string[],
  loadedThreadIds: Set<string>,
  options: { canPruneMissing: boolean },
): string[] {
  if (!options.canPruneMissing) return pinnedThreadIds
  return pinnedThreadIds.filter((threadId) => loadedThreadIds.has(threadId))
}

export async function hydratePinnedThreadSummaries<T>(
  threadIds: readonly string[],
  load: (threadId: string) => Promise<T>,
  isAuthoritativeMissing: (error: unknown) => boolean,
  concurrency = 4,
): Promise<{
  loaded: T[]
  authoritativeMissingIds: string[]
  retryableIds: string[]
}> {
  const loaded: T[] = []
  const authoritativeMissingIds: string[] = []
  const retryableIds: string[] = []
  let nextIndex = 0
  const workerCount = Math.min(threadIds.length, Math.max(1, Math.floor(concurrency)))

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < threadIds.length) {
      const threadId = threadIds[nextIndex++]!
      try {
        loaded.push(await load(threadId))
      } catch (error) {
        if (isAuthoritativeMissing(error)) authoritativeMissingIds.push(threadId)
        else retryableIds.push(threadId)
      }
    }
  }))

  return { loaded, authoritativeMissingIds, retryableIds }
}

export function createSingleFlightTask(task: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null
  let pending = false

  return async () => {
    pending = true
    do {
      if (!running) {
        running = (async () => {
          while (pending) {
            pending = false
            await task()
          }
        })().finally(() => {
          running = null
        })
      }
      await running
    } while (pending)
  }
}

export function getPinnedHydrationRetryDelay(attempt: number): number | null {
  if (!Number.isSafeInteger(attempt) || attempt < 1) return null
  if (attempt > 5) return 5 * 60_000
  return Math.min(30_000, 2_000 * (2 ** (attempt - 1)))
}

export function createBoundedRetryScheduler(task: () => void | Promise<void>): {
  clear: () => void
  dispose: () => void
  scheduleAt: (retryAt: number) => void
} {
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | null = null

  return {
    clear() {
      if (timer) clearTimeout(timer)
      timer = null
    },
    scheduleAt(retryAt) {
      if (disposed || !Number.isFinite(retryAt)) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        if (!disposed) void task()
      }, Math.max(0, retryAt - Date.now()))
    },
    dispose() {
      disposed = true
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}

export function prunePinnedHydrationBookkeeping(
  pinnedThreadIds: readonly string[],
  loadedThreadIds: ReadonlySet<string>,
  retryAfterById: Map<string, number>,
  authoritativeMissingIds: Set<string>,
): void {
  const pinnedIdSet = new Set(pinnedThreadIds)
  for (const threadId of retryAfterById.keys()) {
    if (!pinnedIdSet.has(threadId) || loadedThreadIds.has(threadId)) retryAfterById.delete(threadId)
  }
  for (const threadId of authoritativeMissingIds) {
    if (!pinnedIdSet.has(threadId) || loadedThreadIds.has(threadId)) authoritativeMissingIds.delete(threadId)
  }
}

export function removeAuthoritativelyMissingPinnedThreadIds(
  pinnedThreadIds: readonly string[],
  authoritativeMissingIds: readonly string[],
): string[] {
  if (authoritativeMissingIds.length === 0) return [...pinnedThreadIds]
  const missingIdSet = new Set(authoritativeMissingIds)
  return pinnedThreadIds.filter((threadId) => !missingIdSet.has(threadId))
}
