DONE

commit: none (uncommitted by user instruction)

Changed paths (src/cli/commands/analytics/sync/):
- scheduler/generators.ts
- scheduler/index.ts
- types.ts (added `taskName?: string` to SyncSettings)

Verification: `npm run typecheck` EXIT=0; `npx eslint` on the 3 files clean.

New exports:
- generators.ts: `validateSchedulerSuffix(suffix: string): string` (throws SyncConfigError per rule)
- index.ts: `SchedulerNameSettings { taskName?: string }`, `defaultSchedulerName(platform: NodeJS.Platform): string`, `resolveSchedulerName(settings: SchedulerNameSettings, platform: NodeJS.Platform): string`, `ownedNames(settings, platform): string[]`; re-exports `validateSchedulerSuffix`.

Changed signature: `launchdPlist(cmd, at, logPath, label: string)` (label is the new LAST param; label is plist-escaped). registerDarwin passes LAUNCHD_LABEL. Default output unchanged.

Concerns: existing scheduler/__tests__/generators.test.ts calls launchdPlist with 3 args; it needs the label argument (tests not touched, tsc does not cover them).
