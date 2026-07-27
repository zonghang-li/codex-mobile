import { describe, expect, it } from 'vitest'
import { createSharedShutdown } from './shutdown.js'

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
