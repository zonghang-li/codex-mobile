export function createSharedShutdown(operation: () => Promise<void>): () => Promise<void> {
  let shutdown: Promise<void> | undefined
  return () => {
    shutdown ??= operation()
    return shutdown
  }
}
