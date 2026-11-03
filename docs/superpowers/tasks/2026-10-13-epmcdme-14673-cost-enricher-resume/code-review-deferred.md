# Deferred from code review — 2026-10-13-epmcdme-14673-cost-enricher-resume (2026-10-13)

- **Kimi ignores usage window** — `src/cli/commands/analytics/cost/usage-readers.ts:918` — gatherDedupedUsageRecords/gatherUsageDeduped pass Kimi records through without the window, so a resumed shared Kimi log may double count. Pre-existing: Kimi readers were already session-local with no dedup before this change, and the task scopes the fix to Claude shared logs.
