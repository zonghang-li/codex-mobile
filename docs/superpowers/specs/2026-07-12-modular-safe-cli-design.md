# Modular Codex Mobile Safe Design

## Goal

Turn the locally installed `codex-mobile-safe` fork into a maintained module of `zonghang-li/codex-mobile` while preserving the upstream application and both local commands:

- `codex-mobile`: upstream-compatible behavior for users who explicitly want it.
- `codex-mobile-safe`: safe-by-default behavior for Tailnet-only remote access.

The repository is installed from a GitHub clone and updated frequently. Publishing either package to npm is outside scope.

## Constraints

- Keep the repository easy to update from `friuns2/codex-mobile`.
- Do not commit installed bundles, `node_modules`, credentials, generated passwords, runtime state, or machine-specific paths outside documented examples.
- Keep the safe service on `127.0.0.1` unless the user explicitly passes `--lan`.
- Never start Cloudflare Tunnel or Tailscale Funnel from the safe command.
- Require an explicit `expose tailscale` operation for remote access.
- Preserve authentication for every non-loopback request.
- Keep passwords out of process command lines when systemd starts the service.
- Preserve the existing upstream CLI aliases `codexapp` and `codexui`.

## Repository Architecture

The project remains a single package rather than becoming a workspace monorepo. This minimizes upstream merge conflicts and keeps the existing frontend, app-server bridge, and build pipeline shared.

### Entry points

- `src/cli/index.ts` remains the upstream-compatible CLI entry.
- `src/cli/safe.ts` becomes the safe CLI entry.
- `src/cli/shared/` contains launch behavior genuinely shared by both entry points. Refactoring into this directory must preserve upstream behavior before the safe policy is applied.
- `src/safe/` contains policy and lifecycle behavior that only the safe entry point imports.

The build emits two executable entry points. `package.json` exposes:

- `codexapp`, `codexui`, and `codex-mobile` through the upstream-compatible entry.
- `codex-mobile-safe` through the safe entry.

## Safe Module Boundaries

The locally installed safe bundle contains six distinct source responsibilities. They become maintainable source modules rather than copied compiled output:

1. `safeFeatureGate`: RPC allowlist and disabled high-risk HTTP routes.
2. `safeRuntimePolicy`: loopback binding, sandbox/approval allowlists, and safe defaults.
3. `safePath`: path validation used by safe routes and diagnostics.
4. `state`: managed-process state, live PID validation, stale-state cleanup, and URL reporting.
5. `exposure`: explicit Tailscale Serve enable/disable operations without Funnel support.
6. `doctor`: static checks that packaged code retains all required security invariants.

The safe feature gate is injected into the shared HTTP bridge through an explicit policy interface. The upstream-compatible entry uses the permissive upstream policy. The safe entry uses the restrictive policy. Shared code must not import safe modules implicitly.

## CLI Compatibility

`codex-mobile-safe start [projectPath]` keeps the current command surface:

- `--port`
- `--password`
- `--no-password`
- `--lan`
- `--open` / `--no-open`
- `--login` / `--no-login`
- `--memories` / `--no-memories`
- `--sandbox-mode`
- `--approval-policy`

It also adds `--password-file <path>`. The file must be a regular file, owned by the current user, and inaccessible to group/other users. `--password` and `--password-file` are mutually exclusive. This option allows systemd to use the existing mode-0600 password file without exposing its value through `/proc/<pid>/cmdline`.

The safe command retains `status`, `urls`, `expose tailscale`, `unexpose`, `stop`, `doctor`, and `login`.

`status` must not trust the state JSON alone. It verifies that the PID exists and that its command marker matches the safe executable. When verification fails, it removes stale state and reports `running: false`.

## Local Installation and Service Management

`pnpm run install:local` performs a production build and installs the current clone under the user npm prefix, defaulting to `$HOME/.local`. Running it again after `git pull` refreshes both commands.

The repository includes:

- a systemd user-unit template;
- an installer that substitutes the clone path and user home;
- commands to install, restart, inspect, and uninstall the service.

The unit runs only `codex-mobile-safe`, uses `--password-file`, binds port `5900` on loopback, uses `workspace-write` with `on-request`, and sets `Restart=on-failure`. Tailscale Serve remains independently managed so it can continue to provide a stable Tailnet URL across service restarts.

The installer reports when `loginctl show-user "$USER" -p Linger` is disabled. It does not silently enable lingering because that requires administrator policy. Documentation gives the explicit optional command for boot-before-login operation.

## Tests and Verification

Automated coverage includes:

- safe runtime default and invalid-option tests;
- RPC and route feature-gate tests;
- password-file ownership, type, and permission tests;
- mutual-exclusion tests for password sources;
- stale PID and mismatched command-marker state tests;
- Tailscale exposure command tests with a fake runner;
- doctor pass/fail tests;
- build and executable smoke tests for both CLI entries;
- systemd unit verification and assertions that the password is absent from `ExecStart`.

The final runtime verification installs from the clone, starts the user service, confirms only `127.0.0.1:5900` is listening, confirms the Tailnet route points to that loopback port, authenticates without printing the password, and checks `thread/read` plus `thread/resume` over Tailnet HTTPS. A forced process termination verifies systemd starts a new PID and the RPC path recovers.

## Performance Audit

The safe policy is evaluated once per RPC/HTTP request using constant-size sets. State validation adds one process probe only to explicit lifecycle commands such as `status` and `urls`; it does not run on chat traffic. Password-file validation runs once at startup. The module split must not add frontend bundles, duplicate app-server processes, or extra startup API requests.

Build output size and CLI startup behavior are compared before and after implementation. Any material increase must be attributed to the safe entry rather than duplicated shared code.

## Agent Documentation

`docs/AGENT_GUIDE.md` explains:

- architecture and ownership boundaries;
- security invariants that must not regress;
- local install/update workflow;
- service and Tailnet lifecycle;
- focused and full verification commands;
- how to sync from upstream without overwriting safe modules;
- which generated and secret files must never be committed.

The root `AGENTS.md` gains a concise mandatory section pointing agents to that guide and listing the minimum tests for changes to CLI, networking, authentication, exposure, state, packaging, or systemd behavior.

## Delivery

Implementation is committed in discrete, reviewable commits on `codex/modular-safe-cli`. After full verification, the branch is pushed to `zonghang-li/codex-mobile`. A pull request is preferred by the repository workflow; direct merging to `main` occurs only with explicit user approval.
