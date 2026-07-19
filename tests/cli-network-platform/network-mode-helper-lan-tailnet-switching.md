# Feature: network mode helper LAN and Tailnet switching

## Prerequisites / setup

- Linux with Node.js 18+, pnpm, systemd user services, Tailscale, and `${HOME}/.local/bin` on `PATH`.
- The checkout has been installed locally with `pnpm run install:local`.
- The device can authenticate to the intended tailnet with `tailscale up`.
- The password file either exists at `~/.codex/codex-mobile-safe-password` with mode `0600` or can be created by the helper.

## Actions

1. Verify the helper syntax and package shortcuts:

   ```bash
   sh -n scripts/codex-mobile-network-mode.sh
   codex-mobile-network --help
   pnpm run network:status
   ```

   Expect the syntax check and help command to exit 0. Status may report stopped services, but it must not print the password or ntfy topic.

2. Start LAN-only mode:

   ```bash
   codex-mobile-network lan
   codex-mobile-safe status
   ss -ltnp '( sport = :5900 )'
   tailscale status || true
   tailscale serve status || true
   ```

   Expect `bindHost` to be `0.0.0.0`, `accessMode` to be `lan`, `passwordProtected` to be `true`, and the listener to include `0.0.0.0:5900`. Expect Tailscale to be stopped or unavailable and Tailscale Serve to have no active mapping.

3. Confirm LAN browser access from a device on the same local network:

   ```bash
   pnpm run network:status
   ```

   Open the printed `http://192.168.x.x:5900` URL from the LAN device. Expect the Codex Mobile password screen, then normal authenticated UI access after entering the local password.

4. Switch to Tailnet mode:

   ```bash
   codex-mobile-network tailnet
   codex-mobile-safe status
   ss -ltnp '( sport = :5900 )'
   tailscale serve status
   ```

   Expect `bindHost` to be `127.0.0.1`, `accessMode` to be `local`, password protection to remain enabled, and Tailscale Serve to proxy to `http://127.0.0.1:5900`. Expect no `0.0.0.0:5900` listener.

5. Confirm Tailnet browser access from a device logged into the same tailnet:

   ```bash
   codex-mobile-safe urls
   ```

   Open the printed HTTPS URL from the tailnet device. Expect the Codex Mobile password screen, then normal authenticated UI access after entering the local password.

6. Stop all managed exposure:

   ```bash
   codex-mobile-network stop
   codex-mobile-safe status
   tailscale status || true
   tailscale serve status || true
   ss -ltnp '( sport = :5900 )' || true
   ```

   Expect the safe service to be stopped, Tailscale to be stopped, Tailscale Serve to have no mapping, and no listener on port 5900.

## Expected results

- `network:lan` produces LAN-only access on `0.0.0.0:5900`, removes Tailscale Serve, and stops Tailscale.
- `network:tailnet` produces Tailnet HTTPS access through Tailscale Serve while the backend stays on `127.0.0.1:5900`.
- Both running modes use password-file authentication, `workspace-write`, and `approval-policy never` unless explicit environment overrides are supplied.
- `network:stop` removes all safe-service listeners and Tailscale Serve exposure.
- No command prints the password, ntfy URL, or ntfy topic.

## Rollback / cleanup

Return to the persistent installed service:

```bash
pnpm run network:stop
pnpm run service:install
codex-mobile-safe expose tailscale
```

If the user wants LAN-only operation again, run `pnpm run network:lan` instead of reinstalling the persistent service.
