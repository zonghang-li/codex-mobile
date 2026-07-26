import type { RpcNotification } from '../api/codexRpcClient'

const SUBAGENT_ITEM_TYPES = new Set([
  'subAgentActivity',
  'collabAgentToolCall',
])

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function shouldRefreshMessagesForNotification(notification: RpcNotification): boolean {
  if (
    notification.method === 'turn/started' ||
    notification.method === 'turn/completed' ||
    notification.method === 'error'
  ) {
    return true
  }
  if (notification.method !== 'item/started' && notification.method !== 'item/completed') {
    return false
  }
  const params = asRecord(notification.params)
  const item = asRecord(params?.item)
  return typeof item?.type === 'string' && SUBAGENT_ITEM_TYPES.has(item.type)
}
