export function createSharedShutdown(operation: () => Promise<void>): () => Promise<void> {
  let shutdown: Promise<void> | undefined
  return () => {
    shutdown ??= operation()
    return shutdown
  }
}

export class ShutdownCleanupError extends Error {
  constructor(readonly errors: unknown[]) {
    super('One or more shutdown cleanup steps failed')
    this.name = 'ShutdownCleanupError'
  }
}

export async function runBestEffortShutdown(
  startHttpClose: () => Promise<void>,
  cleanupSteps: readonly (() => void | Promise<void>)[],
): Promise<void> {
  const errors: unknown[] = []
  let httpClose: Promise<void>
  try {
    httpClose = startHttpClose()
  } catch (error) {
    errors.push(error)
    httpClose = Promise.resolve()
  }

  const cleanupResults = cleanupSteps.map((cleanup) => {
    try {
      return Promise.resolve(cleanup()).catch((error: unknown) => {
        errors.push(error)
      })
    } catch (error) {
      errors.push(error)
      return Promise.resolve()
    }
  })
  await Promise.all(cleanupResults)

  try {
    await httpClose
  } catch (error) {
    errors.push(error)
  }

  if (errors.length > 0) throw new ShutdownCleanupError(errors)
}
