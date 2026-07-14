### External live thread sync

#### Acceptance Steps

1. Start a desktop Codex turn that emits at least two visible reasoning summaries and two commentary/agent messages.
2. Record the desktop thread ID and open the same thread in mobile Chrome without reloading again.
3. At `390×844`, confirm the live overlay changes from `Thinking` to the newest desktop-visible summary within one settled polling cycle.
4. Confirm each new desktop commentary message appears without reload and each stable message ID renders once.
5. Confirm the externally owned composer remains non-interruptible.
6. Record DevTools requests and confirm one selected `thread/read` RPC request at a time, no selected `/codex-api/thread-runtime-state` request, and the next detail read starts at least 2,000 ms after settlement.
7. Hide the page for at least five seconds; confirm the in-flight detail/batch requests abort and no new detail or batch request starts.
8. Return visible; confirm one immediate detail refresh catches up both summary and output.
9. Complete the desktop task; confirm the final output appears before the live overlay disappears and persisted reasoning becomes visible in history.
10. Repeat layout checks at `768×1024` and in light/dark appearances.

#### Evidence Template

```text
selected external thread: <sanitized ID suffix>
summary before/after: Thinking -> <visible summary>
output message count before/after: <n> -> <n+1>
duplicate stable IDs: 0
max selected detail requests in flight: 1
runtime-only selected requests: 0
requests while hidden: 0
foreground catch-up: passed
final output before overlay clear: passed
```

#### Rollback

Revert the feature commits, run `pnpm run install:local`, and restart only `codex-mobile-safe.service`; do not change or restart Tailscale Serve.
