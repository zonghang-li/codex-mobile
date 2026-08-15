import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createBoundedRetryScheduler,
  createSingleFlightTask,
  getPinnedHydrationRetryDelay,
  hydratePinnedThreadSummaries,
  prunePinnedHydrationBookkeeping,
  removeAuthoritativelyMissingPinnedThreadIds,
  reconcilePinnedThreadIds,
} from './pinnedThreadUtils'

afterEach(() => {
  vi.useRealTimers()
})

describe('reconcilePinnedThreadIds', () => {
  it('keeps pins whose threads have not loaded while pagination is still incomplete', () => {
    expect(
      reconcilePinnedThreadIds(['loaded', 'not-yet-loaded'], new Set(['loaded']), {
        canPruneMissing: false,
      }),
    ).toEqual(['loaded', 'not-yet-loaded'])
  })

  it('prunes missing pins after the thread list is fully loaded', () => {
    expect(
      reconcilePinnedThreadIds(['loaded', 'missing'], new Set(['loaded']), {
        canPruneMissing: true,
      }),
    ).toEqual(['loaded'])
  })
})

describe('hydratePinnedThreadSummaries', () => {
  it('marks only authoritative missing summaries as safe to prune', async () => {
    const result = await hydratePinnedThreadSummaries(
      ['loaded', 'missing', 'transient'],
      async (threadId) => {
        if (threadId === 'loaded') return { id: threadId }
        const error = new Error(threadId)
        Object.assign(error, { status: threadId === 'missing' ? 404 : 502 })
        throw error
      },
      (error) => (error as { status?: number }).status === 404,
    )

    expect(result.loaded).toEqual([{ id: 'loaded' }])
    expect(result.authoritativeMissingIds).toEqual(['missing'])
    expect(result.retryableIds).toEqual(['transient'])
  })

  it('limits concurrent passive summary requests', async () => {
    let active = 0
    let maximumActive = 0
    const result = await hydratePinnedThreadSummaries(
      Array.from({ length: 20 }, (_, index) => `thread-${index}`),
      async (threadId) => {
        active += 1
        maximumActive = Math.max(maximumActive, active)
        await new Promise((resolve) => setTimeout(resolve, 1))
        active -= 1
        return { id: threadId }
      },
      () => false,
      4,
    )

    expect(result.loaded).toHaveLength(20)
    expect(maximumActive).toBeLessThanOrEqual(4)
  })
})

describe('createSingleFlightTask', () => {
  it('serializes overlapping hydration requests and coalesces pending reruns', async () => {
    let active = 0
    let maximumActive = 0
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const run = createSingleFlightTask(async () => {
      calls += 1
      active += 1
      maximumActive = Math.max(maximumActive, active)
      if (calls === 1) await gate
      active -= 1
    })

    const first = run()
    const second = run()
    const third = run()
    release()
    await Promise.all([first, second, third])

    expect(maximumActive).toBe(1)
    expect(calls).toBe(2)
  })

  it('runs a request that arrives after the loop settles but before cleanup', async () => {
    let calls = 0
    const taskCompletion = Promise.resolve()
    const run = createSingleFlightTask(() => {
      calls += 1
      return taskCompletion
    })

    const first = run()
    const settlementWindowRequest = taskCompletion.then(() => run())
    await Promise.all([first, settlementWindowRequest])

    expect(calls).toBe(2)
  })
})

describe('createBoundedRetryScheduler', () => {
  it('does not recreate a timer when an in-flight hydration finishes after disposal', async () => {
    vi.useFakeTimers()
    const retry = vi.fn()
    const scheduler = createBoundedRetryScheduler(retry)
    let finishHydration!: () => void
    const hydration = new Promise<void>((resolve) => { finishHydration = resolve })
    const inFlight = (async () => {
      await hydration
      scheduler.scheduleAt(Date.now() + 2_000)
    })()

    scheduler.dispose()
    finishHydration()
    await inFlight
    await vi.advanceTimersByTimeAsync(2_000)

    expect(retry).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('backs off retryable summaries and continues with a long recovery interval', () => {
    expect(Array.from({ length: 6 }, (_, attempt) => getPinnedHydrationRetryDelay(attempt + 1))).toEqual([
      2_000,
      4_000,
      8_000,
      16_000,
      30_000,
      300_000,
    ])
  })
})

describe('prunePinnedHydrationBookkeeping', () => {
  it('removes retry and missing markers for unpinned or normally loaded threads', () => {
    const retryAfterById = new Map([
      ['unpinned', 1],
      ['loaded', 2],
      ['pending', 3],
    ])
    const authoritativeMissingIds = new Set(['unpinned', 'loaded', 'missing'])
    prunePinnedHydrationBookkeeping(
      ['loaded', 'pending', 'missing', 'exhausted'],
      new Set(['loaded']),
      retryAfterById,
      authoritativeMissingIds,
    )

    expect([...retryAfterById]).toEqual([['pending', 3]])
    expect([...authoritativeMissingIds]).toEqual(['missing'])
  })

  it('removes authoritative missing pins without waiting for another reactive update', () => {
    expect(removeAuthoritativelyMissingPinnedThreadIds(
      ['loaded', 'archived', 'missing'],
      ['archived', 'missing'],
    )).toEqual(['loaded'])
  })
})
