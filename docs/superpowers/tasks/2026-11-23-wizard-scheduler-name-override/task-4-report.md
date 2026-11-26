DONE

commit: none

Changed paths:
- src/cli/commands/analytics/sync/install.ts

Verification:
- `npm run typecheck` EXIT=0; `npx eslint src/cli/commands/analytics/sync/install.ts` EXIT=0 (log in test.local.log). No tests written or run.

Signatures:
- `InstallDeps.scheduler` replaced by `schedulerFor(name: string): Scheduler`.
- New `InstallDeps.promptTaskName(prefixHint: string, defaultName: string): Promise<string>` (inquirer input; validates via validateSchedulerSuffix; empty = default).
- Real deps: `schedulerFor: (name) => createScheduler(createRealSchedulerDeps(), name)`.
- Internal: `PreviousInstall { settingsRaw, jobs: {name, at}[], names }`; `restorePreviousInstall(deps, previous, cmd, newName)`; new `resolveTaskName(opts, settings, deps)`.

Behavior:
- Preflight runs via schedulerFor(default name). Prompt only if isTTY and no opts.taskName; answer validated; taskName set on settings only when custom.
- Snapshot parses taskName from raw settings (invalid/unreadable -> ignored, default only), queries each name in ownedNames once. Unregisters every enabled owned job, writes settings, registers resolveSchedulerName. Failure: unregister new name, restore settings, re-register each previously enabled job under its own name.

Concerns:
- Previous jobs' schedule: only one `at` is stored in settings, so both owned jobs are restored with that `at`, and with the freshly resolved command (not each job's own command, which is not recoverable).
- A job found enabled only via query that fails to unregister aborts and triggers restore.
- Existing tests in sync/__tests__/install.test.ts use `scheduler:` deps and will break (makeDeps harness); analytics-sync-cli.test.ts mocks install and should be unaffected. Only install.ts consumed InstallDeps (plus analytics/index.ts, which just passes createRealInstallDeps()).
