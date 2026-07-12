# ntfy Long-Task Completion Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send one lock-screen ntfy notification with a one-sentence final-response summary for every successful, failed, or interrupted Codex turn lasting at least ten minutes.

**Architecture:** Safe-mode startup reads an optional mode-`0600` ntfy URL file and passes a validated configuration into the shared HTTP server. A focused notifier subscribes to app-server turn events, persists bounded timing/outbox/deduplication state, reads the final thread only for qualifying turns, and posts asynchronously to one strictly validated ntfy.sh topic.

**Tech Stack:** Node.js 18+, TypeScript, Vitest, Express bridge middleware, systemd user service, ntfy HTTP API

## Global Constraints

- Notify only when elapsed time is greater than or equal to exactly `600_000` milliseconds.
- Success, failure, and interruption all notify; shorter turns never notify.
- Titles are exactly `Codex 任务完成`, `Codex 任务失败`, and `Codex 任务已中断`.
- Body is the first non-empty final-assistant sentence with collapsed whitespace, truncated to at most 180 characters; no additional AI call.
- Each `threadId + turnId` pair produces at most one notification.
- Accept only `https://ntfy.sh/<single-topic>` with no credentials, query, or fragment.
- The URL/topic is read only from a current-user mode-`0600` regular file and never enters Git, process arguments, systemd units, managed notifier state, response bodies, or logs.
- The notifier is explicit outbound-only safe functionality; do not enable Telegram, other background integrations, incoming commands, LAN access, Funnel, or authentication bypasses.
- Active timing and pending delivery survive service restart.
- Request timeout is exactly five seconds; each drain performs at most three immediate attempts per pending record.
- Active, pending, and sent collections remain bounded to 256 records each.
- Notification errors never fail or delay a Codex turn.
- Disabled configuration adds no event subscription or network work.

---

### Task 1: Secure ntfy configuration and durable bounded state

**Files:**
- Create: `src/safe/ntfyConfig.ts`
- Create: `src/safe/ntfyConfig.test.ts`
- Create: `src/safe/ntfyState.ts`
- Create: `src/safe/ntfyState.test.ts`

**Interfaces:**
- Produces: `DEFAULT_NTFY_URL_FILE: string`
- Produces: `loadNtfyPublishUrl(options: { explicitPath?: string; defaultPath?: string; uid?: number }): Promise<string | null>`
- Produces: `NtfyNotifierState`, `ActiveTurnRecord`, `PendingNtfyRecord`, and `SentTurnRecord` types.
- Produces: `createEmptyNtfyState(): NtfyNotifierState`
- Produces: `FileNtfyStateStore` with `load(): Promise<NtfyNotifierState>` and `save(state): Promise<void>`.
- Produces: `boundNtfyState(state, limit = 256): NtfyNotifierState`.

- [ ] **Step 1: Write failing configuration tests**

Create tests using temporary files that assert:

```ts
await expect(loadNtfyPublishUrl({ defaultPath: missing })).resolves.toBeNull()
await expect(loadNtfyPublishUrl({ explicitPath: missing })).rejects.toThrow('ntfy URL file')
await expect(loadNtfyPublishUrl({ explicitPath: valid0600 })).resolves.toBe('https://ntfy.sh/random-topic')
await expect(loadNtfyPublishUrl({ explicitPath: mode0644 })).rejects.toThrow('0600')
await expect(loadNtfyPublishUrl({ explicitPath: directory })).rejects.toThrow('regular file')
await expect(loadNtfyPublishUrl({ explicitPath: wrongOwner, uid: 42 })).rejects.toThrow('current user')
```

Reject these exact URL shapes:

```ts
[
  'http://ntfy.sh/topic',
  'https://example.com/topic',
  'https://user:pass@ntfy.sh/topic',
  'https://ntfy.sh/',
  'https://ntfy.sh/a/b',
  'https://ntfy.sh/topic?x=1',
  'https://ntfy.sh/topic#fragment',
]
```

- [ ] **Step 2: Run configuration tests and verify RED**

Run: `pnpm exec vitest run src/safe/ntfyConfig.test.ts`

Expected: FAIL because `ntfyConfig.ts` does not exist.

- [ ] **Step 3: Implement strict secret-file and URL validation**

Implement the public loader with this behavior:

```ts
export const DEFAULT_NTFY_URL_FILE = join(homedir(), '.codex', 'codex-mobile-safe-ntfy-url')

export async function loadNtfyPublishUrl(options: {
  explicitPath?: string
  defaultPath?: string
  uid?: number
} = {}): Promise<string | null> {
  const path = resolve(options.explicitPath ?? options.defaultPath ?? DEFAULT_NTFY_URL_FILE)
  const required = Boolean(options.explicitPath)
  const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (!required && error.code === 'ENOENT') return null
    throw new Error('Unable to read ntfy URL file')
  })
  if (!info) return null
  if (!info.isFile()) throw new Error('ntfy URL file must be a regular file')
  const uid = options.uid ?? process.getuid?.()
  if (uid !== undefined && info.uid !== uid) throw new Error('ntfy URL file must be owned by the current user')
  if ((info.mode & 0o077) !== 0) throw new Error('ntfy URL file permissions must be 0600 or stricter')
  return validateNtfyPublishUrl((await readFile(path, 'utf8')).trim())
}
```

`validateNtfyPublishUrl` must parse with `new URL`, require `url.origin === 'https://ntfy.sh'`, reject username/password/search/hash, and require `url.pathname` to match `/^\/[A-Za-z0-9_-]+$/u`.

- [ ] **Step 4: Write failing durable-state tests**

Cover exact empty shape, mode `0600`, reconstruction from disk, malformed JSON recovery, no URL/topic fields, and oldest-first bounding:

```ts
expect(boundNtfyState(oversized, 256).active).toHaveLength(256)
expect(boundNtfyState(oversized, 256).pending).toHaveLength(256)
expect(boundNtfyState(oversized, 256).sent).toHaveLength(256)
expect(boundNtfyState(oversized, 256).active[0].startedAt).toBe(44)
```

- [ ] **Step 5: Run state tests and verify RED**

Run: `pnpm exec vitest run src/safe/ntfyState.test.ts`

Expected: FAIL because `ntfyState.ts` does not exist.

- [ ] **Step 6: Implement durable state**

Use this persisted shape:

```ts
export type ActiveTurnRecord = { key: string; threadId: string; turnId: string; startedAt: number }
export type PendingNtfyRecord = {
  key: string
  title: 'Codex 任务完成' | 'Codex 任务失败' | 'Codex 任务已中断'
  message: string
  createdAt: number
}
export type SentTurnRecord = { key: string; sentAt: number }
export type NtfyNotifierState = {
  active: ActiveTurnRecord[]
  pending: PendingNtfyRecord[]
  sent: SentTurnRecord[]
}
```

`FileNtfyStateStore.save` must create the parent directory with mode `0700`, write JSON with mode `0600`, and chmod the final file to `0600`. `load` validates each record, never accepts extra secret fields, returns a bounded state, and returns the empty state after malformed content while calling an injected redacted warning callback.

- [ ] **Step 7: Run focused tests and commit**

Run:

```bash
pnpm exec vitest run src/safe/ntfyConfig.test.ts src/safe/ntfyState.test.ts
git diff --check
```

Expected: both files pass and diff check is clean.

Commit:

```bash
git add src/safe/ntfyConfig.ts src/safe/ntfyConfig.test.ts src/safe/ntfyState.ts src/safe/ntfyState.test.ts
git commit -m "feat: add secure ntfy notification state"
```

---

### Task 2: Long-turn completion notifier and ntfy delivery

**Files:**
- Create: `src/server/ntfyCompletionNotifier.ts`
- Create: `src/server/ntfyCompletionNotifier.test.ts`

**Interfaces:**
- Consumes: `NtfyNotifierState`, `FileNtfyStateStore`, and record types from Task 1.
- Produces: `NtfyCompletionNotifier` with `start(): Promise<void>`, `handle(notification): void`, and `dispose(): Promise<void>`.
- Produces: `summarizeAssistantResponse(text: string): string`.
- Produces: `readLatestAssistantText(threadReadResult: unknown): string`.
- Consumes injected dependencies: `publishUrl`, `stateStore`, `readThread(threadId)`, `send(request)`, `now()`, `createTimeoutSignal(milliseconds)`, and redacted `warn(message)`.

- [ ] **Step 1: Write failing pure summary and event tests**

Use fake clock, state store, thread reader, and sender. Cover:

```ts
expect(summarizeAssistantResponse('  完成了。\n后续内容')).toBe('完成了。')
expect(summarizeAssistantResponse('A'.repeat(220))).toHaveLength(180)
```

Event cases must assert:

- `599_999` ms sends zero requests;
- `600_000` ms sends one request;
- `completed`, `failed`, and another terminal status produce the three exact titles;
- missing IDs or a missing start record sends nothing;
- duplicate starts keep the earliest timestamp;
- duplicate completes produce one pending/sent key and one successful delivery;
- `readThread` is never called for short turns;
- final assistant text is read from the newest `agentMessage` item;
- fallback text is used when no assistant message exists.

- [ ] **Step 2: Run notifier tests and verify RED**

Run: `pnpm exec vitest run src/server/ntfyCompletionNotifier.test.ts`

Expected: FAIL because the notifier module does not exist.

- [ ] **Step 3: Implement deterministic summary and event parsing**

Implement constants:

```ts
export const NTFY_MIN_DURATION_MS = 600_000
export const NTFY_SUMMARY_MAX_LENGTH = 180
export const NTFY_REQUEST_TIMEOUT_MS = 5_000
export const NTFY_IMMEDIATE_ATTEMPTS = 3
```

Turn keys are `${threadId}:${turnId}`. Extract IDs from direct camel/snake fields and nested `thread`/`turn` records. `handle` must enqueue work onto one private promise chain and return immediately so app-server event emission never awaits file or network I/O.

- [ ] **Step 4: Write failing retry/restart tests**

Cover:

- state is saved with an active record before `handle(turn/started)` work completes;
- a reconstructed notifier loads the active start and qualifies the later completion;
- completion is persisted in `pending` before the first send;
- sender failures cause exactly three immediate attempts;
- failed pending survives reconstruction and is retried by `start()`;
- success moves the key from pending to sent before returning;
- multiple pending rows drain sequentially, not with unbounded fanout;
- injected sender receives a signal configured for a 5,000 ms timeout;
- retries and reconstruction use one deterministic bounded ASCII sequence ID for the same turn key, while different keys produce different IDs;
- the real default sender RFC 2047-encodes the logical Chinese title and includes `X-Sequence-ID`;
- warning strings contain no URL/topic or message body.

- [ ] **Step 5: Implement bounded durable delivery**

Default sending behavior:

```ts
async function sendNtfyRequest(request: NtfySendRequest): Promise<void> {
  const response = await fetch(request.publishUrl, {
    method: 'POST',
    headers: {
      Title: encodeRfc2047(request.record.title),
      Priority: 'default',
      Tags: 'white_check_mark',
      'X-Sequence-ID': request.sequenceId,
    },
    body: request.record.message,
    signal: request.signal,
  })
  if (!response.ok) throw new Error(`ntfy request failed with HTTP ${String(response.status)}`)
}
```

RFC 2047-encode the exact logical Chinese title so Node's Fetch implementation receives an ASCII-safe header. Derive a deterministic, non-secret, bounded ASCII sequence ID from the turn key and reuse it across all attempts and restarts. This gives local deduplication plus ntfy client-side logical replacement, not atomic transport-level exactly-once delivery; an ambiguous timeout or crash before the local sent-state commit can still cause a repeated alert. Create a fresh timeout signal with `createTimeoutSignal(NTFY_REQUEST_TIMEOUT_MS)` for every attempt; the production default is `AbortSignal.timeout`. Persist before attempting, after success, and after bounded retry failure. Never include `publishUrl` or message text in warnings. `dispose()` awaits the private promise chain so tests and shutdown can observe completion without exposing production polling.

- [ ] **Step 6: Run focused tests and commit**

Run:

```bash
pnpm exec vitest run src/server/ntfyCompletionNotifier.test.ts
git diff --check
```

Expected: all notifier tests pass with no warnings.

Commit:

```bash
git add src/server/ntfyCompletionNotifier.ts src/server/ntfyCompletionNotifier.test.ts
git commit -m "feat: notify completed long Codex turns"
```

---

### Task 3: Bridge, safe CLI, doctor, and service packaging integration

**Files:**
- Modify: `src/server/codexAppServerBridge.ts`
- Modify: `src/server/httpServer.ts`
- Modify: `src/server/securityPolicy.ts`
- Modify: `src/server/securityPolicy.test.ts`
- Modify: `src/cli/safe.ts`
- Modify: `src/cli/safe.entry.test.ts`
- Modify: `src/safe/doctor.ts`
- Modify: `src/safe/doctor.test.ts`
- Modify: `src/safe/packaging.test.ts`
- Modify: `packaging/systemd/codex-mobile-safe.service.in`

**Interfaces:**
- Consumes: `loadNtfyPublishUrl`, `FileNtfyStateStore`, and `NtfyCompletionNotifier`.
- Extends `ServerOptions` with optional `ntfyNotifications?: { publishUrl: string; statePath: string }`.
- Extends bridge middleware with `readThreadForNotifier(threadId: string): Promise<unknown>`.

- [ ] **Step 1: Write failing server/CLI/packaging wiring tests**

Assert:

- permissive/original server with no config creates no notifier;
- safe CLI source has `--ntfy-url-file <path>` and calls `loadNtfyPublishUrl`;
- bridge exposes only an internal thread reader and notification subscription, not a new HTTP route;
- systemd template contains no ntfy URL/topic and no plaintext `Environment=` secret;
- doctor requires optional ntfy code to retain strict `https://ntfy.sh` validation and outbound-only wiring;
- `backgroundIntegrationsEnabled` remains false in safe policy.

- [ ] **Step 2: Run focused wiring tests and verify RED**

Run:

```bash
pnpm exec vitest run src/server/securityPolicy.test.ts src/cli/safe.entry.test.ts src/safe/doctor.test.ts src/safe/packaging.test.ts
```

Expected: new wiring assertions fail.

- [ ] **Step 3: Add bridge/server notifier lifecycle**

Extend the bridge middleware type with:

```ts
readThreadForNotifier: (threadId: string) => Promise<unknown>
```

Implement it as an internal `appServer.rpc('thread/read', { threadId, includeTurns: true })` call. In `httpServer.createServer`, instantiate and `start()` the notifier only when `options.ntfyNotifications` exists, subscribe it to bridge notifications, and make `dispose()` unsubscribe and dispose it without blocking HTTP shutdown. Do not add a route.

- [ ] **Step 4: Add safe CLI optional configuration**

Add:

```ts
.option('--ntfy-url-file <path>', 'read a mode-0600 ntfy.sh publish URL file')
```

Before `createApp`, call `loadNtfyPublishUrl({ explicitPath: options.ntfyUrlFile })`. Pass `ntfyNotifications` only when the result is non-null, with state path `join(getSafeHome(), 'ntfy-notifier.json')`. Startup output may say `Long-task notifications: enabled` but must not print the URL or topic.

The default file is auto-detected when no flag is supplied, so the systemd unit needs no ntfy argument or secret and remains unchanged except its description/documentation if necessary.

- [ ] **Step 5: Update doctor invariants and packaging assertions**

Doctor must statically require the validated loader and notifier wiring while allowing the feature to be absent at runtime. Packaging tests must assert the systemd unit contains neither `ntfy.sh`, `codex-mobile-safe-ntfy-url`, nor any topic-like secret.

- [ ] **Step 6: Run focused tests, build, CLI smoke, and commit**

Run:

```bash
pnpm exec vitest run src/server/securityPolicy.test.ts src/cli/safe.entry.test.ts src/safe/doctor.test.ts src/safe/packaging.test.ts src/server/ntfyCompletionNotifier.test.ts
pnpm run build
node dist-cli/index.js --help
node dist-cli/safe.js --help
node dist-cli/safe.js doctor
```

Expected: tests and build pass; original help remains unchanged; safe help lists the optional file; doctor reports `ok` without printing a URL.

Commit:

```bash
git add src/server/codexAppServerBridge.ts src/server/httpServer.ts \
  src/server/securityPolicy.ts src/server/securityPolicy.test.ts \
  src/cli/safe.ts src/cli/safe.entry.test.ts \
  src/safe/doctor.ts src/safe/doctor.test.ts src/safe/packaging.test.ts \
  packaging/systemd/codex-mobile-safe.service.in
git commit -m "feat: wire safe long-task notifications"
```

---

### Task 4: Operator and agent documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/AGENT_GUIDE.md`
- Create: `tests/cli-network-platform/ntfy-long-task-completion-notifications.md`
- Modify: `tests/cli-network-platform/index.md`

**Interfaces:**
- Documents the exact default secret path, validation rules, ten-minute threshold, status behavior, test command, and rollback.

- [ ] **Step 1: Add user setup without committing the real topic**

Document:

```bash
install -m 600 /dev/null ~/.codex/codex-mobile-safe-ntfy-url
read -r NTFY_TOPIC
printf 'https://ntfy.sh/%s\n' "$NTFY_TOPIC" > ~/.codex/codex-mobile-safe-ntfy-url
chmod 600 ~/.codex/codex-mobile-safe-ntfy-url
pnpm run service:restart
```

State that the example placeholder must be replaced locally, the file must never be committed, and deleting the file plus restarting disables notifications.

- [ ] **Step 2: Add agent invariants and troubleshooting**

Document no secret logging, fixed ntfy origin, no incoming control, bounded state/retry, no additional AI summarization, and commands to inspect redacted service errors.

- [ ] **Step 3: Add exact manual test**

Include prerequisites, fake-clock or injectable-threshold test actions, one real locked-phone notification, success/failure/interruption cases, short-turn negative case, restart recovery, duplicate prevention, and cleanup.

- [ ] **Step 4: Check links/content and commit**

Run:

```bash
git diff --check
test -f tests/cli-network-platform/ntfy-long-task-completion-notifications.md
rg -n '600_000|10 minutes|0600|ntfy' README.md docs/AGENT_GUIDE.md tests/cli-network-platform
```

Commit:

```bash
git add README.md docs/AGENT_GUIDE.md tests/cli-network-platform/index.md \
  tests/cli-network-platform/ntfy-long-task-completion-notifications.md
git commit -m "docs: explain long-task phone notifications"
```

---

### Task 5: Final verification, real topic setup, and stacked-branch delivery

**Files:**
- Verify/deploy only; the real topic file is outside Git.

**Interfaces:**
- Consumes all prior tasks.
- Produces validated local service configuration and two clean GitHub changes: the older message-window fix, then the notification feature based on updated main.

- [ ] **Step 1: Run complete automated and production verification**

Run:

```bash
pnpm run test:unit
pnpm run build
node dist-cli/safe.js doctor
sh -n scripts/install-local.sh scripts/install-user-service.sh scripts/uninstall-user-service.sh
git diff --check
```

Expected: all tests/build/checks pass.

- [ ] **Step 2: Audit security and performance**

Confirm with diff inspection and measurements:

- no secret value or actual topic appears in tracked files, build output, unit, process arguments, or logs;
- URL parsing prevents SSRF outside `https://ntfy.sh/<single-topic>`;
- no new browser request/frontend work;
- disabled notifier creates no listener or network request;
- queues cap at 256 and per-drain attempts cap at three;
- qualifying completion work is asynchronous;
- CLI/frontend bundle deltas are measured and attributed.

- [ ] **Step 3: Complete and merge the prerequisite message-window branch**

Push `codex/fix-mobile-message-window`, create a PR to `main`, merge only through the chosen GitHub workflow, fetch `origin/main`, and verify commit `091a6d2` is contained in the new remote main.

- [ ] **Step 4: Rebase the notification branch onto updated main and re-verify**

From a clean worktree, rebase `codex/ntfy-completion-notifications` onto updated `main`, resolve only intentional conflicts, then rerun the complete suite and build. Never use automatic conflict-bias strategies.

- [ ] **Step 5: Store the real ntfy URL securely and deploy**

Write the user-approved URL to `~/.codex/codex-mobile-safe-ntfy-url` with mode `0600` without printing it. Run `pnpm run service:install`, verify active service and loopback listener, and confirm logs show notifications enabled without the topic.

- [ ] **Step 6: Perform a real delivery test without waiting ten minutes**

Use the notifier's injected fake clock or a test-only invocation from the focused test harness; never add a production threshold override. Confirm the phone receives one fixed test summary, then confirm a simulated `599_999` ms turn sends nothing and duplicate completion sends once.

- [ ] **Step 7: Push notification branch and create draft PR**

Push `codex/ntfy-completion-notifications`, create a draft PR to `main`, and include test counts, build output, security/performance audit, real phone delivery result, and the fact that the actual topic is not tracked.
