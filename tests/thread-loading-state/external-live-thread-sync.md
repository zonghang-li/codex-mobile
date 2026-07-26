### Feature: External live thread sync

#### Prerequisites

- Run the current `main` build through `codex-mobile-safe` with the browser connected over the existing Tailscale-only route.
- Keep desktop Codex and mobile browser access to the same test thread, and open mobile DevTools network recording.
- Prepare `390×844` and `768×1024` responsive viewports with both light and dark appearances available.

#### Steps

1. Start a desktop Codex turn that emits at least two visible reasoning summaries and two commentary/agent messages.
2. Record the desktop thread ID and open the same thread in mobile Chrome without reloading again.
3. At `390×844`, confirm the live overlay changes from `Thinking` to the newest desktop-visible summary within one settled polling cycle.
4. Confirm each new desktop commentary message appears without reload and each stable message ID renders once.
5. Confirm the externally owned composer remains non-interruptible.
6. While the desktop writer is active, attempt a normal mobile send and confirm no mobile `turn/start` reaches the app-server; repeat once while writer discovery is deliberately inconclusive.
7. Record DevTools requests and confirm one selected `thread/read` RPC request at a time, no selected `/codex-api/thread-runtime-state` request, and the next detail read starts at least 2,000 ms after settlement.
8. Hide the page for at least five seconds; confirm the in-flight detail/batch requests abort and no new detail or batch request starts.
9. Return visible; confirm one immediate detail refresh catches up both summary and output.
10. Complete the desktop task; confirm the final output appears before the live overlay disappears and persisted reasoning becomes visible in history.
11. Repeat layout checks at `768×1024` and in light/dark appearances.

#### Expected Results

- The newest visible desktop reasoning summary replaces `Thinking` within one settled polling cycle, while `Thinking` remains the fallback before a summary exists.
- New commentary/output appears without reload, stable IDs do not duplicate, and active reasoning rows stay out of the transcript until the turn completes.
- Exactly one selected live `thread/read` is in flight; the next starts at least 2,000 ms after settlement, and no selected runtime-only request is sent.
- Hiding the page aborts live-detail and background-runtime requests and pauses new requests; returning visible performs one immediate catch-up.
- The final output is reconciled before external ownership and the live overlay clear, and externally owned controls remain non-interruptible.
- Confirmed external and unknown writer observations reject normal mobile sends both before and at the server dispatch boundary; only an explicit idle probe permits `turn/start`.

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

#### Rollback/Cleanup

Revert the feature commits, run `pnpm run install:local`, and restart only `codex-mobile-safe.service`; do not change or restart Tailscale Serve.
