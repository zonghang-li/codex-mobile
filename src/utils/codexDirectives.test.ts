import { describe, expect, it } from 'vitest'
import {
  codexDirectiveExportLines,
  codexDirectiveHref,
  codexDirectiveLabel,
  parseCodexDirectiveText,
} from './codexDirectives'

const translate = (message: string, params?: Record<string, string | number>): string =>
  message.replace(/\{(\w+)\}/gu, (_, key: string) => String(params?.[key] ?? `{${key}}`))

describe('parseCodexDirectiveText', () => {
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
    ['an inline example', 'Use ::git-push{cwd="/tmp/repo" branch="main"} after review.'],
    ['an unknown name', '::future-directive{cwd="/tmp/repo"}'],
    ['a missing required attribute', '::git-push{cwd="/tmp/repo"}'],
    ['a duplicate attribute', '::git-stage{cwd="/tmp/repo" cwd="/tmp/other"}'],
    ['an unknown attribute', '::git-stage{cwd="/tmp/repo" branch="main"}'],
    ['trailing garbage', '::git-stage{cwd="/tmp/repo"} nope'],
    ['a malformed quoted value', '::git-stage{cwd=/tmp/repo}'],
    ['an HTTP pull request URL', '::git-create-pr{cwd="/tmp/repo" branch="main" url="http://example.com/1" isDraft="false"}'],
    ['both created-thread ids', '::created-thread{threadId="one" clientThreadId="two"}'],
    ['an invalid code-comment range', '::code-comment{title="Title" body="Body" file="a.ts" start="7" end="4"}'],
    ['an invalid code-comment priority', '::code-comment{title="Title" body="Body" file="a.ts" priority="4"}'],
  ])('leaves %s visible', (_name, source) => {
    expect(parseCodexDirectiveText(source)).toEqual({ text: source, directives: [] })
  })

  it.each([
    ['backtick', ['```text', '::git-push{cwd="/tmp/repo" branch="main"}', '```']],
    ['tilde', ['~~~', '::git-push{cwd="/tmp/repo" branch="main"}', '~~~']],
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

  it('withholds an incomplete supported directive only in live mode', () => {
    expect(parseCodexDirectiveText('Done.\n\n::git-pu', {
      suppressIncompleteTrailingDirective: true,
    })).toEqual({ text: 'Done.', directives: [] })

    expect(parseCodexDirectiveText('Done.\n\n::git-pu')).toEqual({
      text: 'Done.\n\n::git-pu',
      directives: [],
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

  it('does not withhold an incomplete unsupported directive in live mode', () => {
    expect(parseCodexDirectiveText('Done.\n\n::future-directive', {
      suppressIncompleteTrailingDirective: true,
    }).text).toContain('::future-directive')
  })

  it('never withholds a trailing directive-like line inside a fence', () => {
    const source = '```\n::git-pu'
    expect(parseCodexDirectiveText(source, {
      suppressIncompleteTrailingDirective: true,
    })).toEqual({ text: source, directives: [] })
  })
})

describe('directive presentation helpers', () => {
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
