export const THREAD_RENDER_WINDOW_SIZE = 50
export const THREAD_RENDER_LOAD_CHUNK = 30

export function clampThreadRenderWindowStart(start: number, messageCount: number): number {
  const boundedCount = Math.max(0, Math.floor(messageCount))
  if (boundedCount === 0) return 0
  const normalizedStart = Number.isFinite(start) ? Math.max(0, Math.floor(start)) : 0
  return Math.min(normalizedStart, boundedCount - 1)
}

export function latestThreadRenderWindowStart(messageCount: number): number {
  return Math.max(0, Math.floor(messageCount) - THREAD_RENDER_WINDOW_SIZE)
}

export function earlierThreadRenderWindowStart(start: number, messageCount: number): number {
  const effectiveStart = clampThreadRenderWindowStart(start, messageCount)
  return Math.max(0, effectiveStart - THREAD_RENDER_LOAD_CHUNK)
}
