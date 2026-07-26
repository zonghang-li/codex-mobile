# Current Conversation Page Desktop Parity Design

## Objective

Make the mobile current-conversation page present the same information, state
transitions, controls, and interaction outcomes as the Codex desktop client.
The layout remains responsive to a phone viewport, but mobile-specific
presentation must not change the meaning of an event or invent a different
workflow.

## Scope

This design covers the complete current-conversation page:

- conversation header and thread-level controls;
- user messages, assistant activity, final responses, and turn boundaries;
- reasoning summaries, commands, file operations, skill usage, image viewing,
  context compaction, plans, review findings, and generic tool activity;
- subagent lifecycle summaries without leaking subagent transcripts into the
  parent conversation;
- active-turn plan and file-change status above the composer;
- thread goals and their status/actions;
- approval and user-input requests;
- queued or steered messages;
- composer attachments, permissions, goal mode, model/effort/speed controls,
  dictation, submit, and stop behavior;
- responsive typography, spacing, colors, borders, and interaction affordances.

The sidebar, home page, settings, automation management, review page, and
standalone terminal interface are out of scope. Existing runtime synchronization,
notification, Tailnet/LAN, and safe-service behavior must remain unchanged
unless a current-conversation interaction depends on it.

## Source of Truth

Codex desktop behavior is the source of truth. The implementation uses observed
desktop event handling and component behavior rather than matching screenshots
with CSS alone.

Confirmed desktop rules include:

- the compact plan step is the first `in_progress` step, otherwise the first
  non-completed step, otherwise the last step;
- plan progress is the completed-step count divided by total steps;
- plan progress and file-change counts belong to a footer status pill above the
  composer, not to the scrollable message timeline;
- completed turns collapse activity behind `Worked for …` while leaving the
  final assistant response visible;
- goal state is driven by `thread/goal/updated` and `thread/goal/cleared`;
- permissions labels and enabled options reflect the actual runtime permission
  profile;
- pending approvals and questions are actionable state, not ordinary assistant
  text.

## Architecture

### 1. Conversation presentation projector

Introduce a pure presentation layer that converts normalized Codex messages and
runtime state into desktop-compatible view items. It owns:

- turn grouping and final-response selection;
- separation of parent activity from subagent activity;
- activity aggregation and desktop summary labels;
- completed-turn collapse state;
- suppression of transport-only and duplicate live/persisted items;
- stable keys so live updates do not reorder or duplicate visible content.

`ThreadConversation` renders the projected items and no longer independently
reinterprets each raw message type in scattered template branches.

### 2. Active-turn footer projector

Derive one `ConversationFooterState` from the current authoritative turn:

- current and total plan steps;
- completed-step percentage;
- changed-file, addition, and deletion counts;
- active goal summary and elapsed/budget text;
- whether each footer section is visible or actionable.

The resulting status pill is rendered outside the scroll container and inside
the composer stack. It stays immediately above the goal strip and composer as
the conversation scrolls. It updates from live events and disappears or changes
state only when authoritative turn/goal state changes.

Historical file-change summaries remain available inside completed-turn
activity. The live footer must not produce a second inline summary for the same
turn.

### 3. Desktop-compatible composer controller

The composer keeps one controller for text, attachments, queue/steer mode,
permissions, goal mode, model, effort, speed, dictation, submit, and stop.
Visible controls follow desktop ordering:

- left: add/attachment, permissions, goal;
- right: speed plus combined model/effort trigger, microphone, submit or stop.

Menus reuse existing capabilities but expose desktop labels, enabled states,
confirmation dialogs, and selection behavior. A control is never shown as
enabled when the backend cannot perform its action.

### 4. Goal controller

Normalize desktop goal fields and notifications into a thread-scoped goal
state. Support the desktop statuses `active`, `paused`, `blocked`,
`usageLimited`, `budgetLimited`, and `complete`, including objective truncation,
elapsed time or token budget, edit, pause/resume, clear, and expansion behavior.

If the connected Codex runtime does not advertise a required goal method, the
UI hides the unsupported mutation rather than simulating success. Read-only or
externally owned threads expose status without mutation controls.

## Presentation and Interaction Rules

### Running turn

- Activity appears in arrival order using desktop summary rows.
- Reasoning summary text updates in place.
- Commands, file edits, reads, skills, images, compaction, and tool calls use
  their desktop icon, label, completion state, and disclosure behavior.
- Subagent lifecycle is represented by neutral status chips/rows. It is not
  clickable when the desktop item has no action, and subagent transcript output
  never appears as parent assistant prose.
- The footer pill shows `Step n / total`, file count, additions, and deletions
  when those fields exist.
- The primary composer action is Stop while the turn is actively owned by this
  runtime; external ownership follows desktop read-only behavior.

### Completed or interrupted turn

- Activity collapses behind `Worked for …` or `You stopped after …`.
- The final assistant response remains expanded and is rendered with desktop
  typography and Markdown/code/math behavior.
- Expanding the divider reveals the exact activity items for that turn.
- Completion never depends on a page refresh; authoritative turn events update
  the timeline and composer immediately.

### Approvals and user questions

- A pending request uses its dedicated interactive UI and cannot be rendered as
  a raw tool-call waiting string.
- Available answers, approval scope, cancel behavior, disabled state, and
  submission feedback mirror desktop behavior.
- Answering or approving is idempotent. A stale or already-resolved request is
  removed after the backend confirms its state and does not leave the composer
  stuck.

### Mobile adaptation

- Desktop semantic order is preserved.
- Controls may truncate or move into the same associated menu when phone width
  is insufficient, but labels, selected values, and actions remain available.
- Typography uses the desktop client font stack and proportional/monospace
  roles at a mobile-appropriate size.
- The page cannot overflow horizontally or be dragged sideways.
- The composer and footer respect the visual viewport and safe-area inset when
  the software keyboard opens.

## Data Flow

1. The gateway and runtime bridge normalize Codex protocol notifications without
   assigning presentation meaning.
2. `useDesktopState` reconciles live and persisted items, runtime ownership,
   pending requests, turn state, plan state, diff state, and goal state.
3. Pure projectors create timeline items and footer/composer view models.
4. Page components render those view models and emit semantic user actions.
5. Controllers issue the matching Codex RPC, then update visible state only from
   the accepted response or authoritative notification.

This keeps display decisions out of transport code and prevents live/persisted
copies or one thread's state from leaking into another thread.

## Error Handling

- Unknown events remain available through a neutral fallback activity row and
  are not promoted to assistant prose.
- Malformed optional metadata is omitted without dropping the surrounding turn.
- Unsupported actions are hidden or disabled with an accurate reason.
- Failed mutations restore the previous visible state and show a concise error.
- Reconnect and resume rebuild projectors from authoritative thread data and
  preserve the draft, selected controls, and pending request state.
- Archived, inaccessible, or deleted threads follow the existing safe-home
  redirect behavior.

## Testing

### Pure unit tests

- turn grouping, final-response selection, and collapse boundaries;
- live/persisted deduplication;
- subagent isolation;
- desktop activity labels and disclosure capabilities;
- plan step selection and percentage;
- per-turn file-change aggregation;
- goal status and elapsed/budget formatting;
- composer action visibility and permission modes.

### Component tests

- running, completed, interrupted, external-owner, pending-approval, and pending
  user-input states;
- footer location outside the scroll container;
- footer live updates and completed-turn transition;
- `Worked for …` expansion;
- composer menu, submit/stop, queue/steer, approval, goal, and dictation
  interactions;
- narrow viewport, keyboard, safe-area, and horizontal-overflow behavior.

### Integration and regression tests

- refresh/reconnect while a desktop-owned turn is running;
- completion without refresh;
- goal update/clear notifications;
- stale pending-request resolution;
- existing notification, runtime ownership, five-thread loading, Tailnet/LAN,
  and safe-service behavior.

### Visual comparison

Capture the same conversation states at the same viewport dimensions and compare
the mobile implementation against the supplied Codex desktop references. Check
type scale, line height, icon size, spacing, borders, radii, footer ordering,
composer control order, keyboard behavior, and disclosure states. Browser-driven
visual QA requires the user's chosen browser permission before it is run.

## Acceptance Criteria

- The current-conversation page shows the same user-visible content categories
  as Codex desktop and does not leak child-agent transcripts.
- Running and completed states transition without manual refresh.
- Activity collapses on completion while the final response remains visible.
- The plan/file-change pill is always directly above the composer stack.
- Goal, approval, question, submit, stop, queue, and composer controls perform
  the same action and expose the same state as Codex desktop.
- Mobile width changes layout only; it does not change semantics.
- No existing runtime, notification, network-mode, or safe-service regression is
  introduced.
