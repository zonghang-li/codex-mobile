### Feature: Codex desktop activity parity and mobile typography

#### Prerequisites

- Build and run `codex-mobile-safe` from the current repository.
- Use a Codex task that produces reasoning summaries, read/list/search commands, a general command, file edits, an image view, context compaction, and subagent activity.
- Keep the same task open in the Codex desktop client for side-by-side content comparison.
- Use Playwright device contexts at 375x812 and 768x1024.
- Test both light and dark themes at each viewport.

#### Steps — running activity

Repeat these steps at 375x812 light, 375x812 dark, 768x1024 light, and 768x1024 dark:

1. Open the same running task in Codex desktop and codex-mobile.
2. Confirm reasoning summaries appear on mobile in the same source order as the desktop client rather than as a generic `Thinking` row.
3. Confirm adjacent file and command activity is summarized with readable desktop-style grammar such as `Edited files, read files, ran a command`.
4. Confirm read, list, and search commands restored without `commandActions` still use conservative activity labels; mutation and general execution remain commands.
5. Confirm `subAgentActivity` appears as a compact bordered chip whose readable name and status correspond to the desktop client.
6. Confirm dynamic tools, image view/generation, waiting, web search, and context compaction appear as readable activity rows with no raw JSON or protocol item names while the task is running.
7. Expand an activity summary containing commands and confirm the individual command labels, statuses, and output remain accessible.
8. Confirm generated/viewed images still render their preview.

#### Steps — completed activity

9. Allow the task to complete successfully.
10. Confirm detailed reasoning, intermediate assistant progress, and activity disappear from the default completed view.
11. Confirm `Worked for …` remains visible above the final assistant reply.
12. Expand `Worked for …` and confirm it contains the same ordered activity segments that were visible while running.
13. Confirm the final assistant reply remains outside the collapsed activity region and is visible by default.

#### Steps — typography and viewport

14. Compare the conversation font with the Codex desktop client: it should use the native system UI family, including SF Pro/PingFang on Apple platforms.
15. Confirm assistant paragraphs and lists render at approximately 15px/24px on mobile, activity rows at 14px/22px, and command content at 13px/20px.
16. Focus the composer and confirm Safari does not zoom the page; the composer input remains 16px.
17. Scroll through long Chinese/English mixed content, inline code, code blocks, tables, and activity chips.
18. Confirm the page cannot be dragged horizontally and every activity/message container stays within the viewport.

#### Expected Results

- Mobile preserves the same meaningful app-server activity content and ordering as Codex desktop.
- Running turns expose detailed activity; completed turns fold activity under `Worked for …` and keep the final reply visible.
- Restored history remains readable when the app-server omits `commandActions`.
- No raw `subAgentActivity`, `dynamicToolCall`, or related protocol payload is printed in the conversation.
- Native UI typography is denser than the previous 16px/32px conversation layout without reducing the 16px composer safeguard.
- Both viewports remain readable and horizontally stable in light and dark themes.

#### Performance Checks

- Confirm the feature adds no duplicate API request or polling timer.
- Run `pnpm run profile:thread` and inspect request count, duplicate counts, total API KB, warnings, and the thread bundle size.
- Confirm full-history responses omit historical `reasoning` items server-side and activity presentation remains bounded by the 50-message DOM window.

#### Rollback/Cleanup

- Close the comparison task after screenshots are captured.
- Reverting the feature must restore the normalizer, activity segment builder, template rendering, and typography changes together so raw protocol events are not partially exposed.
