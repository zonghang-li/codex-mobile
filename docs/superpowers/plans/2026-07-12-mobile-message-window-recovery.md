# Mobile Message Window Recovery Implementation Plan

> Superseded. Do not execute the old local render-window plan.

The current requirement is:

- Load all turns returned by the backend.
- Do not hide already-loaded middle turns behind a client-side message window.
- Prune historical `reasoning` items outside the latest running turn.
- For completed historical turns, show user content and the final assistant reply by default, not intermediate assistant progress updates.
- Use `Load earlier messages` only when the backend explicitly reports older persisted turns that were not returned in the current payload.

The earlier implementation plan for a fixed-size local message window was intentionally removed because it caused long histories to appear as if middle turns were missing.
