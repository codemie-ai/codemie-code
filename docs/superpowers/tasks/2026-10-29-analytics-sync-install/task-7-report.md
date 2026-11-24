DONE
commit: 31bbd4ba
test_command: npx vitest run src/cli/commands/analytics/__tests__/analytics-sync-cli.test.ts
changed: src/cli/commands/analytics/index.ts, src/cli/commands/analytics/sync/format.ts, src/cli/commands/analytics/sync/install.ts, src/cli/commands/analytics/sync/status.ts, src/cli/commands/analytics/__tests__/analytics-sync-cli.test.ts
renames: createSyncCommand (bare action) → createSyncCommand (pure group) + createSyncInstallCommand/createSyncStatusCommand/createSyncRunCommand/createSyncUninstallCommand; call sites: command.addCommand wiring in createAnalyticsCommand
reused: lookbackText/webhookHost — new sync/format.ts (extracted from install.ts and status.ts duplicates)
standards: ES modules + .js import extensions (AGENTS.md); dynamic import for scheduler/runner modules so `analytics --help` stays light; Conventional Commits, no ticket key in subject (git-workflow.md)
notes:
- sync group description: "Send this machine's analytics reports one way to the team's webhook on a daily schedule". install: "Developer: register the daily delivery job on this machine" (verbatim from story). status/run/uninstall each got a who/what one-liner too.
- install/status/run/uninstall are plain `.option()`s on InstallOptions (not commander requiredOption) — missing --webhook is still caught by validateInstallOptions inside runInstall (spec's validation order), not by commander's own error path.
- --scheduled is `new Option('--scheduled').hideHelp()` on `run`; confirmed absent from `sync run --help` output in test.
- sync itself also carries `.enablePositionalOptions()` (defensive, matches the existing analytics-level pattern) even though it owns no options of its own; harmless and kept per brief's "keep .enablePositionalOptions()".
- AC-X2 sweep re-run post-commit: grep for sync config/backfill/analytics-sync-path/SyncDeliveryTarget/SyncTarget\b/applySyncUpdate/validateSyncUpdate/SyncConfigUpdate in src+bin returns only unrelated hits (telemetry adapters' `applySyncUpdates` plural, unrelated `backfill*` in telemetry/copilot-cli, and comments/tests describing the removal) — nothing to remove.
- Full `src/cli/commands/analytics` suite: 40 files / 562 tests passed. `npm run typecheck` and `npm run lint` both clean. TDD RED proven by temporarily restoring HEAD's old index.ts, running the new test file (11/18 failed for the expected "unknown command/option" and "not called" reasons), then restoring the new index.ts for GREEN (18/18) before committing.
