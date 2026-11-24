# Spec: Scheduler task name override for analytics sync

Paths are under `src/cli/commands/analytics/` unless noted.

## Problem

`sync install` registers an OS scheduler job under a fixed per-platform name: launchd label, systemd unit base name, Windows task name (`sync/scheduler/generators.ts:13-17`). Users cannot choose the name. `Scheduler.register/query/unregister` take no name (`sync/scheduler/index.ts`), and nothing persists one, so uninstall, status and restore only work with the constants.

## Naming model

A custom name is a short **suffix**. The tool prepends a fixed per-platform prefix, so a custom job can never collide with a task the user owns (for example a Windows task called "Backup").

| Platform | Default (Enter) | Prefix for a custom suffix `X` |
|---|---|---|
| macOS | `com.epam.codemie.analytics-sync` | `com.epam.codemie.analytics-sync.X` |
| Linux | `codemie-analytics-sync` | `codemie-analytics-sync-X` |
| Windows | `CodeMie Analytics Sync` | `CodeMie Analytics Sync - X` |

- The stored value is the user's suffix only (`taskName` in `SyncSettings`). The full name is resolved per platform at run time, so one suffix works on every OS and in bootstrap's printed command.
- Suffix rules: 1 to 32 characters, letters, digits, `.`, `_`, `-` only, not starting with `.` or `-`. No spaces on any platform.
- One validator, `validateSchedulerSuffix`, lives beside the name constants in `sync/scheduler/generators.ts`. Install, `loadSyncSettings` and bootstrap all call it.
- Install touches only jobs this tool owns: the default name or a name with the prefix above. It never queries, replaces or deletes any other job.

## Behavior

1. `sync install` accepts `--task-name <suffix>`. Its help text states the prefix per platform.
2. On a TTY without the flag, install asks: "Name suffix for the scheduler task (full name will be `<prefix><suffix>`, Enter for default `<default>`):". Enter keeps the exact current default. This follows the injected `promptEmail`/`isTTY` pattern in `sync/install.ts`.
3. Without a TTY and without the flag, the default is used. Install never blocks.
4. `taskName` is written to `~/.codemie/analytics-sync.json` only when a custom suffix was chosen. An absent value means the default. `loadSyncSettings` validates it and fails closed, naming the file, on an invalid value.
5. One helper `resolveSchedulerName(settings)` (scheduler module) returns the full name. Install, uninstall and status all use it.
6. The `Scheduler` interface stays name-less. `createScheduler(deps, name)` builds a scheduler for one name, and `InstallDeps` gets `schedulerFor(name)`. The darwin label and plist path, linux unit and timer paths, and the Windows `/TN` argument come from that name. Log and temp-XML file names stay fixed.
7. Install snapshots the job under the saved name and, if different, under the default name (one `query()` each). It unregisters every owned job found, then registers the new name. This is the same default-name takeover install does today.
8. If registration fails, install unregisters the new name, then re-registers every previously enabled job under its own name with its own command and schedule.
9. Uninstall and status resolve the name via `resolveSchedulerName`. If settings cannot be read or validated, uninstall reports the problem, keeps the file and exits non-zero. It deletes settings only after unregister under the saved name succeeded or the job is confirmed absent.
10. The bootstrap wizard asks the lead for an optional suffix (empty means omit), showing the per-platform prefixes. The answer is saved in the bootstrap state file. `buildInstallCommand` (`sync/install-command.ts`) emits `--task-name "<suffix>"` through `assertPrintableValue`. The suffix charset already passes it.
11. Docs: `docs/ANALYTICS-SYNC.md:242-246,344-346` and `docs/COMMANDS.md` describe the option, the prefixes, and that manual `launchctl`/`systemctl`/`schtasks` commands use the resolved name.

## Acceptance criteria

- AC1: `--task-name X` registers the prefixed name on darwin, linux and win32.
- AC2: On a TTY without the flag, Enter registers the exact current default and a typed value registers prefix plus value. The prompt and `--help` show the prefix.
- AC3: Without a TTY and without the flag, the default is used and there is no prompt.
- AC4: The suffix is persisted. Uninstall and status act on the resolved name. A default install leaves existing behavior and settings unchanged.
- AC5: Reinstalling with a new suffix removes the old job and the default-name job, leaving exactly one.
- AC6: If registration fails, the new name is unregistered and every previously enabled job (saved name and default name) is back under its own name.
- AC7: Invalid suffixes (bad characters, space, too long, leading `.` or `-`, empty) are rejected before any job is touched, with a message naming the rule. A hand-edited invalid `taskName` is rejected on load, and no path is built from it.
- AC8: Install never queries, replaces or deletes a job whose name is neither the default nor prefixed.
- AC9: Uninstall with unreadable settings reports it, keeps the file and removes nothing.
- AC10: The bootstrap wizard asks for the suffix, and the printed command carries a valid `--task-name` or omits it.
- AC11: Docs are updated.

## Non-goals

- Renaming an existing job in place (install replaces it).
- Letting the user choose a name without the prefix.
- Changing the default names or the default install's collector compatibility.
- Running multiple sync jobs side by side.
- Changing what the sync does, or the schedule options.
- Making the bootstrap wizard install anything on the machine.
- Per-platform name entry in bootstrap.
- Cleaning up jobs the collector registered under other names.

## Decisions

- Both `sync install` (prompt plus flag) and the bootstrap wizard ask for the name, over only one of them — user
- All three platforms over macOS and Windows only — user
- Persist the name in `analytics-sync.json` over passing it to uninstall and status each time — user
- Install removes the previous job (saved or default name) before registering over leaving the old job — user
- Strict validation over accepting anything the OS accepts — user
- Custom names are a suffix under an automatic per-platform prefix over a full typed name, so they cannot collide with the user's own tasks — user
- Enter keeps the exact current default over applying the prefix to an empty value
- The stored value is the suffix over the full resolved name, so one value works on every OS and in the bootstrap command
- Suffix has no spaces on any platform over spaces on Windows only, because the suffix is platform-agnostic and the Windows prefix already has them
- Suffix capped at 32 characters, not starting with `.` or `-`, over no length rule, so the full name stays a safe filename
- Non-TTY uses the flag or the default and never blocks over failing when no name is given
- `taskName` is stored only when custom over always writing it, so default installs and old settings files stay identical
- A scheduler is built per name (`createScheduler(deps, name)`, `InstallDeps.schedulerFor`) over a `SchedulerDeps` name or a parameter on each `Scheduler` method, because install touches up to three names in one run
- One `resolveSchedulerName` helper and one validator over per-runner copies
- Invalid saved name fails closed on load and uninstall keeps settings on error over falling back to the default
- Install removes the default-name job over leaving it, as it does today — user, answers AR-3

## Risks and assumptions

- Assumption: the standalone collector does not look up its job under the default name after install replaced it. Install already takes over that name today, so this change adds no new exposure. It stays unverified from this repo.
- Install can still replace an owned prefixed job from an earlier install under the same suffix. That is intended.
- A user who deletes the settings file by hand after a custom install leaves a prefixed job that uninstall cannot find. Re-running install with the same suffix removes it.
- Behavior of `launchctl`, `systemctl` and `schtasks` with suffixes ending in `.service` or differing only by case is unverified and needs a check on each OS.
- Scheduler, install, uninstall and install-command tests assert exact names and argv, so they need updating (only when the user asks for tests).

## Revision 2026-11-24: full name, no prefix

The user dropped the prefix model. This revision supersedes "Naming model", Suffix rules, Behavior 1, 2, 4 and 10, AC1, AC2, AC7, AC8 and AC10, and the matching Decisions and Non-goals; everything else stands.

- `--task-name <name>` and the prompt take the FULL task name, used as-is on every platform (launchd label and plist file name, systemd unit base name, `schtasks /TN`). Enter or empty means the platform default (unchanged). `taskName` is persisted as the full name, only when it differs from the platform default. No migration: the suffix design never shipped, and a saved invalid value still fails closed on load.
- One validator, `validateSchedulerName` (`sync/scheduler/generators.ts`), replaces `validateSchedulerSuffix`. Input is trimmed first; it rejects empty, leading/trailing whitespace, control characters, `/`, `\`, `..`, a leading `-` or `.`, and more than 100 characters. Spaces and other printable characters are allowed. `assertNameSupportedOnPlatform` adds what the OS itself cannot take (systemd: only `[A-Za-z0-9:_.-]`; Task Scheduler: not `: * ? " < > |`) and runs at install time before any job is touched.
- Overwrite check: before any job is removed, install asks the scheduler whether a task with the chosen name exists (`Scheduler.exists()`: `present`, `absent`, `unknown`; disabled jobs count). The previously saved name and the platform default are ours and replaced silently. Otherwise install prints `The following task already exists and will be deleted and overwritten by this one: <name>` (an `unknown` result prints that the check could not tell). On a TTY with the name typed at the prompt it asks y/N (default No; No aborts, nothing touched). With `--task-name`, or without a TTY, it refuses with a non-zero exit and `Re-run with --force to overwrite it.`; the new `--force` flag proceeds after printing the warning.
- The prompt reads `Scheduler task name (Enter for default "<default>"):`. The bootstrap step asks for the full name (Enter = default), validates with the same validator plus `assertPrintableValue`, prints no platform-specific text, and `buildInstallCommand` emits `--task-name` or omits it.
- Docs updated: `docs/ANALYTICS-SYNC.md`, `docs/ANALYTICS-REPORT.md`, `docs/COMMANDS.md`.
- Risk: the `exists()` probes (`launchctl print` plus the plist file; unit files plus `systemctl --user is-enabled`; the `schtasks /Query /FO CSV /NH` listing) and the per-OS name limits are unverified on real macOS, Linux and Windows hosts.
