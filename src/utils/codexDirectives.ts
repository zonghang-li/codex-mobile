import type { UiCodexDirective } from '../types/codex'

export type DirectiveTranslate = (
  message: string,
  params?: Record<string, string | number>,
) => string

export type ParsedCodexDirectiveText = {
  text: string
  directives: UiCodexDirective[]
}

const SUPPORTED_DIRECTIVE_NAMES = [
  'git-stage',
  'git-commit',
  'git-create-branch',
  'git-push',
  'git-create-pr',
  'created-thread',
  'code-comment',
] as const

type ParsedDirectiveAttributes = {
  values: Record<string, string>
  ordered: Array<{ key: string; value: string }>
}

const SENSITIVE_ATTRIBUTE_PARTS = [
  'password',
  'passwd',
  'token',
  'secret',
  'credential',
  'authorization',
  'apikey',
] as const

function hasOnlyKeys(attributes: Record<string, string>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed)
  return Object.keys(attributes).every((key) => allowedSet.has(key))
}

function isHttpsUrl(value: string | undefined): value is string {
  if (!value) return false
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function readPositiveInteger(value: string | undefined): number | undefined | null {
  if (value === undefined) return undefined
  if (!/^[1-9]\d*$/u.test(value)) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function readAttributes(source: string): ParsedDirectiveAttributes | null {
  const values: Record<string, string> = {}
  const ordered: ParsedDirectiveAttributes['ordered'] = []
  let index = 0
  let hasAttribute = false

  while (index < source.length) {
    const whitespaceStart = index
    while (/\s/u.test(source[index] ?? '')) index += 1
    if (index >= source.length) return { values, ordered }
    if (hasAttribute && index === whitespaceStart) return null

    const keyMatch = /^[A-Za-z][A-Za-z0-9]*/u.exec(source.slice(index))
    if (!keyMatch) return null
    const key = keyMatch[0]
    if (Object.prototype.hasOwnProperty.call(values, key)) return null
    index += key.length
    if (source[index] !== '=') return null
    index += 1
    if (source[index] !== '"') return null
    index += 1

    let value = ''
    let closed = false
    while (index < source.length) {
      const character = source[index]
      if (character === '"') {
        index += 1
        closed = true
        break
      }
      if (character === '\\') {
        const escaped = source[index + 1]
        if (escaped !== '"' && escaped !== '\\') return null
        value += escaped
        index += 2
        continue
      }
      value += character
      index += 1
    }
    if (!closed) return null
    values[key] = value
    ordered.push({ key, value })
    hasAttribute = true
  }

  return { values, ordered }
}

function isSensitiveAttribute(key: string): boolean {
  const normalized = key.toLowerCase()
  return SENSITIVE_ATTRIBUTE_PARTS.some((part) => normalized.includes(part))
}

function toGenericDirective(
  name: string,
  ordered: ParsedDirectiveAttributes['ordered'],
): UiCodexDirective {
  return {
    kind: 'generic',
    name,
    attributes: ordered.map(({ key, value }) => {
      const sensitive = isSensitiveAttribute(key)
      return {
        key,
        value: sensitive ? '••••' : value,
        sensitive,
      }
    }),
  }
}

function toDirective(
  name: string,
  attributes: Record<string, string>,
): UiCodexDirective | null {
  switch (name) {
    case 'git-stage':
    case 'git-commit':
      return hasOnlyKeys(attributes, ['cwd']) && attributes.cwd
        ? { kind: name, cwd: attributes.cwd }
        : null
    case 'git-create-branch':
    case 'git-push':
      return hasOnlyKeys(attributes, ['cwd', 'branch']) && attributes.cwd && attributes.branch
        ? { kind: name, cwd: attributes.cwd, branch: attributes.branch }
        : null
    case 'git-create-pr': {
      if (!hasOnlyKeys(attributes, ['cwd', 'branch', 'url', 'isDraft'])) return null
      if (!attributes.cwd || !attributes.branch || !isHttpsUrl(attributes.url)) return null
      if (attributes.isDraft !== 'true' && attributes.isDraft !== 'false') return null
      return {
        kind: name,
        cwd: attributes.cwd,
        branch: attributes.branch,
        url: attributes.url,
        isDraft: attributes.isDraft === 'true',
      }
    }
    case 'created-thread':
      if (!hasOnlyKeys(attributes, ['threadId', 'clientThreadId'])) return null
      if (Boolean(attributes.threadId) === Boolean(attributes.clientThreadId)) return null
      return attributes.threadId
        ? { kind: name, threadId: attributes.threadId }
        : { kind: name, clientThreadId: attributes.clientThreadId }
    case 'code-comment': {
      if (!hasOnlyKeys(attributes, ['title', 'body', 'file', 'start', 'end', 'priority'])) return null
      if (!attributes.title || !attributes.body || !attributes.file) return null
      const start = readPositiveInteger(attributes.start)
      const end = readPositiveInteger(attributes.end)
      const priority = attributes.priority === undefined
        ? undefined
        : /^(?:0|1|2|3)$/u.test(attributes.priority)
          ? Number.parseInt(attributes.priority, 10)
          : null
      if (start === null || end === null || priority === null) return null
      if (end !== undefined && start === undefined) return null
      if (start !== undefined && end !== undefined && end < start) return null
      return {
        kind: name,
        title: attributes.title,
        body: attributes.body,
        file: attributes.file,
        start,
        end,
        priority,
      }
    }
    default:
      return null
  }
}

function readSafeDirectiveName(value: string): string | undefined {
  return /^::([a-z][a-z0-9-]*)(?=\{|$)/u.exec(value)?.[1]
}

function readDirective(line: string): UiCodexDirective | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('::')) return null

  const name = readSafeDirectiveName(trimmed)
  if (!name) return { kind: 'invalid', reason: 'invalid-name' }
  if (!hasStructuralClosingBrace(trimmed.slice(2))) {
    return { kind: 'invalid', name, reason: 'incomplete' }
  }

  const match = /^::([a-z][a-z0-9-]*)\{(.*)\}$/u.exec(trimmed)
  if (!match) return { kind: 'invalid', name, reason: 'invalid-syntax' }
  const attributes = readAttributes(match[2])
  if (!attributes) return { kind: 'invalid', name, reason: 'invalid-syntax' }

  if (!SUPPORTED_DIRECTIVE_NAMES.includes(name as typeof SUPPORTED_DIRECTIVE_NAMES[number])) {
    return toGenericDirective(name, attributes.ordered)
  }
  return toDirective(name, attributes.values)
    ?? { kind: 'invalid', name, reason: 'invalid-schema' }
}

type FenceState = { marker: '`' | '~'; length: number }

function readFenceRun(line: string): { marker: '`' | '~'; length: number; rest: string } | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line)
  if (!match) return null
  const marker = match[1][0] as '`' | '~'
  const rest = match[2]
  if (marker === '`' && rest.includes('`')) return null
  return {
    marker,
    length: match[1].length,
    rest,
  }
}

function hasStructuralClosingBrace(value: string): boolean {
  let insideQuotes = false
  let escaped = false

  for (const character of value) {
    if (escaped) {
      escaped = false
      continue
    }
    if (insideQuotes && character === '\\') {
      escaped = true
      continue
    }
    if (character === '"') {
      insideQuotes = !insideQuotes
      continue
    }
    if (!insideQuotes && character === '}') return true
  }

  return false
}

function isIncompleteTrailingDirective(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('::') && !hasStructuralClosingBrace(trimmed.slice(2))
}

export function parseCodexDirectiveText(
  value: string,
  options: { suppressIncompleteTrailingDirective?: boolean } = {},
): ParsedCodexDirectiveText {
  const lines = value.split('\n')
  const removedLineIndexes = new Set<number>()
  const directives: UiCodexDirective[] = []
  let fence: FenceState | null = null

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const fenceRun = readFenceRun(line)

    if (fence) {
      if (
        fenceRun &&
        fenceRun.marker === fence.marker &&
        fenceRun.length >= fence.length &&
        fenceRun.rest.trim().length === 0
      ) {
        fence = null
      }
      continue
    }

    if (fenceRun) {
      fence = { marker: fenceRun.marker, length: fenceRun.length }
      continue
    }

    const isFinalLine = index === lines.length - 1
    if (
      isFinalLine &&
      options.suppressIncompleteTrailingDirective === true &&
      isIncompleteTrailingDirective(line)
    ) {
      removedLineIndexes.add(index)
      continue
    }

    const directive = readDirective(line)
    if (directive) {
      directives.push(directive)
      removedLineIndexes.add(index)
    }
  }

  if (removedLineIndexes.size === 0) {
    return { text: value, directives }
  }

  const visibleLines: string[] = []
  let hasVisibleContent = false
  let index = 0
  while (index < lines.length) {
    if (!removedLineIndexes.has(index) && lines[index].trim().length > 0) {
      visibleLines.push(lines[index])
      hasVisibleContent = true
      index += 1
      continue
    }

    const regionStart = index
    let containsRemovedLine = false
    let containsBlankLine = false
    while (
      index < lines.length
      && (removedLineIndexes.has(index) || lines[index].trim().length === 0)
    ) {
      if (removedLineIndexes.has(index)) containsRemovedLine = true
      else containsBlankLine = true
      index += 1
    }

    if (!containsRemovedLine) {
      visibleLines.push(...lines.slice(regionStart, index))
      continue
    }

    const hasVisibleContentAfter = index < lines.length
    if (containsBlankLine && hasVisibleContent && hasVisibleContentAfter) {
      visibleLines.push('')
    }
  }

  return {
    text: visibleLines.join('\n'),
    directives,
  }
}

export function codexDirectiveLabel(
  directive: UiCodexDirective,
  translate: DirectiveTranslate,
): string {
  switch (directive.kind) {
    case 'generic':
      return translate('Codex directive: {name}', { name: directive.name })
    case 'invalid':
      return translate('Directive format error')
    case 'git-stage':
      return translate('Changes staged')
    case 'git-commit':
      return translate('Commit created')
    case 'git-create-branch':
      return translate('Switched to branch {branch}', { branch: directive.branch })
    case 'git-push':
      return translate('Pushed {branch}', { branch: directive.branch })
    case 'git-create-pr':
      return translate(directive.isDraft ? 'Draft pull request created' : 'Pull request created')
    case 'created-thread':
      return translate(directive.threadId ? 'New task created' : 'New task queued')
    case 'code-comment':
      return translate('Code comment: {title}', { title: directive.title })
  }
}

export function codexDirectiveInvalidReason(
  directive: Extract<UiCodexDirective, { kind: 'invalid' }>,
  translate: DirectiveTranslate,
): string {
  switch (directive.reason) {
    case 'invalid-name':
      return translate('Invalid directive name')
    case 'invalid-syntax':
      return translate('Invalid directive syntax')
    case 'invalid-schema':
      return translate('Invalid directive fields')
    case 'incomplete':
      return translate('Incomplete directive output')
  }
}

export function codexDirectiveHref(directive: UiCodexDirective): string | null {
  if (directive.kind === 'git-create-pr') {
    return isHttpsUrl(directive.url) ? directive.url : null
  }
  if (directive.kind === 'created-thread' && directive.threadId) {
    return `/#/thread/${encodeURIComponent(directive.threadId)}`
  }
  return null
}

export function codexDirectiveLocation(
  directive: Extract<UiCodexDirective, { kind: 'code-comment' }>,
): string {
  if (directive.start === undefined) return directive.file
  if (directive.end === undefined) return `${directive.file}:${directive.start}`
  return `${directive.file}:${directive.start}-${directive.end}`
}

function escapeMarkdown(value: string | number): string {
  return String(value).split('').map((character) => {
    const code = character.charCodeAt(0)
    const isAsciiPunctuation =
      (code >= 33 && code <= 47) ||
      (code >= 58 && code <= 64) ||
      (code >= 91 && code <= 96) ||
      (code >= 123 && code <= 126)
    return isAsciiPunctuation ? `\\${character}` : character
  }).join('')
}

export function codexDirectiveExportLines(
  directive: UiCodexDirective,
  translate: DirectiveTranslate,
): string[] {
  switch (directive.kind) {
    case 'generic':
      return [
        `- ${codexDirectiveLabel(
          { ...directive, name: escapeMarkdown(directive.name) },
          translate,
        )}`,
        ...directive.attributes.map(({ key, value }) =>
          `  - ${escapeMarkdown(key)}: ${escapeMarkdown(value)}`),
      ]
    case 'invalid':
      return [
        `- ${codexDirectiveLabel(directive, translate)}`,
        ...(directive.name
          ? [`  - ${translate('Directive name')}: ${escapeMarkdown(directive.name)}`]
          : []),
        `  - ${codexDirectiveInvalidReason(directive, translate)}`,
      ]
    case 'git-stage':
    case 'git-commit':
      return [
        `- ${codexDirectiveLabel(directive, translate)}`,
        `  - ${translate('Working directory')}: ${escapeMarkdown(directive.cwd)}`,
      ]
    case 'git-create-branch':
    case 'git-push':
      return [
        `- ${codexDirectiveLabel(
          { ...directive, branch: escapeMarkdown(directive.branch) },
          translate,
        )}`,
        `  - ${translate('Working directory')}: ${escapeMarkdown(directive.cwd)}`,
      ]
    case 'git-create-pr':
      return [
        `- ${codexDirectiveLabel(directive, translate)}`,
        `  - ${translate('Working directory')}: ${escapeMarkdown(directive.cwd)}`,
        `  - ${translate('Branch')}: ${escapeMarkdown(directive.branch)}`,
        `  - ${translate('Pull request')}: ${escapeMarkdown(directive.url)}`,
      ]
    case 'created-thread': {
      const identifier = directive.threadId ?? directive.clientThreadId ?? ''
      return [
        `- ${codexDirectiveLabel(directive, translate)}`,
        `  - ${translate('Task')}: ${escapeMarkdown(identifier)}`,
      ]
    }
    case 'code-comment': {
      const range = directive.start === undefined
        ? null
        : directive.end === undefined
          ? String(directive.start)
          : `${directive.start}-${directive.end}`
      return [
        `- ${translate('Code comment: {title}', { title: escapeMarkdown(directive.title) })}`,
        `  - ${translate('Body')}: ${escapeMarkdown(directive.body)}`,
        `  - ${translate('File')}: ${escapeMarkdown(directive.file)}`,
        ...(range ? [`  - ${translate('Lines')}: ${escapeMarkdown(range)}`] : []),
        ...(directive.priority === undefined
          ? []
          : [`  - ${translate('Priority')}: ${escapeMarkdown(directive.priority)}`]),
      ]
    }
  }
}
