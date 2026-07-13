# External Runtime Process Detection Correction

Date: 2026-07-13
Branch: `codex/fix-appserver-process-detection`

## Problem

The external-thread runtime probe currently has two opposing process-identification defects:

1. It recognizes only command lines shaped like `codex app-server`. The desktop application actually launches the binary as `codex -c ... app-server --listen unix://`, so a real external writer can be ignored and an active thread reported as `idle`.
2. The mobile bridge excludes only the PID returned by the Node launcher. The native Codex app-server is a descendant of that launcher, so its file descriptors can be mistaken for an external writer.

Production evidence showed both cases at once. Thread `019f50f7...` had an unmatched `task_started`, a continuously growing rollout, and a desktop writer at the file end, but the endpoint returned `idle` because the desktop command placed `-c` before `app-server`. Thread `019f565b...` returned `running`, but the existing matcher was also accepting the mobile bridge's native child because only its wrapper PID was excluded.

## Goals

- Recognize supported Codex app-server argv layouts without broad substring matching.
- Exclude the mobile bridge's complete launcher descendant chain from external-writer evidence.
- Preserve the existing two-factor decision: an unmatched lifecycle turn plus a live, same-UID, writable descriptor for the exact rollout identity.
- Keep non-Linux and inconclusive `/proc` behavior conservative (`unknown`).
- Add regression tests based on the two command/process layouts observed in production.

## Non-goals

- Cross-machine runtime detection.
- Cross-app-server interruption.
- Changing polling cadence, UI behavior, authentication, Tailscale exposure, or session lifecycle parsing.
- Treating file modification time alone as proof of a running turn.

## Design

### Command recognition

Parse `/proc/<pid>/cmdline` as NUL-delimited argv. A process qualifies as a Codex app-server only when:

- one argv token has basename exactly `codex`; and
- a later argv token is exactly `app-server`.

Arguments may appear between those tokens, which accepts both observed forms:

- `codex app-server -c ...`
- `codex -c ... app-server --listen unix://`

Names such as `codex-wrapper`, `my-codex`, or a free-form string merely containing `codex app-server` remain rejected.

### Launcher-descendant exclusion

Each `/proc` process snapshot records its PID and parent PID. Before matching descriptors, the Linux scan builds a process-parent map for the same `/proc` snapshot. For every candidate writer it walks the parent chain with a cycle/depth guard.

A candidate is excluded when its PID is the mobile launcher PID or any ancestor chain reaches that PID. A sibling app-server and a separately launched desktop app-server remain eligible. If ancestry cannot be parsed reliably for a candidate, the scan is inconclusive rather than treating that candidate as external evidence.

The exclusion stays independent of command recognition: a mobile native child must remain excluded even though its argv otherwise qualifies.

### Existing evidence retained

After command and ancestry validation, the existing writer checks remain unchanged:

- UID equals the bridge UID;
- descriptor dev/ino equals the trusted rollout file;
- descriptor access mode is writable;
- descriptor position is positive;
- the rollout parser has a non-empty unmatched turn ID.

The existing canonical sessions-root containment, regular-file check, opened-file identity validation, incremental cache/checkpoint logic, and `unknown` failure semantics remain intact.

## Data flow

1. Read a stable list of `/proc` numeric entries.
2. Read UID, PPID, and cmdline metadata and build the parent map.
3. Select same-UID processes whose argv represents a Codex app-server.
4. Enumerate their descriptors and produce snapshots with ancestry evidence.
5. Parse the registered rollout lifecycle incrementally.
6. Return `running` only for an unmatched turn plus an eligible writer outside the mobile launcher tree; otherwise return `idle`, or `unknown` when required evidence is unreadable.

## Error handling and safety

- Disappearing processes/descriptors remain normal races and are skipped.
- Permission failures or malformed UID/PPID/fdinfo remain inconclusive.
- Parent cycles and excessive ancestry depth are treated as inconclusive.
- No PID, command line, path, or password is exposed through the public runtime endpoint.
- The change does not broaden HTTP routes or network exposure.

## Testing

Tests must be written and observed failing before production code changes.

Unit regressions:

- accepts `codex app-server`;
- accepts `codex -c value app-server --listen unix://`;
- rejects codex-like basenames and `app-server` appearing before `codex`;
- excludes a direct mobile launcher child;
- excludes a deeper mobile launcher descendant;
- still accepts a sibling/separate desktop app-server;
- malformed or cyclic ancestry fails conservatively;
- the full probe still requires lifecycle, UID, dev/ino, writable mode, and positive position evidence.

Verification:

- focused external-runtime probe tests;
- complete unit suite and production build;
- live host diagnostic against the two currently active rollout files: the long-running desktop thread must become `running`, while the mobile launcher descendants must not be the evidence source;
- fresh mobile-sized browser check must show the disabled external-running stop control for the affected thread;
- safe doctor, loopback-only listener, and tailnet-only Serve state must remain unchanged after deployment.

## Rollout

Implement on the isolated branch, review the diff, merge by fast-forward into `main`, push `origin/main`, reinstall locally, and restart `codex-mobile-safe`. During restart, preserve the existing password file and Tailscale Serve configuration. If live validation does not distinguish the desktop writer from the mobile descendant, do not claim the bug fixed and do not proceed to the sidebar blue-dot task.
