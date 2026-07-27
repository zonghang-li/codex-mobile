# Graceful Long-Connection Shutdown Design

## Context

The asynchronous restart trigger now moves `systemctl --user restart
codex-mobile-safe.service` out of the Codex turn and into an independent
systemd worker. Live verification exposed a second, independent failure:
with a mobile browser connected, the main service remains in
`stop-sigterm` until systemd's 90-second stop timeout, is killed with
`SIGKILL`, and only then starts again.

The shutdown path currently awaits `http.Server.close()` before disposing
the application. `Server.close()` waits for active HTTP connections, while
the application deliberately keeps SSE and WebSocket connections open.
The WebSocket server also exposes no shutdown handle. The shutdown sequence
therefore waits on connections that only application shutdown can close.

## Goals

- A SIGTERM-driven service restart must close active HTTP, SSE, and WebSocket
  connections without waiting for the systemd stop timeout.
- Application resources and the child Codex app-server must still be disposed.
- Shutdown must be idempotent and safe if SIGINT/SIGTERM arrives more than once.
- The existing asynchronous restart trigger, security policy, password,
  loopback binding, approval policy, and Tailnet exposure must remain unchanged.
- Tests must reproduce the long-connection failure before the fix and prove the
  corrected shutdown behavior.

## Non-goals

- Do not reduce `TimeoutStopSec` or switch the service to unconditional
  `SIGKILL`.
- Do not add an `ExecStop` kill script.
- Do not change turn persistence, queue semantics, or notification behavior.
- Do not wait for active browser clients to cooperate with shutdown.

## Design

### HTTP and SSE connection closure

`listenWithFallback` remains the owner of the Node HTTP server lifecycle.
Its `close()` method will first stop accepting new connections with
`server.close()`, then close idle and active HTTP connections using the Node
server connection-closing APIs. This explicitly ends long-lived SSE and
keep-alive requests instead of waiting for their clients.

The close operation remains a promise and is idempotent: repeated callers
observe the same shutdown rather than starting competing close sequences.

### WebSocket lifecycle

`ServerInstance.attachWebSocket(server)` will return an idempotent disposer.
The disposer removes the upgrade listener, terminates every connected client,
and closes the `WebSocketServer`. Upgraded sockets are handled here because
Node's HTTP connection-closing APIs do not close upgraded WebSocket sockets.

Both CLI entry points will retain this disposer. A shutdown starts the HTTP
close, disposes WebSockets and application resources, and then awaits HTTP
closure. Starting HTTP close first prevents new requests or upgrades from
racing with resource disposal.

### Application and child-process disposal

The existing application `dispose()` path remains responsible for timers,
notification monitors, terminal state, queues, and the child Codex app-server.
It runs during shutdown even if connection cleanup reports an error.
The safe CLI continues to clear its managed-state file before exiting.

### Error handling

Shutdown is best-effort but bounded. Each cleanup component is idempotent.
Connection cleanup errors do not prevent the remaining resources from being
disposed. The process exits only after the bounded local cleanup sequence
settles; systemd remains the last-resort safety boundary rather than the normal
shutdown mechanism.

## Testing

1. Add a launcher regression test that holds an HTTP response open and proves
   `ListeningServer.close()` completes promptly and disconnects the client.
   This test must fail against the current implementation.
2. Add a WebSocket lifecycle test that attaches a real client and proves the
   returned disposer closes the upgraded connection and can be called twice.
3. Add or extract a small shutdown coordinator test if needed to prove order
   and idempotency without spawning the full CLI.
4. Run the focused tests, full unit suite, production build, CLI doctor, and
   shell syntax checks.
5. Reinstall through the marker trigger while a browser connection is active.
   The new PID must appear without a `stop-sigterm timed out` or `SIGKILL`
   journal entry, HTTP must return `200`, and security/exposure invariants must
   remain unchanged.

## Acceptance criteria

- With SSE/WebSocket clients connected, service shutdown completes well before
  the 90-second systemd timeout.
- The restart worker exits successfully and reports the replacement service
  healthy.
- The main PID changes and `127.0.0.1:5900` returns HTTP `200`.
- The journal contains no shutdown timeout or forced-kill entry for the
  acceptance restart.
- Password metadata, loopback binding, approval/sandbox settings, and
  Tailnet-only exposure are unchanged.
