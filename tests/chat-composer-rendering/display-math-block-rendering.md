### Display and inline math rendering

#### Feature/Change Name
Balanced `\[...\]` display environments and `\(...\)` inline environments render with lazy local KaTeX.

#### Prerequisites/Setup
1. Build the current worktree and run it at `http://127.0.0.1:4173`.
2. A `TestChat` project/thread is available.
3. DevTools Network is open with cache disabled.

#### Steps
1. Load a thread without `\[` or `\(` and confirm no KaTeX asset is requested.
2. Send `Energy is \(E=mc^2\), while \[x^2\] is displayed.`; confirm the first formula stays in its sentence and the second is centered on its own line.
3. Send a multiline fraction/summation and two inline formulas in one paragraph; confirm source order and one lazy load.
4. Render both forms in a plan explanation or plan step, a heading, a list item, and a table cell.
5. Send `` `\(inline code\)` ``, fenced `\[display code\]`, escaped delimiters, and unmatched delimiters; confirm each stays literal.
6. Send invalid TeX inside each delimiter form; confirm its exact source remains visible without breaking adjacent text or later output.
7. Inspect a wide inline expression and wide display matrix at 375x812 and 768x1024 in light and dark themes.
8. Repeat the representative check against the installed service URL after restart, not only the development server.

#### Expected Results
- Only supported balanced environments outside code render as KaTeX; dollar syntax remains literal.
- `\(...\)` follows the surrounding baseline while `\[...\]` remains a display block.
- Normal messages and plan cards agree; failure never hides source or later output.
- Wide formulas scroll inside their own wrapper without page overflow in either theme.
- A browser refresh of the installed service still renders both forms.

#### Rollback/Cleanup
- Remove the TestChat messages. Reverting the parser, renderer, styles, and dependency restores literal output.
