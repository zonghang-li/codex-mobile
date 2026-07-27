export type NativeThreadTurnPage = {
  turns: unknown[]
  nextCursor: string | null
  backwardsCursor: string | null
}

type ThreadTurnsListRpc = (method: string, params: unknown) => Promise<unknown>

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readCursor(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function isThreadTurnsListMethodNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()
  return normalized.includes('method not found') || normalized.includes('unknown method')
}

export async function readNativeThreadTurnPage(
  rpc: ThreadTurnsListRpc,
  input: {
    threadId: string
    cursor?: string
    limit: number
  },
): Promise<NativeThreadTurnPage> {
  const limit = Math.max(1, Math.min(50, Math.floor(input.limit) || 1))
  const response = asRecord(await rpc('thread/turns/list', {
    threadId: input.threadId,
    cursor: input.cursor && input.cursor.length > 0 ? input.cursor : null,
    limit,
    sortDirection: 'desc',
    itemsView: 'full',
  }))
  const data = response?.data
  if (!response || !Array.isArray(data)) {
    throw new Error('thread/turns/list returned an invalid response')
  }

  return {
    turns: [...data].reverse(),
    nextCursor: readCursor(response.nextCursor),
    backwardsCursor: readCursor(response.backwardsCursor),
  }
}
