# Technical Research

**Task**: analytics sync git
**Generated**: 2026-11-03
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-16564 — [CodeMie CLI][Analytics] Analytics sync: deliver reports to a team git repository.
Branch context: built on top of unmerged predecessor EPMCDME-16488 (branch EPMCDME-16488_analytics-sync-install, already contains `codemie analytics sync install/run/status/uninstall` delivering to a Power Automate webhook; `bootstrap` from EPMCDME-16487). Prior task artifacts: docs/superpowers/tasks/2026-10-29-analytics-sync-install/.

## Context
- EPMCDME-16476 moves daily analytics delivery into the CodeMie CLI: `codemie analytics sync install`, `run`, `status` and `uninstall` (EPMCDME-16488) deliver to one target, the team's Power Automate webhook (SharePoint and Teams), set up by the lead with `bootstrap` (EPMCDME-16487).
- Teams that want their usage data in a store only their members can reach have no option today, and clients who can't use Power Automate can't receive analytics at all.
- An earlier central git "inbox" design was dropped because it put one access token on every machine. A repository owned by each team, reached with each developer's own git credentials, avoids that.
- The Control Plane will harvest exports from a team git repository (EPMCDME-16562), in JSON or flattened OTel format (EPMCDME-16561).

## Story
As a developer on a team that keeps its AI-usage analytics private, I want the daily analytics sync to push my report to my team's git repository, so that only my team can see our data and the Control Plane can harvest it, using git access I already have.

## Acceptance Criteria
- Given the CLI is installed, when a user runs `codemie analytics sync install --help`, then it lists a git repository option next to `--webhook`, and at least one of the two is required.
- Given an install with a team repository address, when it runs, then it test-pushes to the repository with the developer's git credentials before registering the daily job; a failed test push registers nothing and explains the likely cause.
- Given a git target, when the daily job or `codemie analytics sync run` runs, then the report is committed under the developer's own folder (named from their email) on the repository's default branch and pushed with the developer's existing git credentials; CodeMie neither asks for nor stores a token.
- Given another member pushed in the meantime, when the sync pushes, then it integrates the remote changes and retries, never overwriting other members' files.
- Given both webhook and git targets, when the sync runs, then both receive the report, and each target's last-sent marker moves only after its own successful delivery.
- Given git credentials are missing or rejected, or the repository is unreachable, when the scheduled job runs, then it fails at once without waiting on a prompt, the git marker does not move, the webhook target still delivers, and the next run re-sends the missed window to git.
- Given pushes keep being rejected beyond the retry limit, when the sync runs, then the git target is logged as failed and its marker does not move.
- Given no sessions in the window, when the sync runs, then nothing is committed.
- Given `codemie analytics sync status`, when a git target is configured, then it shows the repository, its last successful push and its last failure, without credentials.
- Given a lead running `codemie analytics sync bootstrap`, when they choose a team repository instead of or beside the webhook, then the printed install command carries the repository address.
- Given the export format chosen for the sync (JSON, or flattened OTel per EPMCDME-16561), when the report is pushed, then the file in the repository uses that format and its file name says which.

## Out of Scope
- Creating or provisioning team repositories, or granting access.
- Read-isolation between members of one repository; encryption of files.
- Git host REST APIs; only plain git with the developer's credentials.
- Harvesting the repository in the Control Plane (EPMCDME-16562).

## Decisions
- D1: Dedicated repository owned by the team, configured per developer, reached with the developer's own git credentials.
- D2: All members can read all members' files; repository access is the boundary.
- D3: Repository's default branch, one folder per developer (email slug), one report file per sync.
- D4: An option of `sync install` and `bootstrap`, not a separate setup.

## Ticket comment (additions to fold into AC)
1. Branch and path are configurable: `install` takes `--git-branch <name>` and `--git-path <dir>` beside the repository address, and rejects an absolute `--git-path` before touching the scheduler.
2. The committed file name is the webhook attachment name: D8 of EPMCDME-16476 fixes it as `codemie-analytics-<lowercased email slug>-<date>.report.json`.
3. `uninstall` removes the local working copy kept under the CodeMie home folder, together with settings and the OS job.
4. A scheduled run must never wait on: a credential prompt, an SSH key passphrase, or an unknown host-key confirmation (D2 of EPMCDME-16476 forbids prompts in scheduled runs).

---

## 2. Codebase Findings

### Existing Implementations
All sync code lives in `src/cli/commands/analytics/sync/` (current branch = 16488 work, HEAD `b390c555`):
- `types.ts` — `SyncSettings { webhookUrl: string; includeExternal; at; lookbackDays? }` (webhook mandatory), `InstallOptions { webhook?, at?, lookbackDays?, includeExternal? }`, `SyncReport { fileName; bytes: Buffer }`, `SyncResult`.
- `config-store.ts` — `validateInstallOptions()` (pure, throws `SyncConfigError`; `validateWebhookUrl` throws "--webhook is required"), `loadSyncSettings()` (rejects file without `webhookUrl`), `writeSyncSettings()` (whole-file overwrite, mode 0600), `deleteSyncSettings()`. Path `~/.codemie/analytics-sync.json` via `getCodemiePath`.
- `marker.ts` — single collector-compatible marker `~/.codemie/analytics-last-sent` (ISO text, 0600, mtime fallback). Header comment states "no per-target markers". `readMarker(now, path?)` / `writeMarker(at, path?)` already accept a path parameter.
- `run-sync.ts` — `runSync(deps: SyncDeps)`: load settings -> identity -> marker -> `dailyWindow` -> `buildReport` -> `deps.send(settings.webhookUrl, report)` -> `writeMarker`. One window per run, computed from the one marker. Emits exactly one log line `<ISO> ok sent|skip|fail <category> ...` to stdout and `~/.codemie/logs/analytics-sync.log`; exit 0/1. `SyncDeps.send(url, report)` is webhook-shaped.
- `targets/webhook-target.ts` — `WebhookTarget { id='webhook'; deliver(report) }` + free `sendWebhook()`; `MAX_EXPORT_BYTES=70_000_000`, 5-min timeout, `SyncDeliveryError`. Only target in `targets/`.
- `report-builder.ts` — `buildSyncReport()` returns `null` on empty window; JSON payload via `buildPayload`; file name `codemie-analytics-${emailSlug(email.toLowerCase())}-${YYYY-MM-DD UTC}.report.json` (matches ticket comment item 2).
- `install.ts` — `runInstall(opts, InstallDeps)`: validate+`scheduler.preflight()` -> resolve email (TTY prompt fallback) -> collector-dir check -> `scheduler.unregister()` -> `writeSettings` -> `register()` with rollback -> `printSummary` (prints `Webhook: <host>`).
- `status.ts` — `runStatus(StatusDeps)`: prints run time, lookback, include-external, `Webhook: <host>`, `Last run` parsed from log by regex `LAST_RUN_LINE = /^(\S+) ((?:ok sent|skip|fail \w+).*)$/`, `Last successful send` from the single marker. Disabled hint hardcodes `--webhook <url>`.
- `uninstall.ts` — `runUninstall`: `unregister()` + `deleteSettings()`; keeps marker and log by design.
- `identity.ts` — email: CodeMie config then `git config --global user.email`; uses `exec` from `@/utils/exec.js`.
- `format.ts` (`lookbackText`, `webhookHost`), `redact.ts` (`redactSecrets` strips only `sig=`; `errorMessage` walks `cause`), `window.ts` (`dailyWindow`), `policy.ts`.
- `scheduler/index.ts`, `scheduler/generators.ts` — launchd/systemd/schtasks; job runs `<node> <codemie.js> analytics sync run --scheduled`. No env vars are set in job definitions.
- CLI wiring: `src/cli/commands/analytics/index.ts:73-135` — `createSyncCommand()` with install options `--webhook`, `--at`, `--lookback-days`, `--include-external`; dynamic import of runners. Help texts say "to the team's webhook".
- `src/utils/scheduled-run.ts` — `isScheduledSyncRun(argv)` lets `bin/codemie.js` skip interactive startup.
- Errors (`src/utils/errors.ts:50-110`): `SyncConfigError`, `SyncTargetMissingError` (message hardcodes `--webhook <url>`), `SyncIdentityMissingError`, `SyncSchedulerUnsupportedError`, `SyncSchedulerRegisterError`, `SyncDeliveryError(message, status?)`, `ExportTooLargeError`.

**Not present on this branch:**
- No `bootstrap` subcommand anywhere in `src/` (grep: only `launchctl bootstrap` hits). No local or remote branch for EPMCDME-16487.
- No flattened-OTel *export* format. `--export` accepts `html|json|both` (`index.ts:148`); `analytics otel --file` is an OTel *input* source (`sources/otel-source.ts`). No branch for EPMCDME-16561.
- No git client library (`package.json` has no simple-git/isomorphic-git); no existing clone/commit/push code in `src/`.

### Architecture and Layers Affected
- CLI layer: `analytics/index.ts` sync subcommands (options, descriptions).
- Sync runner layer: `install.ts`, `run-sync.ts`, `status.ts`, `uninstall.ts`.
- Config/state: `config-store.ts`, `types.ts`, `marker.ts`, run log format (parsed by `status.ts`).
- Delivery targets: `targets/` (webhook only).
- Utilities: `src/utils/exec.ts`, `src/utils/errors.ts`, `src/utils/paths.ts`.

### Integration Points
- `exec(command, args, { cwd, env, timeout, interactive })` (`src/utils/exec.ts`): `spawn` with `shell:false` on Unix, `env` merged over `process.env`, `stdio:'pipe'` unless `interactive`, timeout rejects with `Error("Command timed out after …ms")`.
- Precedent for non-interactive git: `src/cli/commands/skills/add.ts:86-90` passes `env: { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }` plus a timeout. No `GIT_SSH_COMMAND`/`BatchMode` usage anywhere in `src/`.
- Identity already shells out to `git config --global user.email`; scheduled job has no cwd guarantee (comment in `identity.ts`).
- External: developer's git binary, credential helpers, SSH agent; remote host.

### Patterns and Conventions
- Runner + injected `*Deps` interface + `createReal*Deps()`/`realSyncDeps()` factory; runners never throw nor call `process.exit`, return exit code.
- Dynamic import of runners from CLI actions.
- Validation is pure (`validateInstallOptions`), throws `SyncConfigError` naming the flag; preflight before any scheduler mutation.
- Install rollback on register failure (unregister + deleteSettings).
- State files under `getCodemiePath(...)`, mode 0600, re-chmod after write; log dir 0700.
- All user-visible text passes through `errorMessage`/`redactSecrets`.

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/` present: architecture, development-practices, code-quality, testing-patterns, security-practices, external-integrations, exposed-api, project-config, quality-gates, project. None covers analytics sync specifically.
- `docs/ANALYTICS-REPORT.md:384-530` — "Scheduled delivery (`analytics sync`)": options table, per-OS scheduler table, file-name rule, state-file table (settings, marker, run log, launchd log).

### Architectural Decisions
- Prior task `docs/superpowers/tasks/2026-10-29-analytics-sync-install/spec.md` and `story.md`: collector-compatible paths (D1, D9); single webhook, single marker; `bootstrap` explicitly a non-goal there (spec line 68; story D6 says `bootstrap` delivered by sibling story).
- `marker.ts` and `run-sync.ts` headers document "no per-target markers" and "single-webhook" as deliberate.
- `uninstall.ts` header: marker and log kept on uninstall.

### Derived Conventions
- Log line grammar `ok sent|skip|fail <category>` is a contract consumed by `status.ts#parseLastRun`.
- Lowercased email slug applied only in sync file naming.

---

## 4. Testing Landscape

### Existing Coverage
- `src/cli/commands/analytics/sync/__tests__/`: `config-store`, `identity`, `install` (254 lines), `marker`, `redact`, `report-builder`, `run-sync` (275), `status` (228), `uninstall`, `webhook-target`, `window`.
- `sync/scheduler/__tests__/scheduler.test.ts`, `generators.test.ts`.
- `src/cli/commands/analytics/__tests__/analytics-sync-cli.test.ts` (245) — command surface/help.
- `tests/integration/analytics-sync-scheduled-startup.test.ts`; `src/utils/__tests__/scheduled-run.test.ts`.

### Testing Framework and Patterns
- Vitest; `makeDeps(overrides: Partial<SyncDeps>)` harness with `vi.fn()` fakes (e.g. `run-sync.test.ts:32`). No real fs/network/scheduler in unit tests.

### Coverage Gaps
- No tests exist for any git operation (no git code exists).
- No test fixture for a local bare repository or multi-target delivery.

---

## 5. Configuration and Environment

### Environment Variables
- None read by sync (`loadSyncSettings` doc: "Never reads any `ANALYTICS_*` environment variable").
- Git-related env precedent only in `skills/add.ts`: `GIT_TERMINAL_PROMPT`, `GCM_INTERACTIVE`.

### Configuration Files
- `~/.codemie/analytics-sync.json` — settings (0600); `loadSyncSettings` rejects files lacking `webhookUrl`.
- `~/.codemie/analytics-last-sent` — single marker.
- `~/.codemie/logs/analytics-sync.log` — run log.
- `~/.codemie/codemie-onboarding` — standalone collector clone, detected by install.

### Feature Flags and Deployment Concerns
- No feature flags. Scheduler job definitions (`scheduler/generators.ts`) carry no environment block; Windows task has `ExecutionTimeLimit PT30M`, systemd `Type=oneshot` without a limit.

---

## 6. Risk Indicators

- `bootstrap` (EPMCDME-16487) does not exist on this branch or any local/remote branch; the bootstrap AC has no code to extend.
- Flattened OTel export (EPMCDME-16561) does not exist; `--export` is `html|json|both` only. The format AC has no producer to reuse.
- Speculative: the single-marker design (`marker.ts`, `run-sync.ts`) and one-window-per-run flow conflict with "each target's marker moves independently"; per-target windows likely needed, changing marker layout and collector compatibility.
- Speculative: `SyncSettings.webhookUrl` is mandatory in types, validation, `loadSyncSettings`, `format.ts`, `install.ts` summary, `status.ts`, and `SyncTargetMissingError` text; making it optional touches all of them.
- Speculative: run-log grammar (`ok sent|skip|fail <cat>`) is single-target; multi-target outcomes need a grammar `status.ts#parseLastRun` still matches.
- No-prompt git in scheduled runs: only precedent covers HTTPS prompts (`GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`); SSH passphrase and host-key prompts have no precedent (`BatchMode`/`StrictHostKeyChecking`) in `src/`. Cross-platform (Windows Git Credential Manager, macOS keychain) behavior unverified.
- `redactSecrets` strips only `sig=`; repo URLs with embedded `user:token@` would leak into log/status.
- `exec` runs `shell:false`; Windows path resolution for `git` handled by `exec`, but no test coverage for git there.
- Concurrency: rebase/retry against other members' pushes and persistent working copy under `~/.codemie` (dirty/corrupt clone recovery) are new territory.
- Scheduler timeouts: systemd oneshot/launchd have no time limit; a hung git process would hang the job unless bounded.

---

## 7. Summary for Complexity Assessment

The change sits entirely in the analytics sync feature (`src/cli/commands/analytics/sync/`, ~1.6 KLOC incl. scheduler) plus its CLI wiring in `analytics/index.ts`, `src/utils/errors.ts`, and `docs/ANALYTICS-REPORT.md`. Every runner (install, run, status, uninstall), the settings store, types, marker and log-line grammar currently assume exactly one webhook target and one marker; these assumptions are documented as deliberate in file headers. The well-established runner + injected-deps pattern and install rollback make extension mechanical, but the surface is wide (roughly 10+ source files and their tests).

Technical novelty is high: the repo has no git client code, no clone/commit/push/rebase logic, and only one weak precedent for non-interactive git (`skills/add.ts` env vars). Prompt-free SSH, retry-on-reject, a persistent working copy under `~/.codemie`, and cross-platform credential behavior are all new. Two ACs depend on code absent from this branch: the `bootstrap` command (EPMCDME-16487) and the flattened OTel export format (EPMCDME-16561); neither has a branch locally or on origin.

Test posture is good for existing sync code (11 unit test files, scheduler and CLI tests, one integration test), all using fakes. Nothing covers git delivery or multi-target runs. Key risks: per-target marker/window redesign versus collector compatibility, credential-free scheduled runs, credential leakage via URLs, and the scope question raised by the missing bootstrap and OTel dependencies.

---

## 8. External References

None named by the task as a file or URL. Referenced tickets (EPMCDME-16476 D2/D8, 16487, 16561, 16562) were not readable from the filesystem; the only local artifacts are `docs/superpowers/tasks/2026-10-29-analytics-sync-install/` (spec.md, story.md), summarized in Section 3. D8 file-name rule matches `report-builder.ts`.
