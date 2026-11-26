DONE_WITH_CONCERNS

commit: none

Changed paths (src/cli/commands/analytics/sync/):
- scheduler/index.ts: all per-OS helpers (darwin target/plist path, linux service/timer unit and paths, schtasks /TN x3) take `name`; registerDarwin passes `name` as the launchd label.
- install.ts, uninstall.ts, status.ts: real deps now `createScheduler(createRealSchedulerDeps(), defaultSchedulerName(process.platform))` (placeholder, later tasks rework).

Signatures: `createScheduler(deps: SchedulerDeps, name: string): Scheduler` (Scheduler interface unchanged). Log file and temp XML names unchanged. With the default name, argv/paths are identical.

Verification: `npm run typecheck` EXIT=0; eslint on the 4 files EXIT=0.

Concerns:
- Existing scheduler/__tests__/scheduler.test.ts still calls `createScheduler(deps)` with one arg; tests were not touched (not requested; tsc config does not cover them). They need `name` added when tests are requested.
- OS verification is unrun (cannot run other OSes). Reasoning: systemd suffix ending `.service` -> `<base>-x.service.service`/`.timer` is a valid unit name, fine. Suffix charset [letters digits . _ -] is safe for plist file names, launchd labels, systemd unit names and schtasks /TN (spaces come only from the fixed " - " joiner). Case-only differing names (Foo vs foo) collide on macOS (case-insensitive FS) and Windows task names; on Linux they are distinct. This only matters across separate installs; ownedNames/default-vs-saved are the same family so no collision within one install. I did not tighten validateSchedulerSuffix: rejecting case duplicates is not possible statelessly, and a collision just overwrites the other job (same as re-install).
