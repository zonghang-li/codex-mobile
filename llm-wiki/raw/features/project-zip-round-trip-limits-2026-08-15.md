# Project ZIP round-trip limits source

Date: 2026-08-15

Implementation facts:
- Project ZIP import and export share round-trip limits of 10,000 entries, 256 MiB archive bytes, and 256 MiB logical file data.
- Export validates count, path uniqueness, logical bytes, and archive bytes incrementally before sending ZIP headers.
- Import rejects oversized request bodies and invalid archive bounds before creating a destination project.
- Physical project files under `.codex-project/chats/` are excluded from export because that namespace is reserved for generated portable chat entries.
- Imported state-database rollback fills a bounded staging table in multiple transactions, then deletes imported rows and drops the staging table in one final atomic transaction.

Verification facts:
- Regression tests cover over-limit archives, overlapping local ZIP records, reserved chat paths, and failed import rollback.
