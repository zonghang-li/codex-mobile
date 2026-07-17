export type AppServerLifecycleNotification = {
  method: string
  params: unknown
}

export type LocalRunningTurn = {
  threadId: string
  turnId: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readLifecycle(
  notification: AppServerLifecycleNotification,
): LocalRunningTurn | null {
  const params = asRecord(notification.params)
  const turn = asRecord(params?.turn)
  const threadId = typeof params?.threadId === 'string' ? params.threadId.trim() : ''
  const turnId = typeof turn?.id === 'string' ? turn.id.trim() : ''
  return threadId && turnId ? { threadId, turnId } : null
}

export class LocalThreadRuntimeLedger {
  private readonly activeByThreadId = new Map<string, string>()

  record(notification: AppServerLifecycleNotification): void {
    if (
      notification.method !== 'turn/started'
      && notification.method !== 'turn/completed'
    ) {
      return
    }

    const lifecycle = readLifecycle(notification)
    if (!lifecycle) return

    if (notification.method === 'turn/started') {
      this.activeByThreadId.set(lifecycle.threadId, lifecycle.turnId)
      return
    }

    if (this.activeByThreadId.get(lifecycle.threadId) === lifecycle.turnId) {
      this.activeByThreadId.delete(lifecycle.threadId)
    }
  }

  getRunning(threadId: string): LocalRunningTurn | null {
    const normalizedThreadId = threadId.trim()
    const turnId = this.activeByThreadId.get(normalizedThreadId)
    return turnId ? { threadId: normalizedThreadId, turnId } : null
  }

  clear(): void {
    this.activeByThreadId.clear()
  }
}
