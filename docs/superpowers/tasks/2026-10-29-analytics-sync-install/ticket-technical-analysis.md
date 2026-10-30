# Technical Research

**Task**: analytics collector scheduler webhook quickstart cron launchd schtasks export codemie analytics CLI command
**Generated**: 2026-10-28
**Research path**: filesystem
**Workspace root**: `/Users/Oleksandr_Voievodin1/projects/AI_RUN/codemie-dev`. Repositories: `codemie-code` (`codemie-code/`, rev `19c2166b`, change-owning), `codemie-onboarding` (`codemie-onboarding/`, rev `f8a4204`, read-only reference).

**Slice**: scheduler (child of `../../technical-analysis.md`). Covers install, scheduled/manual run, status, uninstall and take-over. The lead-side bootstrap wizard (quickstart generation, admin wizard, §9 of the parent) belongs to the sibling slice `bootstrap-wizard`. The install-command contract in §8 is what that sibling produces.

---

## 1. Original Context

Add the codemie-onboarding/codemie-analytics-collector functionality into the codemie-code CLI so codemie-code users get the collector's capabilities without downloading the collector: (1) install a scheduler into the OS (cron/launchd/Windows Task Scheduler) that runs the analytics export and POSTs it to a configured webhook; (2) generate a pre-configured quickstart command that leads send to developers to set up the scheduler; (3) a status command showing scheduler state (enabled/disabled, lookback window, execution time, last execution time). Basically the quickstart and setup scripts of the collector. Out of scope: the collector's auto-update (handled by codemie-code update workflows), keeping the codemie-analytics-collector repo in sync, enhancing analytics. Define best-fit CLI subcommands and plan the integration.

---

## 2. Codebase Findings

**Repository impact**: `codemie-code` is **affected**. The new subcommands land under `src/cli/commands/analytics/`. `codemie-onboarding` is **not_affected**. It is a read-only reference, and the task puts keeping it in sync out of scope.

### Existing Implementations
- `codemie-code:src/cli/index.ts:24,95`: `createAnalyticsCommand()` is imported and registered with `program.addCommand`. Every top-level command is a `createXCommand(): Command` factory registered here.
- `codemie-code:src/cli/commands/analytics/index.ts:26-49`: the `analytics` parent command has its own `.action(runAnalytics)` plus one subcommand, `otel`, added with `command.addCommand(otel)`. Shared options are registered on both the parent and the subcommand. As a result, `otel` has to use `command.optsWithGlobals()` (comment at lines 37-40).
- `codemie-code:src/cli/commands/analytics/index.ts:72-290`: `runAnalytics(options, source)`:
  - Validates `--export html|json|both` before loading anything.
  - When no sessions match, it prints "No sessions found…" and returns. It writes no file and leaves the exit code at 0. The collector's skip-on-empty logic depends on this behavior.
  - On an unexpected error it calls `process.exit(1)`.
  - It reads `userEmail` through `ConfigLoader.loadMultiProviderConfig()`. If the email is missing it prompts with inquirer, but only when `process.stdout.isTTY`.
  - It writes the JSON report to `cwd` unless `-o` is given.
- `codemie-code:src/cli/commands/analytics/index.ts:356-379`: `parseDuration` accepts `^\d+[dhm]$`. An invalid `--last`, `--from` or `--to` value is only warned about and the filter is dropped. The collector validates periods itself for this reason (`src/backfill.js` header).
- `codemie-code:src/cli/commands/analytics/report/report-generator.ts:64-80`: default export name. `emailSlug()` keeps the address's case. The JSON report is named `codemie-analytics-<slug>-<YYYY-MM-DD>.report.json`, using the UTC date.
- `codemie-code:src/cli/commands/analytics/report/output-target.ts`: `resolveOutputTargets(format, output, cwd, userEmail)` handles a directory target or a file target for `-o`.
- `codemie-code:src/utils/paths.ts:367-387`: `getCodemieHome()` returns `CODEMIE_HOME` or `~/.codemie`. `getCodemiePath(...)` builds paths under it.
- `codemie-code:src/utils/config.ts:57,593`: the global config is `~/.codemie/codemie-cli.config.json`. `ConfigLoader.saveUserEmail()` writes `userEmail` to it.
- `codemie-code:src/utils/processes.ts`: provides `commandExists`, `getCommandPath`, `spawnDetached` and `npxRun`.
- **Search limits**: grep finds no `launchctl`, `schtasks`, `crontab` or `systemctl` usage in `codemie-code/src`. There is no OS-scheduler code in codemie-code today.

### Architecture and Layers Affected
- **CLI command layer**: commander v11 command factories (`src/cli/commands/**`) and their registration in `src/cli/index.ts`.
- **Analytics domain**: `src/cli/commands/analytics/` (export path and report naming).
- **Utils/config**: `src/utils/paths.ts` (CodeMie home) and `src/utils/config.ts` (userEmail).
- **CLI bootstrap**: `codemie-code:bin/codemie.js:20-44` runs `MigrationRunner` and then `checkAndPromptForUpdate()` on every start. Both would run for an invocation made by a scheduler.

### Integration Points
- **Outbound HTTPS**: codemie-code has no webhook client. `src/utils/system-proxy-dispatcher.ts` (`installSystemProxyDispatcher`, called at `src/cli/index.ts:46`) sets up a global proxy dispatcher, so a `fetch` POST would go through the system proxy.
- **Auto-update**: `codemie-code:src/utils/cli-updater.ts:345-400` rate-limits update checks to once per 24h:
  - Auto mode (the default) runs a silent `updateCli` under a lock.
  - Prompt mode (`CODEMIE_AUTO_UPDATE=false`) calls `promptForCliUpdate`.
- **OS schedulers**: launchd, systemd user timers and `schtasks`, through `execFileSync` (collector reference, Section 8).

### Patterns and Conventions
- Command factories return a `Command`. Grouped commands live in a folder with an `index.ts` (`profile/`, `doctor/`, `proxy/`, `analytics/`).
- Heavy modules are loaded with dynamic `await import()` inside actions (`analytics/index.ts:158-161`).
- Output uses `chalk` for messages and `logger` from `src/utils/logger.js` for errors. `ora` is used for spinners.
- The collector designs for testability: pure generator functions for plist, systemd and Task Scheduler XML, plus injectable side effects (`runCollect({ exportAnalytics, send, now, log })`).

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `codemie-code:.ai-run/guides/testing/testing-patterns.md`: co-located `src/**/__tests__/*.test.ts`, nested `describe` blocks, `vi.mock` at module level, `vi.spyOn` in `beforeEach`.
- `codemie-code:.ai-run/guides/architecture/architecture.md`, `security/security-practices.md`, `development/development-practices.md` and `quality-gates.md` all apply. None of them covers scheduling.
- `codemie-code:docs/COMMANDS.md:624` (Analytics Commands) and `:1373` (`codemie analytics`), plus `docs/ANALYTICS-REPORT.md`: these document the commands and would gain new entries.
- `codemie-onboarding:codemie-analytics-collector/README.md` and `docs/design.md` (37 KB, with a "Known gaps" section) and `docs/client-setup.md`: reference behavior.

### Architectural Decisions
- In the collector, `src/scheduler.js:8-10` rules out plain cron: "a laptop asleep at the scheduled time would silently skip that day". Every platform catches up a missed run instead: launchd on wake, systemd `Persistent=true`, Task Scheduler `StartWhenAvailable`.
- The collector writes the Task Scheduler definition as XML through `schtasks /Create /XML`, not PowerShell. The reasons given: no execution-policy problem and no PowerShell dependency (`scheduler.js:118-127`).
- The webhook URL's `sig` parameter is its whole authorization. Errors redact it (`webhook.js:520-524`), config files holding it are written with mode 600, and parse errors never quote the file.
- No retries: the rolling window makes the next successful run self-healing (`bin/collect.js` header).
- Prior decision (user memory dated 2026-09-28): "Moving the collector into the codemie CLI was rejected ('keep it separate')". This task reverses that decision. The memory also recorded a deferred alternative: a public npm package.

### Derived Conventions
- One log line per run, appended to `~/.codemie/logs/analytics-sync.log` and echoed to stderr. The line starts with `ok sent`, `skip`, or `fail <setup|send|export|usage>`.

---

## 4. Testing Landscape

### Existing Coverage
- `codemie-code:src/cli/commands/analytics/__tests__/`:
  - `analytics-output-writes.test.ts` drives `runAnalytics` against real temp-dir writes, with the aggregator, cost and payload modules mocked.
  - `analytics-cli-metadata.test.ts` covers the export metadata.
  - Other files cover the loaders, the aggregator and the formatter.
- `codemie-code:src/cli/commands/__tests__/self-update.test.ts`: the command-test pattern. It mocks modules with `vi.mock`, spies on `console.log` and `process.exit`, then calls `await createXCommand().parseAsync(['node','x',...])`.
- `codemie-code:tests/integration/analytics.test.ts`, `analytics-auth-gate.test.ts` and `cli-commands/*.test.ts` spawn `bin/codemie.js` against the built dist with an isolated temp `CODEMIE_HOME`. Helpers live in `tests/helpers/` (`cli-runner.ts`, `test-isolation.ts`, `temp-workspace.ts`).
- Collector reference tests, in `node:test`: `test/scheduler.test.js` (pure generators), `collect.test.js` (23 KB, full in-process runs with injected fakes), plus `marker`, `lookback`, `webhook`, `export`, `install-args` and `wizard` tests. These can serve as case lists to port.

### Testing Framework and Patterns
- Vitest `^4.1.5` with projects `unit` (`src/**/*.test.ts`), `cli` (`tests/integration/**`, agent tests excluded) and `agent`.
- The unit project sets `CODEMIE_HOME` to `tmpdir()/codemie-test-home-<pid>` and `NODE_ENV=test` (`vitest.config.ts`). `bin/codemie.js` skips the update check when `NODE_ENV=test` or `VITEST=true`.

### Coverage Gaps
- codemie-code has no tests for scheduling, webhook delivery, marker or lookback handling, or the quickstart command. All of these areas are new.
- No test exercises `runAnalytics` with no TTY and a missing `userEmail`. That is the path a scheduled run takes.

---

## 5. Configuration and Environment

### Environment Variables
- codemie-code: `CODEMIE_HOME`, `CODEMIE_AUTO_UPDATE`, `NODE_ENV`, `VITEST`.
- Collector (reference): `ANALYTICS_WINDOW`, `ANALYTICS_WEBHOOK_URL`, `ANALYTICS_CODEMIE_BIN`, `ANALYTICS_INCLUDE_EXTERNAL`, `ANALYTICS_LOOKBACK_DAYS`, `ANALYTICS_MAX_EXPORT_BYTES`, `ANALYTICS_AUTO_UPDATE`, `COLLECTOR_DIR`, `COLLECTOR_REPO_URL`, `NO_COLOR` (README table, lines 410-422).

### Configuration Files
- `~/.codemie/codemie-cli.config.json`: the CLI config, the source of `userEmail`.
- Collector files in `~/.codemie`:
  - `analytics-sync.json` (mode 600): `{ window: "7d", codemieBin, webhookUrl?, includeExternal?, lookbackDays? }`.
  - `analytics-last-sent`: one ISO UTC timestamp line, mode 600.
  - `logs/analytics-sync.log` and `logs/analytics-sync.launchd.log`.
  - `analytics-setup.json`: the admin wizard's answers, including the webhook.
  - `codemie-onboarding/`: the managed clone.

### Feature Flags and Deployment Concerns
- There are no feature flags. The collector's `destination.json` (in `codemie-onboarding`) holds a live webhook URL and is a secret. Its value is not reproduced here.
- On Windows npm installs `codemie` as a `.cmd` shim. The collector runs it through `cmd.exe /d /s /c` with verbatim quoting to work around CVE-2024-27980 (`export.js:spawnPlan`).

---

## 6. Risk Indicators

- **Scheduled runs go through CLI startup.** A run through `bin/codemie.js` executes migrations and `checkAndPromptForUpdate()` (`bin/codemie.js:20-44`).
  - In auto mode this can run `npm install -g` from a launchd or schtasks context.
  - In prompt mode (`CODEMIE_AUTO_UPDATE=false`) `promptForCliUpdate` may block or fail with no TTY.
- **Missing email under a scheduler.** With no TTY, `runAnalytics` skips the email prompt and names the export without a slug. The collector instead resolves the email from `codemie-cli.config.json`, then `git config user.email`, and fails with `IdentityError` if neither works (`identity.js`).
- **Error exits.** `runAnalytics` calls `process.exit(1)` on error and prints to the console. Speculative: reusing it in-process for a scheduled run would need a non-exiting variant that returns the written path.
- **Slug case mismatch.** The CLI's `emailSlug` keeps case and the collector's lowercases. Downstream SharePoint/harvester naming expects the collector's lowercase `codemie-analytics-<slug>-<date>.report.json`.
- **Scheduler choice.** The ticket says "cron". The reference deliberately uses launchd, systemd user timers and schtasks because plain cron skips runs missed during sleep. On Linux, `loginctl enable-linger` is needed for the job to run while the user is logged out.
- **Stable job target.** Scheduled jobs record absolute paths: the node binary, the entry script and `CODEMIE_HOME`. Speculative: a version-manager node path (for example nvm) or a `codemie` install that moves (see the dual-install PATH memory) would break the job after updates.
- **Migration overlap.** Machines that already run the collector have job labels `com.epam.codemie.analytics-sync`, `codemie-analytics-sync.timer` and `CodeMie Analytics Sync`, plus the same `~/.codemie` files. Speculative: reusing or replacing these labels and files needs a defined migration rule, otherwise two jobs will double-send.
- **Secret handling.** The webhook URL's `sig` must never reach logs, status output or errors. The quickstart command embeds the URL in clear text by design.
- **Known data gap.** Sessions are selected by start time only (`data-loader.ts`), which is why the 7-day lookback exists. The lookback/marker logic therefore has to be ported unchanged.
- **Subcommand option binding.** The `analytics` parent command has an action and shared options, and neither it nor the root program calls `enablePositionalOptions()`. Commander therefore binds a parent option to `analytics` even when it is typed after a subcommand (the quirk documented for `otel`, `analytics/index.ts:41-45`). `analytics` registers a boolean `--include-external` plus `--from`, `--to`, `--last`, `--output` and the other shared filters, so `codemie analytics sync install --include-external windows` would set the parent's boolean and leave `windows` as an excess argument, which commander 11 rejects. The same applies to `bootstrap --include-external`. Fixes: call `.enablePositionalOptions()` on `analytics` (check that `analytics otel --export …` still works, since its shared options then bind to `otel`, which registers them too), or give the `sync` options names `analytics` does not use. `proxy/index.ts:125,305` already uses `enablePositionalOptions()` for nested groups (see `proxy/__tests__/connect-wiring.test.ts`).

---

## 7. Summary for Complexity Assessment

The change belongs entirely to `codemie-code`'s CLI command layer, under `src/cli/commands/analytics/`. It adds a new sub-tree for scheduling, running and delivery, and a status view, registered through the existing `createAnalyticsCommand` factory. It touches three supporting areas:
- the analytics export path: `runAnalytics`, `resolveOutputTargets` and `emailSlug`;
- CodeMie home and config helpers: `getCodemieHome` and `ConfigLoader`;
- the CLI bootstrap in `bin/codemie.js`, because scheduled runs invoke it.

codemie-code has no OS-scheduler, webhook or marker code today. Everything in that area is new to this repository, but a complete, tested reference exists in `codemie-onboarding/codemie-analytics-collector`: about 1,000 lines of plain JS across scheduler, marker, lookback, webhook, export, config, destination, identity and install-args. Porting it to TypeScript is moderate work in volume and well specified.

The new parts are the per-platform scheduler registration (launchd plist, systemd service and timer, UTF-16 schtasks XML) and making a non-interactive scheduled invocation of the CLI safe. Both are platform-specific and hard to test outside CI, though the reference keeps its generators pure, so they can be unit-tested on any OS.

Test coverage for the new surface is zero. The reference `node:test` suites (scheduler, collect, marker, lookback, webhook, install-args, wizard) give ready-made case lists to port to Vitest.

The main risks:
- update and migration side effects when the CLI starts under a scheduler;
- email and attachment-name consistency (slug case);
- coexistence with, or migration from, collector installs that use the same job labels and `~/.codemie` files;
- keeping the webhook signature out of every output.

A recorded earlier decision rejected moving the collector into the CLI. This task reverses it.

---

## 8. External References

Source named by the task: `codemie-onboarding/codemie-analytics-collector`. It resolved at `/Users/Oleksandr_Voievodin1/projects/AI_RUN/codemie-dev/codemie-onboarding/codemie-analytics-collector` (rev `f8a4204`, Node ≥20, ESM, no dependencies).

**Install arguments** (`bin/install.js` and `src/install-args.js`): `--at HH:MM` (default 03:00), `--webhook <https url>`, `--include-external windows|always|never` and `--lookback-days <1-30>|default`. Unknown flags are reported without their value.

Install steps:
1. Resolve absolute `nodeBin` (`process.execPath`) and `codemieBin` by scanning PATH, with PATHEXT on Windows (`prereqs.js`).
2. Build the config with `installerConfig()`. It keeps the stored webhook, policy and lookback unless a flag overrides them.
3. Resolve the destination: `ANALYTICS_WEBHOOK_URL`, then `analytics-sync.json`, then `destination.json`. If none is set, the install aborts. The URL must be `https:`.
4. Write `analytics-sync.json` with mode 600 and register the schedule.

**Scheduler** (`src/scheduler.js`):
- **macOS**: plist at `~/Library/LaunchAgents/com.epam.codemie.analytics-sync.plist`.
  - Keys: `ProgramArguments [node, collect.js]`, `EnvironmentVariables{CODEMIE_HOME, PATH=<dir(node)>:/usr/bin:/bin}`, `StartCalendarInterval{Hour,Minute}`, `StandardErrorPath=…/logs/analytics-sync.launchd.log`, `RunAtLoad=false`.
  - Registered with `launchctl bootout gui/<uid>/<label>` and then `launchctl bootstrap gui/<uid> <plist>`.
- **Linux**: `~/.config/systemd/user/codemie-analytics-sync.{service,timer}`.
  - The service is `Type=oneshot`. The timer uses `OnCalendar=*-*-* HH:MM:00`, `Persistent=true` and `RandomizedDelaySec=300`.
  - Registered with `systemctl --user daemon-reload`, `enable --now`, then `loginctl enable-linger $USER`.
- **Windows**: task `CodeMie Analytics Sync`, defined in Task Scheduler XML encoded as UTF-16LE with a BOM.
  - Settings: `CalendarTrigger` daily, `RandomDelay PT5M`, `InteractiveToken` with `LeastPrivilege`, `DisallowStartIfOnBatteries=false`, `StopIfGoingOnBatteries=false`, `StartWhenAvailable`, `IgnoreNew`, `ExecutionTimeLimit PT30M`.
  - Registered with `schtasks /Delete /F` and then `/Create /XML <tmp>`. The temp file is then deleted.
- **Uninstall** (`uninstallSchedule`): bootout or disable plus file removal. It returns `{removed, survived}` and re-queries the scheduler (`launchctl list`, `systemctl is-enabled`, `schtasks /Query`) to report whether the job survived.

**State files and lookback**:
- `analytics-last-sent` (`src/marker.js`) holds an ISO UTC timestamp as the file's content, with mtime as a fallback. It is written only after the webhook accepts a daily run, never after a backfill.
- The window is `max(ceil(gapHours)+1, lookbackDays*24)` hours. With no marker, or a marker in the future, it is `max(fallback 7d, lookback)`.
- Lookback (`src/lookback.js`) is taken from `ANALYTICS_LOOKBACK_DAYS`, then `analytics-sync.json`, then `destination.json`, then the default of 7. The range is 1-30.

**Collect run** (`src/collect.js`):
1. Parse the backfill arguments (`--last Nd|Nh`, `--from/--to`).
2. Auto-update. This step is out of scope here.
3. Load the config and resolve the destination, include-external policy, lookback and email.
4. `mkdtemp`, then run `codemie analytics --last <window> --export json [--include-external]` with `cwd` set to the temp dir and no `-o` (`export.js:analyticsArgs`).
5. If no `.json` was produced, log `skip … no sessions in the last <window>` and exit 0 without touching the marker.
6. Otherwise name the attachment with `attachmentName()`: the CLI file name with its own slug replaced by the lowercased email slug, giving `codemie-analytics-<slug>-<date>.report.json`. A backfill uses `<from>-to-<to>` in place of the date.
7. POST the file, write the marker, and log `ok sent <file> (<bytes> bytes, window …)`.

On failure the run logs one `fail …` line and exits 1.

The include-external policy is `windows` by default, which turns the flag on only on win32: there the ownership lookup fails and the export would otherwise be empty.

**Webhook** (`src/webhook.js`): one POST with `Content-Type: application/json` and body `{"type":"message","attachments":[{"contentType":"application/json","name":<filename>,"contentBytes":<base64>}]}`.
- Size limit: `MAX_EXPORT_BYTES = 70,000,000`, below Power Automate's 100 MB per request once base64 is applied. `ANALYTICS_MAX_EXPORT_BYTES` can only lower it.
- Errors are a non-2xx status (`DeliveryError`, at most 300 characters of the body, `sig` redacted) or an oversize export (`ExportTooLargeError`). There is no retry.
