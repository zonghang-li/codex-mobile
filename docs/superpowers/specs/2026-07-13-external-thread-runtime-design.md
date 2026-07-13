# External Thread Runtime Detection Design

## Problem

After a mobile page refresh, `codex-mobile-safe` starts from a different Codex app-server process than the desktop client that owns an already-running turn. The mobile app-server reports the thread's latest turn as terminal, so the mobile composer shows the send control even though the desktop client is still running the turn.

Production evidence for thread `019f50f7-b8d9-72a3-9861-5ca7c3a0ea1e` showed all three layers disagreeing:

- the mobile app-server's `thread/read` reported the latest turn as `interrupted`;
- the shared rollout log contained `task_started(019f5b13-fcaf-7a12-b9a1-d84472031138)` with no later matching `task_complete` or `turn_aborted`;
- the desktop app-server still held that rollout file open for append with its file position advancing, while the mobile app-server's non-owning descriptor remained at position zero.

The root cause is that active-turn ownership is process-local. A `thread/read` result from one app-server is not authoritative for a turn owned by another app-server.

## Required Behavior

When a selected thread is running in another Codex client on the same Linux host:

- refresh and thread selection restore a running state instead of showing a completed/send state;
- the sidebar shows the normal working indicator;
- the composer remains visible but read-only, shows a disabled stop control, and explains that the turn is running in another client;
- the mobile client does not send interrupt, queue, steer, or new-turn requests for that externally owned turn;
- the state returns to idle after the external turn writes its terminal lifecycle event or its owning writer exits;
- a locally observed `turn/started` always takes precedence and remains governed by the existing turn-ID lease rules.

The existing behavior remains unchanged when there is no reliable external-owner evidence. In particular, non-Linux hosts must not guess from timestamps alone.

## Approaches Considered

### Session lifecycle plus live writer evidence (selected)

Combine an unmatched lifecycle record in the rollout log with a live Codex app-server append descriptor for the same file. Neither signal is sufficient alone: an unmatched start can survive a crash, while an open session file can remain loaded after completion. Together they identify the observed cross-app-server running case without a timeout heuristic.

### Recent log modification heuristic

Treat an unmatched start as active while the file was modified recently. This is portable and simple, but it incorrectly ends long silent commands and temporarily keeps crashed turns active. It is rejected.

### Connect to the desktop app-server control socket

Query and subscribe to the desktop client's private Unix control socket. This could provide direct state, but it depends on an internal handshake, process ownership, and socket lifecycle that are not part of codex-mobile's supported interface. It is rejected.

## Architecture

### Server runtime probe

Add a focused server module responsible for external runtime detection. It has no UI or RPC-normalization responsibilities.

For a trusted rollout path returned by `thread/read`, the probe:

1. validates that the real path is a regular file under the configured Codex sessions directory;
2. incrementally parses JSONL lifecycle events, tracking the latest `task_started` turn ID and clearing it only when `task_complete` or `turn_aborted` carries that same turn ID;
3. on Linux, scans same-user Codex app-server processes, excluding the bridge's own child app-server, for a writable descriptor referencing the same device/inode with a positive file position;
4. returns `running` only when an unmatched turn and a live writer are both present.

The cache key includes the resolved path, device, and inode. Each cache entry stores the last parsed byte offset, an incomplete trailing line, and the unmatched turn ID. File replacement or truncation resets the entry. Initial discovery scans the file once; subsequent probes read only appended bytes.

The process scan is bounded to numeric `/proc` entries owned by the current user whose command line identifies a Codex app-server. Permission errors and disappearing processes are treated as inconclusive rather than exceptional.

The probe result is a discriminated union so idle and inconclusive results cannot accidentally carry a stale turn ID:

```ts
type ExternalThreadRuntime =
  | {
      state: 'running'
      turnId: string
      interruptible: false
      source: 'external-session-writer'
    }
  | { state: 'idle' }
  | { state: 'unknown' }
```

`unknown` means the platform or evidence cannot support a safe decision. It never creates or releases a local lease.

### Bridge integration

The bridge augments successful `thread/read` and `thread/resume` responses with external runtime metadata only when their own app-server result is not active. It registers the thread-to-session-path association in the runtime probe without rewriting the persisted turn's terminal status.

Add a lightweight authenticated endpoint for subsequent checks:

```text
GET /codex-api/thread-runtime-state?threadId=<id>
```

This endpoint uses the registered path and incremental cache; it does not issue another full `thread/read`. Missing registration returns `unknown`.

### Client runtime ownership

Extend normalized thread detail with explicit ownership:

```ts
type ThreadRuntimeOwnership = 'idle' | 'local' | 'external'

type ThreadDetailRuntime = {
  inProgress: boolean
  activeTurnId: string
  ownership: ThreadRuntimeOwnership
  canInterrupt: boolean
}
```

The existing event-established local lease remains authoritative. An external runtime result establishes a separate, revocable external lease. It must not reuse the local lease retention rule because external completion is learned by polling rather than by a notification delivered to the mobile app-server.

State precedence is:

1. locally observed `turn/started` and its matching completion;
2. active state reported by the mobile app-server;
3. confirmed external runtime evidence;
4. idle.

A local start replaces external ownership. A stale external poll result cannot clear a local lease.

### Targeted polling

While the selected thread has external ownership, schedule one runtime-state request every two seconds. Do not add a global interval and do not poll idle or locally owned threads.

- `running`: retain external ownership and schedule the next probe;
- `idle`: release only the external lease, then perform one normal detail load to collect terminal output;
- `unknown` or request failure: conservatively retain the current external state and retry; it cannot affect a local lease.

Selection changes, local `turn/started`, disposal, and service disconnect cancel the previous thread's timer. After reconnect and detail recovery, confirmed external ownership starts a fresh polling cycle. Only one external-runtime request may be in flight.

## User Interface

The sidebar uses the existing working spinner because the thread is genuinely active.

The composer receives external ownership separately from `isTurnInProgress`:

- it shows the stop-shaped running control rather than the send arrow;
- the control is disabled and labelled `Running in another client`;
- text entry, attachments, model changes, queue, steer, submit, and interrupt actions are disabled for the external lease;
- messages remain scrollable and readable.

Local running behavior, including the normal enabled stop control, is unchanged.

## Error Handling and Safety

- Never infer external running from an unmatched log record alone.
- Never infer external running from file modification time alone.
- Never expose arbitrary filesystem probing: the session path must originate from Codex and resolve under the Codex sessions directory.
- `/proc` races, permission failures, malformed JSONL rows, and incomplete trailing writes are tolerated.
- Probe failures preserve an already-confirmed external running display but do not create a new one.
- The runtime endpoint remains covered by the existing safe authentication and loopback/tailnet exposure policy.

## Testing

### Server unit tests

- unmatched `task_started` plus a matching live writer returns `running` with the correct turn ID;
- matching `task_complete` and `turn_aborted` return `idle`;
- unmatched start without a live writer returns `idle`;
- open writer without an unmatched start returns `idle`;
- appended lifecycle records are parsed incrementally;
- partial JSONL lines, file truncation/replacement, `/proc` races, path escape, and unsupported platforms return safe results.

Process and filesystem inspection use injected adapters so tests never depend on the host's real `/proc` state.

### Client unit tests

- refreshed detail with confirmed external runtime shows running and external ownership;
- external ownership disables composer mutation and interrupt actions;
- external `idle` releases only the external lease and refreshes detail;
- `unknown` retains an established external state;
- local `turn/started` replaces external ownership and restores normal local interrupt behavior;
- stale external poll results cannot clear a local turn-ID lease;
- polling is single-flight, selected-thread-only, and cancelled on selection/disposal.

### Integrated verification

Run the full Vitest suite, production build, CLI doctor, service binding checks, and a two-app-server manual scenario:

1. start a long turn in the desktop client;
2. refresh mobile and open that thread;
3. confirm sidebar working state and disabled external stop control;
4. finish the desktop turn;
5. confirm mobile returns to idle and loads the terminal output without another page refresh.

## Deployment and Rollback

Merge only after review and full verification. Reinstall `codex-mobile-safe`, restart the user service, and confirm it remains bound to `127.0.0.1:5900` behind tailnet-only Tailscale Serve.

Rollback is a revert of the runtime-probe and client-ownership commits followed by the same local service installation. No stored data migration is required; the new runtime state is ephemeral.
