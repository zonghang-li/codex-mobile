# Feature: Safe long-task completion notifications

## Prerequisites / setup

- Linux with Node.js 18+, pnpm, systemd user services, and Tailscale installed and logged into the intended tailnet.
- A clean local clone of `https://github.com/zonghang-li/codex-mobile.git` with dependencies installed.
- The persistent `codex-mobile-safe` user service installed from this checkout with `pnpm run service:install`. This manual test uses the service lifecycle throughout; foreground-only `install:local` is not equivalent because it does not install or refresh the systemd unit.
- The ntfy mobile app installed. The phone is subscribed to one locally generated, unguessable topic and is logged into the same tailnet for browser access.
- No real topic, publish URL, password, or Tailnet credential is present in tracked files, shell history, process arguments, systemd units, or logs.

Create the local notification configuration from the repository root. Enter only the subscribed topic at the prompt:

```bash
install -d -m 700 ~/.codex
install -m 600 /dev/null ~/.codex/codex-mobile-safe-ntfy-url
read -r NTFY_TOPIC
printf 'https://ntfy.sh/%s\n' "$NTFY_TOPIC" > ~/.codex/codex-mobile-safe-ntfy-url
unset NTFY_TOPIC
chmod 600 ~/.codex/codex-mobile-safe-ntfy-url
pnpm run service:restart
```

## Automated deterministic checks

1. Run the focused notification suite:

   ```bash
   pnpm exec vitest run src/safe/ntfyConfig.test.ts src/safe/ntfyState.test.ts src/server/externalThreadRuntime.test.ts src/server/rolloutLifecycle.test.ts src/server/externalTurnMonitor.test.ts src/server/ntfyCompletionNotifier.test.ts src/server/securityPolicy.test.ts src/cli/safe.entry.test.ts src/safe/doctor.test.ts src/safe/packaging.test.ts
   ```

2. Confirm the tests cover `599_999` ms with no thread read/send and exactly `600_000` ms with a send.
3. Confirm completed, failed, and interrupted/cancelled terminal statuses produce the exact titles `Codex 任务完成`, `Codex 任务失败`, and `Codex 任务已中断`.
4. Confirm the body uses the first non-empty final-assistant sentence, collapses whitespace, truncates to 180 characters, uses a fixed status fallback when needed, and makes no additional AI request.
5. Confirm active timing survives notifier reconstruction, pending delivery is durable before sending, a startup retries pending work, each attempt has a five-second timeout, and each drain makes at most three immediate attempts per pending record.
6. Confirm ordinary duplicate completion events create one local pending/sent key and reuse the same bounded ASCII ntfy sequence ID; distinct turn keys use distinct sequence IDs.
7. Confirm the real default Fetch request uses an RFC 2047 ASCII title and `X-Sequence-ID`, while warnings contain no URL, topic, body, or sender exception text.
8. Confirm absent notification configuration creates no notifier, external monitor, event subscription, process/filesystem scan, timer, state store, or network work.
9. In the deterministic integration harness, deliver the same logical turn once through a direct app-server notification and once through external rollout discovery. Confirm exactly one ntfy send is captured, both observations resolve to the same durable turn key and sequence ID, and no duplicate pending or sent record is created.
10. Confirm an external completion acknowledgement is withheld until its state save succeeds. Make that save fail once, then verify the monitor retries the same record with one durable start and exactly one send.
11. Confirm tracked cursors are read before process discovery. A missing-writer cursor remains eligible before 24 hours, is evicted at the 24-hour inactive boundary without a synthetic terminal event, and a live writer or growing file refreshes the appropriate activity clock.
12. Confirm default Linux discovery stops at 16,384 numeric processes, 4,096 descriptors per app-server, 8,192 yielded snapshots, 256 unique rollout writers, or 5,000 ms wall time. Each capped/deadline result and each candidate canonicalization/stat rejection must report incomplete, and omission from it must not expire an aged tracked cursor; only a complete missing-writer scan can release capacity. A successfully validated unsafe candidate remains a conclusive rejection.

## Cross-client and restart acceptance

Use only synthetic topic placeholders in deterministic harness output. Do not print, paste, or record the production topic or publish URL.

1. Open and authenticate the mobile browser UI, then put the browser in the background while leaving its tab open.
2. Under the same operating-system user as `codex-mobile-safe`, start a controlled Codex Desktop turn, let its authoritative duration reach at least `600_000` ms, and complete it. With the browser still backgrounded but open, verify the real ntfy app receives exactly one notification according to the device's ntfy notification, Focus, sound, and vibration settings.
3. Close every mobile browser tab and lock the subscribed phone.
4. Under the same operating-system user, start a separate controlled Codex CLI turn, let its authoritative duration reach at least `600_000` ms, and complete it. With the browser closed and phone locked, verify the real ntfy app receives exactly one notification according to the same device settings.
5. During both production turns, repeat `ss -ltnp` and `tailscale serve status`. Verify no new inbound or public listener appears: the backend remains on `127.0.0.1:5900`, Tailscale Serve remains non-Funnel, and notification delivery is outbound-only.
6. In the deterministic external-monitor/notifier harness, complete a turn at `599_999` ms and observe no captured ntfy send.
7. In the same harness, complete a turn at exactly `600_000` ms and observe exactly one captured ntfy send.
8. In the deterministic integration harness, feed one logical turn through both direct app-server notification handling and external rollout discovery. Observe exactly one captured send, one durable turn key, one stable sequence ID, and no duplicate pending or sent record.
9. Start another controlled external turn, restart the safe service between its authoritative rollout start and terminal records, then complete it. Observe exactly one send using the original rollout timestamp rather than the restart time.
10. Complete a historical rollout fixture before monitor startup, start the monitor, and observe no send. Also remove its writer/process evidence without a terminal lifecycle record and confirm no completion is inferred.
11. In the deterministic fake-clock harness, keep a missing-writer active cursor below and then at the 24-hour inactive boundary. Confirm append checks continue before the boundary, eviction at the boundary emits nothing, and released cursor capacity can admit a newly discovered writer.

## Service and Tailnet boundary checks

1. Run:

   ```bash
   codex-mobile-safe doctor
   codex-mobile-safe status
   codex-mobile-safe urls
   pnpm run service:status
   ss -ltnp
   tailscale serve status
   journalctl --user -u codex-mobile-safe -n 100 --no-pager
   ```

2. Confirm `doctor` reports `codex-mobile-safe doctor: ok`.
3. Confirm the service listens on `127.0.0.1:5900`, not `0.0.0.0:5900`, and the systemd command line contains no ntfy URL/topic or `--ntfy-url-file` argument.
4. If not already exposed, run `codex-mobile-safe expose tailscale`. Confirm `codex-mobile-safe urls` shows the HTTPS tailnet URL and `tailscale serve status` forwards it to `http://127.0.0.1:5900` without Funnel.
5. Open the URL from the subscribed phone while it is logged into the intended tailnet. Confirm password authentication is still required. Confirm a device outside the tailnet cannot reach the UI.
6. Confirm the journal may report redacted notification state/delivery failures but never prints the publish URL, topic, or notification body.
7. Confirm neither Telegram/background integrations nor a Cloudflare/public tunnel is running. Do not use `--lan` for this test.

## End-to-end phone checks

1. Run both production cases from **Cross-client and restart acceptance**: one qualifying Codex Desktop turn while an authenticated mobile tab remains open in the background, then one separate qualifying Codex CLI turn after all mobile tabs are closed and the phone is locked. Leave sound/vibration behavior controlled by the phone's ntfy settings and Focus/Do Not Disturb state.
2. Confirm each turn lasts at least 10 minutes (`600_000` ms) from its authoritative rollout timestamp and produces exactly one notification with the correct status title and only the first concise sentence of the final assistant response.
3. Run a normal turn that finishes in less than 10 minutes. Wait beyond its completion long enough to distinguish it from delivery latency and confirm it does not notify.
4. For failure and interruption coverage, rely on the deterministic focused tests unless deliberately running additional real ten-minute turns. If run end to end, confirm the failure and interruption titles exactly match the table above and no conversation history is included.
5. For restart recovery, run the exact reconstruction and pending-startup cases without changing the production threshold:

   ```bash
   pnpm exec vitest run src/server/ntfyCompletionNotifier.test.ts -t 'loads an active start after reconstruction and qualifies completion|reconstructs and retries a pending record left by failed delivery'
   ```

   Confirm both pass; they reconstruct the notifier around durable state rather than relying on an unsafe production threshold override.
6. Repeat an ordinary completion event and then repeat the same logical turn through the other observation source in the deterministic harness. Confirm no second local pending/sent record is created and the same durable key and sequence ID are retained. Do not interpret this as transport-level exactly-once delivery: an ambiguous timeout or a process crash after ntfy accepts the POST but before the local sent-state commit can append another event and may re-alert depending on client timing/platform behavior.
7. Confirm the Desktop case works while the mobile browser remains open in the background and the CLI case works after all mobile browser tabs are closed with the phone locked. The 15-second monitor cadence may add detection latency, but it must not change qualification duration, infer completion from writer disappearance, or require a browser reconnect.

## Expected results

- Notifications are disabled when the default file is absent and enabled only after a valid current-user mode-`0600` regular file is present and the service restarts.
- Only `https://ntfy.sh/<single-topic>` is accepted. The topic segment contains only letters, numbers, `_`, or `-`; credentials, queries, fragments, other origins, extra segments, and symlinks are rejected.
- Tasks shorter than 10 minutes never notify. Successful, failed, and interrupted qualifying turns use the exact titles and one-sentence summary behavior above.
- With ntfy enabled, same-user turns started from the mobile UI, Codex Desktop, Codex CLI, and other Codex clients that write authoritative rollouts are eligible. External detection is server-side, polls on a serialized 15-second cadence, reads tracked rollouts before bounded discovery, survives a safe-service restart using authoritative rollout timestamps, and never replays already-terminal history. A missing writer is not completion; its cursor expires only after 24 inactive hours.
- Notification sending is outbound-only and does not block or fail the Codex turn. Active/pending/sent state is private, durable, and bounded to 256 records per collection.
- Ordinary duplicates and cross-source observations of the same logical turn are locally suppressed through one durable key and reuse one stable sequence ID, without duplicate pending/sent records. Ambiguous delivery remains a documented possible re-alert boundary.
- Browser access remains password-protected, loopback-backed, and Tailscale Serve-only. No LAN listener, Funnel, Telegram bridge, or Cloudflare/public tunnel is enabled.

## Rollback / cleanup

1. Disable notification delivery without printing the secret:

   ```bash
   rm ~/.codex/codex-mobile-safe-ntfy-url
   pnpm run service:restart
   ```

2. Confirm a short task creates no notification network work and the redacted journal contains no secret.
3. Remove the test topic subscription from the phone if it is no longer needed.
4. To remove remote browser exposure, run `codex-mobile-safe unexpose` and confirm `tailscale serve status` no longer lists the mapping.
5. To remove the service, run `pnpm run service:uninstall`. The password file is intentionally retained for explicit user handling.
