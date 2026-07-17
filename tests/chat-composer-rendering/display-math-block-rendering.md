### Display math block rendering

#### Feature/Change Name
Balanced `\[...\]` LaTeX display environments render with lazy local KaTeX.

#### Prerequisites/Setup
1. Build the current worktree and run it at `http://127.0.0.1:4173`.
2. A `TestChat` project/thread is available.
3. DevTools Network is open with cache disabled.

#### Steps
1. Load a thread without `\[` and confirm no KaTeX asset is requested.
2. Send `\[ E = mc^2 \]` and a multiline fraction/summation; confirm formatted math and one lazy load.
3. Render the same formula in a plan explanation or plan step.
4. Send delimiter text inside inline backticks, backtick fences, and tilde fences.
5. Send escaped, unmatched, and invalid formulas; confirm exact source remains visible.
6. Inspect a wide matrix at 375x812 and 768x1024 in light and dark themes.

#### Expected Results
- Only supported balanced environments outside code render as KaTeX.
- Normal messages and plan cards agree; failure never hides source or later output.
- Wide formulas scroll inside their block without page overflow in either theme.

#### Rollback/Cleanup
- Remove the TestChat messages. Reverting the parser, renderer, styles, and dependency restores literal output.
