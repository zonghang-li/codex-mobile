# Mobile Message Window Recovery Design

## Problem

On long, actively updating threads, the mobile conversation can show only the `Load earlier messages` control. The backend still returns messages and older-turn pagination succeeds, but `ThreadConversation` slices the message array from a stale `renderWindowStart`. When that index is at or beyond the shortened array length, the visible slice is empty while `hasMoreAbove` remains true. Repeated clicks may still leave the index out of range.

## Desired behavior

- A non-empty message array must always render at least one message.
- Clicking `Load earlier messages` enters manual history-reading mode and immediately exposes earlier content.
- New messages may continue arriving, but they must not reset the manually expanded window or move the reader to the bottom.
- `Jump to latest` explicitly restores automatic following and the bounded latest-message window.
- Persisted older-turn pagination, scroll restoration, command grouping, and file-change grouping remain unchanged.

## Design

Extract the render-window arithmetic into a small pure helper owned by the conversation component. It will clamp any proposed start index to `0..messages.length - 1`, returning `0` for an empty array. `visibleMessages` and every state transition that changes `renderWindowStart` use this helper, so stale asynchronous state cannot produce an empty slice.

When `loadMoreAbove` begins, it sets `autoFollowOutput` to `false` before changing the local window or awaiting persisted pagination. This preserves the current reading position across subsequent message updates. The existing scroll-height compensation remains responsible for keeping the same content in view after prepending messages.

`jumpToLatest` remains the explicit transition back to automatic following. It sets `autoFollowOutput` to `true`, resets the render window to the latest bounded batch, and scrolls to the bottom.

## Testing

Add focused unit tests for the pure render-window helper:

1. an oversized stale index is clamped so a non-empty array cannot render zero rows;
2. an empty array resolves to index zero;
3. expanding toward older messages remains within bounds;
4. the latest-window calculation remains limited to the existing 50-message window.

Add a static component wiring assertion that loading earlier messages disables auto-follow and that jumping to latest resets the bounded window. Run the focused test, full unit suite, production build, and existing manual thread-loading test guidance. No browser automation is required unless explicitly requested.

## Performance

The helper performs constant-time integer arithmetic. It adds no requests, watchers, payloads, or rendered rows. The 50-message window remains intact, so mobile memory and rendering costs do not increase.
