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
