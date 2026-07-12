# Modular Codex Mobile Safe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a maintained, safe-by-default `codex-mobile-safe` module and local GitHub installation workflow to `zonghang-li/codex-mobile` while preserving the upstream-compatible CLI.

**Architecture:** Keep one package and one shared frontend/app-server bridge. Add explicit security-policy injection points, a dedicated safe CLI entry, lifecycle modules, and local service packaging. Build two CLI entries from shared source and expose four compatible bin names.

**Tech Stack:** TypeScript, Node.js 18+, Commander, Express, tsup, Vitest, pnpm, systemd user services, Tailscale Serve.

## Global Constraints

- Safe mode binds to `127.0.0.1` unless `--lan` is explicitly supplied.
- Safe mode never starts Cloudflare Tunnel or Tailscale Funnel.
- Tailnet access requires explicit `expose tailscale` and password protection.
- Safe mode permits only `read-only` or `workspace-write`, and never approval policy `never`.
- Password files must be current-user-owned regular files without group/other permission bits.
- `codexapp` and `codexui` retain upstream-compatible behavior.
- No generated bundles, credentials, passwords, runtime state, or `node_modules` are committed.
- Every behavior change includes focused unit tests and the full `pnpm run test:unit` suite.

---

### Task 1: Safe policy modules

**Files:**
- Create: `src/safe/featureGate.ts`
- Create: `src/safe/runtimePolicy.ts`
- Create: `src/safe/pathPolicy.ts`
- Create: `src/safe/featureGate.test.ts`
- Create: `src/safe/runtimePolicy.test.ts`
- Create: `src/safe/pathPolicy.test.ts`

**Interfaces:**
- Produces: `SafeRuntimeConfig`, `loadSafeRuntimeConfig(env)`, `isDisabledRoute(method, pathname)`, `isAllowedRpcMethod(method)`, and `resolveAllowedPath(path, roots)`.
- Consumes: only Node path/filesystem APIs and environment values.

- [ ] Write failing tests asserting loopback/default port, safe sandbox/approval fallback, explicit LAN, no auth bypass, route denial, RPC allowlisting, and symlink-aware allowed-root containment.
- [ ] Run `pnpm exec vitest run src/safe/*.test.ts`; expect missing-module failures.
- [ ] Port the six safe policy behaviors from the installed `codex-mobile-safe` source map into focused modules under `src/safe/`.
- [ ] Run the focused tests; expect all pass.
- [ ] Commit with `feat: add safe runtime policy modules`.

### Task 2: Inject security policy into shared HTTP and RPC layers

**Files:**
- Create: `src/server/securityPolicy.ts`
- Create: `src/server/securityPolicy.test.ts`
- Modify: `src/server/httpServer.ts`
- Modify: `src/server/codexAppServerBridge.ts`
- Create: `src/server/codexAppServerBridge.security.test.ts`

**Interfaces:**
- Produces: `ServerSecurityPolicy`, `PERMISSIVE_SECURITY_POLICY`, and `buildSafeSecurityPolicy(config)`.
- `createServer({ password, securityPolicy })` passes the policy to `createCodexBridgeMiddleware({ securityPolicy })` and applies file-edit/path restrictions.
- Default call sites receive `PERMISSIVE_SECURITY_POLICY`, preserving upstream behavior.

- [ ] Write failing tests that permissive policy allows existing routes, safe policy blocks disabled route prefixes, rejects non-allowlisted RPC methods, blocks terminal input/file editing by default, and restricts local paths to configured roots.
- [ ] Run the focused tests and confirm they fail on missing injection points.
- [ ] Add the policy interface and optional parameters with permissive defaults.
- [ ] Apply checks at the bridge request boundary, `/codex-api/rpc`, terminal input, and local browse/edit/file routes without changing response shapes outside rejected safe requests.
- [ ] Run focused and full unit suites.
- [ ] Commit with `feat: inject safe server policy`.

### Task 3: Password, state, exposure, and doctor lifecycle modules

**Files:**
- Create: `src/safe/passwordFile.ts`
- Create: `src/safe/passwordFile.test.ts`
- Create: `src/safe/state.ts`
- Create: `src/safe/state.test.ts`
- Create: `src/safe/exposure.ts`
- Create: `src/safe/exposure.test.ts`
- Create: `src/safe/doctor.ts`
- Create: `src/safe/doctor.test.ts`

**Interfaces:**
- `readSecurePasswordFile(path, identity?) -> Promise<string>` validates regular-file type, uid, mode, and non-empty content.
- `readLiveManagedState()` validates persisted JSON plus PID command marker; stale state is cleared before returning `null`.
- `exposeTailscale(port, runner?) -> Promise<string>` uses `tailscale serve --bg --https=443 http://127.0.0.1:<port>`.
- `runDoctor(root) -> Promise<{ok:boolean; failures:string[]}>` statically checks packaged safe invariants.

- [ ] Write failing tests with temporary homes/files and fake process/Tailscale runners.
- [ ] Confirm missing-module failures.
- [ ] Implement password validation, managed-state lifecycle, explicit Tailscale Serve operations, and doctor checks.
- [ ] Run focused and full unit suites.
- [ ] Commit with `feat: add safe CLI lifecycle modules`.

### Task 4: Shared launcher and dual CLI build

**Files:**
- Create: `src/cli/shared/launcher.ts`
- Create: `src/cli/shared/launcher.test.ts`
- Create: `src/cli/safe.ts`
- Modify: `src/cli/index.ts`
- Modify: `src/server/password.ts`
- Modify: `src/server/appServerRuntimeConfig.ts`
- Modify: `tsup.config.ts`
- Modify: `package.json`

**Interfaces:**
- `launchWebServer(options)` accepts bind host, password, security policy, runtime mode, branding, lifecycle callbacks, and optional tunnel callbacks.
- Original CLI continues through `src/cli/index.ts` with `0.0.0.0` and existing tunnel-selection behavior.
- Safe CLI exposes `start`, `status`, `urls`, `expose tailscale`, `unexpose`, `stop`, `doctor`, `login`, and `help`.
- Safe start accepts mutually exclusive `--password` and `--password-file` and validates safe sandbox/approval values.
- tsup emits ESM `dist-cli/index.js` and `dist-cli/safe.js`.
- Package bins include `codexapp`, `codexui`, `codex-mobile`, and `codex-mobile-safe`.

- [ ] Write failing launcher/CLI parsing tests before extraction.
- [ ] Extract only shared startup behavior; leave Cloudflare discovery/install/tunnel code original-only.
- [ ] Implement safe CLI using the Task 1-3 modules and write state only after successful bind.
- [ ] Build with `pnpm run build:cli` and run `node dist-cli/index.js --help` plus `node dist-cli/safe.js --help`.
- [ ] Confirm safe help contains no tunnel/funnel flag and original help remains compatible.
- [ ] Run full tests and commit with `feat: build original and safe CLIs together`.

### Task 5: GitHub-clone installation and systemd service

**Files:**
- Create: `packaging/systemd/codex-mobile-safe.service.in`
- Create: `scripts/install-local.sh`
- Create: `scripts/install-user-service.sh`
- Create: `scripts/uninstall-user-service.sh`
- Create: `src/safe/packaging.test.ts`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- `pnpm run install:local` builds and installs the current clone under `${CODEX_MOBILE_PREFIX:-$HOME/.local}`.
- `pnpm run service:install`, `service:restart`, and `service:uninstall` manage the user unit.
- The unit invokes `codex-mobile-safe start ... --password-file %h/.codex/codex-mobile-safe-password` with `Restart=on-failure` and no plaintext password.

- [ ] Write failing static packaging tests for bin names, template binding, restart behavior, absence of `--password`, and presence of `--password-file`.
- [ ] Create POSIX shell installers with quoted paths, idempotent directory creation, `systemd-analyze --user verify`, and clear linger guidance.
- [ ] Run `shellcheck` when available, otherwise `sh -n`, plus focused tests.
- [ ] Build and install into a temporary prefix; confirm both bin symlinks execute `--help`.
- [ ] Commit with `feat: add local install and user service tooling`.

### Task 6: User and agent documentation

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Create: `docs/AGENT_GUIDE.md`
- Create: `tests/cli-network-platform/modular-safe-cli-local-install-and-tailnet-service.md`
- Modify: `tests/cli-network-platform/index.md`

**Interfaces:**
- Documents clone/install/update, both command modes, password-file creation, Tailscale setup, systemd lifecycle, rollback, architecture, security invariants, and required tests.

- [ ] Update README with a safe-first quickstart and explicit warning about original-mode exposure.
- [ ] Add the agent guide with source ownership, upstream sync workflow, generated/secret exclusions, and exact validation commands.
- [ ] Add a mandatory root `AGENTS.md` section pointing to the guide and listing security regression tests.
- [ ] Add the repo-required manual test case and index entry.
- [ ] Run documentation link/path checks using `rg` and `git diff --check`.
- [ ] Commit with `docs: explain modular safe CLI workflow`.

### Task 7: Full verification, performance audit, and delivery

**Files:**
- Modify only if verification finds a confirmed defect.

**Interfaces:**
- Consumes all previous tasks.
- Produces reproducible evidence and a pushed feature branch.

- [ ] Run `pnpm run test:unit`, `pnpm run build`, both CLI help smoke tests, doctor, and CJS/package/runtime smoke appropriate to the ESM executables.
- [ ] Compare `dist-cli` sizes and startup request/process behavior; confirm shared code is not duplicated into simultaneous app-server processes.
- [ ] Install from the worktree to the user prefix, install/restart the user service, and verify only `127.0.0.1:5900` listens.
- [ ] Verify Tailscale Serve remains Tailnet-only and authenticate without printing the password.
- [ ] Verify current-thread `thread/read` and `thread/resume` return HTTP 200.
- [ ] Kill the service process, wait for a new PID, and repeat `thread/resume`.
- [ ] Run `git diff --check`, inspect branch delta, and confirm no secrets/generated bundles are tracked.
- [ ] Push `codex/modular-safe-cli` to `zonghang-li/codex-mobile` and open a pull request against `main` with verification notes.
