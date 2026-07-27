### Native turn pagination load performance

#### Feature/Change Name
Bounded initial and live thread hydration.

#### Prerequisites/Setup
1. `codex-mobile-safe` is installed from the current repository and running.
2. A long Codex session exists with a rollout JSONL larger than 100 MB and more than 15 turns.
3. Service performance logging is enabled.

#### Steps
1. Restart `codex-mobile-safe` and open the long thread from a fresh mobile browser load.
2. Inspect the initial metadata request and `/codex-api/thread-turn-page` response.
3. Confirm metadata uses `thread/read` with `includeTurns: false`.
4. Confirm the newest page contains at most five chronological turns, has a bounded response body, and returns `nextCursor` while older history exists.
5. Leave the thread open through several `/codex-api/thread-live-state` polls.
6. Confirm every full live-state response contains at most five persisted turns and an `olderCursor`; matching projection keys may return a body without `conversationState`.
7. Load older history twice and confirm each request contains at most ten turns and advances the opaque cursor.
8. Review service logs for any initial or live `thread/read(includeTurns: true)` request.
9. On an app-server that does not implement `thread/turns/list`, repeat once and confirm the compatibility full read occurs only after a method-not-found response.

#### Expected Results
- Native-capable initial and live loading never issue `thread/read(includeTurns: true)`.
- Initial and live response size is proportional to five turns, not total session size.
- Older history is loaded only on demand in pages of at most ten turns.
- A malformed, aborted, unauthorized, or ordinary failed page does not trigger a full-history fallback.
- Every historical turn remains reachable; live polling, completion reconciliation, and forced refresh preserve all already-loaded turns.

#### Rollback/Cleanup
- Remove only temporary browser/session measurements. Do not delete the source Codex rollout.
