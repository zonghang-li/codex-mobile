### Feature: Ephemeral user image attachment tokens

#### Prerequisites

- Run the current dev server and open a writable test thread.
- Have a small local PNG or JPEG that can be deleted after the test.

#### Steps

1. In light theme, attach the image from the composer.
2. Confirm the composer shows `@<filename>` with a remove button and no thumbnail.
3. Remove it, attach it again, type a short request, and send.
4. If another turn is already running, choose queue and confirm the attachment is sent immediately instead of entering the persistent queue.
5. Wait for the turn (including any unsupported-model fallback) to finish and reload the thread.
6. Confirm the user message still shows the `@<filename>` text but no user image preview.
7. Confirm any assistant-generated image in the same thread still renders normally.
8. In dark theme, repeat attachment and removal, then switch to another thread without sending.
9. From the new-chat screen, attach an image and send the first turn; before the first server reconciliation, confirm the optimistic user row contains only `@<filename>` text and no image preview.
10. Simulate a transient `408`, `502`, `503`, `504`, network, or invalid-response failure from `turn/start`; confirm the `@<filename>` row remains visible and the image remains readable when the accepted turn later starts.
11. Repeat with Stop clicked while resume is still pending; confirm the cancelled pre-start upload is deleted once.
12. Retry cleanup for the same accepted upload twice and restart the mobile server between two cleanup attempts; confirm both valid cleanup requests succeed and no arbitrary sibling path is removed.

#### Expected Results

- User uploads render as compact, readable `@filename` tokens in both themes.
- Draft persistence and reloaded history contain no temporary upload path or local-image URL.
- The real image remains available through unsupported-model fallback and is deleted only after the final turn outcome.
- An ambiguous `turn/start` response retains submission ownership until a later
  terminal event confirms whether Codex accepted the image.
- Managed attachments are never written into persistent queue state; a queue action sends them immediately.
- Removal, thread-switch discard, and final failed handoff also request deletion.
- Assistant-generated image previews are unchanged.
- New-thread optimistic rows follow the same text-only token rule before their first persisted `thread/read`.
- Valid cleanup is idempotent across sequential retries and server restart; expired uploads are reaped later without following symlinks or accepting guessed paths.

#### Rollback/Cleanup

- Remove any unsent attachment token and delete the local test image if it was created solely for this test.
