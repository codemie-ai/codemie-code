---
schema: sdlc-factory/code-review@1
decision: approve
reviewed_head: dcf49666a5372540a4af96a29300220413a453a2
---

# Code review — 2026-10-29-analytics-sync-install

**Decision:** approve (check round, confidence final medium · check medium)  
**Reviewed head:** `dcf4966` · **Rounds:** final → check

**Closed:** 21 fixed · 0 moot · 1 decided

Targeted check: all 22 prior blocking findings resolved; 21 code findings confirmed against current source. CR-003 (ticket key in 8 commit subjects) resolved only by the recorded human decision against a code-kind finding, so not source-verified: the squash-merge PR title must carry no ticket key. CR-001's fix is an untracked test file absent from changed_files.

## Open — 0

## Decided — 1

- **CR-003** · Ticket key in commit subjects — `git log 69c248d1..HEAD` — **Accept the alternative: no history rewrite; the squash-merge PR title carries no ticket key and the ticket is referenced only in the PR/commit body.** The user decided at the gate not to rewrite already-made branch commits; git-workflow.md's concern is satisfied at squash-merge, where the PR title becomes the single commit subject on main.

## Coverage

Graded at the final round; the check round re-verified the findings, not these rows — Open and Closed above are current.

| Acceptance criterion | Status | Notes |
|---|---|---|
| `codemie analytics sync --help` lists install, status, run, uninstall | pass | createSyncCommand adds four subcommands; covered by analytics-sync-cli.test.ts |
| Group and every subcommand description says who runs it and what it changes | partial (final round) | run description names no actor (index.ts:118) — CR-004 |
| `codemie analytics` export options and `analytics otel` behave as before | pass | loadAnalytics extraction; date-args moved unchanged; otel regression tests |
| `sync install --include-external windows` applies to the subcommand | pass | .enablePositionalOptions() on analytics and sync; scoping test |
| Install registers daily per-user job at 03:00 or --at, catch-up, Linux runs while logged out | pass | launchd StartCalendarInterval, systemd Persistent, StartWhenAvailable, enable-linger |
| Omitted --lookback-days / --include-external use CLI default 7 days and windows | pass | lookbackDays key omitted; DEFAULT_LOOKBACK_DAYS / DEFAULT_INCLUDE_EXTERNAL |
| Successful install prints run time, lookback, policy, masked host, email, run/status hint | pass | install.ts printSummary; webhookHost prints host only |
| Re-install replaces job and settings without duplicating; marker kept | pass | unregister, whole-file write, register; install never touches marker |
| Settings file holding the webhook is readable only by the current user | pass | writeSyncSettings mode 0o600 + chmod |
| No configured email: TTY prompts and saves; no TTY fails with instructions, registers nothing | pass | resolveInstallEmail; non-TTY returns 1 before unregister/write/register |
| Linux without systemd user session or unsupported platform fails clearly, registers nothing | pass | preflight throws SyncSchedulerUnsupportedError before any write |
| Invalid --at/--lookback-days/--include-external/--webhook fails before scheduler, naming the option | pass | validateInstallOptions runs first; SyncConfigError names the flag |
| Collector job removed before CLI job registered; marker kept; old folder can be deleted | pass | shared job identities; unregister before register; take-over message |
| After collector then CLI install, exactly one delivery at next scheduled time | pass | single job identity per platform replaced in place |
| Run exports window since last send as priced JSON, POSTs collector message shape with lowercased-slug attachment | pass | dailyWindow; emailSlug(lowercase); {type:'message',attachments:[...]} |
| Webhook accepts: marker moves to run time and one `ok sent` line appended to run log | fail (final round) | macOS launchd StandardOutPath is the same log, so each line is written twice — CR-014 |
| No sessions in window: nothing sent, marker unchanged, `skip` line logged | pass | report===null -> skip, return 0 (duplicated on macOS, CR-014) |
| Webhook rejects/unreachable or export fails: marker unchanged, `fail` logged without signature, non-zero exit | pass | catch blocks emit fail export/send, return 1; redactSecrets |
| Export over 70 MB: nothing sent, failure logged with size | pass | ExportTooLargeError before fetch, mapped to `fail export` |
| Scheduled start: no update check/install/prompt; missing email logged `fail setup` | pass | bin/codemie.js isScheduledRun gates; identity error caught as fail setup |
| `run` with no install fails with the setup command and sends nothing | pass | settings===null -> fail setup naming sync install |
| Status shows enabled/disabled, run time, lookback, policy, masked host, last run, last successful send | pass | status.ts runStatus prints all fields |
| OS job removed/disabled outside CLI: status reports disabled and says to run install again | pass | disabled branch prints install-again hint |
| Nothing installed: status reports not installed with setup command, exits 0 | pass | settings===null branch returns 0 |
| No run yet: last-run fields say never | pass | lastRunText/marker null -> never |
| Uninstall removes OS job and settings; repeat uninstall reports nothing to remove | partial (final round) | unregister skips a disabled job (win32 delete only when enabled) — CR-020 |
| CLI command reference documents subcommands, per-platform behaviour, collector migration | pass | COMMANDS.md and ANALYTICS-REPORT.md sections |
| `sync` is a pure group with install/status/run/uninstall | pass | no action/options on sync; tests reject --from/--to/--last |
| Delete `sync config` surface; keep .enablePositionalOptions() | pass | no sync config code remains |
| `run` takes a hidden --scheduled flag; OS job always passes it | pass | Option('--scheduled').hideHelp(); resolveJobCommand args end with it |
| Settings at ~/.codemie/analytics-sync.json, 0600, schema {webhookUrl, includeExternal, at, lookbackDays?} | pass | config-store.ts |
| Marker ~/.codemie/analytics-last-sent, ISO; invalid falls back to mtime; future treated absent | pass | marker.ts readMarker/writeMarker |
| Log ~/.codemie/logs/analytics-sync.log (dir 0700, file 0600), one line per run | fail (final round) | macOS launchd stdout targets the same log; two lines per run — CR-014 |
| Paths via getCodemiePath(); branch paths ~/.codemie/analytics/sync/ dropped | pass | no old paths remain in src |
| No ANALYTICS_* env overrides; webhook in 0600 file; security guide exception names new path | pass | loadSyncSettings reads only the file |
| macOS job plist, StartCalendarInterval, RunAtLoad=false, bootout then bootstrap gui/<uid> | pass | generators.ts launchdPlist; registerDarwin |
| Linux job service+timer, oneshot, OnCalendar, Persistent, RandomizedDelaySec=300, linger | pass | systemdUnits; registerLinux |
| Windows task XML UTF-16LE+BOM, StartWhenAvailable, IgnoreNew, InteractiveToken, PT30M | pass | taskSchedulerXml; registerWindows |
| Job command: absolute process.execPath + realpath of CLI entry + `analytics sync run --scheduled` | partial (final round) | Windows <Arguments> does not quote the entry path; paths with spaces split — CR-016 |
| Preflight fails before anything is written on unsupported platform / no systemctl --user | pass | preflight called first in install |
| Query for status: registered and enabled -> enabled, otherwise disabled | pass | scheduler query per platform |
| Install order: validate, preflight, email, detect collector, unregister, write, register, summary | pass | runInstall follows this sequence |
| Email: config userEmail then git user.email; TTY prompt with EMAIL_REGEX saved; no TTY fails | pass | identity.ts; install prompt/save |
| Registration failure deletes just-written settings and exits non-zero | pass | catch calls deleteSettings, returns 1 (job files left behind, CR-009) |
| Take-over message when ~/.codemie/codemie-onboarding exists; marker never touched | pass | collectorDirExists + summary message |
| Summary masks signature via host only; Linux linger failure is a summary warning | pass | webhookHost; lingerWarning printed redacted |
| Run: dailyWindow, in-process export, POST via webhook-target (shape, 70 MB cap, redirect error, no retry) | pass | matches; no fetch timeout (CR-022) |
| Attachment name lowercased in sync only; shared emailSlug unchanged | pass | report-builder lowercases before emailSlug |
| Marker moves to run start time only after 2xx | pass | writeMarker(now) only after send resolves |
| Log line format and ok/skip/fail mapping; non-zero on fail; never throws | partial (final round) | log append failure rejects runSync (CR-010); marker write failure after 2xx logged fail setup (CR-012) |
| Error messages point to `codemie analytics sync install`, not `sync config` | pass | errors.ts messages; redact.test.ts |
| bin/codemie.js: on `analytics sync run --scheduled` skip update check, silent migrations, no prompt | pass | isScheduledSyncRun gates (no integration test, CR-001) |
| Status: not installed -> message, exit 0; else enabled/disabled, settings, last run, last send | pass | status.ts runStatus |
| Uninstall: unregister OS job, delete settings, keep marker and log; nothing installed -> exit 0 | partial (final round) | disabled job left registered — CR-020 |
| Removal of superseded code (backfill, RunSyncOptions, temp dir, per-target markers); date-args.ts kept | pass | window.ts only dailyWindow; single webhook |
| Docs: COMMANDS.md, ANALYTICS-REPORT.md, exposed-api.md, security guide exception path | partial (final round) | ANALYTICS-REPORT.md says linger warning shows in `sync status`; it does not — CR-002 |
| AC-X1: state at collector paths; collector marker honoured by first CLI run | pass | marker.ts reads collector marker with mtime fallback |
| AC-X2: no branch-era sync config, backfill flags or ~/.codemie/analytics/sync/ paths remain | pass | none in src |
| Non-goals respected (no bootstrap, backfill, auto-update, env overrides, retries, cron) | pass | none appear in the diff |

Standards: commit-format partial (final round) · code-quality partial (final round) · security pass
