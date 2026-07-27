# Asynchronous Safe-Service Restart Trigger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace direct, blocking `systemctl --user restart` calls with a private `/tmp` marker watched by user systemd so a restricted Codex turn can queue a restart and finish without deadlocking the service it is restarting.

**Architecture:** A small request script atomically updates a user-owned marker and returns immediately. A rendered systemd path unit starts an independent oneshot worker that restarts the fixed `codex-mobile-safe.service` unit and performs a bounded health check.

**Tech Stack:** POSIX shell, systemd user service/path units, Node.js package scripts, Vitest packaging tests.

## Global Constraints

- Preserve the current password file, loopback binding, Tailnet/LAN exposure, Codex sandbox and approval settings, and `Restart=on-failure`.
- Add no HTTP restart endpoint and no root-level service.
- The marker contains no password, ntfy topic, session token, upload capability, or command.
- The request directory is user-specific, non-symlink, current-user-owned, and mode `0700`.
- The worker can restart only `codex-mobile-safe.service`.
- A restart request reports only that it was queued; worker health is authoritative in the user journal and `service:status`.
- Preserve the existing uncommitted upload-lifecycle changes in `src/composables/useDesktopState.ts`, `src/composables/useDesktopState.test.ts`, `src/server/codexAppServerBridge.ts`, and `src/server/codexAppServerBridge.security.test.ts`. Do not stage them in restart-trigger commits.

---

## File Structure

- Create `scripts/request-user-service-restart.sh`: validate the private marker directory and atomically publish one restart request without invoking systemd.
- Create `scripts/restart-user-service-worker.sh`: restart the fixed main unit and perform bounded systemd/runtime health checks.
- Create `packaging/systemd/codex-mobile-safe-restart.path.in`: watch the rendered marker path.
- Create `packaging/systemd/codex-mobile-safe-restart.service.in`: run the fixed worker script with the installed safe binary path.
- Modify `scripts/install-user-service.sh`: render, verify, enable, and activate the three units, then queue rather than await a restart.
- Modify `scripts/uninstall-user-service.sh`: disable and remove restart units and safely remove this user's marker directory.
- Modify `package.json`: route `service:restart` through the request script.
- Modify `src/safe/packaging.test.ts`: behavioral and static coverage for scripts, templates, installation, and removal.
- Modify `README.md`: explain queued restart semantics and status verification.
- Modify `docs/AGENT_GUIDE.md`: make asynchronous restart and its required verification the agent-facing default.

### Task 1: Private Restart Request and Worker

**Files:**
- Create: `scripts/request-user-service-restart.sh`
- Create: `scripts/restart-user-service-worker.sh`
- Create: `packaging/systemd/codex-mobile-safe-restart.path.in`
- Create: `packaging/systemd/codex-mobile-safe-restart.service.in`
- Modify: `src/safe/packaging.test.ts`

**Interfaces:**
- Consumes: `CODEX_MOBILE_RESTART_REQUEST_DIR` only as a test/install-time path override; production defaults to `/tmp/codex-mobile-safe-restart-$(id -u)`.
- Produces: `scripts/request-user-service-restart.sh` with exit status `0` after atomic marker publication.
- Produces: `scripts/restart-user-service-worker.sh <safe-bin>` with exit status `0` only after the fixed main unit is active and `safe-bin status` reports `"running": true`.
- Produces: templates containing `@RESTART_REQUEST_FILE@`, `@PROJECT_DIR@`, and `@PREFIX@` placeholders for the installer.

- [ ] **Step 1: Write failing packaging and behavior tests**

Extend imports in `src/safe/packaging.test.ts`:

```ts
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
```

Add focused tests:

```ts
it('queues a restart through a private atomic marker without calling systemctl', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'codex-mobile-restart-request-'))
  try {
    const requestDirectory = join(temporaryRoot, 'request')
    const scriptPath = fileURLToPath(new URL('../../scripts/request-user-service-restart.sh', import.meta.url))
    await execFileAsync('sh', [scriptPath], {
      env: {
        ...process.env,
        CODEX_MOBILE_RESTART_REQUEST_DIR: requestDirectory,
      },
    })

    expect((await stat(requestDirectory)).mode & 0o777).toBe(0o700)
    expect((await readFile(join(requestDirectory, 'restart.request'), 'utf8')).trim())
      .toMatch(/^[0-9]+$/u)
    expect(await readFile(scriptPath, 'utf8')).not.toContain('systemctl')
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

it('rejects a symlink restart request directory', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'codex-mobile-restart-symlink-'))
  try {
    const realDirectory = join(temporaryRoot, 'real')
    const requestDirectory = join(temporaryRoot, 'request')
    await mkdir(realDirectory)
    await symlink(realDirectory, requestDirectory)

    await expect(execFileAsync('sh', [
      fileURLToPath(new URL('../../scripts/request-user-service-restart.sh', import.meta.url)),
    ], {
      env: {
        ...process.env,
        CODEX_MOBILE_RESTART_REQUEST_DIR: requestDirectory,
      },
    })).rejects.toThrow()
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

it('packages a fixed-unit restart worker and path trigger', async () => {
  const [requestScript, workerScript, pathUnit, workerUnit] = await Promise.all([
    readRepoFile('scripts/request-user-service-restart.sh'),
    readRepoFile('scripts/restart-user-service-worker.sh'),
    readRepoFile('packaging/systemd/codex-mobile-safe-restart.path.in'),
    readRepoFile('packaging/systemd/codex-mobile-safe-restart.service.in'),
  ])

  expect(requestScript).toContain('restart.request')
  expect(requestScript).not.toContain('systemctl')
  expect(workerScript).toContain('systemctl --user restart codex-mobile-safe.service')
  expect(workerScript).toContain('\"running\": true')
  expect(pathUnit).toContain('PathChanged=@RESTART_REQUEST_FILE@')
  expect(pathUnit).toContain('Unit=codex-mobile-safe-restart.service')
  expect(workerUnit).toContain('Type=oneshot')
  expect(workerUnit).toContain(
    'ExecStart=@PROJECT_DIR@/scripts/restart-user-service-worker.sh @PREFIX@/bin/codex-mobile-safe',
  )
  expect(`${requestScript}\n${workerScript}\n${pathUnit}\n${workerUnit}`)
    .not.toMatch(/ntfy\.sh|password=|NTFY_/u)
})
```

- [ ] **Step 2: Run the focused tests and observe the missing-file failures**

Run:

```bash
pnpm exec vitest run src/safe/packaging.test.ts -t 'queues a restart|rejects a symlink|fixed-unit restart'
```

Expected: FAIL because the two scripts and two templates do not exist.

- [ ] **Step 3: Implement the atomic request script**

Create `scripts/request-user-service-restart.sh`:

```sh
#!/bin/sh
set -eu

uid=$(id -u)
request_dir=${CODEX_MOBILE_RESTART_REQUEST_DIR:-"/tmp/codex-mobile-safe-restart-$uid"}
request_file=$request_dir/restart.request

if [ -L "$request_dir" ]; then
  printf '%s\n' 'Restart request directory must not be a symlink.' >&2
  exit 1
fi
if [ -e "$request_dir" ] && [ ! -d "$request_dir" ]; then
  printf '%s\n' 'Restart request path is not a directory.' >&2
  exit 1
fi

umask 077
mkdir -p "$request_dir"
owner=$(stat -c '%u' "$request_dir")
mode=$(stat -c '%a' "$request_dir")
if [ "$owner" != "$uid" ] || [ "$mode" != 700 ]; then
  printf '%s\n' 'Restart request directory must be current-user-owned with mode 0700.' >&2
  exit 1
fi

temporary_file=$request_dir/.restart.request.$$
trap 'rm -f "$temporary_file"' EXIT HUP INT TERM
date +%s%N > "$temporary_file"
mv -f "$temporary_file" "$request_file"
trap - EXIT HUP INT TERM
printf '%s\n' 'Queued codex-mobile-safe service restart.'
```

The `CODEX_MOBILE_RESTART_REQUEST_DIR` override exists for isolated installer
and unit tests. The installed path unit always watches the rendered fixed
production path.

- [ ] **Step 4: Implement the fixed restart worker**

Create `scripts/restart-user-service-worker.sh`:

```sh
#!/bin/sh
set -eu

safe_bin=${1:-}
if [ -z "$safe_bin" ] || [ ! -x "$safe_bin" ]; then
  printf '%s\n' 'Missing executable codex-mobile-safe path.' >&2
  exit 1
fi

systemctl --user restart codex-mobile-safe.service

attempts=30
while [ "$attempts" -gt 0 ]; do
  if systemctl --user is-active --quiet codex-mobile-safe.service \
    && "$safe_bin" status 2>/dev/null | grep -q '"running": true'; then
    printf '%s\n' 'codex-mobile-safe restart completed and is healthy.'
    exit 0
  fi
  attempts=$((attempts - 1))
  sleep 1
done

printf '%s\n' 'codex-mobile-safe did not become healthy after restart.' >&2
exit 1
```

- [ ] **Step 5: Implement the two systemd templates**

Create `packaging/systemd/codex-mobile-safe-restart.path.in`:

```ini
[Unit]
Description=Watch for Codex Mobile Safe restart requests

[Path]
PathChanged=@RESTART_REQUEST_FILE@
Unit=codex-mobile-safe-restart.service

[Install]
WantedBy=default.target
```

Create `packaging/systemd/codex-mobile-safe-restart.service.in`:

```ini
[Unit]
Description=Restart and verify Codex Mobile Safe

[Service]
Type=oneshot
ExecStart=@PROJECT_DIR@/scripts/restart-user-service-worker.sh @PREFIX@/bin/codex-mobile-safe
UMask=0077
```

- [ ] **Step 6: Run focused tests and shell syntax checks**

Run:

```bash
pnpm exec vitest run src/safe/packaging.test.ts -t 'queues a restart|rejects a symlink|fixed-unit restart'
sh -n scripts/request-user-service-restart.sh scripts/restart-user-service-worker.sh
```

Expected: focused tests PASS and both shell scripts parse successfully.

- [ ] **Step 7: Commit Task 1 without staging upload-lifecycle files**

```bash
git add \
  scripts/request-user-service-restart.sh \
  scripts/restart-user-service-worker.sh \
  packaging/systemd/codex-mobile-safe-restart.path.in \
  packaging/systemd/codex-mobile-safe-restart.service.in \
  src/safe/packaging.test.ts
git commit -m "feat(service): add asynchronous restart trigger"
```

### Task 2: Installer, Uninstaller, and Package Lifecycle

**Files:**
- Modify: `scripts/install-user-service.sh`
- Modify: `scripts/uninstall-user-service.sh`
- Modify: `package.json`
- Modify: `src/safe/packaging.test.ts`

**Interfaces:**
- Consumes: the Task 1 templates and request script.
- Produces: rendered `codex-mobile-safe.service`, `codex-mobile-safe-restart.path`, and `codex-mobile-safe-restart.service` in the user unit directory.
- Produces: `pnpm run service:restart` as a non-blocking marker publication command.

- [ ] **Step 1: Write failing package and isolated-installer assertions**

Change the package assertion to:

```ts
expect(packageJson.scripts?.['service:restart'])
  .toBe('sh scripts/request-user-service-restart.sh')
```

Extend the isolated installer test with:

```ts
const restartPathUnitPath = join(
  configDirectory,
  'systemd/user/codex-mobile-safe-restart.path',
)
const restartServiceUnitPath = join(
  configDirectory,
  'systemd/user/codex-mobile-safe-restart.service',
)
const restartPathUnit = await readFile(restartPathUnitPath, 'utf8')
const restartServiceUnit = await readFile(restartServiceUnitPath, 'utf8')

expect(restartPathUnit).not.toMatch(/@[A-Z_]+@/u)
expect(restartPathUnit).toContain(
  `PathChanged=${join(temporaryRoot, 'restart-request/restart.request')}`,
)
expect(restartServiceUnit).not.toMatch(/@[A-Z_]+@/u)
expect(restartServiceUnit).toContain(
  `ExecStart=${repoRoot}/scripts/restart-user-service-worker.sh ${prefix}/bin/codex-mobile-safe`,
)
expect((await stat(restartPathUnitPath)).mode & 0o777).toBe(0o600)
expect((await stat(restartServiceUnitPath)).mode & 0o777).toBe(0o600)
```

Pass this isolated request directory to the installer test:

```ts
CODEX_MOBILE_RESTART_REQUEST_DIR: join(temporaryRoot, 'restart-request'),
```

Replace the old static direct-restart assertions with:

```ts
expect(serviceInstaller).toContain(
  'systemctl --user enable --now codex-mobile-safe-restart.path',
)
expect(serviceInstaller).toContain(
  'sh \"$root/scripts/request-user-service-restart.sh\"',
)
expect(serviceInstaller).not.toContain(
  'systemctl --user restart codex-mobile-safe.service',
)
```

Add uninstaller assertions:

```ts
const uninstaller = await readRepoFile('scripts/uninstall-user-service.sh')
expect(uninstaller).toContain(
  'systemctl --user disable --now codex-mobile-safe-restart.path',
)
expect(uninstaller).toContain('codex-mobile-safe-restart.service')
expect(uninstaller).toContain('codex-mobile-safe-restart.path')
expect(uninstaller).toContain('restart.request')
```

- [ ] **Step 2: Run focused tests and observe lifecycle assertion failures**

Run:

```bash
pnpm exec vitest run src/safe/packaging.test.ts
```

Expected: FAIL on the old direct `service:restart`, missing rendered units, and
missing installer/uninstaller wiring.

- [ ] **Step 3: Render and install all user units**

Modify `scripts/install-user-service.sh` to define:

```sh
main_unit_file=$unit_dir/codex-mobile-safe.service
restart_path_unit_file=$unit_dir/codex-mobile-safe-restart.path
restart_service_unit_file=$unit_dir/codex-mobile-safe-restart.service
uid=$(id -u)
restart_request_dir=${CODEX_MOBILE_RESTART_REQUEST_DIR:-"/tmp/codex-mobile-safe-restart-$uid"}
restart_request_file=$restart_request_dir/restart.request
```

Replace the one-template rendering block with a reusable renderer:

```sh
if [ -L "$restart_request_dir" ]; then
  printf '%s\n' 'Restart request directory must not be a symlink.' >&2
  exit 1
fi
if [ -e "$restart_request_dir" ] && [ ! -d "$restart_request_dir" ]; then
  printf '%s\n' 'Restart request path is not a directory.' >&2
  exit 1
fi
umask 077
mkdir -p "$restart_request_dir"
owner=$(stat -c '%u' "$restart_request_dir")
mode=$(stat -c '%a' "$restart_request_dir")
if [ "$owner" != "$uid" ] || [ "$mode" != 700 ]; then
  printf '%s\n' 'Restart request directory must be current-user-owned with mode 0700.' >&2
  exit 1
fi

render_template() {
  template=$1
  destination=$2
  sed \
    -e "s|@PROJECT_DIR@|$(escape_sed "$root")|g" \
    -e "s|@PREFIX@|$(escape_sed "$prefix")|g" \
    -e "s|@RESTART_REQUEST_FILE@|$(escape_sed "$restart_request_file")|g" \
    "$template" > "$destination"
  chmod 600 "$destination"
}

render_template \
  "$root/packaging/systemd/codex-mobile-safe.service.in" \
  "$main_unit_file"
render_template \
  "$root/packaging/systemd/codex-mobile-safe-restart.path.in" \
  "$restart_path_unit_file"
render_template \
  "$root/packaging/systemd/codex-mobile-safe-restart.service.in" \
  "$restart_service_unit_file"
```

Keep test mode after rendering all files. In normal mode verify and activate:

```sh
systemd-analyze --user verify \
  "$main_unit_file" \
  "$restart_path_unit_file" \
  "$restart_service_unit_file"
systemctl --user daemon-reload
systemctl --user enable codex-mobile-safe.service
systemctl --user enable --now codex-mobile-safe-restart.path
CODEX_MOBILE_RESTART_REQUEST_DIR=$restart_request_dir \
  sh "$root/scripts/request-user-service-restart.sh"
```

Remove the blocking main-service restart and immediate status wait.

- [ ] **Step 4: Update package command and safe uninstallation**

Set in `package.json`:

```json
"service:restart": "sh scripts/request-user-service-restart.sh"
```

Modify `scripts/uninstall-user-service.sh` to use fixed unit paths and this
ordering:

```sh
uid=$(id -u)
restart_request_dir=${CODEX_MOBILE_RESTART_REQUEST_DIR:-"/tmp/codex-mobile-safe-restart-$uid"}
restart_request_file=$restart_request_dir/restart.request

systemctl --user disable --now codex-mobile-safe-restart.path 2>/dev/null || true
systemctl --user stop codex-mobile-safe-restart.service 2>/dev/null || true
systemctl --user disable --now codex-mobile-safe.service 2>/dev/null || true
rm -f \
  "$unit_dir/codex-mobile-safe.service" \
  "$unit_dir/codex-mobile-safe-restart.path" \
  "$unit_dir/codex-mobile-safe-restart.service"
if [ -d "$restart_request_dir" ] \
  && [ ! -L "$restart_request_dir" ] \
  && [ "$(stat -c '%u' "$restart_request_dir")" = "$uid" ]; then
  rm -f "$restart_request_file"
  rmdir "$restart_request_dir" 2>/dev/null || true
fi
systemctl --user daemon-reload
systemctl --user reset-failed codex-mobile-safe.service 2>/dev/null || true
systemctl --user reset-failed codex-mobile-safe-restart.service 2>/dev/null || true
```

- [ ] **Step 5: Run packaging and syntax checks**

Run:

```bash
pnpm exec vitest run src/safe/packaging.test.ts
sh -n \
  scripts/install-user-service.sh \
  scripts/uninstall-user-service.sh \
  scripts/request-user-service-restart.sh \
  scripts/restart-user-service-worker.sh
```

Expected: packaging tests PASS and all scripts parse.

- [ ] **Step 6: Render temporary units and verify systemd syntax**

Run:

```bash
temporary_root=$(mktemp -d)
HOME="$temporary_root/home" \
XDG_CONFIG_HOME="$temporary_root/config" \
PREFIX="$temporary_root/prefix" \
CODEX_MOBILE_RESTART_REQUEST_DIR="$temporary_root/restart-request" \
CODEX_MOBILE_SERVICE_INSTALL_TEST_MODE=1 \
  sh scripts/install-user-service.sh
systemd-analyze --user verify \
  "$temporary_root/config/systemd/user/codex-mobile-safe.service" \
  "$temporary_root/config/systemd/user/codex-mobile-safe-restart.path" \
  "$temporary_root/config/systemd/user/codex-mobile-safe-restart.service"
rm -rf "$temporary_root"
```

Expected: all three rendered units verify successfully.

- [ ] **Step 7: Commit Task 2 without staging upload-lifecycle files**

```bash
git add \
  scripts/install-user-service.sh \
  scripts/uninstall-user-service.sh \
  package.json \
  src/safe/packaging.test.ts
git commit -m "feat(service): install asynchronous restart lifecycle"
```

### Task 3: Operator and Agent Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/AGENT_GUIDE.md`

**Interfaces:**
- Consumes: `pnpm run service:restart`, the fixed marker path, and worker journal from Tasks 1-2.
- Produces: exact deployment and diagnosis instructions for people and future agents.

- [ ] **Step 1: Update README service lifecycle wording**

Replace statements that say `service:install` or `service:restart` has already
completed the restart with:

```markdown
`service:install` rebuilds and reinstalls the checkout, renders the user units,
and queues a restart through the private systemd path trigger. The command
returns after the request is published; it does not wait for the active
Codex turn to release the old service.

Check completion with:

```bash
pnpm run service:status
systemctl --user --no-pager --full status codex-mobile-safe-restart.service
```

`service:restart` also queues through the marker and never invokes
`systemctl restart` in the calling Codex turn.
```

Keep all password and ntfy guidance unchanged.

- [ ] **Step 2: Update agent restart and verification rules**

Add to `docs/AGENT_GUIDE.md`:

```markdown
For an installed-service deployment, never wait on
`systemctl --user restart codex-mobile-safe.service` from a Codex turn served
by that same process. Run `pnpm run service:restart` as the final mutation;
it atomically queues the user-systemd path trigger and returns. On the next
interaction, verify the main service and restart-worker journal before
claiming deployment success.
```

Extend the shell-check command to include both new scripts.

- [ ] **Step 3: Verify documentation references**

Run:

```bash
rg -n 'systemctl --user restart codex-mobile-safe\\.service|service:restart|restart\\.request' \
  README.md docs/AGENT_GUIDE.md package.json scripts packaging/systemd
```

Expected: direct restart remains only inside
`scripts/restart-user-service-worker.sh`; operator and agent paths use
`service:restart`.

- [ ] **Step 4: Commit documentation**

```bash
git add README.md docs/AGENT_GUIDE.md
git commit -m "docs: explain queued safe-service restarts"
```

### Task 4: Full Verification and Live Installation

**Files:**
- Verify only; do not modify source unless a failing check identifies a defect.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: installed user units and evidence that marker-triggered restart changes the PID while preserving security and exposure.

- [ ] **Step 1: Run full automated verification**

```bash
pnpm test:unit
pnpm run build
node dist-cli/index.js --help
node dist-cli/safe.js --help
node dist-cli/safe.js doctor
sh -n \
  scripts/install-local.sh \
  scripts/install-user-service.sh \
  scripts/uninstall-user-service.sh \
  scripts/request-user-service-restart.sh \
  scripts/restart-user-service-worker.sh
git diff --check
```

Expected: all tests and builds pass, both help commands exit `0`, doctor
passes, shell syntax passes, and `git diff --check` prints nothing.

- [ ] **Step 2: Record pre-install runtime invariants**

```bash
systemctl --user show codex-mobile-safe.service -p MainPID -p ActiveState
stat -c '%U %a %s' ~/.codex/codex-mobile-safe-password
ss -ltnp | grep ':5900'
tailscale serve status
```

Expected: record the current PID, password metadata, loopback listener, and
unchanged exposure before installation. Do not print password contents.

- [ ] **Step 3: Install units and queue the restart**

```bash
pnpm run service:install
```

Expected: the command reports a queued restart and returns without waiting for
the old service to terminate.

- [ ] **Step 4: Let the current turn finish**

Return a concise progress checkpoint so the systemd worker can restart the
service outside the active turn. Do not run a synchronous restart command.

- [ ] **Step 5: Verify live completion on the next interaction**

```bash
systemctl --user is-active codex-mobile-safe.service
systemctl --user is-active codex-mobile-safe-restart.path
systemctl --user --no-pager --full status codex-mobile-safe-restart.service
systemctl --user show codex-mobile-safe.service -p MainPID -p ExecMainStartTimestamp
ss -ltnp | grep ':5900'
curl -sS -o /dev/null -w 'local_http=%{http_code}\n' http://127.0.0.1:5900/
stat -c '%U %a %s' ~/.codex/codex-mobile-safe-password
tailscale serve status
journalctl --user -u codex-mobile-safe-restart.service \
  -u codex-mobile-safe.service --since '-5 minutes' --no-pager
```

Expected:

- main and path units are active;
- restart worker completed successfully;
- main PID differs from Step 2;
- listener remains `127.0.0.1:5900`;
- local HTTP returns `200`;
- password metadata is unchanged;
- Tailnet/LAN exposure is unchanged; and
- journal contains no startup error or secret value.

- [ ] **Step 6: Review final scope**

```bash
git status --short
git log --oneline -5
git diff --stat HEAD~3..HEAD
```

Expected: restart-trigger commits contain only the planned scripts, units,
packaging tests, package command, and documentation. The four pre-existing
upload-lifecycle files remain uncommitted and are not included in those
commits.
