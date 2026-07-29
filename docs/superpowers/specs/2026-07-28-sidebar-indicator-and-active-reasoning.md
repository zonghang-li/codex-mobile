# Sidebar Indicator and Active Reasoning Design

## Scope

Fix two mobile conversation-page state inconsistencies:

1. The top-left sidebar button can keep a blue dot after the visible thread-row
   unread dots disappear.
2. The last running turn can show only compact reasoning activity plus one
   repeatedly replaced reasoning line instead of the turn's complete reasoning
   transcript.

## Sidebar indicator semantics

Thread-row state has one canonical priority:

1. `awaiting-approval`
2. `awaiting-response`
3. `working`
4. `unread`
5. `idle`

The top-level sidebar button must derive its dot from that same state resolver.
It is active for `awaiting-approval`, `awaiting-response`, and `unread`. It is
inactive for `working` and `idle`. Hidden, collapsed, and later-directory-page
threads still participate because the button represents the full loaded
sidebar directory rather than only currently rendered rows.

## Running-turn reasoning semantics

Only the last running turn exposes reasoning as transcript text. Historical or
completed-turn reasoning remains hidden.

The recent-turn RPC projection may compress raw items for both locally owned
and externally owned running turns. The client therefore detects compression
on the active turn in either projection and hydrates its text-only rollout
pages. Hydration retains ordered `reasoning`, `agentMessage`, and
`contextCompaction` items without transferring large tool outputs.

Realtime reasoning deltas accumulate for the full running turn. Starting an
agent message must not erase earlier reasoning; starting a later reasoning item
adds a paragraph boundary. Completion clears the transient live overlay after
the persisted final output is reconciled.

## Verification

- Unit-test the shared sidebar state resolver and aggregate dot predicate.
- Unit-test locally owned compressed active-turn hydration.
- Unit-test local and external active-turn reasoning transcript visibility.
- Unit-test realtime reasoning across an intervening agent message.
- Run the full unit suite, production build, service restart, and browser
  verification.
