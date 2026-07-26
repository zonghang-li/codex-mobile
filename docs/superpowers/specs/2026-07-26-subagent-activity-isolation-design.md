# Codex Subagent Activity Isolation Design

## Goal

Match the Codex desktop client's subagent presentation while keeping the
mobile transcript focused on the parent task.

The target behavior is:

- show subagent lifecycle as compact, neutral status chips;
- group simultaneous subagents and share one lifecycle status label;
- never render a child agent's response text as parent assistant prose;
- keep the chips fully non-interactive;
- fold completed subagent activity with the rest of the completed turn's work;
- update subagent state without requiring a manual page refresh.

## Evidence

The design is grounded in:

- the supplied Codex desktop screenshot;
- the locally installed Codex 0.144.1 app-server TypeScript protocol;
- a real `thread/read` response from the screenshot task;
- the installed macOS ChatGPT/Codex client's packaged local-conversation
  renderer.

The app-server protocol exposes two relevant item families.

`subAgentActivity` contains:

- `id`;
- `kind`: `started`, `interacted`, or `interrupted`;
- `agentThreadId`;
- `agentPath`.

`collabAgentToolCall` contains:

- the action and call status;
- sender and receiver thread IDs;
- the spawn or follow-up prompt when present;
- `agentsStates`, keyed by child thread ID, with status and an optional
  child-agent message.

The desktop client:

- maps `started`, `interacted`, and `interrupted` to visible lifecycle states;
- groups activity by child thread ID;
- derives completion from `agentsStates`, completed waits, and the parent turn
  lifecycle;
- gives multiple subagents one shared suffix such as `started working`,
  `updated`, `interrupted`, or `finished`;
- keeps child-thread content separate from the parent transcript;
- uses a separate child-agent panel when navigation is enabled.

For hosted ChatGPT conversation data, the desktop client also excludes
assistant messages whose recipient is a specific agent rather than `all`.
This is the content-isolation rule the mobile implementation must preserve.

## Root Cause

The current mobile normalizer turns each `subAgentActivity` into an independent
system message but drops `agentThreadId`. The renderer then displays each event
as an unrelated row.

This causes four problems:

1. repeated events for one child cannot be reconciled;
2. simultaneous child agents cannot share a lifecycle status;
3. `interacted` is treated as a terminal-looking update even when the child is
   still running;
4. richer `collabAgentToolCall.agentsStates` cannot participate in completion
   decisions.

The live notification path also does not treat subagent items as content events,
so the parent task can remain stale until a later turn-level refresh.

## Chosen Approach

Implement protocol-aware aggregation in the frontend, keyed by
`agentThreadId`.

This is preferred over grouping by display name because names are not unique.
It is preferred over server-generated synthetic cards because the server
bridge should preserve app-server protocol data rather than own presentation
semantics.

This specification supersedes the `Subagent labels` rule and the
subagent-specific running-turn rendering described in
`2026-07-26-codex-desktop-activity-parity-design.md`. Other event,
typography, folding, and performance rules in that specification remain in
force.

## Data Model

Extend the normalized activity payload with:

- `agentThreadId`;
- `agentPath`;
- original subagent activity kind;
- normalized display name;
- lifecycle state.

Normalize `collabAgentToolCall` without placing its prompt or
`agentsStates.message` in assistant prose. Retain only the bounded metadata
needed to reconcile:

- action;
- call status;
- receiver thread IDs;
- per-agent status.

The optional child message may be retained in the raw diagnostic payload, but
it must never be copied into `UiMessage.text`, a transcript summary, a status
label, an accessibility label, or a notification.

## Lifecycle Reconciliation

Derive subagent state per parent turn using stable child thread IDs.

Status mapping:

- `pendingInit` → waiting;
- `running` → working;
- `completed`, `shutdown` → done;
- `interrupted` → interrupted;
- `errored`, `notFound` → failed.

Activity mapping:

- `started` establishes or reactivates the child;
- `interacted` records an update while keeping the child working unless a
  stronger state says otherwise;
- `interrupted` closes the child as interrupted.

Terminal inference:

- an explicit terminal `agentsStates` status wins;
- a completed `wait` closes still-working children represented by that wait;
- completion of the parent turn closes remaining children as done;
- a running parent turn never becomes finished merely because no newer child
  event has arrived.

Group status precedence:

1. interrupted or failed;
2. updated;
3. all children done → finished;
4. otherwise → started working.

Interrupted and failed are distinct terminal states. A failed group uses the
neutral status text `failed`; it does not display the child agent's optional
message as an explanation.

Each activity cluster is bounded by the parent turn and by ordinary transcript
content. Activity must never cross a user message, a final assistant response,
or a `Worked for …` boundary.

## Transcript Isolation

The parent transcript accepts only content owned by the parent thread.

Rules:

- never turn `agentsStates.message` into transcript text;
- never merge child `thread/read` items into the parent turn;
- when recipient metadata is available, exclude assistant content directed to
  a specific child agent;
- when parent/child thread metadata is available, require the item thread ID to
  match the requested parent thread ID;
- suppress a generic completed spawn row when the same operation is already
  represented by subagent chips;
- keep ordinary parent-agent commentary visible in its original order.

The isolation filter belongs before transcript rendering. CSS hiding is not
acceptable because it leaves child text in accessibility, copy, search, and
notification surfaces.

## Presentation

### Activity row

One cluster renders as:

- one neutral pill per visible child agent;
- one shared status label after the pills;
- horizontal wrapping when the row does not fit the mobile viewport.

The pill contains:

- a small icon from the project's existing icon library;
- the humanized leaf name from `agentPath`;
- single-line truncation.

The icon and pill use low-contrast neutral colors close to the surrounding
surface. They do not use per-agent accent colors. Light and dark themes use the
existing surface and secondary-text tokens rather than new hard-coded colors.

### Interaction

Subagent pills are display-only:

- render with `div` and `span`, not `button` or `a`;
- no click handler;
- no pointer cursor;
- no tab stop;
- no hover-only affordance;
- no child-thread panel or navigation.

### Completed turns

Subagent activity remains part of the work stream. When the parent turn
completes, it folds beneath `Worked for …` with reasoning, commands, tools, and
file activity. The final parent assistant response stays visible outside the
fold.

## Realtime Updates

Recognize `subAgentActivity` and `collabAgentToolCall` in item lifecycle
notifications.

For the selected parent thread:

- normalize the item immediately when the payload is complete enough; or
- schedule a debounced authoritative `thread/read` refresh when only partial
  notification data is available.

For an unselected parent thread:

- refresh bounded thread state without selecting or opening it;
- do not treat child-agent completion as parent-task completion;
- preserve the existing parent turn/unread authority rules.

Background browser suspension remains unchanged. Visibility resume performs one
authoritative catch-up read.

## Testing

### Normalizer tests

- retain `agentThreadId`, path, kind, and display name;
- normalize all collaboration agent statuses;
- prove `agentsStates.message` never becomes visible text;
- preserve unrelated parent assistant messages.

### Aggregation tests

- one child: started → updated → finished;
- two children starting together share `started working`;
- one child finishing while another runs remains active;
- interrupted and failed states take precedence;
- duplicate display names remain separate by thread ID;
- a completed wait and parent-turn completion close only the applicable group;
- activity never crosses turn or transcript boundaries.

### Component tests

- render multiple neutral pills and one shared status;
- render no `button`, link, click handler, or tab stop;
- suppress duplicate generic spawn rows;
- fold completed activity below `Worked for …`;
- keep the final parent response visible;
- confirm no child response text appears in DOM, accessible text, copied text,
  or notification inputs.

### Realtime tests

- subagent item notifications trigger bounded reconciliation;
- status updates appear without manual refresh;
- child completion does not complete the parent turn;
- resuming a hidden tab catches up exactly once.

### Visual verification

Compare the real mobile task with the supplied desktop screenshot in both
themes. Verify:

- pill radius, spacing, typography, truncation, and shared suffix;
- neutral icon and surface treatment;
- wrapping without horizontal page drag;
- no interactive affordance;
- no child transcript content in the parent task.

## Scope

This change affects only subagent event normalization, lifecycle aggregation,
transcript isolation, activity rendering, and related realtime refreshes.

It does not expose child conversations, add navigation, change execution,
modify approval behavior, alter notification policy, or change network
exposure.
