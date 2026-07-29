# Active-turn reasoning history design

## Problem

An externally owned running Codex turn can contain many ordered reasoning
items interleaved with tool, command, collaboration, subagent, and context
compaction activity. The server already preserves every reasoning item in the
active turn and removes reasoning only from historical turns.

The mobile client currently converts those active-turn reasoning items into an
`ExternalReasoningSnapshot`. That snapshot:

1. records every reasoning message ID as hidden;
2. keeps only the last non-empty paragraph from the newest reasoning item; and
3. replaces that label whenever the next snapshot arrives.

As a result, the conversation shows the surrounding activity but only one
reasoning sentence at a time. Earlier reasoning from the same active turn is
present in the response but intentionally hidden by the frontend.

## Expected behavior

- The last running turn displays all of its reasoning items in source order.
- New reasoning appends a new visible row and never replaces an older row.
- Tool calls, commands, collaboration events, subagent status, image activity,
  file activity, and context compaction remain interleaved in source order.
- The running indicator does not duplicate the newest visible reasoning row.
- When the turn completes, its internal activity is folded under the existing
  `Worked for…` control, matching the completed-turn behavior.
- Reasoning from every older historical turn remains pruned. Historical turns
  continue to show their user and final response content without reasoning.
- Refresh, polling, and reconnect use the server snapshot as the source of
  truth. They must neither duplicate nor discard reasoning items.

## Chosen approach

Render the active turn's persisted reasoning messages directly.

The server-side pruning boundary remains unchanged: it preserves every item in
the active running turn and removes reasoning from non-active turns. The
frontend stops treating active-turn reasoning IDs as hidden and lets the
existing ordered activity projection render one reasoning segment per message.

The external live overlay becomes only a transient running-state fallback. It
may show a generic activity state when no persisted activity is available, but
it must not mirror the latest persisted reasoning text.

This approach is preferred over accumulating overlay text or maintaining a
separate browser-side reasoning history. Those alternatives lose authority
across refreshes, can duplicate snapshot data, and cannot reliably reconstruct
events produced by another Codex client.

## Data flow

1. `thread/read` and the live snapshot endpoint return all turns.
2. Server pruning removes reasoning from non-active turns while retaining all
   items in the active running turn.
3. The normalizer converts each retained reasoning item into a stable
   `UiMessage` with its source item ID and turn ID.
4. External snapshot reconciliation may derive a fallback running label, but
   it does not return or accumulate hidden reasoning IDs.
5. The selected-thread message list includes every retained active-turn
   reasoning message.
6. `buildThreadActivitySegments` emits one reasoning activity segment per
   message, preserving its order relative to other activity.
7. Existing completed-turn projection folds those activity messages only
   after a terminal turn state and `Worked for…` boundary exist.

## State and merge rules

- Source item IDs are the deduplication identity.
- A newer snapshot replaces the authoritative persisted message array through
  the existing reconciliation path; the UI does not append a second copy.
- Same-turn fallback state may preserve the last generic activity label while
  a snapshot is temporarily empty, but it never hides persisted messages.
- A turn change clears the previous external fallback state.
- Local notification streaming remains unchanged. This fix targets the
  externally owned or refresh-restored active-turn path that currently hides
  reasoning messages.

## UI behavior

- Active reasoning is rendered using the existing client-style reasoning
  activity row rather than a large combined text panel.
- Each reasoning item remains a separate chronological row.
- The live overlay shows only a non-duplicating running fallback such as
  `Thinking` when needed.
- No new expand/collapse control is added for an active turn.
- Completion continues to use the existing `Worked for…` folding interaction.

## Error and recovery behavior

- If a live read fails and a successful snapshot is available, the fallback
  uses the same active-turn reasoning retention rules.
- If no active turn can be identified, reasoning remains treated as historical
  and is pruned rather than exposed speculatively.
- Repeated snapshots with unchanged item IDs must be visually stable.
- A partial snapshot cannot erase previously rendered reasoning merely because
  the transient fallback label is empty; the existing authoritative snapshot
  fallback remains responsible for preserving the last successful detail.

## Test strategy

Add focused regression coverage before production changes:

1. An external active turn with multiple reasoning items exposes all reasoning
   IDs instead of returning them as hidden.
2. Two consecutive snapshots add a new reasoning item without replacing or
   duplicating earlier items.
3. Reasoning remains ordered around CodeGraph/tool activity, subagent activity,
   and context compaction.
4. The live overlay does not repeat the latest persisted reasoning label.
5. Completed-turn projection still folds internal activity under `Worked for…`.
6. Server tests continue to prove that historical turns lose reasoning while
   the active turn retains every reasoning item.
7. Refresh/reconciliation tests cover an externally owned running turn.

Run the focused composable, external snapshot, activity projection, normalizer,
and live snapshot suites, then the complete unit suite and production build.
After deployment, refresh a running external session and verify that existing
reasoning remains visible while new reasoning appends in order.

## Non-goals

- Loading reasoning for completed historical turns.
- Changing the Codex server protocol or session logs.
- Reformatting command, tool, subagent, or compaction rows.
- Changing notification frequency, polling cadence, or completion detection.
- Refactoring unrelated upload lifecycle work currently present in the main
  checkout.
