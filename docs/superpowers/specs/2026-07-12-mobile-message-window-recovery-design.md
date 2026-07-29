# Mobile Message Window Recovery Design

> Superseded by the full-history loading requirement: mobile should render every
> already-loaded non-hidden message, while historical reasoning is pruned
> server-side and completed-turn intermediate assistant progress is hidden from
> the default transcript. A client-side 50-message render window must not be
> reintroduced.

## Problem

On long, actively updating threads, the mobile conversation can show only the `Load earlier messages` control. The backend still returns messages and older-turn pagination succeeds, but `ThreadConversation` slices the message array from a stale `renderWindowStart`. When that index is at or beyond the shortened array length, the visible slice is empty while `hasMoreAbove` remains true. Repeated clicks may still leave the index out of range.

## Desired behavior

- A non-empty message array must render all already-loaded user/final-assistant messages after hidden metadata/reasoning/progress filtering.
- `Load earlier messages` is reserved for older persisted turns that the backend explicitly reports as not yet loaded.
- New messages may continue arriving, but they must not reset the manually expanded window or move the reader to the bottom.
- `Jump to latest` explicitly restores automatic following and scrolls to the latest message.
- Persisted older-turn pagination, scroll restoration, command grouping, and file-change grouping remain unchanged.

## Design

Keep render-window arithmetic normalized to `0`. `visibleMessages` must be the filtered renderable message list, not a slice of that list, so stale asynchronous state cannot hide middle turns.

When `loadMoreAbove` begins, it sets `autoFollowOutput` to `false` before awaiting persisted pagination. This preserves the current reading position across subsequent message updates. The existing scroll-height compensation remains responsible for keeping the same content in view after prepending messages.

`jumpToLatest` remains the explicit transition back to automatic following. It sets `autoFollowOutput` to `true` and scrolls to the bottom.

## Testing

Add focused unit tests for the pure render-window helper:

1. an oversized stale index is clamped so a non-empty array cannot render zero rows;
2. an empty array resolves to index zero;
3. expanding toward older messages remains at `0`;
4. the latest-window calculation remains at `0` so all loaded history is visible.

Add a static component wiring assertion that loaded messages are not sliced and loading earlier messages is used only for persisted server history. Run the focused test, full unit suite, production build, and existing manual thread-loading test guidance. No browser automation is required unless explicitly requested.

## Performance

The helper performs constant-time integer arithmetic. Rendering cost is controlled by server-side historical reasoning pruning, completed-turn assistant-progress filtering, and raw-item compression; the frontend must not hide already-loaded user/final-assistant turns behind a local 50-message window.
