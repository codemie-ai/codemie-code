# Technical Research

**Task**: analytics sync install scheduler wizard
**Generated**: 2026-11-23
**Research path**: filesystem

---

## 1. Original Context

Improve the wizard installation for the codemie analytics sync. It currently creates scheduler tasks for macOS/Windows with a hardcoded name. Add an option during wizard installation to override the name: ask the user how to name the scheduler task, or press enter to use the default (current name).

(Hints from caller: likely area src/cli/commands/analytics/sync/ — install.ts, scheduler/, types.ts, install-command.ts, plus uninstall/status paths that reference the task name.)

---

## 2. Codebase Findings

All paths below are under `src/cli/commands/analytics/` unless noted.

### Existing Implementations

Purpose A: name the OS scheduler job that `sync install` registers.
- `sync/scheduler/generators.ts:13,15,17` — three hardcoded constants: `LAUNCHD_LABEL='com.epam.codemie.analytics-sync'` (macOS), `SYSTEMD_UNIT_NAME='codemie-analytics-sync'` (Linux), `WINDOWS_TASK_NAME='CodeMie Analytics Sync'` (Windows). Comments say they are "collector-compatible" so install replaces the standalone collector's job.
- `sync/scheduler/generators.ts:106` — `launchdPlist()` embeds `LAUNCHD_LABEL` in the plist `<key>Label`. Windows `taskSchedulerXml()` does not reference the name (name is passed to schtasks `/TN`).
- `sync/scheduler/index.ts` — every consumer of the names:
  - darwin: `darwinDomainTarget` (`gui/<uid>/<label>`, ~l.66), `darwinPlistPath` (`~/Library/LaunchAgents/<label>.plist`, ~l.70); used by register (bootout/bootstrap), query (`launchctl print`), unregister (bootout + rm plist).
  - linux: `linuxServicePath`, `linuxTimerUnit`, `linuxTimerPath` (`<name>.service` / `.timer`); used by register, query (`systemctl --user is-enabled`), unregister.
  - win32: `WINDOWS_TASK_NAME` in `registerWindows` (`/Delete /F /TN`, `/Create /XML ... /TN`), `queryWindows` (`/Query /TN`), `unregisterWindows` (`/Delete /F /TN`). Temp XML file name is fixed `codemie-analytics-sync-task.xml` (`windowsTaskXmlPath`).
- `sync/scheduler/index.ts` `Scheduler` interface: `preflight()`, `register(cmd, at)`, `unregister()`, `query()` — none takes a name; `createScheduler(deps: SchedulerDeps)` builds it. `SchedulerDeps` has no name field.
- `sync/install.ts` — `runInstall(opts, deps)` fixed order: validate options -> preflight -> resolve email -> collector detection -> git test push -> `replaceJob` (snapshot previous via `scheduler.query()`, `unregister()`, `writeSettings`, `register(cmd, settings.at)`, restore on failure via `restorePreviousInstall`) -> `printSummary`. Summary does not print the job name. `createRealInstallDeps()` builds `scheduler: createScheduler(createRealSchedulerDeps())`.
- `sync/install.ts` `promptEmail` (real deps) — the only existing interactive prompt in `install`: inquirer `input`, invoked only if `isTTY` and identity resolution fails. Dynamic `import('inquirer')`.

Purpose B: the "wizard".
- `sync/bootstrap/` (`guided.ts`, `guided-start.ts`, `guided-late-steps.ts`, `guided-support.ts`, `run-bootstrap.ts`, `state-store.ts`) — the team-lead `codemie analytics sync bootstrap` guided wizard. It installs nothing on the machine (`index.ts:104`); it prints a `sync install ...` command for developers. Prompts via `deps.prompt.input/select/confirm` (`guided-support.ts:30` retry loop with default; `guided-late-steps.ts:188,211` select prompts). Saved answers in `~/.codemie/analytics-sync-bootstrap.json`.
- `sync/install-command.ts` — `buildInstallCommand(opts: InstallCommandOptions)` builds the printed `codemie analytics sync install ...` string from webhook/gitRepo/gitBranch/gitPath/at/lookbackDays/includeExternal; every value goes through `assertPrintableValue` (rejects `" $ \` ! \`, bare `%`, control and non-ASCII chars) and is double-quoted. Only consumer found outside tests: bootstrap (not wired elsewhere).
- No code or doc in `src/` contains a "wizard" install step that creates the scheduler task. The only place that registers the task is `sync install` (non-interactive except the email prompt). "Wizard installation" therefore maps either to the `install` command run interactively or to the bootstrap wizard's printed install command; the task does not say which.

Other touched code
- `sync/types.ts` — `InstallOptions` (raw CLI flags), `SyncSettings` (persisted; no scheduler-name field today).
- `index.ts:125-146` — `createSyncInstallCommand()` commander options for `install` (no name option); `:148` status command; `:178` uninstall command.
- `sync/uninstall.ts` — `runUninstall`: `deps.unregister()` -> `scheduler.unregister()` (no name arg), deletes settings, removes working copy. `createRealUninstallDeps()` builds its own `createScheduler(createRealSchedulerDeps())`.
- `sync/status.ts:41,182,228-232` — `query()` via a third separately constructed scheduler; no name printed.
- `sync/config-store.ts` — `validateInstallOptions` (l.284) maps `InstallOptions` -> `SyncSettings`; `loadSyncSettings` (~l.340) reads only known fields (webhookUrl, git, includeExternal, at, lookbackDays); unknown keys are dropped on load; `writeSyncSettings` is a whole-file overwrite, mode 0600.

### Decisions Already in the Code
- Fixed job identities, shared with the standalone collector, so install "takes over" the collector's job and so uninstall/status can find it without any stored state — `generators.ts:12-17`. Alternative: configurable name; reason recorded only as "collector-compatible".
- Install unregisters the existing job before registering (`install.ts replaceJob`), and relies on the name being constant so a previous install or collector job is found. Unregister/query/uninstall/status have no input telling them which name was used; nothing persists the name.
- Scheduler is stateless and name-less: `Scheduler` methods take no identity; three separate `createScheduler(createRealSchedulerDeps())` calls (install.ts, uninstall.ts, status.ts) each get the constants.
- Dependency injection convention: all side effects (including prompts: `promptEmail`, `isTTY`) are injected through `*Deps` interfaces and faked in tests; `runInstall` never throws or exits.
- Dynamic-import convention for heavy modules (`index.ts` action handlers; `inquirer` loaded lazily).
- Printable-value rule for anything printed into the install command (`install-command.ts`).
- Settings file is the only persisted install state (`getSyncSettingsPath()` = `~/.codemie/analytics-sync.json`).

### Task Statements Checked Against the Code
- "creates scheduler tasks for macOS/Windows with a hardcoded name" — holds, and also Linux (systemd unit name) — `generators.ts:13-17`. macOS name is a launchd label (also the plist filename), not a "task".
- "Add an option during wizard installation" — unverified which flow: `install` has no wizard; bootstrap wizard does not install (see Purpose B).
- "press enter to use the default (current name)" — holds as a default: `WINDOWS_TASK_NAME`/`LAUNCHD_LABEL`/`SYSTEMD_UNIT_NAME`. The default differs per platform. Existing `deps.prompt.input(message, def)` (`guided-support.ts:30`) already supports an enter-for-default pattern.
- Keeps in place: the collector-compatible constant names and the name-less `unregister()`/`query()` used by uninstall, status, and install's replace/restore (see Consumers).

### Consumers of Changed Contracts
Contract: the scheduler job identity (constants + `Scheduler` interface/`SchedulerDeps`).
- `sync/scheduler/index.ts` — all register/query/unregister helpers listed above read the constants directly.
- `sync/scheduler/generators.ts:106` — `launchdPlist` embeds the label.
- `sync/install.ts` — `snapshotPreviousInstall` (`query`), `replaceJob` (`unregister`, `register`), `restorePreviousInstall` (`unregister`, `register`).
- `sync/uninstall.ts` — `scheduler.unregister()`.
- `sync/status.ts` — `scheduler.query()`.
- Tests importing the constants: `sync/scheduler/__tests__/scheduler.test.ts:9` (PLIST_PATH, UNIT paths, schtasks args at ~l.268), `sync/scheduler/__tests__/generators.test.ts`, `sync/__tests__/install.test.ts` (fake scheduler), `uninstall.test.ts`, `status.test.ts`, `real-deps.test.ts`.
- Docs: `docs/ANALYTICS-SYNC.md:242-244` (manual `launchctl kickstart gui/$(id -u)/com.epam.codemie.analytics-sync`, `systemctl --user start codemie-analytics-sync.service`, `schtasks /Run /TN "CodeMie Analytics Sync"`) and `:344-346` (platform table); `docs/ANALYTICS-REPORT.md` also matches the names. Docs state names as fixed.
- Standalone collector (outside repo): shares the same identities by design; unverified from this repo how it behaves with a renamed job.
- Previous task docs: `docs/superpowers/tasks/2026-10-29-analytics-sync-install/` (spec/plan for the install feature).

### Architecture and Layers Affected
CLI layer (commander options in `analytics/index.ts`) -> command runners (`install.ts`, `uninstall.ts`, `status.ts`, `bootstrap/*`) -> scheduler module (`scheduler/index.ts`, `generators.ts`) -> OS (`launchctl`, `systemctl`, `schtasks`) and settings store (`config-store.ts`, `types.ts`).

### Integration Points
OS schedulers via injected `exec`; inquirer for prompts; `~/.codemie/analytics-sync.json`; `~/.codemie/analytics-sync-bootstrap.json`; standalone collector job identities.

### Patterns and Conventions
Injected deps interfaces with real factories; never-throw runners returning exit codes; `SyncConfigError` for validation (`@/utils/errors.js`); `@/` alias and `.js` imports; ES modules.

---

## 3. Documentation Findings

### Guides and Architecture Docs
`.ai-run/guides/` exists (architecture, development, standards, testing, usage, integration). `docs/ANALYTICS-SYNC.md` covers the feature and states the fixed names. `docs/COMMANDS.md` lists install options (referenced by ANALYTICS-SYNC.md:423).

### Architectural Decisions
Only the inline "collector-compatible" comments (`generators.ts:12-17`) and the earlier install task spec under `docs/superpowers/tasks/2026-10-29-analytics-sync-install/`.

### Derived Conventions
Options added to `install` flow through `InstallOptions` -> `validateInstallOptions` -> `SyncSettings`, and mirror in `InstallCommandOptions`/`buildInstallCommand` when the bootstrap-printed command must carry them.

---

## 4. Testing Landscape

### Existing Coverage
`sync/__tests__/install.test.ts`, `install-command.test.ts`, `uninstall.test.ts`, `status.test.ts`, `real-deps.test.ts`, `config-store.test.ts`; `sync/scheduler/__tests__/scheduler.test.ts` (394 lines; asserts exact launchctl/systemctl/schtasks argv and paths) and `generators.test.ts`; bootstrap tests under `sync/bootstrap/__tests__/`.

### Testing Framework and Patterns
Vitest; fake `exec`/`fs`/`SchedulerDeps`, fake `InstallDeps` with `promptEmail` mock and `isTTY` flag (`install.test.ts:33-73`). Per AGENTS.md, tests are written/run only on explicit request.

### Coverage Gaps
No test covers a non-default name (none exists). No test covers a prompt for anything other than email in `install`.

---

## 5. Configuration and Environment

### Environment Variables
None found tied to the scheduler names.

### Configuration Files
`~/.codemie/analytics-sync.json` (via `getSyncSettingsPath()`), no name field; `loadSyncSettings` ignores unknown keys.

### Feature Flags and Deployment Concerns
None found. macOS also writes launchd log `~/.codemie/logs/analytics-sync.launchd.log` (fixed name, `scheduler/index.ts registerDarwin`).

---

## 6. Risk Indicators

- Speculative: uninstall/status/restore have no way to learn a custom name unless it is persisted or passed; today they depend on constants (Consumers section).
- Speculative: install's replace step finds the prior job only by constant name; a different name would leave a previous job (including the collector's) registered alongside the new one.
- The constant names are intentionally shared with the standalone collector (`generators.ts:12-17`) — keeps-in-place mechanism; consumers listed above.
- Three independent `createScheduler(createRealSchedulerDeps())` call sites (install, uninstall, status).
- Task wording is ambiguous about which flow is the "wizard" (bootstrap wizard installs nothing; `install` has no wizard) and about Linux; names have per-platform meaning (launchd label doubles as plist filename; systemd unit base name; Windows task name).
- Name inputs flow into file paths (plist/unit filenames), `schtasks /TN`, and (if echoed in bootstrap's install command) the printable-value rule; existing validation conventions in `config-store.ts` and `install-command.ts` apply.
- Docs (`ANALYTICS-SYNC.md:242-244,344-346`, `ANALYTICS-REPORT.md`) and scheduler tests hardcode current names.
- Non-TTY / scripted installs have no prompt path (`isTTY` false).

---

## 7. Summary for Complexity Assessment

The scheduler job name is a set of three module constants in `sync/scheduler/generators.ts` consumed directly by `scheduler/index.ts` (register, query, unregister on all three platforms) and by `launchdPlist`. The `Scheduler` interface and `SchedulerDeps` carry no name; `install.ts`, `uninstall.ts` and `status.ts` each build their own scheduler. Any name override touches the scheduler module, the install runner and its deps (prompt injection follows the existing `promptEmail`/`isTTY` pattern), types/options, and, because uninstall/status/restore are name-less today, those paths too. The `bootstrap` wizard is a separate flow that only prints an install command via `buildInstallCommand`.

Nothing in the repo is novel technically: patterns (DI deps, inquirer prompts with defaults, commander options, settings validation) all exist. Code surface is roughly 6-9 source files plus docs. Test posture is good: scheduler, install, uninstall, status and install-command all have Vitest suites with fakes, and several assert exact names/paths and would need updating for any signature change.

Key risks: which flow is the "wizard"; persistence/discovery of the name for uninstall/status/replace; collector compatibility of the fixed identities; per-platform meaning of "name"; input validation of a value that becomes a filename/CLI argument; docs that state fixed names.

---

## 8. External References

None named by the task.
