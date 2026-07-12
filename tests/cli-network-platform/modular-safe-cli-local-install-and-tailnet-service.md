# Feature: modular safe CLI local install and tailnet service

## Prerequisites / setup

- Linux with Node.js 18+, pnpm, systemd user services, and Tailscale installed.
- The device is logged in to the intended tailnet.
- A clean clone of `https://github.com/zonghang-li/codex-mobile.git`.
- `${HOME}/.local/bin` is on `PATH`.

## Actions

1. Run `pnpm install`, `pnpm run test:unit`, and `pnpm run build`.
2. Run `pnpm run install:local`.
3. Run `codex-mobile --help` and `codex-mobile-safe doctor`.
4. Run `pnpm run service:install`, then `pnpm run service:status`.
5. Confirm the process listens on `127.0.0.1:5900` and not `0.0.0.0:5900`.
6. Run `codex-mobile-safe expose tailscale`, then `codex-mobile-safe urls` and `tailscale serve status`.
7. Open the reported HTTPS Tailnet URL on a mobile device logged into the same tailnet, authenticate, open a thread, and resume it.
8. Record the service main PID, terminate that PID, wait for systemd restart, and repeat the thread resume request.
9. Run `codex-mobile-safe unexpose` and confirm the Serve mapping is removed.

## Expected results

- Both commands are installed from the current clone and print help successfully.
- Doctor reports all safe invariants as passing.
- The service uses the safe entry point, password file, `workspace-write`, and `on-request` settings.
- Only the loopback listener exists before exposure; no LAN listener, Cloudflare tunnel, or Tailscale Funnel is created.
- Tailscale Serve publishes HTTPS only inside the tailnet, and a non-tailnet client cannot connect.
- Authentication is still required through Tailscale.
- Thread resume succeeds without HTTP 502 before and after service restart.
- The service restarts with a new PID after failure.

## Rollback / cleanup

1. Run `codex-mobile-safe unexpose`.
2. Run `pnpm run service:uninstall`.
3. Remove the locally installed package from the chosen prefix if required.
4. The password file is intentionally retained; delete it only when the user explicitly wants to discard that credential.
