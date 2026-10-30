# Technical Research

**Task**: analytics sync scheduler
**Generated**: 2026-10-29
**Research path**: filesystem
**Repo state**: branch `EPMCDME-16488_analytics-sync-install`, 8 commits on `origin/main` (EPMCDME-16554 sync core) plus uncommitted review fixes. Collector facts come from `ticket-technical-analysis.md` §8 (same folder), not re-explored.

---

## 1. Original Context

Implement EPMCDME-16488 "Analytics sync: install, run, status, uninstall" — the approved story is at /home/oleksiiyurchenko/codemie-code/docs/superpowers/tasks/2026-10-29-analytics-sync-install/story.md (read it for ACs and out-of-scope). It supersedes EPMCDME-16554 (sync core) and EPMCDME-16555 (setup/schedule/takeover), both closed as duplicates.
IMPORTANT current state: branch EPMCDME-16488_analytics-sync-install already carries an earlier implementation of the superseded sync-core story — 8 commits on top of origin/main (git log origin/main..HEAD) plus uncommitted review fixes in the working tree — under src/cli/commands/analytics/sync/ (config-store, markers/window incl. backfill, identity, policy, report-builder, targets/webhook-target, run-sync, errors/types, redaction) and CLI wiring in src/cli/commands/analytics/index.ts exposing `codemie analytics sync` + `sync config` with --from/--to/--last backfill. The new story changes the surface to `sync install|status|run|uninstall`, drops backfill and `sync config`, adds a cross-platform daily OS scheduler (launchd / systemd user timer with linger / Windows Task Scheduler), standalone-collector takeover, status, uninstall, run-log outcome lines `ok sent|skip|fail <export|send|setup>`, interactive email prompt only in install with a TTY, no update check/prompt when run by the scheduler. Your analysis must map each story AC to: reusable as-is / needs change / new, naming files; and list existing code to delete (no longer relevant — the new story wins).
A prior analysis written before this code existed is at /home/oleksiiyurchenko/codemie-code/docs/superpowers/tasks/2026-10-29-analytics-sync-install/ticket-technical-analysis.md — use it as a reference for the standalone collector (scheduler.js, job names, marker paths) instead of re-exploring it. Never copy the live webhook URL from the collector's destination.json.

---

## 2. Codebase Findings

### Existing Implementations
All under `src/cli/commands/analytics/` unless noted (994 lines in `sync/`).
- `sync/types.ts` — `SyncTarget`/`SyncReport`, `IncludeExternalPolicy`, `SyncConfig {targets.webhook?.url, includeExternal, lookbackDays}`, `SyncResult {status: ok|skip|fail, category, detail}`. Multi-target abstraction; only `webhook` exists.
- `sync/config-store.ts` — path `getCodemiePath('analytics','sync','config.json')`; load (ENOENT → defaults), strict validation of stored values, `validateSyncUpdate` (https URL, policy enum, lookback 1-30 integer), `applySyncUpdate` merge + write mode 0600 + chmod. No delete function. Stores `lookbackDays` always (default 7 baked in).
- `sync/marker.ts` — per-target `getCodemiePath('analytics','sync','markers')/<id>.last-sent`, ISO content, future/invalid → null, mode 0600. No mtime fallback.
- `sync/window.ts` — `dailyWindow(now, lastSent, lookbackDays)` = `max(lookback, gap+1h)`; `backfillWindow()` for `--from/--to/--last`. Imports `../date-args.js`.
- `sync/policy.ts` — `includeExternalFor(policy, platform)`; `windows` → true only on win32.
- `sync/identity.ts` — config `userEmail` then `git config user.email`, else `SyncIdentityMissingError`. No prompt, no lowercase.
- `sync/redact.ts` — `redactSecrets` (`sig=REDACTED`), `errorMessage` (cause chain, redacted).
- `sync/report-builder.ts` — in-process `loadAnalytics` (new `analytics-core.ts`) + `buildPayload`; returns null on no sessions. File name `codemie-analytics-${emailSlug(email)}-<UTC date>.report.json`; backfill uses window label. `emailSlug` (`report/report-generator.ts:64`) keeps case.
- `sync/targets/webhook-target.ts` — POST `{type:"message",attachments:[{contentType,name,contentBytes(base64)}]}`, `MAX_EXPORT_BYTES = 70_000_000` → `ExportTooLargeError`, `redirect:'error'`, 5 min timeout, non-2xx → `SyncDeliveryError`. Matches collector contract (D8).
- `sync/run-sync.ts` — `runSync(opts, deps)` with injected `SyncDeps`; groups targets by window, writes report to a temp dir (unused by delivery), marker written only after deliver and only for non-backfill. Log line format `${status} ${category} — ${detail}` to `~/.codemie/logs/analytics-sync.log` (dir 0700, file 0600, ISO prefix) and stdout. Categories today: `config|target|identity|report|sync|<targetId>` — not the story's `ok sent|skip|fail export|send|setup`. Returns exit code; never throws.
- `analytics-core.ts` (new on branch) — `loadAnalytics()` extracted from `runAnalytics`, returns `ok|empty-raw|empty-aggregate`. `date-args.ts` (new) — `parseDate`/`parseDuration` shared with `index.ts`.
- `index.ts:44-185` — `createAnalyticsCommand()` now calls `.enablePositionalOptions()` (comment lines 46-50); `createSyncCommand()` (action = runSync with `--from/--to/--last`), `createSyncConfigCommand()` + `runSyncConfig()` (flags `--webhook-url`, `--include-external`, `--lookback-days`, `--email`; `EMAIL_REGEX` line 34). `otel` still uses `optsWithGlobals()`.
- `src/utils/errors.ts:50-92` — `SyncConfigError`, `SyncTargetMissingError` (message names `sync config --webhook-url`), `SyncIdentityMissingError` (names `sync config --email`), `SyncDeliveryError`, `ExportTooLargeError`.
- `bin/codemie.js:20-44` — every start runs `MigrationRunner.runPending({silent:false})` then `checkAndPromptForUpdate()` unless `NODE_ENV=test`/`VITEST=true`. `src/utils/cli-updater.ts:345` — auto mode runs `updateCli` (npm install -g); `CODEMIE_AUTO_UPDATE=false` calls `promptForCliUpdate`. No existing skip switch for unattended runs. What's-new notice already skipped when stdout is not a TTY.
- Search limits: no `launchctl|schtasks|systemctl|loginctl` anywhere in `src/` — no scheduler code exists.

### Architecture and Layers Affected
- CLI command layer: `analytics/index.ts` sync sub-tree.
- Analytics sync domain: `analytics/sync/*`.
- Utils: `src/utils/errors.ts`, `src/utils/config.ts` (`ConfigLoader.saveUserEmail`, `loadMultiProviderConfig`), `src/utils/paths.ts` (`getCodemiePath`), `src/utils/exec.ts` (`exec`), `src/utils/processes.ts` (`getCommandPath`).
- CLI bootstrap: `bin/codemie.js` (update check, migrations).
- OS integration: none yet (launchd, systemd --user, schtasks).

### Integration Points
- Outbound HTTPS via global `fetch` (system proxy dispatcher installed in `src/cli/index.ts:46`).
- `ConfigLoader` for `userEmail`; `git` via `exec`.
- Collector take-over surface (from prior analysis §8): plist `~/Library/LaunchAgents/com.epam.codemie.analytics-sync.plist`; `~/.config/systemd/user/codemie-analytics-sync.{service,timer}`; task `CodeMie Analytics Sync`; state `~/.codemie/analytics-sync.json`, `~/.codemie/analytics-last-sent` (ISO, mtime fallback), `~/.codemie/logs/analytics-sync.log`, `analytics-sync.launchd.log`; clone `~/.codemie/codemie-onboarding/`.

### Patterns and Conventions
- Command factories, dynamic `await import()` in actions, `process.exitCode` not `process.exit`.
- Injected-deps runner (`SyncDeps`) + `realSyncDeps()`; pure functions for testability — same style the collector uses for its plist/systemd/XML generators.
- Secret files mode 0600 + chmod after write; redact on every output path.
- Nested groups with clashing option names: `enablePositionalOptions()` (already on `analytics`; also `proxy/index.ts:125,305`).

### AC mapping (R = reusable as-is, C = needs change, N = new)
| AC | Status | Files / notes |
|---|---|---|
| `sync --help` lists install/status/run/uninstall | C | `index.ts` `createSyncCommand` — remove group action + backfill opts, add 4 subcommands |
| Group/subcommand descriptions | C | `index.ts` descriptions |
| `analytics` + `otel` unchanged | R | `index.ts` `applyCommonOptions`, otel; existing regression tests in `__tests__/analytics-sync-cli.test.ts:171-201` |
| `--include-external windows` binds to subcommand | R (mechanism) / C (tests) | `.enablePositionalOptions()` at `index.ts:51`; regression test targets `sync config`, must retarget to `install` |
| Install registers daily job 03:00/`--at`, catch-up, linger | N | scheduler module (launchd/systemd/schtasks generators + register) |
| `--lookback-days`, `--include-external` defaults | C | `config-store.ts` validators R; "default follows CLI updates" means lookback should not be persisted when omitted (today defaults are written) |
| Install summary output (time, lookback, policy, masked host, email, hint) | N | install action; `redactSecrets` R |
| Re-install replaces, keeps marker | C | `applySyncUpdate` merges (keeps old values when flag omitted); scheduler re-register N |
| Settings file only user-readable | R | `config-store.ts:209-214` |
| Email prompt in TTY / fail without TTY | N/C | `identity.ts` R for resolution; prompt N (pattern: inquirer prompt in `runAnalytics`, `EMAIL_REGEX` `index.ts:34`); `ConfigLoader.saveUserEmail` R |
| Unsupported Linux/platform fails | N | scheduler preflight (`systemctl --user` reachability) |
| Invalid option fails before scheduler | C | validators R; `--at HH:MM` N; `--webhook` required (today optional, flag named `--webhook-url`) |
| Take-over removes standalone job, keeps marker, folder hint | N | collector job detection/removal; marker path/format compatibility (see risks) |
| Exactly one delivery after take-over | N | depends on take-over + same job identity |
| Run exports window since last send (≥ lookback), same shape/name, lowercase slug | C | `window.ts dailyWindow` R; `report-builder.ts` C (lowercase slug, drop backfill name); `webhook-target.ts` R |
| Accept → marker moves, `ok sent` line | C | `run-sync.ts` R logic, C line format |
| No sessions → `skip`, marker unchanged | C | `run-sync.ts:148-151` R logic, C format |
| Reject/unreachable/export fail → `fail <export\|send\|setup>`, non-zero | C | `run-sync.ts` category mapping (`report`→export, target→send, config/target/identity→setup) |
| >70 MB → nothing sent, logged with size | R | `webhook-target.ts:31-33`, `ExportTooLargeError` message has bytes; C log category `send`/`export` |
| Scheduler run: no update check/prompt, missing email = `fail setup` | N/C | `bin/codemie.js` gate N; `identity.ts` already non-interactive R |
| `run` with no install fails with setup command | C | `SyncTargetMissingError` message points to `sync config` |
| Status (enabled, time, lookback, policy, host, last run, last send) | N | needs scheduler query + log tail parse + marker read (`marker.ts` R) |
| Status disabled when OS job removed | N | scheduler query |
| Status "not installed" exit 0 | N | `loadSyncConfig` returns defaults on ENOENT (R) |
| Last run "never" | N | |
| Uninstall removes job + settings, idempotent | N | config-store has no delete; scheduler unregister N |
| Docs: command reference | C | `docs/ANALYTICS-REPORT.md:374-392` documents old surface; `docs/COMMANDS.md:624` has no sync; `.ai-run/guides/integration/exposed-api.md` changed on branch |

### Existing code to delete (superseded by the new story)
- `index.ts`: `createSyncConfigCommand`, `runSyncConfig`, `SyncConfigCliOptions`, group-level sync action with `--from/--to/--last`, `RunSyncOptions`/`SyncConfigUpdate` type imports used only by them.
- `sync/window.ts`: `backfillWindow`, `BackfillWindowOptions`, `SyncWindow.backfill` flag, `date-args` import (story out of scope: backfill).
- `sync/run-sync.ts`: `RunSyncOptions`, backfill branch in `resolvePreconditions`/`groupTargetsByWindow`, `writeFile` of report into temp dir (`:154`) plus `makeTempDir/removeDir` deps if no longer used.
- `sync/report-builder.ts:63-65`: backfill file-name branch.
- `src/utils/errors.ts`: messages in `SyncTargetMissingError`/`SyncIdentityMissingError` referencing `sync config` (change, not delete).
- Tests: `__tests__/analytics-sync-cli.test.ts` `sync config` blocks (`:85-170`), `window.test.ts` backfill cases, `run-sync.test.ts` AC6 (`:161`) and inverted-backfill (`:283`).
- Docs: `docs/ANALYTICS-REPORT.md` "Scheduled upload" section (`:374+`), `sync config` examples.
- `date-args.ts` stays (also used by `index.ts` `parseFilterOptions`).

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/security/security-practices.md` — uncommitted section "Documented exception: analytics sync webhook URL" names `~/.codemie/analytics/sync/config.json`; must follow any path change.
- `.ai-run/guides/testing/testing-patterns.md` — Vitest, co-located `__tests__`, `vi.mock` + dynamic import.
- No guide covers OS scheduling.

### Architectural Decisions
- Story D1/D7/D8/D9/D10/D14 (see story). Collector rejects cron; uses catch-up on all OSes; Windows via `schtasks /Create /XML` UTF-16LE (prior analysis §3, §8).
- Branch decision (config-store header): "Never reads any `ANALYTICS_*` environment variable" — collector's env overrides are not ported.

### Derived Conventions
- One log line per run, ISO timestamp prefix, redacted, file 0600.

---

## 4. Testing Landscape

### Existing Coverage
- `sync/__tests__/`: `config-store`, `identity`, `identity-real-deps` (untracked), `marker`, `redact`, `report-builder`, `run-sync` (deps fakes, sig-leak, log failure), `webhook-target`, `window`.
- `analytics/__tests__/analytics-sync-cli.test.ts` — CLI wiring + `--include-external` scoping regression.

### Testing Framework and Patterns
- Vitest 4, unit project sets temp `CODEMIE_HOME`, `NODE_ENV=test`. Injected-deps fakes for runner; `parseAsync(['node','x',...])` for command tests.

### Coverage Gaps
- No tests for scheduler generation/registration, take-over, status, uninstall, TTY email prompt, unattended update suppression in `bin/codemie.js`, lowercase slug.

---

## 5. Configuration and Environment

### Environment Variables
- `CODEMIE_HOME`, `CODEMIE_AUTO_UPDATE`, `CODEMIE_UPDATE_CHECK_INTERVAL`, `CODEMIE_TIPS`, `NODE_ENV`, `VITEST` (updater/bootstrap). No sync env vars on branch.

### Configuration Files
- Branch: `~/.codemie/analytics/sync/config.json` (0600), `~/.codemie/analytics/sync/markers/webhook.last-sent`, `~/.codemie/logs/analytics-sync.log`.
- Collector: `~/.codemie/analytics-sync.json`, `~/.codemie/analytics-last-sent`, same log file.
- `~/.codemie/codemie-cli.config.json` — `userEmail`.

### Feature Flags and Deployment Concerns
- No flags. Windows `.cmd` shim quoting issue (collector `export.js:spawnPlan`) applies if the job invokes `codemie` rather than `node <entry>`.

---

## 6. Risk Indicators

- **State path divergence.** Branch marker/config live under `~/.codemie/analytics/sync/`; the collector's are `~/.codemie/analytics-last-sent` and `~/.codemie/analytics-sync.json`. Story D1/D9 require the existing marker to be kept on take-over. Speculative: either adopt collector paths or migrate/read the legacy marker; the security guide exception text must match.
- **Lowercase slug.** `report-builder.ts` uses case-preserving `emailSlug`; story requires lowercase. Changing shared `emailSlug` would alter interactive export names (AC "analytics behaves exactly as before").
- **Log line contract.** `run-sync.ts` emits `ok webhook — …`, `fail identity — …`; status parses the last line. Speculative: format and category mapping must change together with status parsing.
- **Lookback default persisted.** `applySyncUpdate` writes `lookbackDays: 7`; story says omitted lookback follows CLI updates.
- **Unattended startup.** `bin/codemie.js` runs migrations (non-silent) and `checkAndPromptForUpdate()` (auto `npm install -g` or prompt) before command parsing; no existing opt-out. Speculative: scheduler job needs an env or argv signal checked in `bin/codemie.js`.
- **Job target stability.** Absolute node path + entry script (nvm, dual install) can break after updates.
- **Platform code untestable locally.** launchd/systemd/schtasks registration, linger, UTF-16 XML; keep generators pure.
- **Multi-target abstraction overhead.** `SyncTarget`/grouping/per-target markers exceed story scope (one webhook); marker file naming keyed by target id complicates collector compatibility.
- **Uncommitted review fixes** in 11 files must be resolved (kept or reverted) before rework.

---

## 7. Summary for Complexity Assessment

The change sits in the CLI command layer (`src/cli/commands/analytics/index.ts`) and the sync domain (`src/cli/commands/analytics/sync/`), with small touches to `src/utils/errors.ts`, `bin/codemie.js` and docs. Roughly half the run path already exists on the branch and matches the delivery contract: webhook target (shape, 70 MB cap, redaction, no redirect), redaction helpers, include-external policy, identity resolution, the daily window, the in-process report builder and the runner with injected deps. These need edits: lowercase slug, outcome lines `ok sent|skip|fail export|send|setup`, the error messages, and dropped backfill. The `sync config` command and backfill code are deleted.

The new parts carry the novelty and platform risk: a per-OS scheduler module (launchd plist, systemd user service+timer with linger, Task Scheduler XML), install with `--at` and an interactive email prompt, take-over of the standalone collector's job, status (OS job query, last-run log parse, marker read), uninstall, and suppressing the update check for scheduler-started runs in `bin/codemie.js`. The repo has no scheduler code. The tested collector is the reference.

Unit tests cover the reusable pieces well. Scheduler, status, uninstall, take-over and the startup gate have no coverage. Key risks: state paths differ from the collector's (marker continuity on take-over), lowercase slug vs the shared `emailSlug`, a persisted lookback default, and the unattended startup side effects.

---

## 8. External References

- `/home/oleksiiyurchenko/codemie-code/docs/superpowers/tasks/2026-10-29-analytics-sync-install/story.md` — resolved. ACs mapped in §2; out of scope: bootstrap wizard, auto-update from the job, backfill, analytics changes, collector changes, cron fallback. Decisions D1 (take-over keeps marker), D2 (no update in background), D3 (`--webhook` required, `--lookback-days`, `--include-external`, `--at` default 03:00), D6 (`codemie analytics sync bootstrap|install|status|run|uninstall`), D7 (launchd / systemd user timer + linger / Task Scheduler, no cron), D8 (same message shape, lowercase slug, 70 MB, no retry, lookback 7), D9 (state under CodeMie home, readable after take-over), D10 (never send without email; `fail setup` in background), D14 (subcommand owns same-named options).
- `/home/oleksiiyurchenko/codemie-code/docs/superpowers/tasks/2026-10-29-analytics-sync-install/ticket-technical-analysis.md` — resolved; used for collector facts (§8): job names `com.epam.codemie.analytics-sync` (plist in `~/Library/LaunchAgents/`, `launchctl bootout/bootstrap gui/<uid>`, `StartCalendarInterval`, `RunAtLoad=false`), `codemie-analytics-sync.{service,timer}` (`Type=oneshot`, `OnCalendar=*-*-* HH:MM:00`, `Persistent=true`, `RandomizedDelaySec=300`, `systemctl --user daemon-reload`, `enable --now`, `loginctl enable-linger $USER`), task `CodeMie Analytics Sync` (UTF-16LE+BOM XML, `StartWhenAvailable`, `IgnoreNew`, `InteractiveToken`/`LeastPrivilege`, `ExecutionTimeLimit PT30M`, `schtasks /Delete /F` then `/Create /XML`); uninstall re-queries (`launchctl list`, `systemctl is-enabled`, `schtasks /Query`). State `~/.codemie/analytics-sync.json`, `~/.codemie/analytics-last-sent` (ISO, mtime fallback), logs `~/.codemie/logs/analytics-sync.log` + `analytics-sync.launchd.log`. Window `max(ceil(gapHours)+1, lookbackDays*24)` h. The collector's live webhook URL is not reproduced.
