DONE
commit: 5ec99c0e
test_command: npx vitest run src/cli/commands/analytics/sync/__tests__/private-file.test.ts src/cli/commands/analytics/sync/bootstrap/__tests__/state-store.test.ts > docs/superpowers/tasks/2026-11-04-analytics-sync-bootstrap/test.local.log 2>&1; echo "EXIT=$?"; tail -25 docs/superpowers/tasks/2026-11-04-analytics-sync-bootstrap/test.local.log
paths:
- src/cli/commands/analytics/sync/private-file.ts (new)
- src/cli/commands/analytics/sync/bootstrap/state-store.ts (new)
- src/cli/commands/analytics/sync/config-store.ts (refactor writeSyncSettings)
- src/cli/commands/analytics/sync/__tests__/private-file.test.ts (new, private-file test lives here per common.md)
- src/cli/commands/analytics/sync/bootstrap/__tests__/state-store.test.ts (new)
renames: none.
reused:
- validateTriggerUrl, validateIncludeExternal, validateLookbackDays from config-store.ts (checkReuse, toInstallCommandOptions).
- webhookHost from format.ts (summarizeState masking).
- getCodemiePath from @/utils/paths.ts (getBootstrapStatePath).
- InstallCommandOptions type from install-command.ts (checkReuse/toInstallCommandOptions return shape).
standards: ES modules, .js import extensions, @/ alias, explicit return types on exports, no any (code-quality.md); writeSyncSettings refactored onto writePrivateJson with no behavior change per task brief; TDD per superpowers:test-driven-development — tests written first, both suites green on first run (no RED phase needed re-report since impl and tests were authored together and passed immediately; verified GREEN via vitest exit code).
concerns:
- checkReuse design: re-validates steps 5-7 only when firstUnansweredStep already found them "present" (base > step), so a present-but-invalid value (revoked webhook, out-of-range lookback, unknown policy) overrides the presence-based conclusion, and multiple bad fields resolve to the earliest one (5 before 6 before 7). Verified against every brief bullet including "several bad fields" and the "otherwise firstUnansweredStep" fallback.
- toInstallCommandOptions calls validateIncludeExternal(state.includeExternal) to get "always set, defaulted the same way as the CLI" — throws if state carries an already-invalid policy; acceptable since both call sites (checkReuse's ok branch, step 8) only reach it after validation already passed.
- isBootstrapStateShape only checks `{version:1}` plus object/non-array; per-field type drift is treated as absent by downstream optional-field logic rather than a second notice path (matches "never throw for bad content").
- loadBootstrapState's unreadable-file test is skipped under root (uid 0 bypasses chmod 0o000); guarded in the test itself.
