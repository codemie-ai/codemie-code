# Scheduler task name override — implementation plan

**Goal:** `sync install` and the bootstrap wizard accept an optional name suffix; the OS job is registered under a per-platform prefix plus the suffix; uninstall and status resolve it from saved settings. Spec: `spec.md` (same dir).

**Conventions:** Commit per task using the repository's existing convention. Paths are under `src/cli/commands/analytics/sync/` unless noted. Use `@/` alias and `.js` imports, injected `*Deps`, `SyncConfigError` for validation. Per AGENTS.md, test files are written or run only when the user asks; each `Test-first` line names the test that would be written then.

**Plan notes from arch review:** one validator beside the name constants, shared by install, `loadSyncSettings` and bootstrap (Task 1). Odd-name check (suffix ending `.service`, case-only differences) is an open OS verification; see Task 2 and the digest.

## Task 1: Name model — validator and resolver

**Files:** `scheduler/generators.ts:13-17,106`, `scheduler/index.ts`

- Add `validateSchedulerSuffix(s): string` (throws `SyncConfigError` naming the broken rule: 1-32 chars, `[A-Za-z0-9._-]`, not starting with `.` or `-`) beside the constants.
- Add `resolveSchedulerName(settings, platform)` in the scheduler module: absent `taskName` returns the default; else prefix plus suffix (`.X` for launchd label, `-X` for systemd, ` - X` for Windows). Add `defaultSchedulerName(platform)` and `ownedNames(settings, platform)` (saved name plus default, de-duplicated).
- `launchdPlist` takes the label as a parameter instead of reading `LAUNCHD_LABEL`.

Test-first: yes — validator rejects empty, 33 chars, space, `/`, `../x`, leading `.`/`-` and accepts `a.b_c-1`; resolver returns the exact default when no suffix and the three prefixed forms when set.

## Task 2: Scheduler built per name

**Files:** `scheduler/index.ts:73-89,222-224,261,303,321`

- Change `createScheduler(deps)` to `createScheduler(deps, name)`. Darwin domain target and plist path, linux service/timer paths and unit names, and the three Windows `/TN` arguments use `name`. `Scheduler` interface stays name-less. Log file and temp XML names stay fixed.
- Pass the label into `launchdPlist` from `registerDarwin`.
- Before finishing, check on each OS that suffixes ending `.service` and case-only differing names register, query and unregister cleanly; if one misbehaves, tighten `validateSchedulerSuffix` (Task 1) and record why.

Test-first: yes — with a fake `exec`, a scheduler built for a custom darwin/linux/win32 name issues launchctl/systemctl/schtasks argv and paths containing that name, and the default name still yields the current exact argv.

## Task 3: Option and persisted setting

**Files:** `types.ts` (`InstallOptions`, `SyncSettings`), `config-store.ts:284` (`validateInstallOptions`), `config-store.ts` (`loadSyncSettings`, ~l.340), `../index.ts:125-146`

- Add `taskName?: string` to both types. `validateInstallOptions` validates via `validateSchedulerSuffix` and stores it only when set.
- `loadSyncSettings` reads `taskName`, validates it, and throws `SyncConfigError` naming the settings file on an invalid value. Absent stays absent.
- Add the commander option `--task-name <suffix>` on `install`; help text lists the three prefixes.

Test-first: yes — `loadSyncSettings` throws naming the file for `taskName: "../../x"` and returns unchanged settings for a file without `taskName`; `validateInstallOptions` rejects `--task-name "a b"` before any side effect.

## Task 4: Install flow — prompt, per-name schedulers, multi-job restore

**Files:** `install.ts:41,62,133,325-340` (`InstallDeps`, `runInstall`, `replaceJob`, `snapshotPreviousInstall`, `restorePreviousInstall`, `createRealInstallDeps`)

- Replace `InstallDeps.scheduler` with `schedulerFor(name)`; the real deps call `createScheduler(createRealSchedulerDeps(), name)`. Keep `preflight` working through the default-name scheduler.
- Add `promptTaskName(prefixHint, defaultName): Promise<string>` to `InstallDeps` (inquirer `input`, dynamic import, same shape as `promptEmail`). Call it only when `isTTY` and no flag; empty answer means default; the answer goes through the validator. No TTY and no flag means default, no prompt.
- Snapshot: one `query()` for the saved name and, if different, one for the default name. Unregister every owned job found, write settings (with `taskName` only when custom), register the new name.
- On register failure: unregister the new name, then re-register each previously enabled job under its own name with its own command and schedule. Never query or touch a name outside `ownedNames`.

Test-first: yes — with fake `schedulerFor`, reinstall under a new suffix with jobs under both saved and default names leaves one job; a forced register failure unregisters the new name and re-registers both prior jobs under their own names; non-TTY without flag never calls `promptTaskName`; Enter keeps the default and writes no `taskName`.

## Task 5: Uninstall and status use the resolved name

**Files:** `uninstall.ts:67` (`runUninstall`, `createRealUninstallDeps`), `status.ts:41,182,228-232`

- Both load settings, call `resolveSchedulerName`, and build a scheduler for that name.
- Uninstall: if settings cannot be read or validated, report it, keep the file, remove nothing, exit non-zero. Delete settings and the working copy only after unregister under the saved name succeeded or the job is confirmed absent.
- Status: query the resolved name; an unreadable settings file reports the problem rather than falling back.

Test-first: yes — uninstall with a corrupt settings file returns non-zero, keeps the file, and calls no `unregister`; uninstall with `taskName: "x"` unregisters the prefixed name; status queries the prefixed name.

## Task 6: Bootstrap wizard and printed command

**Files:** `install-command.ts` (`InstallCommandOptions`, `buildInstallCommand`), `bootstrap/guided*.ts`, `bootstrap/state-store.ts`, `bootstrap/run-bootstrap.ts`

- Add optional `taskName` to `InstallCommandOptions`; emit `--task-name "<suffix>"` through `assertPrintableValue`, omitted when empty.
- Add one guided step asking for an optional suffix via `deps.prompt.input` (retry loop in `guided-support.ts:30`, empty means omit), showing the per-platform prefixes, validated with `validateSchedulerSuffix`. Save the answer in the bootstrap state file and pass it to `buildInstallCommand`. Bootstrap still installs nothing.

Test-first: yes — `buildInstallCommand` with `taskName: "team-a"` contains `--task-name "team-a"` and without it contains no `--task-name`; the wizard re-prompts on an invalid suffix and persists a valid one in the state file.

## Task 7: Docs

**Files:** `docs/ANALYTICS-SYNC.md:242-246,344-346`, `docs/COMMANDS.md`, `docs/ANALYTICS-REPORT.md` (name mentions)

- Document `--task-name`, the prompt, per-platform prefixes, the suffix rules, persistence in `analytics-sync.json`, and that manual `launchctl`/`systemctl`/`schtasks` commands use the resolved name.

Test-first: no — documentation only.

## Negative-constraint pass

- No name without prefix: Task 1 resolver always prefixes a custom suffix; Task 3 stores a suffix only.
- No change to default names or default-install collector compatibility: Tasks 1-2 keep the constants and exact default argv; Task 3 stores nothing for the default.
- No touching other jobs: Task 4 limits queries and deletes to `ownedNames`.
- No multiple jobs side by side: Task 4 leaves exactly one job.
- Bootstrap installs nothing and has no per-platform name entry: Task 6 asks for one suffix and only prints the command.
- No in-place rename, no collector-owned cleanup under other names: not planned.
- Non-TTY never blocks and no fallback to the default on a bad saved name: Tasks 4 and 5.
