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
7. Inspect the effective user unit and process arguments. Confirm the service passes `--sandbox-mode danger-full-access --approval-policy never`, still uses `--password-file`, and does not expose the password value in `ps` output.
8. Confirm the password file mode is `0600` and an unauthenticated request to the loopback service is rejected.
9. Open the reported HTTPS Tailnet URL on a mobile device logged into the same tailnet and authenticate.
10. Record the policy of an existing thread, then create a new mobile thread after the service restart. Confirm the new thread reports `danger-full-access` and `never`, can create and remove a harmless file under `/tmp` without an approval prompt, and the existing thread retains its stored policy.
11. Resume a thread, record the service main PID, terminate that PID, wait for systemd restart, and repeat the thread resume request.
12. Run `codex-mobile-safe unexpose` and confirm the Serve mapping is removed.

## Expected results

- Both commands are installed from the current clone and print help successfully.
- Doctor reports all safe invariants as passing.
- The packaged persistent mobile service uses the safe entry point and password file, with explicit `danger-full-access` and `never` execution-policy overrides.
- Only new mobile threads created through this service inherit the unrestricted/no-approval profile; existing threads retain their stored policy, and desktop/global Codex defaults are unchanged.
- Only the loopback listener exists before exposure; no LAN listener, Cloudflare tunnel, or Tailscale Funnel is created.
- Tailscale Serve publishes HTTPS only inside the tailnet, and a non-tailnet client cannot connect.
- Authentication is still required through Tailscale.
- The password remains in the mode-`0600` password file and never appears as a plaintext process argument; unauthenticated loopback requests are rejected.
- A new mobile thread can perform the harmless `/tmp` write without approval.
- Thread resume succeeds without HTTP 502 before and after service restart.
- The service restarts with a new PID after failure.

## Rollback / cleanup

1. To restore the restricted mobile execution profile, change only the installed unit's execution-policy arguments to `--sandbox-mode workspace-write --approval-policy on-request`.
2. Run `systemctl --user daemon-reload` and `systemctl --user restart codex-mobile-safe.service`, then verify the effective unit and create a new thread to confirm the restored profile. Existing threads remain unchanged.
3. Run `codex-mobile-safe unexpose`.
4. Run `pnpm run service:uninstall` if the persistent service is no longer required.
5. Remove the locally installed package from the chosen prefix if required.
6. The password file is intentionally retained; delete it only when the user explicitly wants to discard that credential.
