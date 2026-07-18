# Ntfy Conversation Title Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every qualifying long-task ntfy notification title identify the completed top-level conversation by its user-visible name, with a deterministic thread-ID fallback.

**Architecture:** Add one shared title-format module used by both the notifier and durable-state validator. Enrich the existing notifier-only `thread/read` result with the merged desktop/mobile title cache, then compose the rendered ntfy title from the verified top-level thread without adding another Codex RPC or AI call.

**Tech Stack:** TypeScript, Node.js, Vitest, Codex app-server v2 RPC, existing atomic ntfy JSON state, systemd user service, Tailscale Serve.

## Global Constraints

- Preserve the notification threshold at exactly `600_000` ms.
- Preserve the deterministic assistant-summary body and its 180-code-point maximum.
- Result prefixes remain exactly `Codex 任务完成`, `Codex 任务失败`, and `Codex 任务已中断`.
- Conversation labels contain at most 80 Unicode code points.
- Name precedence is cached `notificationTitle`, then `thread.name`, then `thread.title`, then `未命名会话（<last 8 thread-ID code points>）`.
- Never use `preview`, prompt text, working directory, project name, or assistant text as the conversation name.
- Do not add a Codex RPC, AI request, incoming endpoint, public exposure, log content, or unbounded durable state.
- Preserve top-level-only filtering, logical deduplication, stable sequence IDs, five-second send timeout, three immediate attempts, and 256-record collection caps.
- Keep `codex-mobile-safe` bound to `127.0.0.1:5900` and Tailscale Serve tailnet-only.

---

### Task 1: Shared Title Contract and Durable-State Compatibility

**Files:**
- Create: `src/safe/ntfyTitle.ts`
- Create: `src/safe/ntfyTitle.test.ts`
- Modify: `src/safe/ntfyState.ts`
- Modify: `src/safe/ntfyState.test.ts`

**Interfaces:**
- Produces: `NtfyResultTitle`, `NTFY_RESULT_TITLES`, `NTFY_THREAD_LABEL_MAX_LENGTH`, `normalizeNtfyThreadLabelCandidate(value)`, `resolveNtfyThreadLabel(candidates, threadId)`, `composeNtfyNotificationTitle(resultTitle, label)`, and `isValidNtfyNotificationTitle(value)`.
- Changes: `PendingNtfyRecord.title` from the three-value literal union to `string`, validated at every state load/save boundary.
- Preserves: legacy fixed pending titles remain valid and retry unchanged.

- [ ] **Step 1: Write failing normalization and composition tests**

Create `src/safe/ntfyTitle.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  NTFY_THREAD_LABEL_MAX_LENGTH,
  composeNtfyNotificationTitle,
  isValidNtfyNotificationTitle,
  resolveNtfyThreadLabel,
} from './ntfyTitle'

describe('ntfy conversation titles', () => {
  it('uses the first normalized non-empty title candidate', () => {
    expect(resolveNtfyThreadLabel([
      '  桌面\n  会话\u0000名称  ',
      'secondary',
    ], 'thread-12345678')).toBe('桌面 会话 名称')
  })

  it('truncates labels by Unicode code point', () => {
    expect(resolveNtfyThreadLabel([
      '😀'.repeat(NTFY_THREAD_LABEL_MAX_LENGTH + 10),
    ], 'thread-12345678')).toBe('😀'.repeat(NTFY_THREAD_LABEL_MAX_LENGTH))
  })

  it('falls back to the final eight thread-ID code points', () => {
    expect(resolveNtfyThreadLabel(['\n\u0000'], 'thread-12345678'))
      .toBe('未命名会话（12345678）')
  })

  it.each([
    ['Codex 任务完成', 'Codex 任务完成：修复状态同步'],
    ['Codex 任务失败', 'Codex 任务失败：修复状态同步'],
    ['Codex 任务已中断', 'Codex 任务已中断：修复状态同步'],
  ] as const)('composes %s with the label', (prefix, expected) => {
    expect(composeNtfyNotificationTitle(prefix, '修复状态同步')).toBe(expected)
    expect(isValidNtfyNotificationTitle(expected)).toBe(true)
  })

  it.each([
    'Codex unknown：会话',
    'Codex 任务完成：',
    'Codex 任务完成：bad\nname',
    `Codex 任务完成：${'A'.repeat(NTFY_THREAD_LABEL_MAX_LENGTH + 1)}`,
  ])('rejects malformed durable title %j', (title) => {
    expect(isValidNtfyNotificationTitle(title)).toBe(false)
  })

  it.each(['Codex 任务完成', 'Codex 任务失败', 'Codex 任务已中断'])
    ('accepts legacy durable title %s', (title) => {
      expect(isValidNtfyNotificationTitle(title)).toBe(true)
    })
})
```

- [ ] **Step 2: Run the new title test and verify RED**

Run: `pnpm vitest run src/safe/ntfyTitle.test.ts`

Expected: FAIL because `src/safe/ntfyTitle.ts` does not exist.

- [ ] **Step 3: Implement the minimal shared title module**

Create `src/safe/ntfyTitle.ts`:

```ts
export const NTFY_RESULT_TITLES = [
  'Codex 任务完成',
  'Codex 任务失败',
  'Codex 任务已中断',
] as const
export type NtfyResultTitle = typeof NTFY_RESULT_TITLES[number]
export const NTFY_THREAD_LABEL_MAX_LENGTH = 80

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu

function truncateCodePoints(value: string, maximum: number): string {
  return Array.from(value).slice(0, maximum).join('')
}

export function normalizeNtfyThreadLabelCandidate(value: unknown): string {
  if (typeof value !== 'string') return ''
  return truncateCodePoints(
    value.replace(CONTROL_CHARACTERS, ' ').replace(/\s+/gu, ' ').trim(),
    NTFY_THREAD_LABEL_MAX_LENGTH,
  )
}

export function resolveNtfyThreadLabel(candidates: readonly unknown[], threadId: string): string {
  for (const candidate of candidates) {
    const normalized = normalizeNtfyThreadLabelCandidate(candidate)
    if (normalized) return normalized
  }
  const suffix = Array.from(threadId.trim()).slice(-8).join('')
  return `未命名会话（${suffix}）`
}

export function composeNtfyNotificationTitle(
  resultTitle: NtfyResultTitle,
  label: string,
): string {
  return `${resultTitle}：${label}`
}

export function isValidNtfyNotificationTitle(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if ((NTFY_RESULT_TITLES as readonly string[]).includes(value)) return true
  for (const resultTitle of NTFY_RESULT_TITLES) {
    const prefix = `${resultTitle}：`
    if (!value.startsWith(prefix)) continue
    const label = value.slice(prefix.length)
    return label.length > 0 && normalizeNtfyThreadLabelCandidate(label) === label
  }
  return false
}
```

- [ ] **Step 4: Run title tests and verify GREEN**

Run: `pnpm vitest run src/safe/ntfyTitle.test.ts`

Expected: the new file passes.

- [ ] **Step 5: Write failing durable-state compatibility tests**

Extend `src/safe/ntfyState.test.ts`, using its existing private state-file harness:

```ts
it('loads a pending notification with a rendered conversation title', async () => {
  const path = await temporaryStatePath()
  const store = new FileNtfyStateStore(path)
  await store.save(createEmptyNtfyState())
  const state = populatedState()
  state.pending[0] = { ...state.pending[0]!, title: 'Codex 任务完成：状态同步修复' }
  await writeFile(path, JSON.stringify(state), { mode: 0o600 })
  await expect(store.load()).resolves.toEqual(state)
})

it.each([
  'Codex unknown：状态同步修复',
  'Codex 任务完成：bad\nname',
  `Codex 任务完成：${'A'.repeat(81)}`,
])('rejects unsafe pending title %j', async (title) => {
  const path = await temporaryStatePath()
  const warn = vi.fn()
  const store = new FileNtfyStateStore(path, warn)
  await store.save(createEmptyNtfyState())
  const state = populatedState()
  state.pending[0] = { ...state.pending[0]!, title }
  await writeFile(path, JSON.stringify(state), { mode: 0o600 })
  await expect(store.load()).resolves.toEqual(createEmptyNtfyState())
  expect(warn).toHaveBeenCalledWith('Unable to load ntfy notifier state; starting with empty state')
})
```

- [ ] **Step 6: Run state tests and verify RED**

Run: `pnpm vitest run src/safe/ntfyState.test.ts`

Expected: the rendered conversation title is rejected by the old three-title set.

- [ ] **Step 7: Wire durable state to the shared validator**

In `src/safe/ntfyState.ts`, import `isValidNtfyNotificationTitle`, change `PendingNtfyRecord.title` to `string`, remove the local `TITLES` set, and replace the old check with:

```ts
&& isValidNtfyNotificationTitle(value.title)
```

- [ ] **Step 8: Run Task 1 tests and verify GREEN**

Run: `pnpm vitest run src/safe/ntfyTitle.test.ts src/safe/ntfyState.test.ts`

Expected: both files pass, including legacy-state fixtures.

- [ ] **Step 9: Commit the shared contract**

```bash
git add src/safe/ntfyTitle.ts src/safe/ntfyTitle.test.ts \
  src/safe/ntfyState.ts src/safe/ntfyState.test.ts
git commit -m "feat: validate ntfy conversation titles"
```

---

### Task 2: Notifier Conversation-Aware Titles

**Files:**
- Modify: `src/server/ntfyCompletionNotifier.ts`
- Modify: `src/server/ntfyCompletionNotifier.test.ts`

**Interfaces:**
- Consumes: `NtfyResultTitle`, `composeNtfyNotificationTitle`, and `resolveNtfyThreadLabel` from Task 1.
- Produces: every newly persisted pending record has a rendered result-plus-conversation title.
- Preserves: body, timestamp, sequence ID, headers, summary extraction, fallback body, hierarchy verification, and duration qualification.

- [ ] **Step 1: Write failing notifier-title tests**

Replace the existing `maps %s to the exact title %s` case in `long-turn notification decisions` with the following rendered-title case, then add the fallback case:

```ts
it.each([
  ['completed', 'Codex 任务完成：移动端状态同步'],
  ['failed', 'Codex 任务失败：移动端状态同步'],
  ['cancelled', 'Codex 任务已中断：移动端状态同步'],
] as const)('includes the conversation name for %s', async (status, title) => {
  const fixture = await runTurn(NTFY_MIN_DURATION_MS, {
    readThread: async () => ({
      thread: {
        parentThreadId: null,
        source: 'appServer',
        notificationTitle: '移动端状态同步',
        name: 'lower-priority name',
        title: 'lower-priority title',
        turns: [{ id: 'turn-1', items: [{ type: 'agentMessage', text: '工作完成。' }] }],
      },
    }),
  }, status)
  expect(fixture.send.mock.calls[0]?.[0].record).toMatchObject({
    title,
    message: '工作完成。',
  })
})

it('falls back to an identifiable unnamed conversation label', async () => {
  const fixture = await runTurn(NTFY_MIN_DURATION_MS, {
    readThread: async () => topLevelThread([
      { id: 'turn-1', items: [{ type: 'agentMessage', text: '工作完成。' }] },
    ]),
  })
  expect(fixture.send.mock.calls[0]?.[0].record.title)
    .toBe('Codex 任务完成：未命名会话（thread-1）')
})
```

In the existing interrupted observed-turn assertion, change only `title: 'Codex 任务已中断'` to `title: 'Codex 任务已中断：未命名会话（thread-1）'`. In `extracts snake-case and nested identifiers`, change only the expected title to `Codex 任务失败：未命名会话（d-thread）`. Leave all message-body assertions unchanged.

- [ ] **Step 2: Run notifier tests and verify RED**

Run: `pnpm vitest run src/server/ntfyCompletionNotifier.test.ts`

Expected: FAIL because pending records still use only the fixed result title.

- [ ] **Step 3: Compose the title from the verified thread**

Import Task 1 helpers and type. Change `classifyStatus` to return `NtfyResultTitle`. After top-level classification succeeds, compute:

```ts
const threadLabel = resolveNtfyThreadLabel([
  thread?.notificationTitle,
  thread?.name,
  thread?.title,
], event.threadId)
const title = composeNtfyNotificationTitle(classification.title, threadLabel)
```

Persist `title` instead of `classification.title`. Do not read `thread.preview`.

- [ ] **Step 4: Run notifier and state tests and verify GREEN**

Run:

```bash
pnpm vitest run src/safe/ntfyTitle.test.ts src/safe/ntfyState.test.ts \
  src/server/ntfyCompletionNotifier.test.ts
```

Expected: all three files pass; threshold, retry, hierarchy, summary, and deduplication remain green.

- [ ] **Step 5: Commit notifier behavior**

```bash
git add src/server/ntfyCompletionNotifier.ts src/server/ntfyCompletionNotifier.test.ts
git commit -m "feat: identify conversations in ntfy alerts"
```

---

### Task 3: Enrich Notifier Reads with the Merged Title Cache

**Files:**
- Modify: `src/server/codexAppServerBridge.ts`
- Create: `src/server/codexAppServerBridge.notifierTitle.test.ts`
- Modify: `src/safe/doctor.ts`
- Modify: `src/safe/doctor.test.ts`

**Interfaces:**
- Produces: `augmentThreadReadWithNotificationTitle(result, title): unknown` and notifier-only `notificationTitle` data.
- Consumes: existing `readMergedThreadTitleCache()` and existing `appServer.rpc('thread/read', { threadId, includeTurns: true })`.
- Preserves: exactly one Codex `thread/read` RPC per qualifying notification.

- [ ] **Step 1: Write failing pure enrichment tests**

Create `src/server/codexAppServerBridge.notifierTitle.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { augmentThreadReadWithNotificationTitle } from './codexAppServerBridge'

describe('notifier conversation title enrichment', () => {
  it('copies a nested thread result and adds the cached title', () => {
    const thread = { id: 'thread-1', turns: [] }
    const result = { thread }
    const enriched = augmentThreadReadWithNotificationTitle(result, 'Renamed conversation')

    expect(enriched).toEqual({
      thread: { id: 'thread-1', turns: [], notificationTitle: 'Renamed conversation' },
    })
    expect(enriched).not.toBe(result)
    expect((enriched as { thread: unknown }).thread).not.toBe(thread)
    expect(result).toEqual({ thread })
  })

  it('returns malformed results and empty titles unchanged', () => {
    const result = { thread: { id: 'thread-1', turns: [] } }
    expect(augmentThreadReadWithNotificationTitle(result, '  ')).toBe(result)
    expect(augmentThreadReadWithNotificationTitle({ thread: null }, 'Title'))
      .toEqual({ thread: null })
  })
})
```

- [ ] **Step 2: Run enrichment test and verify RED**

Run: `pnpm vitest run src/server/codexAppServerBridge.notifierTitle.test.ts`

Expected: FAIL because the exported helper does not exist.

- [ ] **Step 3: Implement immutable notifier enrichment**

Add near the bridge's existing thread-result helpers:

```ts
export function augmentThreadReadWithNotificationTitle(result: unknown, title: string): unknown {
  const normalizedTitle = title.trim()
  if (!normalizedTitle) return result
  const response = asRecord(result)
  const thread = asRecord(response?.thread)
  if (!response || !thread) return result
  return {
    ...response,
    thread: { ...thread, notificationTitle: normalizedTitle },
  }
}
```

- [ ] **Step 4: Run enrichment test and verify GREEN**

Run: `pnpm vitest run src/server/codexAppServerBridge.notifierTitle.test.ts`

Expected: the new test file passes.

- [ ] **Step 5: Write failing packaged-wiring invariant tests**

Define one constant at the top of `src/safe/doctor.test.ts` and use it for every valid `bridge` fixture:

```ts
const VALID_BRIDGE_SOURCE = [
  'securityPolicy.isRouteDisabled',
  'securityPolicy.isRpcMethodAllowed',
  'securityPolicy.terminalInputEnabled',
  'readThreadForNotifier',
  'getAppServerPidForNotifier',
  'getSessionsRootForNotifier',
  "appServer.rpc('thread/read', { threadId, includeTurns: true })",
  'readMergedThreadTitleCache',
  'augmentThreadReadWithNotificationTitle',
  'notificationTitle',
].join(' ')
```

Add this exact parameterized case:

```ts
it.each([
  'readMergedThreadTitleCache',
  'augmentThreadReadWithNotificationTitle',
  'notificationTitle',
] as const)('rejects bridge source missing ntfy title invariant %s', (invariant) => {
  const result = inspectSafeSources({
    runtimePolicy: "bindHost: '127.0.0.1'; approvalPolicy: 'on-request'; sandboxMode: 'workspace-write'",
    featureGate: 'isDisabledRoute isAllowedRpcMethod',
    bridge: VALID_BRIDGE_SOURCE.replace(invariant, ''),
    safeCli: "exposeTailscale(state.port); option('--password-file <path>', 'description'); option('--ntfy-url-file <path>', 'description'); loadNtfyPublishUrl({ explicitPath: options.ntfyUrlFile })",
    ntfyConfig: "url.origin !== 'https://ntfy.sh'; url.username; url.password; url.search; url.hash; !/^\\/[A-Za-z0-9_-]+$/u.test(url.pathname)",
    httpServer: 'options.ntfyNotifications createNtfyNotifierLifecycle bridge.subscribeNotifications NtfyCompletionNotifier createExternalTurnMonitor getSessionsRootForNotifier return notifier.handleObserved(event)',
    securityPolicy: 'backgroundIntegrationsEnabled: false',
  })
  expect(result.ok).toBe(false)
  expect(result.failures.join('\n')).toContain('title')
})
```

Do not weaken existing route, RPC, terminal, or `thread/read` checks.

- [ ] **Step 6: Run doctor tests and verify RED**

Run: `pnpm vitest run src/safe/doctor.test.ts`

Expected: FAIL until `src/safe/doctor.ts` checks the new source invariants.

- [ ] **Step 7: Wire the cached title into the existing notifier read**

Change the bridge assignment to:

```ts
middleware.readThreadForNotifier = async (threadId: string) => {
  const result = await appServer.rpc('thread/read', { threadId, includeTurns: true })
  let cachedTitle = ''
  try {
    cachedTitle = (await readMergedThreadTitleCache()).titles[threadId] ?? ''
  } catch {
    cachedTitle = ''
  }
  return augmentThreadReadWithNotificationTitle(result, cachedTitle)
}
```

In `src/safe/doctor.ts`, require the bridge source to contain `readMergedThreadTitleCache`, `augmentThreadReadWithNotificationTitle`, and `notificationTitle`, while retaining the exact `thread/read` invariant.

- [ ] **Step 8: Run focused bridge and notifier tests and verify GREEN**

Run:

```bash
pnpm vitest run \
  src/server/codexAppServerBridge.notifierTitle.test.ts \
  src/server/ntfyCompletionNotifier.test.ts \
  src/safe/ntfyTitle.test.ts \
  src/safe/ntfyState.test.ts \
  src/safe/doctor.test.ts
```

Expected: all focused files pass. The notifier harness still records one `readThread` call per qualifying completion.

- [ ] **Step 9: Commit bridge wiring**

```bash
git add src/server/codexAppServerBridge.ts \
  src/server/codexAppServerBridge.notifierTitle.test.ts \
  src/safe/doctor.ts src/safe/doctor.test.ts
git commit -m "feat: enrich ntfy alerts with cached titles"
```

---

### Task 4: Documentation, Full Verification, and Deployment

**Files:**
- Modify: `README.md`
- Modify: `docs/AGENT_GUIDE.md`
- Verify: all files changed by Tasks 1-3.

**Interfaces:**
- Documents: rendered title formats, title precedence, 80-code-point bound, ID fallback, unchanged body behavior, and privacy exclusions.
- Produces: a verified deployed candidate without changing Tailscale exposure.

- [ ] **Step 1: Update user and agent documentation**

In `README.md`, replace the fixed-title table with examples containing `<会话名称>` and add:

```text
会话名称优先使用桌面/移动端保存的重命名标题，然后使用 thread/read 的 name/title。
名称缺失时显示“未命名会话（ID 末 8 位）”。名称最多 80 个 Unicode 字符；正文仍是最终助手回复的一句话摘要。
```

In `docs/AGENT_GUIDE.md`, update notification invariants and operator notes with the same precedence and explicitly prohibit `preview` or prompt text as the title.

- [ ] **Step 2: Run documentation and diff checks**

Run:

```bash
rg -n "Codex 任务完成：|未命名会话|80|preview" README.md docs/AGENT_GUIDE.md
git diff --check
```

Expected: both documents describe the new behavior, and `git diff --check` prints nothing.

- [ ] **Step 3: Run focused ntfy verification**

Run:

```bash
pnpm vitest run \
  src/safe/ntfyTitle.test.ts \
  src/safe/ntfyState.test.ts \
  src/safe/doctor.test.ts \
  src/server/ntfyCompletionNotifier.test.ts \
  src/server/codexAppServerBridge.notifierTitle.test.ts \
  src/server/securityPolicy.test.ts
```

Expected: every focused file passes with zero failures.

- [ ] **Step 4: Run the complete unit suite**

Run: `pnpm test:unit`

Expected: all test files pass with zero failures.

- [ ] **Step 5: Run the production build**

Run: `pnpm build`

Expected: `vue-tsc`, Vite, and tsup all exit 0.

- [ ] **Step 6: Review requirements before code quality**

Compare the full diff against `docs/superpowers/specs/2026-07-18-ntfy-thread-title-design.md`. Confirm every source, fallback, bound, legacy compatibility rule, unchanged body behavior, and no-extra-RPC constraint has an automated test or deployment check. Then review normalization, state validation, immutable enrichment, retry compatibility, logs, and scope for unnecessary changes.

- [ ] **Step 7: Commit documentation**

```bash
git add README.md docs/AGENT_GUIDE.md
git commit -m "docs: explain ntfy conversation titles"
```

- [ ] **Step 8: Deploy the verified branch**

Run from the isolated worktree:

```bash
pnpm run service:install
codex-mobile-safe doctor
codex-mobile-safe status
ss -ltnp '( sport = :5900 )'
tailscale serve status
```

Expected: doctor prints `ok`; the service uses the worktree candidate, is password-protected, listens only on `127.0.0.1:5900`, and Tailscale Serve remains tailnet-only proxying to that loopback address.

- [ ] **Step 9: Exercise one qualifying notification safely**

Add or run one notifier-harness case using `notificationTitle: 'ntfy-title-acceptance'`. Confirm the captured `NtfySendRequest.record` has:

```text
Title: Codex 任务完成：ntfy-title-acceptance
Body: the existing one-sentence final assistant summary
```

Do not send a real ntfy request for this acceptance step. Do not print the real ntfy URL/topic, password, cookie, prompt, full thread payload, or conversation content.

- [ ] **Step 10: Record final repository state**

Run:

```bash
git status --short --branch
git log --oneline --decorate -8
git diff main...HEAD --stat
```

Expected: the worktree is clean and the feature branch contains only the design, implementation, tests, and documentation commits described above.
