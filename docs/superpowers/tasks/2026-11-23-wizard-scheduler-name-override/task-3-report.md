DONE

commit: none

Changed paths:
- src/cli/commands/analytics/sync/types.ts (InstallOptions.taskName?: string)
- src/cli/commands/analytics/sync/config-store.ts (validateInstallOptions, loadSyncSettings; imports validateSchedulerSuffix from ./scheduler/generators.js)
- src/cli/commands/analytics/index.ts (install: `--task-name <suffix>`; commander passes opts straight to InstallOptions as `taskName`)

Verification: `npm run typecheck && npx eslint <3 files>` -> EXIT=0.

Signatures: validateInstallOptions(options) now sets `taskName` only when given. loadSyncSettings validates stored taskName and throws SyncConfigError "Sync settings at <path> has an invalid taskName: <reason>".

Concerns: none. install.ts untouched (it persists whatever validateInstallOptions returns, so taskName is already saved).
