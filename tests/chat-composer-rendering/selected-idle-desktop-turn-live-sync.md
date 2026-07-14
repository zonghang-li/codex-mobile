### Selected idle desktop turn live sync

#### Prerequisites

- Install and run the current `codex-mobile-safe` checkout on `127.0.0.1:5900`.
- Keep Tailscale Serve Tailnet-only and open the HTTPS URL on the phone.
- Have the same idle task visible in Codex desktop and selected in mobile Chrome.

#### Steps

1. Leave the task selected and idle on mobile.
2. Send a new prompt in that task from Codex desktop.
3. Without refreshing mobile, wait one normal two-second discovery cycle.
4. Confirm mobile changes to running and shows the desktop input, detailed reasoning summary, and output.
5. Confirm runtime discovery stops for the selected task after external detail polling starts.
6. Background mobile Chrome, advance the desktop turn, and confirm no mobile requests occur while hidden.
7. Foreground Chrome and confirm one immediate probe or detail refresh catches up.
8. Finish the desktop turn and confirm final output appears before the running state clears.

#### Expected Results

- The idle-to-running transition and messages appear without reload.
- Runtime and detail requests never overlap within their respective pollers.
- Local turns remain interruptible; desktop-owned turns remain non-interruptible.
- No authentication, Tailnet exposure, or completion-notification behavior changes.

#### Rollback/Cleanup

- Finish or interrupt the test task from its owning desktop client.
- Revert the selected-idle candidate and handoff commit to restore the previous polling behavior.
