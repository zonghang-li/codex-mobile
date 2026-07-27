# Graceful Long-Connection Shutdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make SIGTERM shutdown close active HTTP/SSE/WebSocket connections promptly so the systemd restart worker never waits for the 90-second stop timeout.

**Architecture:** The shared HTTP launcher will own bounded closure of ordinary HTTP connections, while the HTTP application will return an explicit disposer for upgraded WebSocket connections. Both CLI entry points will start HTTP closure, dispose WebSockets and application resources, then await completion before exiting.

**Tech Stack:** TypeScript, Node.js HTTP server APIs, `ws`, Vitest, systemd user services.

## Global Constraints

- A SIGTERM-driven service restart must close active HTTP, SSE, and WebSocket connections without waiting for the systemd stop timeout.
- Application resources and the child Codex app-server must still be disposed.
- Shutdown must be idempotent and safe if SIGINT/SIGTERM arrives more than once.
- The existing asynchronous restart trigger, security policy, password, loopback binding, approval policy, and Tailnet exposure must remain unchanged.
- Do not reduce `TimeoutStopSec`, add an `ExecStop` kill script, or switch the normal shutdown path to unconditional `SIGKILL`.
- Do not change turn persistence, queue semantics, or notification behavior.
- Preserve the four existing uncommitted upload-lifecycle changes in the original checkout and do not stage them in shutdown-fix commits.

---

## File Structure

- `src/cli/shared/launcher.ts` — owns listening HTTP server lifecycle and bounded closure of HTTP/SSE/keep-alive connections.
- `src/cli/shared/launcher.test.ts` — behavior-level regression for an active HTTP response blocking shutdown.
- `src/server/httpServer.ts` — owns WebSocket server creation and returns an idempotent WebSocket disposer.
- `src/server/httpServer.websocket.test.ts` — behavior-level WebSocket disposer coverage using a real upgraded client.
- `src/cli/safe.ts` — wires the shared HTTP and WebSocket cleanup into safe-service SIGINT/SIGTERM handling.
- `src/cli/index.ts` — applies the same lifecycle to the standard CLI entry point.
- `src/cli/shutdownWiring.test.ts` — verifies both entry points retain and invoke the cleanup handles in the required order.

---

### Task 1: Bounded HTTP and SSE Closure

**Files:**
- Modify: `src/cli/shared/launcher.ts`
- Modify: `src/cli/shared/launcher.test.ts`

**Interfaces:**
- Consumes: Node `http.Server.close()`, `closeIdleConnections()`, and `closeAllConnections()`.
- Produces: idempotent `ListeningServer.close(): Promise<void>` that stops acceptance and forcibly disconnects active HTTP/SSE clients.

- [ ] **Step 1: Write the failing active-response test**

Add imports for `get` and `once`, then add:

```ts
it('closes an active HTTP response instead of waiting for the client', async () => {
  const launched = await listenWithFallback(
    createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('event: ready\n\n')
    }),
    0,
    '127.0.0.1',
  )
  servers.push(launched)

  const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
    const request = get(`http://127.0.0.1:${String(launched.port)}/events`, resolve)
    request.once('error', reject)
  })
  const clientClosed = once(response, 'close')

  const result = await Promise.race([
    launched.close().then(() => 'closed'),
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 500)),
  ])

  expect(result).toBe('closed')
  await clientClosed
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm exec vitest run src/cli/shared/launcher.test.ts -t 'closes an active HTTP response'
```

Expected: FAIL with `expected 'timeout' to be 'closed'`.

- [ ] **Step 3: Implement idempotent bounded HTTP closure**

Inside `listenWithFallback`, create one close promise per listening result:

```ts
let closePromise: Promise<void> | null = null
const close = () => {
  if (closePromise) return closePromise
  closePromise = new Promise<void>((closeResolve, closeReject) => {
    server.close((error) => error ? closeReject(error) : closeResolve())
    server.closeIdleConnections()
    server.closeAllConnections()
  })
  return closePromise
}
```

Return `close` instead of constructing a new promise on every call:

```ts
resolve({
  server,
  port: actualPort,
  host,
  close,
})
```

- [ ] **Step 4: Verify GREEN and regression scope**

Run:

```bash
pnpm exec vitest run src/cli/shared/launcher.test.ts
```

Expected: both launcher tests PASS with no warning or leaked-handle output.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/cli/shared/launcher.ts src/cli/shared/launcher.test.ts
git commit -m "fix(server): bound active HTTP shutdown"
```

---

### Task 2: Explicit WebSocket Disposer

**Files:**
- Modify: `src/server/httpServer.ts`
- Create: `src/server/httpServer.websocket.test.ts`

**Interfaces:**
- Consumes: `HttpServer`, `WebSocketServer`, and each connected `WebSocket`.
- Produces: `ServerInstance.attachWebSocket(server): () => void`, where the returned disposer removes the upgrade handler, terminates clients, closes the WebSocket server, and is idempotent.

- [ ] **Step 1: Write the failing real-client test**

Create `src/server/httpServer.websocket.test.ts`:

```ts
import { createServer as createHttpServer } from 'node:http'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { listenWithFallback } from '../cli/shared/launcher'
import { createServer as createApp } from './httpServer'

describe('HTTP server WebSocket lifecycle', () => {
  it('returns an idempotent disposer that terminates upgraded clients', async () => {
    const instance = createApp()
    const server = createHttpServer(instance.app)
    const disposeWebSockets = instance.attachWebSocket(server)
    const listening = await listenWithFallback(server, 0, '127.0.0.1')
    const client = new WebSocket(`ws://127.0.0.1:${String(listening.port)}/codex-api/ws`)

    try {
      await once(client, 'open')
      const clientClosed = once(client, 'close')
      expect(typeof disposeWebSockets).toBe('function')
      disposeWebSockets()
      disposeWebSockets()
      await clientClosed
    } finally {
      client.terminate()
      instance.dispose()
      await listening.close()
    }
  })
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm exec vitest run src/server/httpServer.websocket.test.ts
```

Expected: FAIL because `attachWebSocket` returns `void` and
`disposeWebSockets` is not callable.

- [ ] **Step 3: Return an idempotent WebSocket disposer**

Change the interface:

```ts
export type ServerInstance = {
  app: Express
  dispose: () => void
  attachWebSocket: (server: HttpServer) => () => void
}
```

Use a named upgrade handler and return cleanup:

```ts
const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  const url = new URL(req.url ?? '', 'http://localhost')
  if (url.pathname !== '/codex-api/ws') return
  if (authSession && !authSession.isRequestAuthorized(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
    wss.emit('connection', ws, req)
  })
}
server.on('upgrade', onUpgrade)
```

Add the required `Duplex` import from `node:stream`. After the existing
connection handler, return:

```ts
let websocketDisposed = false
return () => {
  if (websocketDisposed) return
  websocketDisposed = true
  server.off('upgrade', onUpgrade)
  for (const client of wss.clients) client.terminate()
  wss.close(() => {})
}
```

- [ ] **Step 4: Verify GREEN and related HTTP tests**

Run:

```bash
pnpm exec vitest run \
  src/server/httpServer.websocket.test.ts \
  src/server/httpServer.staticAssets.test.ts
```

Expected: all tests PASS with no unhandled WebSocket errors.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/server/httpServer.ts src/server/httpServer.websocket.test.ts
git commit -m "fix(server): dispose upgraded websocket clients"
```

---

### Task 3: Wire Bounded Shutdown into Both CLI Entrypoints

**Files:**
- Modify: `src/cli/safe.ts`
- Modify: `src/cli/index.ts`
- Create: `src/cli/shutdownWiring.test.ts`

**Interfaces:**
- Consumes: `ListeningServer.close(): Promise<void>`, the disposer returned by `attachWebSocket`, and application `dispose()`.
- Produces: idempotent signal handlers that start HTTP closure, close WebSockets, dispose the application, and await closure before exit.

- [ ] **Step 1: Write failing wiring assertions**

Create `src/cli/shutdownWiring.test.ts`:

```ts
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

async function readSource(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, import.meta.url), 'utf8')
}

describe('CLI shutdown wiring', () => {
  it.each(['./safe.ts', './index.ts'])(
    '%s retains and invokes bounded connection cleanup',
    async (relativePath) => {
      const source = await readSource(relativePath)
      expect(source).toContain('const closeWebSocket = attachWebSocket(server)')
      expect(source).toContain('const closeServer = listening.close()')
      expect(source).toContain('closeWebSocket()')
      expect(source).toContain('dispose()')
      expect(source).toContain('await closeServer')
      expect(source).not.toContain('server.close(() =>')
    },
  )
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm exec vitest run src/cli/shutdownWiring.test.ts
```

Expected: FAIL because neither entry point retains the WebSocket disposer and
the standard entry point still calls raw `server.close`.

- [ ] **Step 3: Update the safe CLI shutdown**

Capture the disposer:

```ts
const closeWebSocket = attachWebSocket(server)
```

Replace the shutdown body after managed-state cleanup with:

```ts
const closeServer = listening.close()
closeWebSocket()
dispose()
await closeServer.catch(() => {})
```

Keep the existing `shuttingDown` guard and signal handlers.

- [ ] **Step 4: Update the standard CLI shutdown**

Capture the disposer and make shutdown idempotent and asynchronous:

```ts
const closeWebSocket = attachWebSocket(server)
let shuttingDown = false

async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  console.log('\nShutting down...')
  if (tunnelChild && !tunnelChild.killed) tunnelChild.kill('SIGTERM')
  const closeServer = listening.close()
  closeWebSocket()
  dispose()
  try {
    await closeServer
    process.exit(0)
  } catch {
    process.exit(1)
  }
}
```

Register it without creating unhandled promises:

```ts
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
```

Remove the obsolete raw `server.close` callback and five-second force-exit
timer.

- [ ] **Step 5: Verify focused tests and build**

Run:

```bash
pnpm exec vitest run \
  src/cli/shutdownWiring.test.ts \
  src/cli/safe.entry.test.ts \
  src/cli/shared/launcher.test.ts \
  src/server/httpServer.websocket.test.ts
pnpm run build
```

Expected: all focused tests PASS and both frontend and CLI builds succeed.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/cli/safe.ts src/cli/index.ts src/cli/shutdownWiring.test.ts
git commit -m "fix(cli): close long-lived clients before exit"
```

---

### Task 4: Full Verification and Live Restart Acceptance

**Files:**
- Verify only; modify source only if a failing check identifies a defect.

**Interfaces:**
- Consumes: all prior shutdown tasks and the installed asynchronous restart trigger.
- Produces: evidence that a browser-connected service replaces its PID without systemd timeout or forced kill.

- [ ] **Step 1: Run complete automated verification**

```bash
pnpm test:unit
pnpm run build
node dist-cli/index.js --help
node dist-cli/safe.js --help
node dist-cli/safe.js doctor
git diff --check
```

Expected: all unit tests pass, build and help commands exit `0`, doctor reports
`ok`, and `git diff --check` is silent. The existing Vite chunk-size advisory
may remain; it is unrelated to shutdown correctness.

- [ ] **Step 2: Integrate into the original checkout without losing upload fixes**

Before integration:

```bash
git -C /home/zonghangli/codex-mobile status --short
git -C /home/zonghangli/codex-mobile rev-parse HEAD
```

Expected: exactly the four pre-existing upload-lifecycle files are modified.
Fast-forward the original branch to the reviewed shutdown-fix head, then repeat
the status check and confirm the same four files remain modified.

```bash
git -C /home/zonghangli/codex-mobile merge --ff-only codex/async-service-restart-trigger
git -C /home/zonghangli/codex-mobile status --short
```

- [ ] **Step 3: Record the acceptance timestamp and runtime baseline**

Record a durable journal boundary that survives the restart interaction:

```bash
date --iso-8601=seconds > /tmp/codex-mobile-shutdown-acceptance-start
```

- [ ] **Step 4: Record the acceptance baseline**

```bash
systemctl --user show codex-mobile-safe.service -p MainPID -p ActiveState
stat -c '%U %a %s' ~/.codex/codex-mobile-safe-password
ss -ltnp | grep ':5900'
tailscale serve status
```

Expected: active service, loopback-only listener, password metadata
`zonghangli 600 10`, and unchanged tailnet-only proxy.

- [ ] **Step 5: Install and queue one acceptance restart**

From `/home/zonghangli/codex-mobile`:

```bash
pnpm run service:install
```

Expected: build/install succeeds and reports `Queued codex-mobile-safe service
restart.` without blocking on the old process.

- [ ] **Step 6: Verify prompt replacement without forced kill**

On the next interaction, run:

```bash
systemctl --user is-active codex-mobile-safe.service
systemctl --user is-active codex-mobile-safe-restart.path
systemctl --user --no-pager --full status codex-mobile-safe-restart.service
systemctl --user show codex-mobile-safe.service -p MainPID -p ExecMainStartTimestamp
curl -sS -o /dev/null -w 'local_http=%{http_code}\n' http://127.0.0.1:5900/
journalctl --user \
  -u codex-mobile-safe-restart.service \
  -u codex-mobile-safe.service \
  --since "$(cat /tmp/codex-mobile-shutdown-acceptance-start)" \
  --no-pager
```

Expected:

- the main and path units are active;
- the worker exited `0`;
- the PID changed well before 90 seconds;
- HTTP returns `200`;
- the acceptance journal contains neither `stop-sigterm timed out` nor
  `SIGKILL`;
- no password, sandbox/approval, listener, or Tailnet invariant changed.

- [ ] **Step 7: Final scope review**

```bash
git status --short
git log --oneline -8
git diff --stat b0188b312d8a0884652df82e281d8fbc25f5528f..HEAD
```

Expected: shutdown commits contain only the planned launcher, WebSocket,
entrypoint, tests, spec, and plan files. The original checkout still contains
exactly the four uncommitted upload-lifecycle files.
