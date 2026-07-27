export function filterRenderableThreadMessages<T extends { id: string }>(
  messages: readonly T[],
  ...hiddenMessageIdSets: ReadonlySet<string>[]
): T[] {
  return messages.filter((message) =>
    hiddenMessageIdSets.every((hiddenMessageIds) => !hiddenMessageIds.has(message.id)),
  )
}

export function clampThreadRenderWindowStart(start: number, messageCount: number): number {
  void start
  void messageCount
  return 0
}

export function latestThreadRenderWindowStart(messageCount: number): number {
  void messageCount
  return 0
}

export function earlierThreadRenderWindowStart(start: number, messageCount: number): number {
  void start
  void messageCount
  return 0
}
