import { describe, expect, it } from 'vitest'
import { createSharedShutdown, runBestEffortShutdown } from './shutdown.js'

describe('createSharedShutdown', () => {
  it('shares one unresolved cleanup operation across every shutdown call', async () => {
    let cleanupCalls = 0
    let resolveCleanup: (() => void) | undefined
    const cleanup = new Promise<void>((resolve) => {
      resolveCleanup = resolve
    })
    const shutdown = createSharedShutdown(() => {
      cleanupCalls += 1
      return cleanup
    })

    const first = shutdown()
    const second = shutdown()
    let firstCompleted = false
    let secondCompleted = false
    const firstCompletion = first.then(() => {
      firstCompleted = true
    })
    const secondCompletion = second.then(() => {
      secondCompleted = true
    })

    await Promise.resolve()

    expect(second).toBe(first)
    expect(cleanupCalls).toBe(1)
    expect(firstCompleted).toBe(false)
    expect(secondCompleted).toBe(false)

    resolveCleanup?.()
    await Promise.all([firstCompletion, secondCompletion])

    expect(firstCompleted).toBe(true)
    expect(secondCompleted).toBe(true)
  })
})

describe('runBestEffortShutdown', () => {
  it('starts HTTP closure first and attempts every cleanup independently', async () => {
    const events: string[] = []
    let resolveHttpClose: (() => void) | undefined
    const httpClose = new Promise<void>((resolve) => {
      resolveHttpClose = resolve
    })

    const shutdown = runBestEffortShutdown(
      () => {
        events.push('http-close-started')
        return httpClose
      },
      [
        () => {
          events.push('websocket-cleanup')
          throw new Error('websocket cleanup failed')
        },
        () => {
          events.push('app-cleanup')
        },
        () => {
          events.push('child-cleanup')
          return Promise.reject(new Error('child cleanup failed'))
        },
      ],
    )
    let settled = false
    void shutdown.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )

    await Promise.resolve()

    expect(events).toEqual([
      'http-close-started',
      'websocket-cleanup',
      'app-cleanup',
      'child-cleanup',
    ])
    expect(settled).toBe(false)

    resolveHttpClose?.()
    await expect(shutdown).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: 'websocket cleanup failed' }),
        expect.objectContaining({ message: 'child cleanup failed' }),
      ],
    })
  })

  it('attempts cleanup when starting HTTP closure throws synchronously', async () => {
    const cleanupCalls: string[] = []

    await expect(runBestEffortShutdown(
      () => {
        throw new Error('HTTP close failed to start')
      },
      [
        () => {
          cleanupCalls.push('websocket')
        },
        () => {
          cleanupCalls.push('app')
        },
      ],
    )).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: 'HTTP close failed to start' }),
      ],
    })

    expect(cleanupCalls).toEqual(['websocket', 'app'])
  })
})
