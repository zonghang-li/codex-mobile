# External Turn Notifications and Mobile Dark Mode Design

Date: 2026-07-15
Status: Approved and implemented
Branch: `codex/external-turn-notifications-dark-mode`

## Summary

Extend `codex-mobile-safe` so long-running Codex turns started by other local clients are eligible for the same ntfy completion notifications as turns started through the mobile web UI. Detection must continue while the phone is locked, the browser is backgrounded, or no browser is connected. Preserve the exact production threshold of 600,000 milliseconds and the existing outbound-only, authenticated, Tailnet-only safety model.

Also expose the existing light/dark/system theme support through a compact mobile header button. The application continues to follow the operating-system theme by default, while the button provides a one-tap explicit light/dark override.

## Problem Statement

The current notifier subscribes to `turn/started` and `turn/completed` notifications emitted by the app-server process owned by `codex-mobile-safe`. Codex Desktop, Codex CLI, and other clients use different app-server processes. Their rollout files are shared under the current user's Codex sessions directory, but their lifecycle notifications are not forwarded to the safe service.

Opening or resuming an external thread in the mobile web UI can cause the safe app-server to observe or replay a running turn. If the browser then stops requesting updates, the safe notifier may never receive the external terminal event. Durable notifier state consequently retains stale active records and no ntfy notification is sent.

The frontend already stores `system`, `light`, and `dark` preferences and has comprehensive dark-theme CSS. The only theme control is buried in the sidebar settings panel, making dark mode difficult to discover and use on a phone.

## Goals

- Detect turns started by any same-user local Codex app-server, including Codex Desktop and Codex CLI.
- Continue detection without a browser connection and while a phone is locked.
- Recover a turn that was already running when `codex-mobile-safe` restarted.
- Use rollout lifecycle timestamps and `duration_ms` rather than the time a scan happened.
- Notify only turns whose duration is at least `600_000` ms.
- Reuse existing summary generation, pending delivery, retries, durable state, and logical deduplication.
- Avoid sending notifications for historical turns that were already terminal before the monitor started.
- Keep external monitoring disabled when ntfy is not configured.
- Provide a visible, accessible mobile header theme toggle while retaining system-theme mode.

## Non-Goals

- No public push endpoint, incoming webhook, service worker push subscription, or browser background execution.
- No Cloudflare tunnel, Tailscale Funnel, LAN listener, or authentication bypass.
- No notification for turns shorter than ten minutes.
- No replay of old completed turns after installation or restart.
- No second AI call to summarize a result.
- No detailed conversation history in monitor state or logs.
- No replacement of the existing theme system.
- No desktop-header redesign.

## Considered Approaches

### 1. Incremental rollout monitor — selected

Discover same-user external Codex app-server writers and incrementally parse their rollout JSONL files. Lifecycle records contain stable turn IDs, timestamps, and terminal duration. This source continues to exist when the browser is absent and covers Desktop and CLI without coupling to their UI processes.

Advantages:

- Browser-independent and client-independent.
- Can recover tasks already running across a safe-service restart.
- Uses authoritative persisted lifecycle facts.
- Adds no public API.

Costs:

- Requires careful file identity, append, truncation, and process-race handling.
- Requires bounded periodic discovery on Linux.

### 2. Poll `thread/list` and `thread/read`

This is simpler conceptually, but list requests are comparatively expensive and thread status can lag the external writer. Polling every thread would add large payloads and unbounded work as history grows.

### 3. Filesystem watchers only

Watchers offer low latency, but recursive watching is not consistently available on Linux, day-based session directories can appear dynamically, and restart races can miss an event. Watchers alone are not a reliable lifecycle source.

## Architecture

### ExternalTurnMonitor

Add a focused server module whose only responsibility is converting external rollout lifecycle records into normalized turn events. It does not know the ntfy URL and does not send network requests.

The monitor is enabled only when the safe server receives a validated `ntfyNotifications` configuration. Its lifecycle belongs to `createNtfyNotifierLifecycle`, alongside `NtfyCompletionNotifier`.

Inputs:

- Codex sessions root for the current user.
- PID of the safe service's own app-server, so its process tree can be excluded from external discovery.
- A bounded scan interval, defaulting to 15 seconds in production.
- Injectable filesystem/process/clock/timer operations for deterministic tests.

Outputs:

```ts
type ObservedTurnLifecycle = {
  method: 'turn/started' | 'turn/completed'
  threadId: string
  turnId: string
  status: 'inProgress' | 'completed' | 'failed' | 'interrupted'
  occurredAt: number
  durationMs?: number
}
```

The monitor exposes `start()`, `dispose()`, and a subscription callback. It performs no work after disposal.

### Discovery

On Linux, reuse and extract the hardened same-user app-server process/FD inspection currently used by `ExternalThreadRuntimeProbe`. A candidate must:

- belong to the current UID;
- have a stable process identity and valid ancestry;
- execute `codex app-server`;
- own a writable descriptor for a regular file;
- resolve to a canonical `.jsonl` path contained under the canonical Codex sessions root;
- not belong to the safe service's own app-server process tree.

Each scan immediately registers newly discovered rollout identities. The scan interval is bounded and serialized: if one scan is still running, another scan is not started.

The monitor retains only active/recently terminal rollout cursors, capped at 256. It does not recursively reread all historical sessions on every interval.

Once a rollout is registered, continue checking its append offset even after the writer descriptor disappears, until a terminal lifecycle record is consumed or 24 hours pass with neither file growth nor live-writer evidence. This inactive expiry only evicts the cursor; writer disappearance by itself never creates a terminal event.

### Incremental JSONL Parsing

For every registered rollout, retain:

- canonical path, device, and inode;
- thread ID read from the rollout's `session_meta.payload.id` record;
- byte offset and a bounded trailing partial line;
- current unmatched turn ID and authoritative start timestamp;
- a small checkpoint used to detect replacement or truncation;
- last observation time.

Read the bounded file prefix once to obtain `session_meta.payload.id`; do not accept lifecycle events until a non-empty thread ID is validated. Read appended bytes in 64 KiB chunks. Parse only complete JSONL lines. Ignore unrelated records and malformed partial lines until completed. Recognized lifecycle records are:

- `event_msg.payload.type === 'task_started'`: emit `turn/started` using the row timestamp.
- `event_msg.payload.type === 'task_complete'`: emit completed status using `completed_at` or the row timestamp and the supplied `duration_ms`.
- `event_msg.payload.type === 'turn_aborted'`: emit interrupted status using `completed_at` or the row timestamp and the supplied `duration_ms`.

Unknown future terminal types are ignored until explicitly reviewed. The monitor never infers success from a writer disappearing.

When a file is first discovered mid-turn, search backwards in bounded chunks for the most recent lifecycle record. If it is `task_started`, recover its original timestamp and begin forward incremental reads from a verified boundary. If the first observed record is a terminal record occurring after monitor startup and its `duration_ms` proves that the turn was already running at monitor startup, synthesize the matching start timestamp as `completedAt - durationMs` before emitting the terminal event. This closes the discovery race without replaying turns that completed before startup.

### Restart Recovery and Historical Suppression

At monitor startup, record `monitorStartedAt`.

- A currently unmatched `task_started` is restored as active with its original timestamp.
- A terminal record whose completion timestamp is earlier than `monitorStartedAt` is baseline history and is not emitted.
- A terminal record after `monitorStartedAt` is eligible when either its start was observed/restored or `duration_ms` proves it crossed startup while still running.
- No completed historical backlog is delivered.

This satisfies the approved behavior: a task already running when the safe service restarts can notify when it later finishes.

### Notifier Integration

Extend normalized notifier input to preserve an authoritative occurrence timestamp. Direct app-server notifications use receipt time when no source timestamp is available. External lifecycle events use rollout timestamps.

Both sources feed the same `NtfyCompletionNotifier`. The existing key remains `${threadId}:${turnId}`. Active, pending, and sent state therefore suppress duplicate local/external observations and preserve one logical notification per turn.

The existing notifier remains responsible for:

- the exact 600,000 ms threshold;
- final thread reads and deterministic first-sentence summaries;
- fixed completion/failure/interruption titles;
- pending delivery retries and five-second request timeout;
- bounded active, pending, and sent collections;
- stable ntfy sequence IDs.

If the final thread read is temporarily unavailable, retain the current safe fallback message. No conversation content is written by the external monitor.

### Stale Active Reconciliation

Existing durable state may contain active records for external turns whose terminal event was previously missed. When the monitor encounters the corresponding terminal lifecycle after this release, the shared key removes the active record and performs normal qualification.

For records already terminal before this monitor starts, do not notify retroactively. A bounded reconciliation pass may remove a stale active record after confirming the rollout's latest lifecycle is terminal, but it must not add it to pending or sent. This prevents permanent stale growth without alert storms.

## Mobile Theme Toggle

Reuse the existing `darkMode` state, `DARK_MODE_KEY`, `applyDarkMode()`, and root `dark` class.

Add a compact icon button to the mobile content-header leading controls:

- visible only at the mobile breakpoint;
- moon icon while the effective theme is light, indicating the action switches to dark;
- sun icon while the effective theme is dark, indicating the action switches to light;
- localized `aria-label` and `title` describing the action;
- minimum 44×44 CSS touch target without changing the visible icon size.

Default remains `system`. On the first quick-toggle click from `system`, compute the current effective theme and store the opposite explicit mode. Later clicks alternate `light` and `dark`. The existing Appearance settings row remains the way to choose `system` again.

Listen to `prefers-color-scheme` changes while the saved mode is `system`; the icon and root class update together. The preference remains local to the browser through existing `localStorage` behavior.

The button must not reduce the title, terminal control, or branch selector below their existing responsive constraints at 375 px.

## Error Handling

- Filesystem or `/proc` permission uncertainty produces no notification and is retried on the next scan.
- PID, ancestry, FD, path, device, or inode changes make that observation inconclusive rather than terminal.
- File truncation/replacement resets only that cursor after identity validation.
- Partial JSONL records are buffered within a strict bound; oversized malformed fragments are discarded with a redacted warning.
- Scan failures are rate-limited and never include rollout contents, ntfy URLs, or topics.
- A disappearing writer without a terminal lifecycle is not classified as completed or interrupted.
- Timer callbacks are serialized and stopped during disposal.
- Theme preference corruption falls back to `system`, matching current behavior.

## Security and Privacy

- Monitoring is local, read-only, same-UID, Linux-only, and constrained to the canonical Codex sessions root.
- Symlink escapes, non-regular files, unstable identities, and other-user processes are rejected.
- The monitor stores lifecycle metadata only: IDs, timestamps, cursor identities, and bounded offsets.
- The monitor never logs or persists prompts, assistant text, notification topics, or publish URLs.
- Final assistant text continues to be read only on a qualifying terminal event by the existing notifier.
- No new HTTP route, RPC allowlist entry, listener, incoming command, or public exposure is introduced.
- Safe mode remains loopback-only with password authentication and explicit Tailscale Serve.

## Performance Bounds

- Default discovery interval: 15 seconds.
- At most one discovery/read cycle at a time.
- Incremental 64 KiB reads; unchanged files read zero payload bytes.
- Cursor and active-turn collections capped at 256.
- Process/FD discovery reuses one `/proc` snapshot per cycle rather than one scan per thread.
- Missing-writer inactive expiry: 24 hours without file growth or renewed writer evidence.
- Per-cycle Linux discovery caps: 16,384 numeric processes, 4,096 descriptors per app-server, 8,192 yielded descriptor snapshots, 256 unique rollout writers, and a 5,000 ms wall-clock budget.
- Historical session files are not repeatedly parsed.
- ntfy-disabled mode starts no monitor, timer, scan, or notification network work.

The performance audit must record process count, candidate descriptor count, tracked rollout count, bytes read, scan duration, skipped overlapping scans, and whether any extra app-server RPC was issued.

## Testing

### External monitor unit tests

- same-user external writer accepted; own app-server, other UID, unstable PID, and unsafe path rejected;
- split JSONL lines and 64 KiB boundaries;
- start, complete, abort, malformed lines, unrelated events, and duplicate records;
- authoritative start/completion timestamps and `duration_ms`;
- running-at-restart recovery;
- terminal-before-startup suppression;
- terminal-after-startup discovery race recovery;
- truncation, replacement, symlink escape, unreadable file, process exit, and missing terminal event;
- multi-turn and multi-session ordering;
- serialized timer behavior, disposal, cursor eviction, and collection caps.

### Notifier integration tests

- external and direct events with the same turn key deliver once;
- 599,999 ms does not notify and 600,000 ms does;
- completion and interruption titles remain exact;
- final assistant summary and fallback behavior remain unchanged;
- restart state and stale-active reconciliation do not replay historical notifications;
- ntfy-disabled lifecycle creates no monitor subscription, timer, or filesystem scan.

### Theme tests

- missing/corrupt preference defaults to system;
- system media-query changes update the effective theme and icon;
- first quick click chooses the opposite explicit theme;
- later clicks alternate and persist light/dark;
- Appearance settings can restore system mode;
- localized button labels and keyboard focus are present.

### Browser verification

At 375×812 and 768×1024, verify:

- system-light, system-dark, explicit-light, and explicit-dark rendering;
- button touch target and icon/label state;
- no header overlap with title, terminal, or branch controls;
- preference persists across refresh;
- chat, sidebar, composer, directive cards, menus, and settings have no light surfaces in dark mode.

### Runtime verification

- Use an isolated test configuration with an injected short threshold/clock; production remains fixed at 600,000 ms.
- Start a controlled external Codex turn with no browser connected and confirm exactly one captured ntfy send request.
- Repeat with the browser backgrounded and with the safe service restarted mid-turn.
- Run focused tests, `pnpm run test:unit`, `pnpm run build`, both CLI help commands, `codex-mobile-safe doctor`, service reinstall/restart, listener inspection, `tailscale serve status`, and redacted journal inspection.

## Documentation

Update:

- `docs/AGENT_GUIDE.md` with cross-client monitoring behavior and diagnostics;
- the relevant notification manual-test document under `tests/`;
- the mobile theme manual-test document and test index;
- PR verification notes with redacted performance and runtime evidence.

## Rollout and Rollback

Rollout uses the existing local install and user-service restart. Verify the service remains on `127.0.0.1:5900` and Tailscale Serve remains Tailnet-only.

Rollback is a code/service rollback to the preceding `main` revision. The design keeps the existing notifier-state schema; external rollout cursors remain bounded in memory and are reconstructed from authoritative files after restart. Removing or invalidating the optional ntfy configuration still disables the notifier and external monitor together.
