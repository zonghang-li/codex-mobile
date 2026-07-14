# Agent Guide: codex-mobile and codex-mobile-safe

## Purpose

This repository maintains the upstream-compatible `codex-mobile` command and a hardened `codex-mobile-safe` module in one build. Keep shared UI and bridge behavior in the upstream paths; implement safety differences through explicit policy injection so upstream updates remain reviewable.

## Architecture

- `src/cli/index.ts`: upstream-compatible CLI entry point.
- `src/cli/safe.ts`: safe lifecycle CLI (`start`, `stop`, `status`, `urls`, `doctor`, login, and Tailscale exposure).
- `src/cli/shared/launcher.ts`: shared listener/browser startup helpers.
- `src/safe/runtimePolicy.ts`: safe host, port, sandbox, and approval defaults.
- `src/safe/featureGate.ts`: HTTP route and app-server RPC allowlists.
- `src/safe/pathPolicy.ts`: canonical allowed-root filesystem checks.
- `src/safe/passwordFile.ts`: password-file ownership, type, mode, and content validation.
- `src/safe/ntfyConfig.ts`: optional current-user mode-`0600` ntfy URL-file loader and strict `https://ntfy.sh/<single-topic>` validation.
- `src/safe/ntfyState.ts`: private atomic notifier state with bounded active, pending, and sent collections.
- `src/safe/state.ts`: PID-validated managed process state.
- `src/safe/exposure.ts`: Tailscale Serve lifecycle; Funnel is rejected.
- `src/safe/doctor.ts`: static security-invariant diagnostics.
- `src/server/securityPolicy.ts`: policy interface injected into HTTP and app-server bridges.
- `src/server/externalThreadRuntime.ts`: hardened same-user app-server and canonical rollout-writer discovery.
- `src/server/rolloutLifecycle.ts`: strict parser for authoritative rollout session and turn lifecycle records.
- `src/server/externalTurnMonitor.ts`: bounded serialized 15-second external rollout monitor with incremental cursors and restart recovery.
- `src/server/ntfyCompletionNotifier.ts`: asynchronous ten-minute turn qualification, deterministic summaries, logical deduplication, and bounded ntfy delivery.
- `packaging/systemd/`: template for the safe Linux user service.
- `scripts/install-local.sh` and `scripts/*user-service.sh`: repeatable local installation and service lifecycle.

## Non-negotiable safe-mode invariants

1. Bind to `127.0.0.1` by default. The compatibility `--lan` override must remain explicit and must never be used by the Tailnet-only service.
2. Require authentication. A password file must be a regular file owned by the current user, contain a non-empty password, and grant no group/other permissions (mode `0600` or stricter).
3. Never start Cloudflare tunnels or Tailscale Funnel from safe mode. Remote access is opt-in Tailscale Serve only.
4. Do not treat a Tailscale source address as an authentication bypass.
5. Keep safe Codex defaults at `workspace-write` sandbox and `on-request` approvals.
6. Restrict HTTP features and app-server RPC methods through `featureGate.ts`; new methods or routes are denied until deliberately reviewed and allowlisted.
7. Canonicalize filesystem paths and keep them under the configured project root. Reject symlink escapes and missing paths.
8. Do not commit secrets, password files, runtime state, generated units, `.tgz` packages, or Tailnet credentials.
9. Treat the ntfy topic as a credential. Read it only from the default `~/.codex/codex-mobile-safe-ntfy-url` file or an explicit `--ntfy-url-file` path. Require a current-user-owned regular file with mode `0600` or stricter and exactly one `https://ntfy.sh/<single-topic>` URL. Never place the URL/topic in Git, process arguments, systemd `Environment=`, managed notifier state, response bodies, or logs.
10. Keep notifications outbound-only and optional. Missing default configuration must create no notification subscription, external-turn monitor, process/filesystem scan, timer, or network work. Do not enable Telegram, background integrations, incoming commands, Cloudflare/public tunnels, Tailscale Funnel, LAN binding, or a Tailscale authentication bypass while adding or operating ntfy notifications.
11. Preserve notification behavior: threshold exactly `600_000` ms; exact success/failure/interruption titles; deterministic first non-empty assistant sentence capped at 180 characters; no extra AI call; five-second request timeout; three immediate attempts per pending record per drain; active/pending/sent collections capped at 256.
12. Preserve one logical notification per turn through local pending/sent suppression and a stable bounded ASCII ntfy sequence ID. Do not claim transport-level exactly-once delivery: an ambiguous timeout or a crash after remote acceptance but before the local sent-state commit may re-alert.
13. Accept external rollout writers only from current-UID Codex app-server processes with stable process/descriptor evidence. Canonicalize each regular `.jsonl` rollout and require it to remain under the canonical current-user Codex sessions root; exclude the safe service's own app-server process tree.
14. Keep external monitoring serialized and bounded: scan tracked cursors before discovery at the 15-second production cadence, parse only complete newly appended JSONL records through bounded incremental cursors, and cap retained cursors. Evict a missing-writer cursor only after 24 hours without file growth or renewed writer evidence; eviction never synthesizes a terminal lifecycle. Bound each Linux discovery cycle to 16,384 numeric processes, 4,096 descriptors per app-server, 8,192 yielded snapshots, 256 unique rollout writers, and 5,000 ms wall time.

The original command may retain upstream behavior. Do not weaken safe mode to make both commands identical; move genuinely shared mechanics into `src/cli/shared` or the server layer and inject the policy difference.

## Development and verification

```bash
pnpm install
pnpm run test:unit
pnpm run build
```

Run the narrow test first while iterating, for example:

```bash
pnpm exec vitest run src/safe/exposure.test.ts
pnpm exec vitest run src/server/securityPolicy.test.ts
```

Before committing a runtime or packaging change, also run:

```bash
node dist-cli/index.js --help
node dist-cli/safe.js --help
node dist-cli/safe.js doctor
sh -n scripts/install-local.sh scripts/install-user-service.sh scripts/uninstall-user-service.sh
```

For an isolated local-install smoke test:

```bash
PREFIX=/tmp/codex-mobile-prefix sh scripts/install-local.sh
/tmp/codex-mobile-prefix/bin/codex-mobile --help
/tmp/codex-mobile-prefix/bin/codex-mobile-safe doctor
```

Instantiate the service template in a temporary location and run `systemd-analyze --user verify` before installing it. Follow the repository's CJS/closest-public-entry smoke-test rule and record the exact command and result in the PR.

## Change-to-test matrix

| Change | Required focused checks |
| --- | --- |
| Safe defaults or feature gates | `src/safe/runtimePolicy.test.ts`, `src/safe/featureGate.test.ts`, and doctor |
| HTTP/RPC policy | `src/server/securityPolicy.test.ts`, bridge security tests, and relevant route tests |
| Filesystem access | `src/safe/pathPolicy.test.ts` plus the affected HTTP route test |
| Password/state lifecycle | matching `src/safe/*test.ts`, stale PID and permissions cases |
| ntfy config/state | `src/safe/ntfyConfig.test.ts`, `src/safe/ntfyState.test.ts`, ownership/mode/symlink/atomic-write cases |
| ntfy qualification/delivery | `src/server/ntfyCompletionNotifier.test.ts`, including 599,999/600,000 ms, all terminal statuses, real default headers, restart, retry, redaction, and direct-notification/external-rollout deduplication through one durable key and sequence ID |
| ntfy CLI/server wiring | safe entry, doctor, packaging, and server security-policy tests; verify disabled mode has no subscription/network |
| external-turn discovery/parsing | `src/server/externalThreadRuntime.test.ts`, `src/server/rolloutLifecycle.test.ts`; cover same UID, stable identity, canonical sessions-root containment, malformed/partial records, and writer disappearance without inferred completion |
| external-turn monitoring | `src/server/externalTurnMonitor.test.ts`; cover serialized 15-second scans, incremental reads, 256-cursor bound, exact threshold handoff, restart recovery, historical suppression, and disposal |
| external notification wiring | safe lifecycle and doctor tests; verify absent ntfy configuration creates no monitor, timer, process/filesystem scan, or network work |
| Tailscale exposure | `src/safe/exposure.test.ts`; confirm Serve only and no Funnel |
| CLI/build/package | launcher and safe entry tests, production build, both help commands, temporary-prefix install |
| systemd scripts/template | packaging test, `sh -n`, `systemd-analyze --user verify`, restart recovery |

Always finish with the complete test suite and production build. Update the relevant manual test document under `tests/` for behavior changes.

## Runtime operations

```bash
codex-mobile-safe start /path/to/project --password-file ~/.codex/codex-mobile-safe-password --no-open
codex-mobile-safe expose tailscale
codex-mobile-safe status
codex-mobile-safe urls
codex-mobile-safe unexpose
codex-mobile-safe stop
```

For the installed user service:

```bash
pnpm run service:install
pnpm run service:status
pnpm run service:restart
journalctl --user -u codex-mobile-safe -n 100
```

The systemd service auto-detects the optional default ntfy file and intentionally has no ntfy argument or secret environment variable. Configure it locally with:

```bash
install -d -m 700 ~/.codex
install -m 600 /dev/null ~/.codex/codex-mobile-safe-ntfy-url
read -r NTFY_TOPIC
printf 'https://ntfy.sh/%s\n' "$NTFY_TOPIC" > ~/.codex/codex-mobile-safe-ntfy-url
unset NTFY_TOPIC
chmod 600 ~/.codex/codex-mobile-safe-ntfy-url
pnpm run service:restart
```

Never put a real topic in a test fixture, issue, PR, shell transcript, generated unit, or log. Valid topics use one `[A-Za-z0-9_-]+` path segment on the fixed `https://ntfy.sh` origin; credentials, query, fragment, extra path segments, alternate origins, non-regular files, wrong ownership, and group/other permissions are rejected. Deleting the file and restarting disables notification subscriptions and delivery:

```bash
rm ~/.codex/codex-mobile-safe-ntfy-url
pnpm run service:restart
```

Operational checks must use redacted surfaces:

```bash
codex-mobile-safe doctor
codex-mobile-safe status
codex-mobile-safe urls
pnpm run service:status
journalctl --user -u codex-mobile-safe -n 100 --no-pager
```

`doctor` is a static packaged-invariant check, not proof that an optional topic is configured or that a phone received an alert. A qualifying notification requires a turn duration of at least 10 minutes (`600_000` ms). Completed, failed, and interrupted turns use `Codex 任务完成`, `Codex 任务失败`, and `Codex 任务已中断`; the body is the deterministic first non-empty final-assistant sentence or a fixed fallback. The notifier retains only bounded timing/outbox/deduplication state under the safe home and never conversation history or the publish URL.

With ntfy enabled, `codex-mobile-safe` observes qualifying turns from the mobile UI, Codex Desktop, Codex CLI, and other same-user Codex clients that write authoritative rollouts. Detection is server-side and continues with no browser connection. The external monitor uses a serialized 15-second scan cadence and authoritative rollout timestamps, so a turn already running when the service restarts remains eligible; turns already terminal before restart are baseline history and are not replayed. A missing terminal lifecycle is never inferred from an app-server process or rollout-writer descriptor disappearing. A cursor whose writer is missing remains append-checked and is evicted only after 24 hours with neither file growth nor renewed writer evidence. Linux discovery is capped per cycle at 16,384 numeric processes, 4,096 descriptors per app-server, 8,192 yielded snapshots, 256 unique rollout writers, and 5 seconds.

External-monitor diagnostics must remain redacted. Use `doctor`, service status, and the journal to confirm whether optional wiring is active and whether scans or delivery fail; never log or print the ntfy URL/topic, notification body, password, conversation content, rollout contents, or request object. Enabling the monitor does not add an inbound listener or change loopback binding, password authentication, Tailscale Serve-only exposure, or the Funnel/LAN/public-tunnel prohibitions.

When notification delivery fails, check the redacted journal for `Unable to ... long-task notification` messages, confirm ordinary HTTPS egress to `ntfy.sh`, confirm the URL file mode/owner without printing its contents, and run the focused tests. Do not print the file, add debug logging of request objects, or relax the URL validator. Pending records are retried on startup and later notification events. Stable sequence IDs provide logical replacement on supported clients, but ambiguous remote acceptance may still re-alert.

An HTTP 502 from a mobile RPC request means the HTTPS proxy received the request but could not obtain a valid response from the loopback backend. Check, in order: service state and journal, listener on `127.0.0.1:5900`, `codex-mobile-safe doctor`, `tailscale serve status`, then authentication. Do not solve a 502 by opening the listener to the LAN.

Remote operation remains Tailnet-only: keep the backend on loopback, enable only `codex-mobile-safe expose tailscale`, verify `tailscale serve status`, and keep password authentication. The ntfy outbound POST does not authorize LAN/public exposure. Never use the compatibility command's Telegram or Cloudflare features for a safe service.

To remove the user service, run `pnpm run service:uninstall`. This removes the unit and managed state but intentionally leaves the password file for explicit user handling.

## Updating from upstream

Keep remotes named `origin` for `zonghang-li/codex-mobile` and `upstream` for `friuns2/codex-mobile`. Work on a feature branch:

```bash
git fetch origin upstream
git switch -c codex/ntfy-docs origin/main
git rebase upstream/main
```

Resolve conflicts deliberately. In particular, preserve and revalidate:

- `src/safe/` and its tests;
- ntfy URL validation, durable state, notifier logic, and optional lifecycle wiring;
- `src/server/securityPolicy.ts` and policy injection points;
- the `safe` build entry and package bin mapping;
- `packaging/systemd/` and installer scripts;
- this guide and the fork section of `README.md`.

After syncing, rerun focused security tests, the complete suite, production build, CLI smoke tests, temporary-prefix install, and service-template verification. Review bundle output for duplicated core chunks and record any startup or bundle-size regression.
