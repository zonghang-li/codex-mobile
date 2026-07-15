# Typed Codex Directive Literals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render official Codex directives with unquoted boolean and integer attributes as specialized mobile notices instead of `Directive format error`.

**Architecture:** Extend the shared parser so every attribute retains a lexical kind (`quoted`, `boolean`, or `integer`), then enforce allowed kinds inside each known directive schema. Persisted messages and live deltas continue using the same parser; unknown generic directives remain quoted-string-only and non-interactive.

**Tech Stack:** TypeScript, Vue 3, Vitest, Vite, tsup, pnpm, systemd user service, Tailscale Serve.

## Global Constraints

- The only new bare forms are exact `true`, exact `false`, and non-negative base-10 integers.
- Known string fields remain quoted-only.
- Only `git-create-pr.isDraft` accepts a boolean literal; quoted `"true"` and `"false"` remain compatible.
- Only `code-comment.start`, `code-comment.end`, and `code-comment.priority` accept integer literals; quoted integers remain compatible.
- Unknown generic directives remain quoted-string-only; typed generic attributes become `invalid-syntax`.
- Existing exact-key, required-field, HTTPS URL, positive line, range, and priority validation remains authoritative.
- No directive is executed and no new action or link is granted.
- Do not change authentication, listeners, state schema, notification configuration, or Tailscale exposure.
- Do not commit build output, service state, logs, screenshots, passwords, ntfy URLs/topics, or review artifacts.

---

### Task 1: Parse and Strictly Validate Official Typed Literals

**Files:**
- Modify: `src/utils/codexDirectives.ts`
- Test: `src/utils/codexDirectives.test.ts`

**Interfaces:**
- Consumes: standalone assistant lines passed to `parseCodexDirectiveText(value, options)`.
- Produces: unchanged `ParsedCodexDirectiveText` and `UiCodexDirective` public shapes.
- Internal: `ParsedDirectiveAttribute` retains `value` and `syntax` through schema validation.

- [ ] **Step 1: Add failing success-path tests**

Add to `describe('parseCodexDirectiveText')`:

```ts
it.each([
  [
    'ready pull request boolean',
    '::git-create-pr{cwd="/tmp/repo" branch="feature/one" url="https://example.com/pull/1" isDraft=false}',
    {
      kind: 'git-create-pr', cwd: '/tmp/repo', branch: 'feature/one',
      url: 'https://example.com/pull/1', isDraft: false,
    },
  ],
  [
    'draft pull request boolean',
    '::git-create-pr{cwd="/tmp/repo" branch="feature/two" url="https://example.com/pull/2" isDraft=true}',
    {
      kind: 'git-create-pr', cwd: '/tmp/repo', branch: 'feature/two',
      url: 'https://example.com/pull/2', isDraft: true,
    },
  ],
  [
    'code comment integers',
    '::code-comment{title="Fix" body="Body" file="src/a.ts" start=4 end=7 priority=2}',
    {
      kind: 'code-comment', title: 'Fix', body: 'Body', file: 'src/a.ts',
      start: 4, end: 7, priority: 2,
    },
  ],
] as const)('extracts official %s', (_label, source, directive) => {
  expect(parseCodexDirectiveText(source)).toEqual({ text: '', directives: [directive] })
})
```

Keep the existing quoted PR boolean and code-comment integer rows unchanged as
legacy-compatibility assertions.

- [ ] **Step 2: Add failing boundary tests**

Add:

```ts
it.each([
  ['boolean in a string field', '::git-push{cwd=true branch="main"}', 'git-push', 'invalid-schema'],
  ['integer in a string field', '::git-stage{cwd=123}', 'git-stage', 'invalid-schema'],
  ['typed unknown attribute', '::future-directive{enabled=true}', 'future-directive', 'invalid-syntax'],
  ['decimal literal', '::code-comment{title="Fix" body="Body" file="a.ts" start=1.5}', 'code-comment', 'invalid-syntax'],
  ['signed integer', '::code-comment{title="Fix" body="Body" file="a.ts" start=-1}', 'code-comment', 'invalid-syntax'],
  ['bare word', '::git-create-pr{cwd="/tmp/repo" branch="main" url="https://example.com/1" isDraft=no}', 'git-create-pr', 'invalid-syntax'],
] as const)('rejects %s', (_label, source, name, reason) => {
  expect(parseCodexDirectiveText(source)).toEqual({
    text: '',
    directives: [{ kind: 'invalid', name, reason }],
  })
})
```

- [ ] **Step 3: Run the parser tests and verify RED**

```bash
pnpm exec vitest run src/utils/codexDirectives.test.ts
```

Expected: official typed rows fail as `invalid-syntax`; typed values in known
string fields also report syntax rather than schema errors.

- [ ] **Step 4: Retain lexical kinds**

Replace the internal attribute types with:

```ts
type ParsedDirectiveAttributeSyntax = 'quoted' | 'boolean' | 'integer'
type ParsedDirectiveAttribute = {
  value: string
  syntax: ParsedDirectiveAttributeSyntax
}
type ParsedDirectiveAttributes = {
  values: Record<string, ParsedDirectiveAttribute>
  ordered: Array<{ key: string } & ParsedDirectiveAttribute>
}
```

In `readAttributes()`, declare `let value = ''` and
`let syntax: ParsedDirectiveAttributeSyntax` after `key=`. Retain the existing
quoted scanner inside `if (source[index] === '"')`, assigning
`syntax = 'quoted'` before consuming the opening quote. In its `else` branch,
parse only:

```ts
const remainder = source.slice(index)
const booleanMatch = /^(?:true|false)(?=\s|$)/u.exec(remainder)
const integerMatch = /^\d+(?=\s|$)/u.exec(remainder)
const literal = booleanMatch?.[0] ?? integerMatch?.[0]
if (!literal) return null
value = literal
syntax = booleanMatch ? 'boolean' : 'integer'
index += literal.length
```

Store `values[key] = { value, syntax }` and
`ordered.push({ key, value, syntax })`. Preserve duplicate-key, whitespace,
escape, and closing-quote checks.

- [ ] **Step 5: Add one strict attribute reader**

Add beside `hasOnlyKeys()`:

```ts
function readAttribute(
  attributes: ParsedDirectiveAttributes,
  key: string,
  allowedSyntax: readonly ParsedDirectiveAttributeSyntax[],
): string | undefined | null {
  const attribute = attributes.values[key]
  if (!attribute) return undefined
  return allowedSyntax.includes(attribute.syntax) ? attribute.value : null
}
```

Widen `hasOnlyKeys()` without changing its behavior:

```ts
function hasOnlyKeys(attributes: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed)
  return Object.keys(attributes).every((key) => allowedSet.has(key))
}
```

Keep `toGenericDirective()` output unchanged by mapping only `key` and `value`
from the new ordered entries.

- [ ] **Step 6: Enforce lexical kinds in known schemas**

Change `toDirective()` to receive `ParsedDirectiveAttributes`. Use:

```ts
const quoted = ['quoted'] as const
const legacyBoolean = ['quoted', 'boolean'] as const
const legacyInteger = ['quoted', 'integer'] as const
```

Require quoted syntax for all string fields. Read PR state with:

```ts
const isDraft = readAttribute(attributes, 'isDraft', legacyBoolean)
if (isDraft !== 'true' && isDraft !== 'false') return null
```

Read code-comment numerics with:

```ts
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
```

Use `hasOnlyKeys(attributes.values, allowedKeys)` and preserve the existing URL,
required-field, range, and priority checks.

- [ ] **Step 7: Keep generic directives quoted-only**

In `readDirective()`, use:

```ts
if (!SUPPORTED_DIRECTIVE_NAMES.includes(name as typeof SUPPORTED_DIRECTIVE_NAMES[number])) {
  return attributes.ordered.every(({ syntax }) => syntax === 'quoted')
    ? toGenericDirective(name, attributes.ordered)
    : { kind: 'invalid', name, reason: 'invalid-syntax' }
}
return toDirective(name, attributes)
  ?? { kind: 'invalid', name, reason: 'invalid-schema' }
```

- [ ] **Step 8: Verify GREEN and commit**

```bash
pnpm exec vitest run src/utils/codexDirectives.test.ts
git diff --check
git add src/utils/codexDirectives.ts src/utils/codexDirectives.test.ts
git commit -m "fix: parse typed Codex directive literals"
```

Expected: all parser and presentation tests pass.

---

### Task 2: Prove Persisted and Live Rendering

**Files:**
- Test: `src/api/normalizers/v2.test.ts`
- Test: `src/composables/useDesktopState.test.ts`
- Modify: `tests/thread-loading-state/mobile-codex-directive-notices.md`

**Interfaces:**
- Consumes: Task 1 through existing persisted and realtime parser calls.
- Produces: identical specialized directives with no raw protocol fragment.

- [ ] **Step 1: Add a persisted regression**

Add to `describe('normalizeThreadMessagesV2')`:

```ts
it('normalizes official typed pull-request and code-comment literals', () => {
  const messages = normalizeThreadMessagesV2(threadReadResponseWithContent([{
    type: 'agentMessage',
    id: 'assistant-typed-directives',
    text: [
      'Done.',
      '::git-create-pr{cwd="/tmp/repo" branch="feature/one" url="https://example.com/pull/1" isDraft=false}',
      '::code-comment{title="Fix" body="Body" file="src/a.ts" start=4 end=7 priority=2}',
    ].join('\n'),
  }]))

  expect(messages[0]).toMatchObject({
    text: 'Done.',
    directives: [
      { kind: 'git-create-pr', url: 'https://example.com/pull/1', isDraft: false },
      { kind: 'code-comment', file: 'src/a.ts', start: 4, end: 7, priority: 2 },
    ],
  })
})
```

- [ ] **Step 2: Add a split-live regression**

Add to `describe('Codex directive notification state')`:

```ts
it('withholds and then renders a split typed pull-request directive', async () => {
  const { state, emit } = await setupCodexDirectiveNotificationState()
  emit({
    method: 'item/agentMessage/delta',
    params: {
      threadId: 'thread-1', itemId: 'agent-typed-pr',
      delta: 'Done.\n::git-create-pr{cwd="/tmp/repo" branch="feature/one" url="https://example.com/pull/1" isDr',
    },
  })
  expect(state.messages.value.at(-1)).toMatchObject({ text: 'Done.' })
  expect(state.messages.value.at(-1)?.directives).toBeUndefined()

  emit({
    method: 'item/agentMessage/delta',
    params: { threadId: 'thread-1', itemId: 'agent-typed-pr', delta: 'aft=false}' },
  })
  expect(state.messages.value.at(-1)).toMatchObject({
    text: 'Done.',
    directives: [{ kind: 'git-create-pr', url: 'https://example.com/pull/1', isDraft: false }],
  })
})
```

- [ ] **Step 3: Run integration tests**

```bash
pnpm exec vitest run src/api/normalizers/v2.test.ts src/composables/useDesktopState.test.ts
```

Expected: both files pass; no live partial `::git-create-pr` fragment is shown.

- [ ] **Step 4: Update manual acceptance**

In `tests/thread-loading-state/mobile-codex-directive-notices.md`, add the exact
unquoted PR boolean and code-comment integer forms. Require the specialized
linked PR card and code-comment location, with neither `Directive format error`
nor raw `::` syntax.

- [ ] **Step 5: Run focused suite and commit**

```bash
pnpm exec vitest run src/utils/codexDirectives.test.ts src/api/normalizers/v2.test.ts src/composables/useDesktopState.test.ts src/components/content/codexDirectiveNotices.wiring.test.ts src/components/content/codexDirectiveExport.wiring.test.ts
git diff --check
git add src/api/normalizers/v2.test.ts src/composables/useDesktopState.test.ts tests/thread-loading-state/mobile-codex-directive-notices.md
git commit -m "test: cover typed directive rendering"
```

Expected: all five files pass.

---

### Task 3: Review, Merge, and Safe Deployment

**Files:**
- Do not modify tracked files unless review finds a concrete defect.

**Interfaces:**
- Consumes: Tasks 1-2 on `codex/fix-typed-directive-literals`.
- Produces: reviewed PR, synchronized `main`, and verified Tailnet-only service.

- [ ] **Step 1: Run complete verification**

```bash
pnpm run test:unit
pnpm exec vue-tsc --noEmit
pnpm exec tsc --noEmit -p tsconfig.server.json
pnpm run build
node dist-cli/safe.js doctor
git diff --check
git status --short
```

Expected: all tests/type checks pass; build has at most the existing chunk-size
warning; doctor prints `codex-mobile-safe doctor: ok`; tree is clean.

- [ ] **Step 2: Request whole-branch review**

Review `origin/main..HEAD` against the design and this plan. Fix every Critical
or Important finding with a failing regression first, rerun its focused suite,
and repeat review until none remain.

- [ ] **Step 3: Push and create the PR**

```bash
git fetch --prune origin
git rebase origin/main
git push -u origin codex/fix-typed-directive-literals
gh pr create --repo zonghang-li/codex-mobile --base main --head codex/fix-typed-directive-literals --title "Fix typed Codex directive literals" --body "Accepts official unquoted boolean and integer directive attributes under strict known schemas, with persisted and live rendering regression coverage."
gh pr comment codex/fix-typed-directive-literals --repo zonghang-li/codex-mobile --body "/review"
gh pr view codex/fix-typed-directive-literals --repo zonghang-li/codex-mobile --json state,mergeable,statusCheckRollup,url
```

- [ ] **Step 4: Merge and synchronize main**

```bash
gh pr merge codex/fix-typed-directive-literals --repo zonghang-li/codex-mobile --rebase --delete-branch
git fetch --prune origin
git switch main
git merge --ff-only origin/main
```

Expected: PR merged and local `main` equals `origin/main`.

- [ ] **Step 5: Check pending state before restart**

```bash
jq '{pending_count:(.pending|length)}' /home/zonghangli/.codex-mobile-safe/ntfy-notifier.json
```

Expected: `pending_count` is `0`; otherwise stop without editing or sending it.

- [ ] **Step 6: Reinstall and verify service**

```bash
pnpm run service:install
codex-mobile-safe doctor
codex-mobile-safe status
ss -ltnp '( sport = :5900 )'
tailscale serve status
jq '{pending_count:(.pending|length)}' /home/zonghangli/.codex-mobile-safe/ntfy-notifier.json
```

Expected: active service, loopback-only port 5900, Tailnet-only Serve, doctor
OK, and pending count still zero.

- [ ] **Step 7: Perform mobile acceptance**

Reopen the completed message. Its unquoted `isDraft=false` PR directive must be
a specialized HTTPS-linked PR card, not `Directive format error`. A synthetic
code-comment with unquoted numeric fields must show file/range/priority; fenced
and inline examples remain literal.
