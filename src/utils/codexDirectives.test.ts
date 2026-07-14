import { describe, expect, it } from 'vitest'
import {
  codexDirectiveExportLines,
  codexDirectiveHref,
  codexDirectiveInvalidReason,
  codexDirectiveLabel,
  codexDirectiveLocation,
  parseCodexDirectiveText,
} from './codexDirectives'

const translate = (message: string, params?: Record<string, string | number>): string =>
  message.replace(/\{(\w+)\}/gu, (_, key: string) => String(params?.[key] ?? `{${key}}`))

describe('parseCodexDirectiveText', () => {
  it('preserves ordinary assistant Markdown byte-for-byte', () => {
    const source = '\n  Intro with intentional indentation.\n\n    const code = true\n    return code\n\n'

    expect(parseCodexDirectiveText(source)).toEqual({ text: source, directives: [] })
  })

  it('extracts the production git-push form from assistant prose', () => {
    expect(parseCodexDirectiveText([
      'Deployment complete.',
      '',
      '::git-push{cwd="/tmp/zonghang-codex-mobile-review" branch="main"}',
    ].join('\n'))).toEqual({
      text: 'Deployment complete.',
      directives: [{
        kind: 'git-push',
        cwd: '/tmp/zonghang-codex-mobile-review',
        branch: 'main',
      }],
    })
  })

  it.each([
    [
      'git-stage',
      '::git-stage{cwd="/tmp/repo"}',
      { kind: 'git-stage', cwd: '/tmp/repo' },
    ],
    [
      'git-commit',
      '::git-commit{cwd="/tmp/repo"}',
      { kind: 'git-commit', cwd: '/tmp/repo' },
    ],
    [
      'git-create-branch',
      '::git-create-branch{cwd="/tmp/repo" branch="feature/one"}',
      { kind: 'git-create-branch', cwd: '/tmp/repo', branch: 'feature/one' },
    ],
    [
      'git-push',
      '::git-push{cwd="/tmp/repo" branch="main"}',
      { kind: 'git-push', cwd: '/tmp/repo', branch: 'main' },
    ],
    [
      'git-create-pr',
      '::git-create-pr{cwd="/tmp/repo" branch="main" url="https://example.com/pull/1" isDraft="true"}',
      {
        kind: 'git-create-pr',
        cwd: '/tmp/repo',
        branch: 'main',
        url: 'https://example.com/pull/1',
        isDraft: true,
      },
    ],
    [
      'created-thread with a server id',
      '::created-thread{threadId="thread/one"}',
      { kind: 'created-thread', threadId: 'thread/one' },
    ],
    [
      'created-thread with a client id',
      '::created-thread{clientThreadId="client-one"}',
      { kind: 'created-thread', clientThreadId: 'client-one' },
    ],
    [
      'code-comment',
      '::code-comment{title="Fix this" body="The value is stale" file="src/a.ts" start="4" end="7" priority="2"}',
      {
        kind: 'code-comment',
        title: 'Fix this',
        body: 'The value is stale',
        file: 'src/a.ts',
        start: 4,
        end: 7,
        priority: 2,
      },
    ],
  ])('extracts %s', (_name, source, directive) => {
    expect(parseCodexDirectiveText(source)).toEqual({ text: '', directives: [directive] })
  })

  it('parses an unknown valid directive into ordered generic attributes', () => {
    expect(parseCodexDirectiveText(
      '::future-directive{phase="done" url="https://example.com"}',
    )).toEqual({
      text: '',
      directives: [{
        kind: 'generic',
        name: 'future-directive',
        attributes: [
          { key: 'phase', value: 'done', sensitive: false },
          { key: 'url', value: 'https://example.com', sensitive: false },
        ],
      }],
    })
  })

  it('redacts sensitive generic values before returning parsed state', () => {
    const parsed = parseCodexDirectiveText(
      '::future-auth{accessToken="do-not-retain" password="also-secret" phase="done"}',
    )

    expect(parsed.directives).toEqual([{
      kind: 'generic',
      name: 'future-auth',
      attributes: [
        { key: 'accessToken', value: '••••', sensitive: true },
        { key: 'password', value: '••••', sensitive: true },
        { key: 'phase', value: 'done', sensitive: false },
      ],
    }])
    expect(JSON.stringify(parsed)).not.toContain('do-not-retain')
    expect(JSON.stringify(parsed)).not.toContain('also-secret')
  })

  it('accepts an empty generic attribute set and preserves escaped values', () => {
    expect(parseCodexDirectiveText([
      '::future-empty{}',
      '::future-value{message="Say \\"hi\\"" path="C:\\\\repo"}',
    ].join('\n')).directives).toEqual([
      { kind: 'generic', name: 'future-empty', attributes: [] },
      {
        kind: 'generic',
        name: 'future-value',
        attributes: [
          { key: 'message', value: 'Say "hi"', sensitive: false },
          { key: 'path', value: 'C:\\repo', sensitive: false },
        ],
      },
    ])
  })

  it('extracts multiple directives in their original order', () => {
    expect(parseCodexDirectiveText([
      'Done.',
      '::git-stage{cwd="/tmp/repo"}',
      '::git-commit{cwd="/tmp/repo"}',
    ].join('\n'))).toEqual({
      text: 'Done.',
      directives: [
        { kind: 'git-stage', cwd: '/tmp/repo' },
        { kind: 'git-commit', cwd: '/tmp/repo' },
      ],
    })
  })

  it('preserves source order across typed, generic, and invalid directives', () => {
    expect(parseCodexDirectiveText([
      '::git-stage{cwd="/tmp/repo"}',
      '::future-directive{phase="done"}',
      '::git-push{cwd="/tmp/repo"}',
    ].join('\n')).directives).toEqual([
      { kind: 'git-stage', cwd: '/tmp/repo' },
      {
        kind: 'generic',
        name: 'future-directive',
        attributes: [{ key: 'phase', value: 'done', sensitive: false }],
      },
      { kind: 'invalid', name: 'git-push', reason: 'invalid-schema' },
    ])
  })

  it('decodes escaped quotes and backslashes in quoted values', () => {
    expect(parseCodexDirectiveText(
      '::code-comment{title="Say \\"hi\\"" body="Path C:\\\\repo" file="src/a.ts"}',
    ).directives).toEqual([{
      kind: 'code-comment',
      title: 'Say "hi"',
      body: 'Path C:\\repo',
      file: 'src/a.ts',
      start: undefined,
      end: undefined,
      priority: undefined,
    }])
  })

  it.each([
    ['missing required fields', '::git-push{cwd="/tmp/repo"}', 'git-push', 'invalid-schema'],
    ['duplicate attributes', '::future{x="1" x="2"}', 'future', 'invalid-syntax'],
    ['unknown known-directive fields', '::git-stage{cwd="/tmp/repo" branch="main"}', 'git-stage', 'invalid-schema'],
    ['trailing garbage', '::future{x="1"} nope', 'future', 'invalid-syntax'],
    ['malformed quoted values', '::git-stage{cwd=/tmp/repo}', 'git-stage', 'invalid-syntax'],
    ['an HTTP pull request URL', '::git-create-pr{cwd="/tmp/repo" branch="main" url="http://example.com/1" isDraft="false"}', 'git-create-pr', 'invalid-schema'],
    ['both created-thread ids', '::created-thread{threadId="one" clientThreadId="two"}', 'created-thread', 'invalid-schema'],
    ['an invalid code-comment range', '::code-comment{title="Title" body="Body" file="a.ts" start="7" end="4"}', 'code-comment', 'invalid-schema'],
    ['an invalid code-comment priority', '::code-comment{title="Title" body="Body" file="a.ts" priority="4"}', 'code-comment', 'invalid-schema'],
    ['an invalid name', '::Future{x="1"}', undefined, 'invalid-name'],
    ['incomplete final output', '::future{x="1"', 'future', 'incomplete'],
  ])('renders %s as a warning directive', (_label, source, name, reason) => {
    expect(parseCodexDirectiveText(source)).toEqual({
      text: '',
      directives: [{ kind: 'invalid', name, reason }],
    })
  })

  it('leaves an inline example visible', () => {
    const source = 'Use ::git-push{cwd="/tmp/repo" branch="main"} after review.'
    expect(parseCodexDirectiveText(source)).toEqual({ text: source, directives: [] })
  })

  it.each([
    ['backtick', ['```text', '::git-push{cwd="/tmp/repo" branch="main"}', '```']],
    ['tilde', ['~~~', '::git-push{cwd="/tmp/repo" branch="main"}', '~~~']],
    ['future backtick', ['```text', '::future-directive{phase="done"}', '```']],
    ['malformed tilde', ['~~~text', '::future-directive{phase="done"', '~~~']],
  ])('leaves directives inside a %s fence visible', (_name, lines) => {
    const source = lines.join('\n')
    expect(parseCodexDirectiveText(source)).toEqual({ text: source, directives: [] })
  })

  it('does not open a backtick fence when its info string contains a backtick', () => {
    expect(parseCodexDirectiveText([
      '```text`invalid',
      '::git-stage{cwd="/tmp/repo"}',
    ].join('\n'))).toEqual({
      text: '```text`invalid',
      directives: [{ kind: 'git-stage', cwd: '/tmp/repo' }],
    })
  })

  it('preserves prose before and after a recognized directive', () => {
    expect(parseCodexDirectiveText([
      'Before.',
      '::git-stage{cwd="/tmp/repo"}',
      'After.',
    ].join('\n'))).toEqual({
      text: 'Before.\nAfter.',
      directives: [{ kind: 'git-stage', cwd: '/tmp/repo' }],
    })
  })

  it('normalizes only blank-line separators around removed directives', () => {
    expect(parseCodexDirectiveText([
      '  Before.',
      '',
      '::git-stage{cwd="/tmp/repo"}',
      '',
      '    indented prose',
      '  trailing spaces  ',
    ].join('\n'))).toEqual({
      text: '  Before.\n\n    indented prose\n  trailing spaces  ',
      directives: [{ kind: 'git-stage', cwd: '/tmp/repo' }],
    })
  })

  it('withholds an incomplete supported directive only in live mode', () => {
    expect(parseCodexDirectiveText('Done.\n\n::git-pu', {
      suppressIncompleteTrailingDirective: true,
    })).toEqual({ text: 'Done.', directives: [] })

    expect(parseCodexDirectiveText('Done.\n\n::git-pu')).toEqual({
      text: 'Done.',
      directives: [{ kind: 'invalid', name: 'git-pu', reason: 'incomplete' }],
    })
  })

  it('withholds an unclosed supported directive in live mode', () => {
    expect(parseCodexDirectiveText('Done.\n::git-push{cwd="/tmp/repo"', {
      suppressIncompleteTrailingDirective: true,
    })).toEqual({ text: 'Done.', directives: [] })
  })

  it('does not treat a closing brace inside a quoted value as the directive closing brace', () => {
    expect(parseCodexDirectiveText('Done.\n::git-push{cwd="/tmp/}repo"', {
      suppressIncompleteTrailingDirective: true,
    })).toEqual({ text: 'Done.', directives: [] })

    expect(parseCodexDirectiveText(
      'Done.\n::git-push{cwd="/tmp/}repo" branch="main"}',
      { suppressIncompleteTrailingDirective: true },
    )).toEqual({
      text: 'Done.',
      directives: [{ kind: 'git-push', cwd: '/tmp/}repo', branch: 'main' }],
    })
  })

  it('withholds an incomplete future directive in live mode', () => {
    expect(parseCodexDirectiveText('Done.\n\n::future-directive', {
      suppressIncompleteTrailingDirective: true,
    })).toEqual({ text: 'Done.', directives: [] })
  })

  it('never withholds a trailing directive-like line inside a fence', () => {
    const source = '```\n::git-pu'
    expect(parseCodexDirectiveText(source, {
      suppressIncompleteTrailingDirective: true,
    })).toEqual({ text: source, directives: [] })
  })
})

describe('directive presentation helpers', () => {
  it('labels generic and invalid directives without granting links', () => {
    const generic = {
      kind: 'generic' as const,
      name: 'future-directive',
      attributes: [{ key: 'phase', value: 'done', sensitive: false }],
    }
    const invalid = {
      kind: 'invalid' as const,
      name: 'git-push',
      reason: 'invalid-schema' as const,
    }

    expect(codexDirectiveLabel(generic, translate)).toBe('Codex directive: future-directive')
    expect(codexDirectiveHref(generic)).toBeNull()
    expect(codexDirectiveLabel(invalid, translate)).toBe('Directive format error')
    expect(codexDirectiveInvalidReason(invalid, translate)).toBe('Invalid directive fields')
    expect(codexDirectiveHref(invalid)).toBeNull()
  })

  it('exports generic and invalid directives as readable Markdown', () => {
    expect(codexDirectiveExportLines({
      kind: 'generic',
      name: 'future-directive',
      attributes: [
        { key: 'phase', value: 'done', sensitive: false },
        { key: 'accessToken', value: '••••', sensitive: true },
      ],
    }, translate)).toEqual([
      '- Codex directive: future\\-directive',
      '  - phase: done',
      '  - accessToken: ••••',
    ])

    const invalidLines = codexDirectiveExportLines({
      kind: 'invalid',
      name: 'git-push',
      reason: 'invalid-schema',
    }, translate)
    expect(invalidLines).toEqual([
      '- Directive format error',
      '  - Directive name: git\\-push',
      '  - Invalid directive fields',
    ])
    expect(invalidLines.join('\n')).not.toContain('::')
  })

  it.each([
    ['file only', { kind: 'code-comment' as const, title: 'Title', body: 'Body', file: 'src/a.ts' }, 'src/a.ts'],
    ['single line', { kind: 'code-comment' as const, title: 'Title', body: 'Body', file: 'src/a.ts', start: 4 }, 'src/a.ts:4'],
    ['line range', { kind: 'code-comment' as const, title: 'Title', body: 'Body', file: 'src/a.ts', start: 4, end: 7 }, 'src/a.ts:4-7'],
  ])('formats a code-comment %s location', (_name, directive, expected) => {
    expect(codexDirectiveLocation(directive)).toBe(expected)
  })

  it('builds translated directive labels', () => {
    expect(codexDirectiveLabel(
      { kind: 'git-push', cwd: '/tmp/repo', branch: 'main' },
      translate,
    )).toBe('Pushed main')
    expect(codexDirectiveLabel(
      { kind: 'created-thread', clientThreadId: 'client-one' },
      translate,
    )).toBe('New task queued')
  })

  it('returns only safe links', () => {
    expect(codexDirectiveHref({
      kind: 'created-thread',
      threadId: 'thread/one',
    })).toBe('/#/thread/thread%2Fone')
    expect(codexDirectiveHref({
      kind: 'git-create-pr',
      cwd: '/tmp/repo',
      branch: 'main',
      url: 'https://example.com/pull/1',
      isDraft: false,
    })).toBe('https://example.com/pull/1')
    expect(codexDirectiveHref({ kind: 'git-stage', cwd: '/tmp/repo' })).toBeNull()
  })

  it('exports readable, escaped code-comment details without protocol syntax', () => {
    const lines = codexDirectiveExportLines({
      kind: 'code-comment',
      title: 'Review *this*',
      body: 'Use `safe` | [value] <now>!',
      file: String.raw`src\a_(one).ts`,
      start: 4,
      end: 7,
      priority: 2,
    }, translate)

    expect(lines.join('\n')).toContain('Review \\*this\\*')
    expect(lines.join('\n')).toContain('Use \\`safe\\` \\| \\[value\\] \\<now\\>\\!')
    expect(lines.join('\n')).toContain(String.raw`src\\a\_\(one\)\.ts`)
    expect(lines.join('\n')).toContain('4\\-7')
    for (const line of lines) {
      expect(line).not.toContain('::')
    }
  })
})
