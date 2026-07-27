# Asynchronous Safe-Service Restart Trigger Design

## Goal

Make Codex Mobile deployments able to request a `codex-mobile-safe` restart
without the active Codex turn invoking and waiting for
`systemctl --user restart`. The restart request must continue to work when a
later host-provided permission profile changes the turn from unrestricted
access to workspace-only access.

The mechanism must preserve the current password file, loopback binding,
Tailnet/LAN exposure, Codex sandbox and approval settings, and existing
systemd restart policy.

## Problem

The current `service:restart` command directly invokes:

```sh
systemctl --user restart codex-mobile-safe.service
```

This has two independent failure modes:

1. The Codex host can inject a more restrictive permission profile at a turn
   boundary. Host policy has higher priority than the CLI flags used by the
   safe service, so the `systemctl` tool call can be rejected or interrupted.
2. The command waits for the service that is currently carrying the same
   Codex turn. The turn cannot finish while it waits for the restart, while
   graceful shutdown waits for the turn, producing a self-induced shutdown
   timeout.

Changing `approval-policy`, `sandbox-mode`, trusted-project settings, or a
Codex config file cannot reliably solve either problem because the failing
operation occurs at the host tool-policy and service-lifecycle layers.

## Considered Approaches

### A. User systemd path trigger

The active turn writes a marker in a private directory under `/tmp`. A
systemd user path unit notices the change and starts an independent oneshot
unit that restarts and verifies `codex-mobile-safe.service`.

This is the selected approach. Writing under `/tmp` remains available in both
permission profiles observed on this machine, and systemd performs the
privileged lifecycle operation outside the Codex turn.

### B. Non-blocking direct systemctl

`systemctl --user restart --no-block` removes the shutdown wait but is still a
direct host tool call. A later workspace-only profile can still reject it, so
it does not meet the durability requirement.

### C. Long-lived Node supervisor

A supervisor could own the web process and reload it when build files change.
It would add another persistent runtime, duplicated restart policy, and more
failure states than a native systemd path unit. The extra complexity is not
justified for one local service.

## Architecture

### Restart request script

Add a POSIX shell script that:

1. resolves the current numeric user ID;
2. uses `/tmp/codex-mobile-safe-restart-<uid>` as the private request
   directory;
3. creates or validates that directory as a non-symlink directory owned by
   the current user with mode `0700`;
4. atomically replaces a `restart.request` marker with a fresh timestamp; and
5. exits immediately after reporting that the restart was queued.

The script never calls `systemctl`. It is therefore safe to use as the final
deployment action from a restricted Codex turn.

### Path unit

Add a rendered user path unit that watches the exact marker path and activates
`codex-mobile-safe-restart.service` when the marker changes. The installer
renders the numeric UID into the path rather than relying on shell expansion
inside the unit.

The path unit is enabled persistently and starts independently from the main
safe service.

### Restart worker unit

Add a oneshot user service that:

1. restarts only `codex-mobile-safe.service`;
2. waits for the main unit to become active;
3. verifies that the configured loopback port responds; and
4. exits non-zero with a concise journal message if restart or health
   verification fails.

The worker executes in the systemd user manager, not as a child of the active
Codex turn. A restart request can therefore remain pending while the current
turn finishes. Once the turn releases the old service, graceful shutdown can
complete without the caller deadlocking on it.

The worker does not alter Tailscale Serve, bring Tailscale up or down, change
LAN mode, rewrite the password file, or modify Codex security flags.

### Installer and package commands

`scripts/install-user-service.sh` will render and verify the main service,
restart worker, and path unit. It will enable the main service and path unit,
start the path unit, then queue a restart through the request script rather
than waiting on a direct restart.

`pnpm run service:restart` will call the request script. A separately named
direct restart command is unnecessary; operators can still invoke
`systemctl --user restart` manually when working outside a service-hosted
Codex turn.

The uninstaller will stop and disable the path/worker units, remove all
rendered unit files, reload the user manager, and remove only this user's
private request directory.

## Request and Failure Semantics

Writing the marker means “restart requested”, not “restart already
completed”. Multiple rapid writes are serialized by the single systemd
oneshot unit; duplicate requests may cause at most one later coalesced rerun
and cannot run workers concurrently.

The request script succeeds only after the marker is safely published. It
does not claim that the new process is healthy. Restart and health results are
recorded in the restart worker's user journal. `service:status` remains the
authoritative interactive check.

If the worker cannot restart the service, it fails without changing exposure
or credentials. If the service starts but does not become healthy within the
bounded verification window, the worker also fails and leaves the main
service's own `Restart=on-failure` policy intact.

## Security

- No HTTP restart endpoint is added.
- No password, ntfy topic, session token, or capability is written to the
  marker, units, process arguments, or journal.
- The request directory is user-specific, mode `0700`, owned by the current
  user, and rejected if it is a symlink or has unsafe ownership.
- The worker can restart only the fixed `codex-mobile-safe.service` unit; the
  marker cannot select an arbitrary unit or command.
- All units remain user units and require no root privileges.

## Testing

Static and focused tests will cover:

- rendered service, path, and worker templates;
- fixed unit target and absence of secret values;
- exact private marker path and owner/mode/symlink validation;
- atomic marker publication without a `systemctl` call;
- installer enable/start ordering and asynchronous restart request;
- uninstaller cleanup of the added units and marker directory;
- shell syntax for all affected scripts; and
- systemd user-unit verification using temporary rendered units.

Full verification will run the unit suite, frontend/CLI build, shell syntax,
`systemd-analyze --user verify`, and `codex-mobile-safe doctor`.

Live acceptance will install the units once, record the current main PID,
queue a restart through the marker, return control immediately, then confirm:

- the path unit remains active;
- the restart worker runs independently;
- the main PID changes;
- `127.0.0.1:5900` responds;
- the password file is unchanged;
- the existing Tailnet/LAN exposure is unchanged; and
- the journal contains no secret or startup error.

## Scope

This change only replaces the installed safe service's deployment restart
path. It does not redesign transient LAN/Tailnet switching, add remote
administration, change Codex permission precedence, or automatically rebuild
the repository.
