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
5. Send or resume from a Desktop `codex_delegation` handoff, including a handoff whose transport XML is HTML-escaped as `&lt;codex_delegation&gt;`, then confirm mobile shows that input as a collapsed user bubble labeled `Sent by Codex from another chat` before the assistant response it triggered; it must not disappear, flatten into assistant output, move below the response after refresh, or expose raw transport XML / escaped entities in the collapsed body.
6. Confirm the externally owned composer exposes Stop for the external active turn id while leaving edit/configuration controls blocked.
7. While the desktop writer is active, attempt a normal mobile send and confirm it is routed through the busy Queue/Steer path without starting a competing mobile `turn/start`; repeat once while writer discovery is deliberately inconclusive.
8. Record DevTools requests and confirm one selected `thread/read` RPC request at a time, no selected `/codex-api/thread-runtime-state` request, and the next detail read starts at least 2,000 ms after settlement.
9. Hide or background the page for at least five seconds; confirm selected active text/runtime polling continues and new desktop output still appends without a manual refresh.
10. Deploy or restart a local build with a new `/codex-api/app-version` build ID while the page is hidden; confirm the hidden tab reloads itself instead of continuing to run an old bundle.
11. Complete the desktop task; confirm the authoritative completed snapshot replaces the same turn's live commentary rows, the final output remains at the bottom, completion timing/actions remain visible, and old running text or handoff bubbles do not move below the final response.
12. Return visible; confirm the page is already current and performs at most one immediate catch-up refresh.
13. Repeat layout checks at `768×1024` and in light/dark appearances.

#### Expected Results

- The newest visible desktop reasoning summary replaces `Thinking` within one settled polling cycle, while `Thinking` remains the fallback before a summary exists.
- New commentary/output appears without reload, stable IDs do not duplicate, and active reasoning rows stay out of the transcript until the turn completes.
- Desktop `codex_delegation` handoffs remain visible as collapsed user bubbles labeled `Sent by Codex from another chat` and stay ordered before the assistant response they triggered during both live delta hydration and page refresh; raw `<codex_delegation>` transport tags and escaped `&lt;codex_delegation&gt;` entities do not appear in the collapsed body; internal environment, permissions, plugin, AGENTS, and subagent-notification inputs remain hidden.
- Exactly one selected live `thread/read` is in flight; the next starts at least 2,000 ms after settlement, and no selected runtime-only request is sent.
- Hidden/background tabs keep selected active text/runtime polling alive, and build-version polling reloads stale hidden tabs after deployment.
- The final output is reconciled before external ownership and the live overlay clear; completed authoritative snapshots remove stale same-turn live commentary without deleting user input bubbles, completion timing/actions, or terminal backfill rows.
- Completed compressed turn windows that contain explicit `final`/`final_answer` text render that final text only; retained `commentary` progress from the compressed window must not reappear after a background poll or refresh.
- Externally owned controls keep Stop plus busy Queue/Steer available while blocking edit/configuration mutations.
- Confirmed external and unknown writer observations reject competing mobile `turn/start` both before and at the server dispatch boundary; only an explicit idle probe permits direct `turn/start`.

#### Evidence Template

```text
selected external thread: <sanitized ID suffix>
summary before/after: Thinking -> <visible summary>
output message count before/after: <n> -> <n+1>
delegation user bubble: visible/collapsed/no raw or escaped XML
delegation order: before triggered assistant response
duplicate stable IDs: 0
max selected detail requests in flight: 1
runtime-only selected requests: 0
selected requests while hidden: continues/no bulk reload
hidden build reload: passed
foreground catch-up: passed
final output before overlay clear: passed
stale live rows after completion: 0
```

#### Rollback/Cleanup

Revert the feature commits, run `pnpm run install:local`, and restart only `codex-mobile-safe.service`; do not change or restart Tailscale Serve.
