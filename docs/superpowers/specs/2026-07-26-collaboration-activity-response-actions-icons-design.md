# Collaboration Activity, Response Actions, and Activity Icons

Date: 2026-07-26

## Goal

Bring three parts of the mobile conversation page back in line with Codex
Desktop:

- show parent-task coordination summaries such as
  `Sent message to chat, wait threads`;
- hide Copy and Fork for the active, unfinished response, then show compact
  icon-only actions after completion;
- use activity icons whose meaning matches the desktop client.

This change does not add Like or Dislike actions. Their screenshot is only a
visual reference for the transparent icon-button treatment.

## Root Cause

The authoritative rollout contains parent coordination function calls such as
`send_message`, `followup_task`, `wait_agent`, and `list_agents`. A read-only
app-server does not return all of those calls as thread items. It returns some
calls only as `subAgentActivity`, while omitting repeated wait calls.

The mobile session-recovery layer currently restores command executions and
file changes only. As a result, the parent coordination activity is absent
before normalization and cannot be rendered.

Separately, response actions are derived from copyable assistant text and a
turn index without checking whether that turn is still active. Their current
text labels, Copy pill, and Fork-before-Copy order differ from the desktop
toolbar.

Finally, activity presentation collapses most rows into only Search, Terminal,
File Pencil, or Bolt. That is too coarse to represent desktop meanings such as
Read files and Used CodeGraph integration.

## Design

### Safe coordination activity recovery

Extend session item recovery with a bounded allowlist of parent coordination
function names. Recover only the call ID and semantic activity kind; never
copy arguments, prompts, child output, or thread messages.

Supported aliases cover both the current and newer names:

- `send_message` and `send_message_to_thread`;
- `followup_task`;
- `wait_agent` and `wait_threads`;
- `list_agents`.

`spawn_agent` remains represented by the existing subagent lifecycle chip.

When a recovered send or follow-up call has the same call ID as an existing
`subAgentActivity` interaction item, replace that interaction item with the
parent coordination activity. This prevents a duplicate “updated” chip.
Recovered waits that have no app-server item are inserted at their original
position relative to assistant messages.

Normalize these items as typed `collaborationActivity` messages. Adjacent
coordination messages are rendered as one neutral activity row. Duplicate
labels are removed while retaining order, producing text such as:

`Sent message to chat, wait threads`

The row is part of normal turn activity. It remains visible while the turn is
running and folds under `Worked for…` after completion.

### Response action visibility and styling

Suppress Copy and Fork when their response belongs to the active turn. If
runtime evidence says a task is active but no authoritative active turn ID is
available, fail closed and suppress response actions until completion is
confirmed.

For completed responses:

- order actions as Copy, then Fork;
- render icon-only controls with accessible labels and titles;
- use transparent backgrounds and no persistent border or pill;
- keep a subtle hover/focus treatment on pointer devices;
- retain at least a 44-by-44-pixel touch target on coarse pointers;
- communicate Copy success through accessible state and a temporary icon tone,
  without adding visible text.

No Like or Dislike behavior is added.

### Semantic activity icons

Expand the activity icon model instead of choosing icons from message text.
The normalized activity type and command categories determine the icon:

- read-only file activity and Read files: open book;
- search and web search: magnifier;
- file edits: file pencil;
- command execution: terminal;
- CodeGraph, MCP, dynamic tools, and collaboration integrations: connected
  nodes;
- image view or generation: image;
- subagent lifecycle: agent/status icon;
- unknown status activity: neutral status icon.

Mixed action summaries keep the highest-impact desktop convention: edit first,
then read/search, then command.

The new icons extend the project's existing local Tabler-style icon system and
inherit `currentColor`, line weight, size, and muted activity-row styling.

## Data Flow

1. Read the rollout through the existing bounded session cache.
2. Convert allowlisted coordination function calls to safe recovered items.
3. Merge recovered items into the matching turn without duplicating existing
   app-server items.
4. Normalize recovered items into presentation-safe activity messages.
5. Aggregate adjacent coordination activity and select semantic icons.
6. Render active activity immediately; use the existing completed-turn folding
   behavior after terminal reconciliation.

## Failure Handling and Safety

- Unknown function names are ignored.
- Missing or malformed call IDs are ignored.
- Arguments and outputs are never placed in recovered activity items.
- Recovery failure leaves the original thread result unchanged.
- Existing subagent transcript isolation remains unchanged.
- Active-state uncertainty hides response actions rather than exposing a Fork
  action against an unfinished turn.

## Verification

Automated tests cover:

- recovery, ordering, deduplication, alias mapping, and payload redaction;
- normalization and adjacent label aggregation;
- replacement of matching interacted subagent items without affecting started
  subagent chips;
- active-turn and unknown-active-state action suppression;
- completed-response Copy-before-Fork ordering and icon-only markup;
- semantic icon selection for Read files and CodeGraph integration;
- completed-turn folding of recovered coordination activity;
- full unit suite, type checking, production build, and CLI doctor.

After deployment, compare the mobile conversation against the supplied desktop
screenshots and verify that the Tailnet endpoint still uses password protection
and `approval-policy=never`.
