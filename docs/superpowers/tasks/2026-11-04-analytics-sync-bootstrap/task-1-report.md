DONE
commit: c0a1e24
test_command: npx vitest run src/cli/commands/analytics/sync/__tests__/install-command.test.ts > docs/superpowers/tasks/2026-11-04-analytics-sync-bootstrap/test.local.log 2>&1; echo "EXIT=$?"; tail -25 docs/superpowers/tasks/2026-11-04-analytics-sync-bootstrap/test.local.log
paths:
- src/cli/commands/analytics/sync/install-command.ts
- src/cli/commands/analytics/sync/__tests__/install-command.test.ts
renames: none. New export `assertPrintableValue(flag, value): void` added; no call sites elsewhere yet (not wired beyond install-command.ts).
reused: `SyncConfigError` from `@/utils/errors.ts` (unchanged import, already used).
standards: TDD per superpowers:test-driven-development (RED confirmed on double-quote expectation mismatch, then GREEN); ES modules/.js imports/no any per AGENTS.md; printable-value rule's 4 clauses taken verbatim from spec.md "Printable-value rule" section (quote/$/backtick/!, control char, non-ASCII incl. U+2018-U+201F, bad %-escape).
concerns: Removed 1:1 flag-mapping claim and single-quote/POSIX-escape doc+tests from header and test file per task instructions; replaced with double-quote tests plus printable-rule throw cases (per-char and git-value case). Ran full `src/cli/commands/analytics/sync` folder (288 tests, exit 0), `npx tsc --noEmit` (exit 0), and `npx eslint` on both changed files (exit 0) — no other caller of buildInstallCommand/quote exists yet in src/.
