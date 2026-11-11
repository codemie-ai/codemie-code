# Spec — Analytics sync: install, run, status, uninstall (EPMCDME-16488)

Story: `story.md` (same folder) is the source of truth for acceptance criteria. Research: `technical-analysis.md`.

## Intent

Move the standalone collector's developer side into the CLI: `codemie analytics sync install|status|run|uninstall`. A daily per-user OS job runs `sync run`, which POSTs the priced JSON report to the team webhook. Delivery stays byte-compatible with the collector so existing Power Automate flows keep working. The branch's sync-core code (EPMCDME-16554, `src/cli/commands/analytics/sync/`) is reworked to this surface; where it conflicts with the story, the story wins.

## Design

### Command surface (`src/cli/commands/analytics/index.ts`)
- `sync` becomes a pure group (no action, no `--from/--to/--last`). Subcommands: `install`, `status`, `run`, `uninstall`, with "who runs it / what it changes" descriptions per story.
- Delete `sync config` (`createSyncConfigCommand`, `runSyncConfig`, `SyncConfigCliOptions`). Keep `.enablePositionalOptions()` so subcommand options win over `analytics` options of the same name (D14).
- `run` takes a hidden `--scheduled` flag; the OS job always passes it.

### State (adopt the collector's paths — D1, D9)
- Settings: `~/.codemie/analytics-sync.json`, mode 0600 + chmod after write. CLI schema: `{ webhookUrl, includeExternal, at, lookbackDays? }`. `lookbackDays` is written only when given, so the default (7) follows CLI updates. A pre-existing collector file is overwritten wholesale by install.
- Marker: `~/.codemie/analytics-last-sent`, ISO content; empty/invalid content falls back to file mtime (collector behaviour); future value → treated as absent.
- Log: `~/.codemie/logs/analytics-sync.log` (dir 0700, file 0600), one line per run.
- Paths built with `getCodemiePath()`. The branch paths `~/.codemie/analytics/sync/{config.json,markers/}` are dropped.
- No `ANALYTICS_*` env overrides. Webhook URL stays in the 0600 file, not CredentialStore; the exception in `.ai-run/guides/security/security-practices.md` is updated to the new path.

### OS scheduler (new module, pure generators + thin register/unregister/query)
- Same job identities as the collector, so install replaces either the collector's job or a previous CLI job:
  - macOS: `~/Library/LaunchAgents/com.epam.codemie.analytics-sync.plist`, `StartCalendarInterval`, `RunAtLoad=false`, `launchctl bootout` then `bootstrap gui/<uid>`.
  - Linux: `~/.config/systemd/user/codemie-analytics-sync.{service,timer}`, `Type=oneshot`, `OnCalendar=*-*-* HH:MM:00`, `Persistent=true`, `RandomizedDelaySec=300`; `daemon-reload`, `enable --now`, then `loginctl enable-linger $USER`.
  - Windows: task `CodeMie Analytics Sync`, UTF-16LE+BOM XML, `StartWhenAvailable`, `IgnoreNew`, `InteractiveToken`/`LeastPrivilege`, `ExecutionTimeLimit PT30M`; `schtasks /Delete /F` then `/Create /XML`.
- Job command: absolute `process.execPath` + realpath of the CLI entry script + `analytics sync run --scheduled` (no `.cmd` shim on Windows).
- Preflight: unsupported platform, or Linux without a reachable `systemctl --user`, fails before anything is written.
- Query (for status): registered and enabled → enabled; otherwise disabled.

### Install
Order: validate options (`--webhook` required, https, valid URL; `--at HH:MM` default `03:00`; `--lookback-days` integer 1-30; `--include-external windows|always|never`, default `windows`) → platform preflight → resolve email → detect standalone collector → unregister existing job → write settings → register job → print summary.
- Email: CLI config `userEmail`, then `git config user.email` (collector order). If neither: TTY → inquirer prompt validated with `EMAIL_REGEX`, saved via `ConfigLoader.saveUserEmail`; no TTY → fail with instructions, nothing registered.
- If registration fails, delete the just-written settings and exit non-zero.
- Take-over: if `~/.codemie/codemie-onboarding/` exists, say the job was taken over and the folder can be deleted. The marker is never touched.
- Summary: run time, lookback (marked "default" when omitted), policy, webhook host only (signature masked via `redactSecrets`), email, hint to try `sync run` and `sync status`. Linux linger failure → warning in the summary (job still registered).

### Run (`run-sync.ts`, single webhook)
- No settings → fail with the install command, send nothing.
- Window: `dailyWindow(now, marker, lookback)` (never less than lookback). Export in-process (`report-builder.ts`), POST via `webhook-target.ts` (unchanged shape, 70 MB cap, `redirect:'error'`, no retry).
- Attachment name `codemie-analytics-<lowercased email slug>-<UTC date>.report.json`. Lowercase is applied in sync only; shared `emailSlug` stays unchanged.
- Marker moves to run start time only after a 2xx.
- Log line format (status parses it): `<ISO> ok sent <name> <bytes>` | `<ISO> skip <reason>` | `<ISO> fail <export|send|setup> <redacted detail>`. Mapping: settings/identity/policy errors → `setup`; export/report errors and >70 MB (size in detail) → `export`; HTTP non-2xx/network → `send`. Exit non-zero on `fail`, zero on `ok`/`skip`. Never throws.
- Error messages in `src/utils/errors.ts` point to `codemie analytics sync install`, not `sync config`.

### Unattended start (`bin/codemie.js`)
When argv contains `analytics sync run --scheduled`: skip `checkAndPromptForUpdate()`, run migrations with `silent:true`, and never prompt. Manual `sync run` keeps today's startup.

### Status
Not installed → "not installed" + install command, exit 0. Otherwise: enabled/disabled (OS query; disabled adds "run install again"), run time, lookback, policy, masked host, last run (time + outcome parsed from the last matching log line, else "never"), last successful send (marker, else "never").

### Uninstall
Unregister OS job (re-query; tolerate absent) and delete settings. Marker and log are kept. Nothing installed → "nothing to remove", exit 0.

### Removal of superseded code
`window.ts` backfill (`backfillWindow`, `BackfillWindowOptions`, `backfill` flag); `run-sync.ts` `RunSyncOptions`, backfill branches, temp-dir report write and its deps; `report-builder.ts` backfill name branch; per-target marker store and target grouping (collapsed to one webhook); `config-store.ts` path/schema reworked; the matching tests and the `sync config` CLI tests. `date-args.ts` stays.

### Docs
`docs/COMMANDS.md` (sync reference), `docs/ANALYTICS-REPORT.md` (replace "Scheduled upload"), per-platform behaviour and collector migration; `.ai-run/guides/integration/exposed-api.md`; security guide exception path.

## Acceptance criteria
As in `story.md` §Acceptance Criteria (all 27), plus:
- AC-X1: State lives at the collector paths above; a collector marker is honoured by the first CLI run.
- AC-X2: No branch-era `sync config`, backfill flags or `~/.codemie/analytics/sync/` paths remain.

## Non-goals
- `bootstrap` wizard; backfill (`--last/--from/--to`); auto-update from the job.
- Any analytics/report change; changing the shared `emailSlug` or interactive export naming.
- Changes to the codemie-onboarding collector; deleting its clone folder.
- Plain-cron fallback; multiple targets or non-webhook targets; retries.
- `ANALYTICS_*` env overrides; storing the webhook in CredentialStore.
- Migrating values from the collector's settings file (install requires `--webhook`).

## Left to the builder
Module split under `sync/`, exact log detail wording, inquirer usage details, how the OS query is parsed per platform.
