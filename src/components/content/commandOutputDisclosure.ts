export function isCommandOutputExpanded(
  expandedIds: ReadonlySet<string>,
  commandId: string,
  canExpand: boolean,
): boolean {
  return canExpand && expandedIds.has(commandId)
}

export function toggleCommandOutputExpanded(
  expandedIds: Set<string>,
  commandId: string,
  canExpand: boolean,
): Set<string> {
  if (!canExpand) return expandedIds

  const next = new Set(expandedIds)
  if (next.has(commandId)) next.delete(commandId)
  else next.add(commandId)
  return next
}
