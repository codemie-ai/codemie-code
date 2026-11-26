DONE
commit: none
changed paths: src/cli/commands/analytics/sync/uninstall.ts, src/cli/commands/analytics/sync/status.ts
verification: `npm run typecheck && npx eslint <both files>` -> EXIT=0 (log: test.local.log)
signatures:
- UninstallDeps: removed `unregister()`; added `loadSettings(): Promise<SyncSettings | null>` and `schedulerFor(name: string): Scheduler`. runUninstall loads settings (throw -> "Uninstall failed: ...", exit 1, nothing removed), resolves name (null settings -> default), unregisters under that name, then deletes settings and working copy.
- StatusDeps: removed `query()`; added `schedulerFor(name: string): Scheduler`. runStatus resolves name from loaded settings; invalid settings still report "Status failed" and exit 1. Added output line `  OS job name:           <resolved>` after the "Analytics sync:" line.
concerns: existing tests using old deps shapes will break (not touched): sync/__tests__/uninstall.test.ts, status.test.ts, real-deps.test.ts, analytics/__tests__/analytics-sync-cli.test.ts, proxy/__tests__/index.test.ts (if they build these deps). Status output has a new "OS job name" line which may affect exact-output assertions.
