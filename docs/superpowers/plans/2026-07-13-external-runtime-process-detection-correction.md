# External Runtime Process Detection Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct Linux external-thread detection so desktop Codex app-servers with options before `app-server` are recognized while every descendant of the mobile bridge launcher is excluded.

**Architecture:** Keep the existing lifecycle-plus-writer evidence model. Replace the command-line regex with an argv-token parser, enrich Linux writer snapshots with validated ancestor PIDs from one `/proc` process table, and reject the mobile launcher's complete descendant tree before accepting writer evidence.

**Tech Stack:** TypeScript, Node.js `/proc` filesystem APIs, Vitest, Vue/Vite build, Playwright production smoke.

## Global Constraints

- Recognize a Codex app-server only when an argv token has basename exactly `codex` and a later argv token is exactly `app-server`.
- Exclude the PID returned by the mobile launcher and every descendant whose validated parent chain reaches that PID.
- Preserve the unmatched lifecycle turn plus same-UID, exact dev/ino, writable descriptor, positive-position writer requirement.
- Preserve canonical sessions-root containment, regular-file checks, opened-file identity checks, cache/checkpoint behavior, and conservative `unknown` errors.
- Non-Linux systems remain `unknown`; do not add timestamp-based inference.
- Do not change polling cadence, UI behavior, authentication, Tailscale exposure, or cross-app-server interruption.
- Tests must be observed failing for the intended reason before production code changes.

---

## File map

- `src/server/externalThreadRuntime.ts`: argv recognition, process-table construction, ancestor validation, and writer matching.
- `src/server/externalThreadRuntime.test.ts`: fake writer fixtures, command-layout regressions, descendant exclusion, `/proc` ancestry integration, and conservative failure cases.
- `tests/thread-loading-state/external-client-running-state-after-refresh.md`: manual production checks for the two real launcher layouts and self-descendant exclusion.

### Task 1: Recognize argv layouts used by desktop and safe app-servers

**Files:**
- Modify: `src/server/externalThreadRuntime.test.ts:247-361`
- Modify: `src/server/externalThreadRuntime.ts:1,167-170`

**Interfaces:**
- Consumes: `RuntimeFdSnapshot.cmdline: string`, containing raw NUL-delimited `/proc/<pid>/cmdline` bytes decoded as UTF-8.
- Produces: internal `isCodexAppServerCommand(cmdline: string): boolean`, accepting only a basename-exact `codex` argv token followed later by exact `app-server`.

- [ ] **Step 1: Add command-layout regression tests**

Add these table cases beside the existing writer-evidence tests:

```ts
it.each([
  [
    'direct app-server subcommand',
    '/usr/local/bin/codex\0app-server\0-c\0approval_policy="never"\0',
  ],
  [
    'desktop options before app-server',
    '/usr/lib/node_modules/@openai/codex/bin/codex\0-c\0features.code_mode_host=true\0app-server\0--listen\0unix://\0',
  ],
  [
    'Node launcher with a Codex script argument',
    '/usr/bin/node\0/usr/bin/codex\0-c\0sandbox_mode="danger-full-access"\0app-server\0',
  ],
])('accepts writer evidence from a %s command', async (_label, cmdline) => {
  const system = fakeRuntimeSystem({
    log: lifecycle('task_started', 'turn-a'),
    fds: [writerFd({ cmdline })],
  })

  await expect(registeredProbe(system).inspect('thread-1', 99)).resolves.toMatchObject({
    state: 'running',
    turnId: 'turn-a',
  })
})

it.each([
  ['codex-like basename', '/usr/bin/my-codex\0app-server\0'],
  ['app-server before codex', 'app-server\0/usr/bin/codex\0'],
  ['missing app-server token', '/usr/bin/codex\0-c\0app-server-like\0'],
])('rejects writer evidence from a %s command', async (_label, cmdline) => {
  const system = fakeRuntimeSystem({
    log: lifecycle('task_started', 'turn-a'),
    fds: [writerFd({ cmdline })],
  })

  await expect(registeredProbe(system).inspect('thread-1', 99)).resolves.toEqual({ state: 'idle' })
})
```

- [ ] **Step 2: Run the focused command tests and verify RED**

Run:

```bash
pnpm vitest run src/server/externalThreadRuntime.test.ts -t 'command'
```

Expected: the `desktop options before app-server` and `Node launcher with a Codex script argument` cases fail with `expected { state: 'idle' } to match { state: 'running' }`. The negative cases remain green.

- [ ] **Step 3: Replace regex matching with ordered argv-token matching**

Extend the path import and replace the matcher with:

```ts
import { basename, isAbsolute, relative, sep } from 'node:path'

function isCodexAppServerCommand(cmdline: string): boolean {
  const argv = cmdline.split('\0').filter((value) => value.length > 0)
  const codexIndex = argv.findIndex((value) => basename(value) === 'codex')
  return codexIndex >= 0 && argv.slice(codexIndex + 1).includes('app-server')
}
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
pnpm vitest run src/server/externalThreadRuntime.test.ts
```

Expected: all external-runtime probe tests pass.

- [ ] **Step 5: Commit command recognition**

```bash
git add src/server/externalThreadRuntime.ts src/server/externalThreadRuntime.test.ts
git commit -m "fix: recognize configured Codex app-server commands"
```

### Task 2: Exclude the mobile launcher descendant tree

**Files:**
- Modify: `src/server/externalThreadRuntime.test.ts:29-239,309-361,593-618`
- Modify: `src/server/externalThreadRuntime.ts:12-20,131-215,299-314`

**Interfaces:**
- Consumes: `/proc/<pid>/status` fields `Uid:` and `PPid:` plus raw `/proc/<pid>/cmdline`.
- Produces: `RuntimeFdSnapshot.ancestorPids: number[]`, ordered from direct parent outward; `matchesWriter(...)` rejects an exact or ancestor match with `excludedPid`.
- Produces: internal process records `{ pid: number; parentPid: number; uid: number; cmdline: string }` assembled before descriptor enumeration.

- [ ] **Step 1: Add fake-snapshot descendant tests**

Add `ancestorPids: []` to `writerFd()` and add:

```ts
it.each([
  ['direct child', [99]],
  ['deep descendant', [150, 120, 99, 1]],
])('excludes a mobile launcher %s from writer evidence', async (_label, ancestorPids) => {
  const system = fakeRuntimeSystem({
    log: lifecycle('task_started', 'turn-a'),
    fds: [writerFd({ pid: 200, ancestorPids })],
  })

  await expect(registeredProbe(system).inspect('thread-1', 99)).resolves.toEqual({ state: 'idle' })
})

it('accepts a separate desktop app-server whose ancestors do not include the mobile launcher', async () => {
  const system = fakeRuntimeSystem({
    log: lifecycle('task_started', 'turn-a'),
    fds: [writerFd({ pid: 200, ancestorPids: [150, 1] })],
  })

  await expect(registeredProbe(system).inspect('thread-1', 99)).resolves.toMatchObject({
    state: 'running',
    turnId: 'turn-a',
  })
})
```

- [ ] **Step 2: Run descendant tests and verify RED**

Run:

```bash
pnpm vitest run src/server/externalThreadRuntime.test.ts -t 'launcher|desktop app-server'
```

Expected: the direct/deep descendant cases fail because the current matcher excludes only `fd.pid === excludedPid`.

- [ ] **Step 3: Add ancestry to the snapshot contract and writer predicate**

Change the snapshot type and writer predicate:

```ts
export type RuntimeFdSnapshot = {
  pid: number
  ancestorPids: number[]
  uid: number
  cmdline: string
  dev: string
  ino: string
  position: number
  flags: number
}

function belongsToExcludedProcessTree(
  fd: RuntimeFdSnapshot,
  excludedPid: number | null,
): boolean {
  return excludedPid !== null
    && (fd.pid === excludedPid || fd.ancestorPids.includes(excludedPid))
}
```

Use `!belongsToExcludedProcessTree(fd, excludedPid)` in `matchesWriter` instead of `fd.pid !== excludedPid`.
Add `ancestorPids: []` to the existing Linux descriptor yield at this intermediate step so the required snapshot field compiles; Step 7 replaces that empty value with validated ancestry from the process table.

- [ ] **Step 4: Extend the default `/proc` fixture to model process trees**

Add the fixture type:

```ts
type DefaultRuntimeProcessFixture = {
  pid: number
  parentPid: number
  cmdline: string
  fds: string[]
}
```

Add `processes?: DefaultRuntimeProcessFixture[]` to `DefaultRuntimeFixture`, defaulting to:

```ts
const processes = fixture.processes ?? [{
  pid: 42,
  parentPid: 1,
  cmdline: '/usr/local/bin/codex\0app-server\0',
  fds: ['7'],
}]
```

Update the mocked `/proc` reads so `/proc` returns every fixture PID, each status includes both fields, each cmdline comes from its fixture, and each `/proc/<pid>/fd` returns that fixture's `fds`:

```ts
return `Name:\tcodex\nPPid:\t${process.parentPid}\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`
```

- [ ] **Step 5: Add real `/proc` ancestry integration regressions**

Add:

```ts
it('excludes a native Codex process descended from the mobile Node launcher', async () => {
  const probe = defaultRuntimeProbe({
    processes: [
      {
        pid: 99,
        parentPid: 1,
        cmdline: '/usr/bin/node\0/usr/bin/codex\0app-server\0',
        fds: [],
      },
      {
        pid: 100,
        parentPid: 99,
        cmdline: '/opt/codex/bin/codex\0app-server\0',
        fds: ['7'],
      },
    ],
  })

  await expect(probe.inspect('thread-1', 99)).resolves.toEqual({ state: 'idle' })
})

it('returns unknown when a candidate app-server ancestry contains a cycle', async () => {
  const probe = defaultRuntimeProbe({
    processes: [
      { pid: 100, parentPid: 101, cmdline: '/opt/codex/bin/codex\0app-server\0', fds: ['7'] },
      { pid: 101, parentPid: 100, cmdline: '/usr/bin/node\0worker.js\0', fds: [] },
    ],
  })

  await expect(probe.inspect('thread-1', 99)).resolves.toEqual({ state: 'unknown' })
})
```

- [ ] **Step 6: Run `/proc` ancestry tests and verify RED**

Run:

```bash
pnpm vitest run src/server/externalThreadRuntime.test.ts -t 'native Codex process|ancestry contains a cycle'
```

Expected: the native-child case is reported `running` or lacks ancestry data, and the cycle case does not return `unknown`.

- [ ] **Step 7: Build a validated process table before descriptor enumeration**

Add:

```ts
type LinuxProcessRecord = {
  pid: number
  parentPid: number
  uid: number
  cmdline: string
}

const MAX_PROCESS_ANCESTRY_DEPTH = 128

function parseProcParentPid(status: string): number {
  const match = /^PPid:\s+(\d+)/mu.exec(status)
  if (!match) throw new InconclusiveRuntimeScanError('Cannot parse process parent PID')
  const parentPid = Number.parseInt(match[1], 10)
  if (!Number.isSafeInteger(parentPid) || parentPid < 0) {
    throw new InconclusiveRuntimeScanError('Cannot parse process parent PID')
  }
  return parentPid
}

function collectAncestorPids(
  pid: number,
  processes: ReadonlyMap<number, LinuxProcessRecord>,
): number[] {
  const ancestors: number[] = []
  const seen = new Set([pid])
  let current = processes.get(pid)?.parentPid ?? 0
  for (let depth = 0; current > 0 && depth < MAX_PROCESS_ANCESTRY_DEPTH; depth += 1) {
    if (seen.has(current)) {
      throw new InconclusiveRuntimeScanError('Process ancestry contains a cycle')
    }
    ancestors.push(current)
    if (current === 1) return ancestors
    seen.add(current)
    const parent = processes.get(current)
    if (!parent) {
      throw new InconclusiveRuntimeScanError('Cannot resolve process ancestry')
    }
    current = parent.parentPid
  }
  if (current > 0) {
    throw new InconclusiveRuntimeScanError('Process ancestry exceeds the depth limit')
  }
  return ancestors
}
```

Refactor `listLinuxFdSnapshots` into two passes:

1. Read all numeric process statuses into `Map<number, LinuxProcessRecord>`, parsing UID and PPID. Read cmdline for same-UID processes and use an empty string for other UIDs.
2. Iterate same-UID records whose argv qualifies, calculate `ancestorPids`, enumerate descriptors, and yield the existing descriptor fields plus `ancestorPids`.

- [ ] **Step 8: Run focused tests and verify GREEN**

Run:

```bash
pnpm vitest run src/server/externalThreadRuntime.test.ts
```

Expected: all probe tests pass, including command ordering, direct/deep exclusion, separate desktop acceptance, and cyclic ancestry.

- [ ] **Step 9: Commit descendant exclusion**

```bash
git add src/server/externalThreadRuntime.ts src/server/externalThreadRuntime.test.ts
git commit -m "fix: exclude the mobile app-server process tree"
```

### Task 3: Document and verify the production correction

**Files:**
- Modify: `tests/thread-loading-state/external-client-running-state-after-refresh.md`

**Interfaces:**
- Consumes: the corrected runtime endpoint and existing mobile external-running UI.
- Produces: a repeatable manual regression procedure covering configured desktop argv and mobile descendant exclusion.

- [ ] **Step 1: Extend the manual regression document**

Add a section titled `Configured desktop command and launcher descendants` with these assertions:

```markdown
1. Start the desktop app-server in the production layout `codex -c features.code_mode_host=true app-server --listen unix://` and begin a long-running turn.
2. Open the same thread in `codex-mobile-safe`; confirm `/codex-api/thread-runtime-state` returns `running` and the composer shows the disabled “Running in another client” stop control.
3. Confirm the mobile Node launcher and its native Codex child can both hold the rollout without being accepted as external evidence.
4. Stop the separate desktop app-server while leaving the mobile service alive; after the terminal refresh the endpoint must become `idle` and the normal send control must return.
```

- [ ] **Step 2: Run focused and complete automated verification**

Run:

```bash
pnpm vitest run src/server/externalThreadRuntime.test.ts src/server/externalThreadRuntimeBridge.test.ts
pnpm test:unit
pnpm build
node dist-cli/safe.js doctor
git diff --check main..HEAD
```

Expected: focused tests pass; all unit tests pass; Vue type checking, Vite, and tsup complete; doctor prints `codex-mobile-safe doctor: ok`; diff-check prints nothing.

- [ ] **Step 3: Review the focused diff**

Run:

```bash
git diff --stat main..HEAD
git diff main..HEAD -- src/server/externalThreadRuntime.ts src/server/externalThreadRuntime.test.ts tests/thread-loading-state/external-client-running-state-after-refresh.md
```

Confirm no HTTP route, auth middleware, polling interval, Tailscale configuration, or UI mutation behavior changed.

- [ ] **Step 4: Commit the manual regression update**

```bash
git add tests/thread-loading-state/external-client-running-state-after-refresh.md
git commit -m "test: cover configured desktop runtime detection"
```

## Controller integration after all task reviews and the final branch review

- [ ] **Step 1: Merge, install, and restart only after review approval**

From the main worktree, fetch and confirm `main == origin/main`, fast-forward merge `codex/fix-appserver-process-detection`, rerun `pnpm test:unit && pnpm build`, push `main`, run `pnpm install:local`, and restart `codex-mobile-safe.service`.

- [ ] **Step 2: Verify the affected production thread and mobile UI**

For the affected thread `019f50f7-b8d9-72a3-9861-5ca7c3a0ea1e`, authenticate without printing the password and require a running endpoint result:

```bash
COOKIE=$(mktemp)
jq -n --rawfile p /home/zonghangli/.codex/codex-mobile-safe-password \
  '{password: ($p | rtrimstr("\n"))}' \
  | curl -sS -o /dev/null -c "$COOKIE" -H 'Content-Type: application/json' \
      --data-binary @- http://127.0.0.1:5900/auth/login
curl -sS -b "$COOKIE" \
  'http://127.0.0.1:5900/codex-api/thread-runtime-state?threadId=019f50f7-b8d9-72a3-9861-5ca7c3a0ea1e' \
  | jq -e '.state == "running" and .interruptible == false'
rm -f "$COOKIE"
```

Expected: `true` while the desktop turn is still active.

Run the existing temporary mobile-sized diagnostic:

```bash
node /tmp/codex-mobile-live-diagnose.mjs 019f50f7-b8d9-72a3-9861-5ca7c3a0ea1e
jq -e '.textareaDisabled == true and .stopDisabled == true and .stopTitle == "Running in another client" and .submitCount == 0' \
  /tmp/codex-mobile-live-evidence.json
```

Expected: `true`.

- [ ] **Step 3: Verify safety and repository state**

Run:

```bash
codex-mobile-safe doctor
codex-mobile-safe status
tailscale serve status
ss -ltnp | rg ':(5900|4173|5173)\b'
git status --short
git rev-parse HEAD
git rev-parse origin/main
```

Expected: doctor is `ok`; safe status is running and password protected; Serve is tailnet-only to `127.0.0.1:5900`; only port 5900 is present and loopback-bound; the worktree is clean; local and remote main SHAs match.
