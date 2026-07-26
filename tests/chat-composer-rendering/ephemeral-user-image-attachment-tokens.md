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

#### Expected Results

- User uploads render as compact, readable `@filename` tokens in both themes.
- Draft persistence and reloaded history contain no temporary upload path or local-image URL.
- The real image remains available through unsupported-model fallback and is deleted only after the final turn outcome.
- Managed attachments are never written into persistent queue state; a queue action sends them immediately.
- Removal, thread-switch discard, and final failed handoff also request deletion.
- Assistant-generated image previews are unchanged.

#### Rollback/Cleanup

- Remove any unsent attachment token and delete the local test image if it was created solely for this test.
