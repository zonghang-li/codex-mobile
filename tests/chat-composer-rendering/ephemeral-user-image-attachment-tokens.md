### Feature: Ephemeral user image attachment tokens

#### Prerequisites

- Run the current dev server and open a writable test thread.
- Have a small local PNG or JPEG that can be deleted after the test.

#### Steps

1. In light theme, attach the image from the composer.
2. Confirm the composer shows `@<filename>` with a remove button and no thumbnail.
3. Remove it, attach it again, type a short request, and send.
4. Wait for `turn/start` to be accepted and reload the thread.
5. Confirm the user message still shows the `@<filename>` text but no user image preview.
6. Confirm any assistant-generated image in the same thread still renders normally.
7. In dark theme, repeat attachment and removal, then switch to another thread without sending.

#### Expected Results

- User uploads render as compact, readable `@filename` tokens in both themes.
- Draft persistence and reloaded history contain no temporary upload path or local-image URL.
- The real image is available to the model during the turn, then its server-managed temporary upload is deleted.
- Removal, thread-switch discard, and failed send also request deletion.
- Assistant-generated image previews are unchanged.

#### Rollback/Cleanup

- Remove any unsent attachment token and delete the local test image if it was created solely for this test.
