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

type ParsedDirectiveAttributeSyntax = 'quoted' | 'boolean' | 'integer'
type ParsedDirectiveAttribute = {
  value: string
  syntax: ParsedDirectiveAttributeSyntax
}
type ParsedDirectiveAttributes = {
  values: Record<string, ParsedDirectiveAttribute>
  ordered: Array<{ key: string } & ParsedDirectiveAttribute>
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

function hasOnlyKeys(attributes: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed)
  return Object.keys(attributes).every((key) => allowedSet.has(key))
}

function readAttribute(
  attributes: ParsedDirectiveAttributes,
  key: string,
  allowedSyntax: readonly ParsedDirectiveAttributeSyntax[],
): string | undefined | null {
  const attribute = attributes.values[key]
  if (!attribute) return undefined
  return allowedSyntax.includes(attribute.syntax) ? attribute.value : null
}

function isHttpsUrl(value: string | undefined | null): value is string {
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
  const values: Record<string, ParsedDirectiveAttribute> = {}
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
    let value = ''
    let syntax: ParsedDirectiveAttributeSyntax
    if (source[index] === '"') {
      syntax = 'quoted'
      index += 1

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
    } else {
      const remainder = source.slice(index)
      const booleanMatch = /^(?:true|false)(?=\s|$)/u.exec(remainder)
      const integerMatch = /^\d+(?=\s|$)/u.exec(remainder)
      const literal = booleanMatch?.[0] ?? integerMatch?.[0]
      if (!literal) return null
      value = literal
      syntax = booleanMatch ? 'boolean' : 'integer'
      index += literal.length
    }
    values[key] = { value, syntax }
    ordered.push({ key, value, syntax })
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
  attributes: ParsedDirectiveAttributes,
): UiCodexDirective | null {
  const quoted = ['quoted'] as const
  const legacyBoolean = ['quoted', 'boolean'] as const
  const legacyInteger = ['quoted', 'integer'] as const

  switch (name) {
    case 'git-stage':
    case 'git-commit': {
      const cwd = readAttribute(attributes, 'cwd', quoted)
      return hasOnlyKeys(attributes.values, ['cwd']) && cwd
        ? { kind: name, cwd }
        : null
    }
    case 'git-create-branch':
    case 'git-push': {
      const cwd = readAttribute(attributes, 'cwd', quoted)
      const branch = readAttribute(attributes, 'branch', quoted)
      return hasOnlyKeys(attributes.values, ['cwd', 'branch']) && cwd && branch
        ? { kind: name, cwd, branch }
        : null
    }
    case 'git-create-pr': {
      if (!hasOnlyKeys(attributes.values, ['cwd', 'branch', 'url', 'isDraft'])) return null
      const cwd = readAttribute(attributes, 'cwd', quoted)
      const branch = readAttribute(attributes, 'branch', quoted)
      const url = readAttribute(attributes, 'url', quoted)
      const isDraft = readAttribute(attributes, 'isDraft', legacyBoolean)
      if (!cwd || !branch || !isHttpsUrl(url)) return null
      if (isDraft !== 'true' && isDraft !== 'false') return null
      return {
        kind: name,
        cwd,
        branch,
        url,
        isDraft: isDraft === 'true',
      }
    }
    case 'created-thread': {
      if (!hasOnlyKeys(attributes.values, ['threadId', 'clientThreadId'])) return null
      const threadId = readAttribute(attributes, 'threadId', quoted)
      const clientThreadId = readAttribute(attributes, 'clientThreadId', quoted)
      if (threadId === null || clientThreadId === null) return null
      if (Boolean(threadId) === Boolean(clientThreadId)) return null
      return threadId
        ? { kind: name, threadId }
        : { kind: name, clientThreadId }
    }
    case 'code-comment': {
      if (!hasOnlyKeys(attributes.values, ['title', 'body', 'file', 'start', 'end', 'priority'])) return null
      const title = readAttribute(attributes, 'title', quoted)
      const body = readAttribute(attributes, 'body', quoted)
      const file = readAttribute(attributes, 'file', quoted)
      if (!title || !body || !file) return null
      const startText = readAttribute(attributes, 'start', legacyInteger)
      const endText = readAttribute(attributes, 'end', legacyInteger)
      const priorityText = readAttribute(attributes, 'priority', legacyInteger)
      if (startText === null || endText === null || priorityText === null) return null
      const start = readPositiveInteger(startText)
      const end = readPositiveInteger(endText)
      const priority = priorityText === undefined
        ? undefined
        : /^(?:0|1|2|3)$/u.test(priorityText)
          ? Number.parseInt(priorityText, 10)
          : null
      if (start === null || end === null || priority === null) return null
      if (end !== undefined && start === undefined) return null
      if (start !== undefined && end !== undefined && end < start) return null
      return {
        kind: name,
        title,
        body,
        file,
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
    return attributes.ordered.every(({ syntax }) => syntax === 'quoted')
      ? toGenericDirective(name, attributes.ordered)
      : { kind: 'invalid', name, reason: 'invalid-syntax' }
  }
  return toDirective(name, attributes)
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
