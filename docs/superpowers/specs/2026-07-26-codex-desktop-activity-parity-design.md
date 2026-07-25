# Codex Desktop Activity and Typography Parity Design

## Goal

Make the mobile browser present the same meaningful task content and lifecycle
as the Codex desktop client while preserving mobile-friendly interaction.

The target behavior is:

- show reasoning summaries, commands, file changes, tool activity, subagent
  activity, plans, images, and compaction events in their original order;
- summarize each run of work between assistant messages with the same semantic
  vocabulary used by the desktop client;
- keep command output, file diffs, images, and other details available on tap;
- collapse completed-turn activity under `Worked for …`, leaving the final
  assistant response visible by default;
- use the platform system text face used by the desktop client and reduce the
  mobile conversation text size and line spacing.

Exact proprietary desktop implementation details are not available. This design
is grounded in the local Codex 0.144.1 app-server generated TypeScript protocol,
raw `thread/read` data from the same task shown in the supplied screenshots,
and the observed desktop rendering.

## Evidence and Root Cause

Codex app-server models a task as ordered turns containing ordered `ThreadItem`
values. The local generated protocol includes:

- `reasoning`;
- `commandExecution` with best-effort `commandActions`;
- `fileChange`;
- `mcpToolCall` and `dynamicToolCall`;
- `collabAgentToolCall` and `subAgentActivity`;
- `webSearch`, `imageView`, `imageGeneration`, and `sleep`;
- `plan`;
- `contextCompaction`.

The screenshot task contains `subAgentActivity` records with paths such as
`/root/updated_docs_coverage_review` and
`/root/updated_plan_command_review`. These are the source of the desktop chips
such as “Updated docs coverage…” and “Updated plan command…”. The mobile
normalizer currently drops this item type.

The same task also contains restored `commandExecution` records without
`commandActions`. The desktop client still summarizes those runs as reading,
searching, or running commands, while mobile falls back to the literal command
text and only groups adjacent command rows.

Finally, mobile renders body copy at `16px` with a fixed `32px` line height and
does not explicitly set the client-style system font stack. This creates the
oversized, sparse appearance in the supplied mobile screenshot.

## Chosen Approach

Build protocol-aware activity presentation in three layers:

1. Normalize every user-visible app-server item into a typed mobile UI event.
2. Derive desktop-style activity segments from the ordered UI event stream.
3. Render a responsive desktop-style presentation without discarding the
   existing detail viewers.

This is preferred over a CSS-only change because missing events would remain
missing. It is also preferred over synthesizing desktop phrases in the server
bridge because server-side synthesis would lose presentation context and could
duplicate events when richer app-server fields become available.

## Event Normalization

### Supported events

Extend the v2 normalizer and UI message types for:

- `subAgentActivity`;
- `dynamicToolCall`;
- `sleep`;
- `imageGeneration`;
- any currently supported event whose useful metadata is not yet retained.

Known user-visible event types must not be silently discarded. A future unknown
item that is explicitly marked as user-visible by the app-server integration
should become a neutral activity row with a safe label rather than raw JSON.
Unknown payloads must not expose credentials or unbounded tool output.

### Subagent labels

Convert `agentPath` to a readable title:

- remove the leading hierarchy such as `/root/`;
- replace underscores and repeated separators with spaces;
- preserve useful abbreviations;
- sentence-case the result;
- retain `agentThreadId` for identity and future navigation.

Map activity kinds to compact status labels:

- `started` → `started`;
- `interacted` → `updated`;
- `interrupted` → `interrupted`.

Repeated updates remain ordered events. They are not globally deduplicated
because the desktop transcript shows the same subagent at multiple points in a
turn.

### Command action fallback

Use official `commandActions` whenever present. For restored external sessions
where they are absent, apply a deterministic, conservative classifier to each
shell segment:

- file reads: `cat`, `sed -n`, `head`, `tail`, and other clearly read-only file
  inspection commands;
- file listing: `ls`, `find`, and `rg --files`;
- search: `rg`, read-only `grep`, and equivalent search commands;
- unknown: everything else.

Pipelines and compound commands can contribute more than one category. The
fallback never changes execution behavior; it only produces presentation
metadata. Ambiguous commands stay `unknown`.

## Activity Segmentation

Create a pure activity-model module that consumes ordered `UiMessage` values.
An activity segment is bounded by user messages, assistant prose messages,
completed-turn separators, and task boundaries.

Within each segment:

- commands retain their original order and expansion state;
- file changes retain their paths, operation, and diff metadata;
- subagent activity retains its identity and status;
- reasoning, compaction, plans, images, searches, and tools retain their order;
- a compact summary is derived from the contained actions.

Summary grammar follows the desktop vocabulary:

- `Edited a file` / `Edited files`;
- `Read a file` / `Read files`;
- `Searched files`;
- `Ran a command` / `Ran commands`;
- comma-separated combinations such as
  `Edited files, read files, ran a command`.

The summary is derived only from the events in that segment. It must not merge
events from another assistant update or another turn.

## Rendering and Lifecycle

### Running turn

Render, in source order:

- reasoning summary lines;
- compact activity summaries;
- subagent chips;
- plan and compaction status rows;
- images and tool-specific rows;
- assistant progress prose.

The compact summary row is the default surface. Tapping it reveals the ordered
command and file details. Existing command output truncation and file diff
viewers remain in use.

### Completed turn

The authoritative completion signal remains the app-server turn lifecycle, not
the presence of assistant prose or file changes.

When a `Worked for …` separator is present:

- fold all reasoning and activity belonging to that turn beneath it;
- keep the final assistant response outside the fold and visible;
- default the fold to closed;
- preserve expansion state while the task remains open;
- do not move activity across user-message or turn boundaries.

### In-progress and failed events

- Running commands and tools show an active state without being labeled done.
- Interrupted and failed items retain their failure state in the details.
- A failed event does not mark the whole task complete.
- If the lifecycle is uncertain, keep the task visually running until the
  existing backend reconciliation confirms completion.

## Typography and Responsive Styling

Set the application text stack to:

```css
system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text",
"PingFang SC", "Segoe UI", sans-serif
```

On iOS this selects San Francisco with the platform Chinese fallback. On other
platforms it uses their native system UI face. Code, commands, paths, and inline
code keep the existing monospace stack.

Mobile conversation sizing:

- body and list text: `15px` with `24px` line height;
- activity rows: `14px` with approximately `22px` line height;
- compact command and status rows: `13px` to `14px`;
- headings scale down one step from their desktop sizes;
- composer inputs remain at least `16px` to prevent iOS focus zoom.

Desktop sizing remains unchanged except for inheriting the explicit system font
stack.

## Performance

Activity derivation must be a linear pass over the currently loaded message
window. It must:

- make no new API requests;
- not scan unloaded history;
- avoid deep-watching command output text;
- use stable event IDs for Vue keys;
- keep command output and diff content collapsed until requested;
- preserve the existing bounded render window and payload truncation.

The implementation should expose the pure segment builder to unit tests and
reuse its result from a computed value rather than repeatedly scanning the
message list during template rendering.

## Testing

### Unit tests

- normalize representative `subAgentActivity`, `dynamicToolCall`, `sleep`, and
  image-generation items;
- preserve subagent identity, order, and readable labels;
- classify restored commands with and without official `commandActions`;
- build activity segments from a fixture matching the supplied screenshot;
- prevent grouping across assistant, user, worked, and turn boundaries;
- preserve the final answer outside completed activity;
- retain failed and interrupted activity status.

### Component tests

- show subagent chips and desktop-style activity summary rows;
- allow summary expansion to reveal command output and file-change details;
- fold completed activity beneath `Worked for …`;
- keep running activity visible before completion;
- verify system font and mobile text-size wiring while preserving 16px composer
  inputs.

### Browser verification

Use the current local service and the screenshot task at:

- `375x812`;
- `768x1024`;
- light theme;
- dark theme.

Verify the real conversation route, not a static mock. Capture evidence that:

- the supplied screenshot sequence is represented without missing event types;
- the completed state folds activity and leaves the final answer visible;
- command/file details remain usable;
- text is smaller and uses the system stack;
- no horizontal page drag or clipping returns.

### Performance audit

Record the number of API requests, total thread payload size, duplicate request
counts, and bundle output. Confirm that the change adds no polling or
thread-history requests and that activity segmentation remains bounded by the
rendered message window.

## Scope

This change does not attempt to copy proprietary desktop source code or exact
pixel values unavailable to the project. It aligns observable behavior,
semantic content, event ordering, lifecycle folding, and the native system
typography shown by the desktop client.

It does not change task execution, approvals, sandbox policy, notification
behavior, network exposure, or app-server persistence.
