# Analytics sync install/run/status/uninstall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the branch's `analytics sync` / `sync config` surface with `codemie analytics sync install|status|run|uninstall`, driven by a daily per-user OS job that takes over the standalone collector.

**Architecture:** Rework `src/cli/commands/analytics/sync/` to one webhook target with collector-compatible state paths. Add a `sync/scheduler/` module (pure launchd/systemd/Task Scheduler generators + thin exec-based register/unregister/query). Install, status and uninstall are injected-deps runners like `runSync`; `index.ts` only wires them.

**Tech Stack:** TypeScript ESM, Commander, inquirer, Vitest 4, `exec()` from `src/utils/exec.ts`.

**Spec:** `docs/superpowers/tasks/2026-10-29-analytics-sync-install/spec.md` (ACs in `story.md` same folder). Research: `technical-analysis.md`.

Commit per task using the repository's existing convention.

## Global Constraints

- Paths via `getCodemiePath()`: settings `analytics-sync.json` (mode 0600 + chmod), marker `analytics-last-sent`, log `logs/analytics-sync.log` (dir 0700, file 0600). No `~/.codemie/analytics/sync/` paths remain.
- Job identities: `com.epam.codemie.analytics-sync` (plist in `~/Library/LaunchAgents/`), `codemie-analytics-sync.{service,timer}`, task `CodeMie Analytics Sync`.
- Webhook signature never in output: every printed/logged string goes through `redactSecrets`; status/summary show host only.
- No `ANALYTICS_*` env reads; webhook URL never in CredentialStore; no retries; no cron.
- Shared `emailSlug` (`report/report-generator.ts:64`) and `codemie analytics` / `otel` behaviour unchanged.

## Review Focus

- Collector marker with empty/garbage content: falls back to file mtime, not "never sent" (Task 1 test).
- Webhook URL with `sig=` inside an error cause chain (fetch failure): `fail send` line is redacted (Task 2 test).
- Re-install with `--lookback-days` omitted after an install that set it: stored `lookbackDays` removed, default 7 applies (Task 1 test).
- Scheduler registration throws after settings were written: settings deleted, exit non-zero, marker untouched (Task 5 test).
- Log with no `ok|skip|fail` line (e.g. only legacy collector lines in other format): status says "never", no throw (Task 6 test).

---

### Task 1: Collector-compatible state store

**Files:** Modify `sync/types.ts`, `sync/config-store.ts`, `sync/marker.ts`, `src/utils/errors.ts:50-92`, `.ai-run/guides/security/security-practices.md` (sync webhook exception path). Tests: `sync/__tests__/config-store.test.ts`, `sync/__tests__/marker.test.ts` (rewrite).

**Interfaces — Produces:**
```ts
interface SyncSettings { webhookUrl: string; includeExternal: IncludeExternalPolicy; at: string; lookbackDays?: number }
interface InstallOptions { webhook?: string; at?: string; lookbackDays?: string; includeExternal?: string }
const DEFAULT_LOOKBACK_DAYS = 7; const DEFAULT_AT = '03:00';
function getSyncSettingsPath(): string;                    // getCodemiePath('analytics-sync.json')
function validateInstallOptions(o: InstallOptions): SyncSettings; // throws SyncConfigError naming the option
async function loadSyncSettings(path?): Promise<SyncSettings | null>; // ENOENT → null; invalid → SyncConfigError
async function writeSyncSettings(s: SyncSettings, path?): Promise<void>; // whole-file overwrite, 0600 + chmod
async function deleteSyncSettings(path?): Promise<boolean>;        // false when absent
async function readMarker(now: Date, path?): Promise<Date | null>;  // getCodemiePath('analytics-last-sent')
async function writeMarker(at: Date, path?): Promise<void>;
```
Remove `SyncConfig`, `SyncConfigUpdate`, `applySyncUpdate`, `validateSyncUpdate`, `SyncTarget`, per-target marker ids.

- [ ] Test-first: yes — `validateInstallOptions` rejects missing/`http:`/malformed `--webhook`, `--at 24:00`/`3:7`, `--lookback-days 0|31|2.5`, `--include-external sometimes`, each message naming the flag; omitting lookback yields no `lookbackDays` key and defaults `at:'03:00'`, `includeExternal:'windows'`; written file is mode 0600 and a pre-existing collector JSON is replaced wholesale; `readMarker` returns file mtime for empty/invalid content and null for a future ISO value; `SyncTargetMissingError`/`SyncIdentityMissingError` messages contain `codemie analytics sync install` and not `sync config`.
- [ ] Implement; keep the existing https/URL/policy/lookback validators, add `--at` as `/^([01]\d|2[0-3]):[0-5]\d$/`.
- [ ] Update the security guide exception to `~/.codemie/analytics-sync.json`. Run the two test files: PASS.

### Task 2: Single-webhook run with outcome lines

**Files:** Modify `sync/window.ts` (delete `backfillWindow`, `BackfillWindowOptions`, `backfill` flag, `date-args` import), `sync/report-builder.ts` (lowercase slug, drop backfill name branch `:63-65`), `sync/run-sync.ts`, `sync/targets/webhook-target.ts` (take URL, no `SyncTarget` interface). Tests: `window.test.ts`, `report-builder.test.ts`, `run-sync.test.ts` (drop backfill/AC6/inverted cases).

**Interfaces — Consumes:** Task 1 `loadSyncSettings`, `readMarker`, `writeMarker`. **Produces:**
```ts
interface SyncDeps { now(); loadSettings(): Promise<SyncSettings|null>; resolveIdentity(): Promise<string>;
  buildReport: typeof buildSyncReport; send(url: string, report: SyncReport): Promise<void>;
  readMarker(now: Date): Promise<Date|null>; writeMarker(at: Date): Promise<void>;
  appendLog(line: string): Promise<void>; print(line: string): void; platform: NodeJS.Platform; source: AnalyticsSource }
async function runSync(deps: SyncDeps): Promise<number>;
function formatLogLine(at: Date, outcome: 'ok'|'skip'|'fail', rest: string): string; // `${iso} ${outcome} ${rest}`, redacted
```
Line shapes: `ok sent <name> <bytes>`, `skip <reason>`, `fail <export|send|setup> <detail>`. Mapping: null settings / identity / policy / `SyncConfigError` → `setup`; build errors and `ExportTooLargeError` (detail includes bytes) → `export`; `SyncDeliveryError` / network → `send`.

- [ ] Test-first: yes — fake deps: null settings → `fail setup` mentioning `codemie analytics sync install`, `send` never called, exit 1; 2xx → marker written with `now()` and `ok sent codemie-analytics-jane.doe-<date>.report.json <n>` for email `Jane.Doe@x.com`; null report → `skip`, marker unchanged, exit 0; send rejects with cause containing `sig=abc` → `fail send`, line has no `abc`, marker unchanged, exit 1; `ExportTooLargeError` → `fail export` with size; identity throws → `fail setup`; window from marker 10 days ago with lookback 7 starts ≥10 days back.
- [ ] Implement; lowercase applied in `report-builder.ts` only (`emailSlug(email.toLowerCase())`). Remove temp-dir write and `makeTempDir/removeDir`. Never throws.
- [ ] Run the sync test folder: PASS.

### Task 3: OS scheduler module

**Files:** Create `sync/scheduler/generators.ts`, `sync/scheduler/index.ts`. Tests: `sync/scheduler/__tests__/generators.test.ts`, `sync/scheduler/__tests__/scheduler.test.ts`.

**Interfaces — Produces:**
```ts
interface JobCommand { node: string; entry: string; args: string[] } // args = ['analytics','sync','run','--scheduled']
function launchdPlist(cmd: JobCommand, at: string, logPath: string): string;
function systemdUnits(cmd: JobCommand, at: string): { service: string; timer: string };
function taskSchedulerXml(cmd: JobCommand, at: string): string;
function resolveJobCommand(): Promise<JobCommand>; // process.execPath + realpath(process.argv[1])
interface SchedulerDeps { platform: NodeJS.Platform; exec: typeof exec; homedir(): string; uid(): number; fs: ... }
function createScheduler(deps): { preflight(): Promise<void>; register(cmd, at): Promise<{ lingerWarning?: string }>;
  unregister(): Promise<boolean>; query(): Promise<'enabled'|'disabled'> }
```
Generator values per spec "OS scheduler" (StartCalendarInterval, RunAtLoad false; Type=oneshot, `OnCalendar=*-*-* HH:MM:00`, Persistent=true, RandomizedDelaySec=300; StartWhenAvailable, IgnoreNew, InteractiveToken/LeastPrivilege, PT30M). Windows XML written UTF-16LE with BOM to a temp file for `schtasks /Create /XML`. Preflight throws a new `SyncSchedulerUnsupportedError` (in `src/utils/errors.ts`) for non darwin/linux/win32 or when `systemctl --user show-environment` fails. Unregister re-queries and tolerates absence. Linger failure returns `lingerWarning`, not a throw.

- [ ] Test-first: yes — generators: plist contains label, hour/minute ints from `'07:05'`, `RunAtLoad` false, XML-escaped paths; timer has `OnCalendar=*-*-* 07:05:00` and `Persistent=true`; Task XML has `StartWhenAvailable` true and `<Command>` = node path (no `.cmd`); scheduler with fake exec: linux preflight fails when `systemctl --user` errors and calls nothing else; register order `bootout` → `bootstrap gui/<uid>` (darwin), `daemon-reload` → `enable --now` → `loginctl enable-linger` (linux), `/Delete /F` → `/Create /XML` (win32); `query` maps not-listed / `is-enabled` ≠ `enabled` / schtasks Disabled to `disabled`.
- [ ] Implement. Run both test files: PASS.

### Task 4: Unattended scheduled start

**Files:** Create `src/utils/scheduled-run.ts`; modify `bin/codemie.js:21-44`. Test: `src/utils/__tests__/scheduled-run.test.ts`.

**Produces:** `isScheduledSyncRun(argv: string[]): boolean` — true only when argv contains `analytics`, `sync`, `run` in order and `--scheduled`.

- [ ] Test-first: yes — true for `['node','codemie','analytics','sync','run','--scheduled']`; false for manual `sync run`, for `--scheduled` without `run`.
- [ ] In `bin/codemie.js` import from `../dist/utils/scheduled-run.js`; when true run migrations with `silent: true` and skip `checkAndPromptForUpdate()` and the what's-new block. Run test: PASS.

### Task 5: Install runner

**Files:** Create `sync/install.ts`. Test: `sync/__tests__/install.test.ts`. Modify `sync/identity.ts` only if a prompt hook is needed.

**Interfaces — Consumes:** Tasks 1, 3. **Produces:** `runInstall(opts: InstallOptions, deps: InstallDeps): Promise<number>`; `InstallDeps` = scheduler, settings write/delete, `resolveIdentity`, `isTTY`, `promptEmail(): Promise<string>`, `saveUserEmail`, `collectorDirExists()` (`getCodemiePath('codemie-onboarding')`), `resolveJobCommand`, `print`.
Order fixed by spec: validate → preflight → email → detect collector → unregister → write settings → register → summary.

- [ ] Test-first: yes — bad option fails before any scheduler call; unsupported platform writes nothing; no email + no TTY fails with instructions and registers nothing; no email + TTY prompts, validates with `EMAIL_REGEX` (move from `index.ts:34` into `sync/identity.ts`), calls `saveUserEmail`; register throws → `deleteSyncSettings` called, exit 1; collector dir present → output says the job was taken over and the folder can be deleted, `writeMarker` never called; summary contains `03:00`, `7 days (default)`, `windows`, webhook host, email, `sync run` and `sync status` hints, and no `sig` value; linger warning printed.
- [ ] Implement with inquirer `input` prompt. Run test: PASS.

### Task 6: Status and uninstall runners

**Files:** Create `sync/status.ts`, `sync/uninstall.ts`. Tests: `sync/__tests__/status.test.ts`, `sync/__tests__/uninstall.test.ts`.

**Produces:** `runStatus(deps): Promise<number>`, `runUninstall(deps): Promise<number>`, `parseLastRun(log: string): { at: string; outcome: string } | null` (last line matching `^<ISO> (ok sent|skip|fail \w+)`).

- [ ] Test-first: yes — no settings → "not installed" + install command, exit 0; `query` disabled → "disabled" + "run install again"; enabled shows time, lookback, policy, host only, last run outcome from the final matching log line, last send from marker; missing log/marker or no matching line → "never"; uninstall calls `unregister` and `deleteSyncSettings`, keeps marker and log; second uninstall prints "nothing to remove", exit 0.
- [ ] Implement. Run tests: PASS.

### Task 7: CLI wiring

**Files:** Modify `src/cli/commands/analytics/index.ts:34,44-185`. Test: `__tests__/analytics-sync-cli.test.ts` (replace `sync config` blocks `:85-170`, keep `:171-201` regressions retargeted to `install`).

- [ ] Test-first: yes — `sync --help` lists `install`, `status`, `run`, `uninstall` with "Developer: register the daily delivery job on this machine" and a one-way-to-webhook group description; `sync install --webhook https://h/x --include-external windows` reaches `runInstall` with `includeExternal:'windows'` and no "unexpected argument"; `sync run --scheduled` accepted and hidden from help; `sync config`, `--from/--to/--last` on `sync` are unknown; `analytics` and `otel` regression tests unchanged and passing.
- [ ] Make `sync` a pure group; add four subcommands with dynamic-import actions setting `process.exitCode`; delete `createSyncConfigCommand`, `runSyncConfig`, `SyncConfigCliOptions`; keep `.enablePositionalOptions()`. Run test: PASS.

### Task 8: Documentation

**Files:** `docs/COMMANDS.md` (add sync reference near `:624`), `docs/ANALYTICS-REPORT.md:374-392` (replace "Scheduled upload"), `.ai-run/guides/integration/exposed-api.md`.

- [ ] Test-first: no — docs only. Document the four subcommands and options, per-platform job (launchd / systemd user timer + linger / Task Scheduler, catch-up), state paths, and collector migration (install takes over the job, keeps the marker, onboarding folder can be deleted). Remove all `sync config` and backfill examples.
