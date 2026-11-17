DONE
commit: 5f05bcc1
test_command: npx vitest run src/cli/commands/analytics/sync/__tests__/config-store.test.ts
paths:
- src/cli/commands/analytics/sync/config-store.ts
- src/cli/commands/analytics/sync/__tests__/config-store.test.ts
renames: none
reused: existing `assertPrintableValue`, `redactSecrets`, `SyncConfigError` unchanged; new `findRawTriggerUrlIssue`/`guidedTriggerUrlMessage` helpers live in config-store.ts beside `validateTriggerUrl`
standards: TDD per common.md — added RED tests asserting typographic-quote wording in both modes first, saw them fail, then implemented; ran via the mandated vitest-run/EXIT shape, tsc --noEmit, eslint on both changed files
concerns: Task 8's guided.ts does not exist yet (only Task 1 landed so far), so the guided-mode fix is verified only through validateTriggerUrl's own tests, not through guided.ts step 5. assertPrintableValue failures (", $, `, !, bad %) still get a slightly generic guided reason ("has a character in it that is not safe to reuse in a command") rather than one reason per forbidden character; this path is unreachable for non-ASCII/control/whitespace (findRawTriggerUrlIssue catches those first) and the plan/finding did not ask for per-character differentiation there, so left as-is.
