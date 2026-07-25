function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

function basename(pathValue: string): string {
  const normalized = pathValue.replace(/\\/gu, '/')
  return normalized.split('/').filter(Boolean).pop() || pathValue
}

function readCommandActionLabel(action: Record<string, unknown>): string {
  const type = readString(action.type)
  const command = compactWhitespace(readString(action.command))

  if (type === 'read') {
    const name = readString(action.name) || basename(readString(action.path))
    return name ? `Read ${name}` : (command ? `Ran ${command}` : 'Read file')
  }

  if (type === 'listFiles') {
    const path = readString(action.path)
    return path ? `Listed ${path}` : 'Listed files'
  }

  if (type === 'search') {
    const query = readString(action.query)
    const path = readString(action.path)
    if (query && path) return `Searched ${query} in ${path}`
    if (query) return `Searched ${query}`
    if (path) return `Searched ${path}`
    return 'Searched files'
  }

  return command ? `Ran ${command}` : ''
}

export type CommandActivityCategory = 'read' | 'listFiles' | 'search' | 'unknown'

function readCommandActionCategory(action: Record<string, unknown>): CommandActivityCategory {
  const type = readString(action.type)
  if (type === 'read' || type === 'listFiles' || type === 'search') return type
  return 'unknown'
}

function appendUnique(
  categories: CommandActivityCategory[],
  category: CommandActivityCategory,
): void {
  if (!categories.includes(category)) categories.push(category)
}

function classifyCommandSegment(value: string): CommandActivityCategory {
  const command = compactWhitespace(value)
  if (!command) return 'unknown'

  if (/[<>]/u.test(command)) return 'unknown'
  if (/^sed\b/iu.test(command)) {
    if (/(?:^|\s)-(?:[^\s]*i[^\s]*)(?:\s|$)/iu.test(command)) return 'unknown'
    return /(?:^|\s)-n(?:\s|$)/u.test(command) ? 'read' : 'unknown'
  }
  if (/^(?:cat|head|tail)\b/iu.test(command)) return 'read'
  if (/^(?:ls|find|fd)\b/iu.test(command)) return 'listFiles'
  if (/^rg\b/iu.test(command) && /(?:^|\s)--files(?:\s|$)/u.test(command)) return 'listFiles'
  if (/^(?:rg|grep)\b/iu.test(command) || /^git\s+grep\b/iu.test(command)) return 'search'
  return 'unknown'
}

export function commandActivityCategories(
  command: string,
  commandActions: unknown,
): CommandActivityCategory[] {
  if (Array.isArray(commandActions) && commandActions.length > 0) {
    const categories: CommandActivityCategory[] = []
    for (const item of commandActions) {
      const action = asRecord(item)
      if (!action) continue
      appendUnique(categories, readCommandActionCategory(action))
    }
    if (categories.length > 0) return categories
  }

  const categories: CommandActivityCategory[] = []
  const segments = command.split(/\s*(?:&&|;|\|(?!\|))\s*/u)
  for (const segment of segments) {
    if (!segment.trim()) continue
    appendUnique(categories, classifyCommandSegment(segment))
  }
  return categories.length > 0 ? categories : ['unknown']
}

export function commandDisplayLabel(command: string, commandActions: unknown): string {
  const actions = Array.isArray(commandActions) ? commandActions : []
  for (const item of actions) {
    const action = asRecord(item)
    if (!action) continue
    const label = readCommandActionLabel(action)
    if (label) return label
  }

  const compactCommand = compactWhitespace(command)
  return compactCommand ? `Ran ${compactCommand}` : 'Ran a command'
}
