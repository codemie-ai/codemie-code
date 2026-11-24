# Technical Research

**Task**: cli proxy analytics doctor status connect disconnect deprecation tips help commander hints
**Generated**: 2026-11-17
**Research path**: codegraph

---

## 1. Original Context

Redesign the `codemie proxy` and `codemie analytics` CLI command surfaces as an epic of six independently releasable stories. (0) Command discoverability, lands first: a related-commands registry per command group that drives a "Related commands" section in --help and a contextual "Next:" line after successful commands (suppressed for --json/hooks/scheduled runs); one unified hint format replacing the mixed `Run:`/`Next step:`/`Repair:`/`Hint:` styles (ReportRow.hint in proxy/analytics-report.ts, HealthCheckDetail.hint in doctor); tip catalog (src/utils/tips.json) updates — new tips for proxy analytics, OTLP connectors, analytics sync, proxy doctor; rewrite tips teaching deprecated forms; deeper staleness check in `codemie tips` validating `commands[]` subcommand paths and flags against the command tree. (1) New `codemie proxy doctor [--json] [--verbose]`: full-depth checks (daemon liveness, authenticated upstream/SSO, client config drift — port mismatch/shared key/another install's hooks, Claude Code OTLP endpoint mismatch, older CLI on PATH, analytics connector config, delivery spool/unsent/next retry/last drop, Claude Desktop collection); per-section ok/warn/error with one fix hint; exit non-zero on error; --verbose absorbs `proxy inspect desktop` session detail; reuse doctor HealthCheck types; condensed ProxyCheck registered in `codemie doctor`. (2) Slim `proxy status` to facts only (running, url, port, profile, project, version, uptime), gateway key masked with --show-key, keep --json; deprecate `status --deep` and `proxy inspect desktop` pointing to doctor. (3) `proxy analytics` project tracking: `include`/`exclude` become true inverses (include also adds to Project-scope allowlist when scope=project); `consent grant|revoke|list` replacing `connect-folder`/`disconnect-folder`; with no connector flag apply to all connected connectors; diagnostic part of `analytics status` moves to doctor. (4) `proxy connect`/`disconnect` symmetry: `disconnect --vscode` (BYOK chatLanguageModels.json remover), `disconnect --all`, `proxy clients` list; split overloaded `--force` into `--overwrite` and `--restart-daemon`; `--yes` replacing `--silent`; `--scope user` must not silently reset an existing project list; warn on ignored `--scope`/`--silent`; non-zero exit when no target given; remove `connect desktop`/`connect vscode` aliases. (5) `codemie analytics` reporting cleanup: remove `--report`/`--report-format`/`--report-output` (past Nov 1 2026 removal date), strict --from/--to/--last validation (error instead of warn-and-ignore), consistent `--include-external` semantics vs `analytics sync --include-external <policy>`, exit codes via process.exitCode, update README/docs/COMMANDS.md. Cross-cutting deprecation standard: one shared helper deprecate({old, replacement, removeOn}) printing one line to stderr, silent under --json/hooks/scheduled; deprecated commands hidden from --help; fixed removal date default 1 month after deprecation; a unit test fails once the date passes while the old form is registered; CHANGELOG "Deprecated" entries; docs updated in same PR. Existing deprecation patterns: printConnectDeprecation in proxy/index.ts, LEGACY_FLAGS_REMOVAL_DATE in analytics/index.ts.

---

## 2. Codebase Findings

Paths below are relative to `src/cli/commands/` unless rooted.

### Existing Implementations

**P1 — Diagnose the proxy in one place (story 1).** Every diagnostic it lists already exists and is assembled inside `proxy status`:
- `proxy/index.ts:142-288` — `proxy status` action: `checkProxyHealth({deep})`, `collectVisibleDeliveryHealth`, `collectDesktopCollection`, `collectClientNotices`, `findOlderCliOnPath`, `checkClaudeCodeOtlpEndpoint`; prints text or a `--json` payload (`status, apiKey, url, port, profile, uptimeSec, level, version, project, reason, lastRecordedIssue, otlpEndpointMismatch, desktop, analytics, clientPortMismatch, clientSharedKey, olderCliOnPath, hooksOfAnotherInstall`). Gateway key printed unmasked (`:184`, `:243`).
- `proxy/health-check.ts:87` `checkProxyHealth` — shallow `/health` + optional deep `GET /v1/llm_models` (401/403/non-JSON → `unauthorized`). Consumers: `proxy/index.ts`, `proxy/analytics-command.ts:276`, `proxy/connect-orchestrator.ts` (`ensureDaemon`), `proxy/watcher.ts`. Never throws.
- `proxy/delivery-health.ts:101` `collectDeliveryHealth` → `DeliveryHealth{status, reason, pendingBytes, heldBytes, sendFailure, latestDrop}`; `DELIVERY_REASONS:51` label + `run` remedy per reason; `formatDeliveryLines:233`, `formatDropLines:190`. Consumers: `analytics-command.ts` (`analytics status`), `analytics-delivery-lines.ts`.
- `proxy/analytics-delivery-lines.ts` — `collectClientNotices:288` (port mismatch, shared key, hooks of another install, iterating `CLIENT_CONFIGS:169` and `HOOK_CONNECTORS:226`), `collectDesktopCollection:84`, `formatAnalyticsLines:54`. Only reads.
- `proxy/connect-orchestrator.ts:509/516` `findOlderCliOnPath` / `formatOlderCliWarning` — also printed after every `connect` (`:1076`).
- `proxy/connectors/claude-code-otlp-endpoint.ts:57` `checkClaudeCodeOtlpEndpoint`.
- `proxy/inspect-desktop.ts:123/153` `inspectDesktopProxy` / `printDesktopInspection` — daemon URLs, Desktop dirs, SSO credentials, last N sessions with ingest status and `reasons`. Only consumer: `proxy inspect desktop` (`proxy/index.ts:431-446`).
- `doctor/index.ts:29` `codemie doctor` — fixed `checks: HealthCheck[]` list (`:93-105`) plus provider check after `AIConfigCheck`; no `--json`; no proxy check today. `doctor/formatter.ts` renders ✓/⚠/✗/○ + hint; `displaySummary:128` calls `process.exit(1)` when any result has `success:false`.
- `doctor/types.ts` — `HealthStatus = ok|warn|error|info`, `HealthCheckDetail{status,message,hint?}`, `HealthCheckResult{name,success,details}`, `HealthCheck`, `ItemWiseHealthCheck`. 11 implementers under `doctor/checks/`. A second, differently-shaped `HealthCheckDetail` (`'ok'|'warning'|'error'`) lives at `src/providers/core/types.ts:173`, adapted by `doctor/type-adapters.ts`.

**P2 — Point the user at the next command / fix (story 0).**
- Hint carriers: `ReportRow.hint` (`proxy/analytics-report.ts:4-10`, rendered 4 spaces under the row) used by `analytics-status.ts:58,70` and `delivery-health.ts:178`; `HealthCheckDetail.hint` (`doctor/types.ts:18`, rendered by `doctor/formatter.ts:68,91,117`).
- Inline styles in use: `Run:` (22 occurrences across `proxy/index.ts`, `delivery-health.ts`, `launch-daemon.ts`, `analytics-delivery-lines.ts`, `analytics-status.ts`, `connect-orchestrator.ts`, `connectors/claude-code-otlp.ts`; also `run:` lowercase at `analytics-delivery-lines.ts:99,274`); `Next step:` (`analytics-command.ts:149`, `connect-orchestrator.ts:210,238,245`, `src/frameworks/plugins/graphify.plugin.ts:94`); `Repair:` (`proxy/index.ts:279`); `Hint:` (`src/utils/errors.ts:264`); `Next:` (`src/frameworks/plugins/bmad.plugin.ts:155`); `To withdraw it, run:` (`analytics-command.ts:380`); doctor/SSO hints `Run: codemie setup` (`src/providers/plugins/sso/sso.health.ts:49,70,93`).
- `src/cli/commands/proxy/analytics-hints.ts`: `adviceForReason:119` (`{description, command?, action?}`), `coverageNote`, `resumeNote`, `unaffectedChannels`.
- Help text: only `program.addHelpText('after', …)` at `src/cli/index.ts:67-81` (hard-coded; lists `proxy inspect desktop`). No per-group related-commands mechanism found (searched `Related commands`, `addHelpText`, `Next:`).
- Silent-context detection exists only in `bin/codemie.js:27,37,42`: `isHookProcess` (argv[2] `hook`/`sound`), `isScheduledSyncRun` (`src/utils/scheduled-run.ts:20`), `isMachineOutputInvocation` (`src/utils/machine-output.ts:13`, unit-tested). Not exposed to command code.

**P3 — Tip catalog and staleness (story 0).**
- `src/utils/tips.json` — 88 tips; `{id, category, message, command?, commands?}` (`src/utils/tips.ts:41`). Proxy/analytics tips teach `codemie proxy inspect desktop` (`:232`), `codemie proxy status --deep` (`:242`), `status --json`, connect/disconnect flags, `analytics --include-external` (`:680`). No tip for `proxy analytics`, OTLP connectors, `analytics sync`.
- `commands/tips.ts` — `collectKnownCommandNames:61` already collects full nested paths (`proxy connect`), but `isKnownVariation:105` only checks the top-level token after `codemie`; flags are never checked. Stale tips are dropped silently (debug log).
- `renderTip` (`src/utils/tips.ts:206`) consumers: `doctor/index.ts:230`, `src/cli/first-time.ts`.

**P4 — Deprecate old forms (cross-cutting).**
- `printConnectDeprecation` (`proxy/index.ts:64`) — `console.log` (stdout), bold yellow, no date; used by `connect desktop`/`connect vscode` aliases (`:393-429`), which stay visible in `--help` with `[deprecated]` descriptions.
- `LEGACY_FLAGS_REMOVAL_DATE = 'November 1, 2026'` (`analytics/index.ts:30`) — free-text date in option help (`:202-204`) and `console.log` warnings to stdout (`:236-253`); TODO at `:230` names what to drop (three options, mapping block, `report/reportFormat/reportOutput` in `analytics/types.ts`). Date already passed (today 2026-11-17).
- Hidden-option convention: `new Option('--scheduled').hideHelp()` (`analytics/index.ts:168`). No shared deprecation helper or date-gated test found (searched `deprecat*(`, `removeOn`, `REMOVAL_DATE` in tests).

**P5 — Project tracking per connector (story 3).**
- `proxy/analytics-command.ts:392` `createProxyAnalyticsCommand`: `disable`, `enable`, `exclude [path]`, `include [path]`, `connect-folder [path]` (`--project`, `--yes`), `disconnect-folder [path]`, `status [--json]`.
- `resolveAnalyticsConnector:76` — no flag means Claude Code; >1 flag throws. `status` alone fans out to every connected connector (`selectStatusConnectors:284`).
- `excludeProject:185` adds to `excludedProjects` (opt-out prefs); `includeProject:232` only removes from `excludedProjects` and then reports effective state via `reportEffectiveState:132` (gate evaluation, `Next step:` advice). Neither touches the scope allowlist.
- Scope allowlist writers are the connectors: Claude `CODEMIE_ANALYTICS_PROJECT_FILTER_ENV` in settings.json (`proxy/connectors/claude-code-otlp.ts:558-563`); Copilot `writeCopilotConnectorScope` (`src/agents/core/copilot-connector-scope.ts`, called from `connectors/copilot-chat-otlp.ts:291`, `copilot-cli-otlp.ts:122`).
- Work consent: `src/agents/core/evidence/consent-store.ts` exports `connectFolder:170`, `disconnectFolder:186`, `coveringEntries:203`, `lookupConsent`, `consentStatus`; no list-all export. Claude-only (`assertClaudeOnly:316`).
- `analytics status` mixes config (scope/tracked/excluded/collection) with delivery health (`showStatus:290-312`). `ANALYTICS_CONNECTORS` / `listActiveAnalyticsConnectors` (`proxy/analytics-connectors.ts:65,77`) are the shared connector table.

**P6 — Connect/disconnect symmetry (story 4).**
- `proxy/index.ts:291-345` `connect` flags; `:347-390` `disconnect` (no `--vscode`, no `--all`).
- `proxy/disconnect-orchestrator.ts:222` `disconnectTargets`; no target → prints `DISCONNECT_TARGET_LIST` and returns (exit 0). `connectTargets` (`connect-orchestrator.ts:890-897`) same: no target → `TARGET_LIST`, exit 0.
- VS Code BYOK: `connectors/vscode.ts` has `writeVsCodeLanguageModelsConfig:318`, `readVsCodeByokGateway:280`, no remover.
- Client inventory already enumerated by `CLIENT_CONFIGS` (6 entries: Desktop, VS Code CC ±Insiders, Codex desktop, VS Code BYOK ±Insiders) and `HOOK_CONNECTORS` (3) in `analytics-delivery-lines.ts`; omp not in either.
- Ignored-flag warnings exist for `--insiders` and `--model` (`connect-orchestrator.ts:902-910`); none for `--scope`/`--silent`.

**P7 — Analytics report flags & validation (story 5).**
- `analytics/index.ts:417-460` `parseFilterOptions` — invalid `--from`/`--to`/`--last` → `console.warn` + ignore. `parseDuration` in `analytics/date-args.ts:8` (`d|h|m`), shared with `analytics sync`.
- `--include-external` boolean on `analytics` (`:43`) vs `<policy>` `windows|always|never` on `sync bootstrap`/`sync install` (`:118,141`).
- Exit codes: invalid `--export` uses `process.exitCode = 1` (`:273`); catch-all uses `process.exit(1)` (`:410`); sync subcommands assign `process.exitCode` from runners.

### Decisions Already in the Code

- `proxy analytics` nested under `proxy`, not top-level, "so it is never confused with … `codemie analytics`" — `proxy/analytics-command.ts:4-6`.
- Default connector = Claude Code when no flag ("the pre-existing behavior") — `analytics-command.ts:75`; alternative (all connected) is already used by `status` only.
- `--scope user` resets the Claude allowlist to `[]` — `connectors/claude-code-otlp.ts:558-563`; option help documents it ("resets the project list", `proxy/index.ts:316`). Copilot `resolveScope` returns `{enabled, scope:'user'}` with no paths (`copilot-chat-otlp.ts:229-231`, `copilot-cli-otlp.ts:102-104`).
- `--force` carries six meanings: replace a running daemon (`connect-orchestrator.ts:413-445`), write Codex config without the app (`:692-700`), replace foreign omp extension (`connectors/omp.ts:53`), overwrite Claude settings env/hook conflicts (`connectors/claude-code-otlp.ts:535-544`), discard invalid allowlist (`:551`, `claude-code-otlp-flow.ts:64`), replace another Codex provider (`connectors/codex-desktop.ts:304`). Each error message tells the user "re-run with --force".
- `--silent` = consent for Claude Code OTLP; non-TTY without it throws before SSO (`connect-orchestrator.ts:921-927`). `connect-folder` uses `--yes` for the same role (`analytics-command.ts:424`).
- Deprecation messages go to stdout (`console.log`) in both existing patterns.
- `codemie doctor` exits 1 when any result has `success:false`, including warn-only checks (e.g. `AwsCliCheck` sets `success=false` on warn) — `doctor/formatter.ts:129-133`.
- Silent-context convention: hook (`hook`/`sound`), `--scheduled`, `--json` detection lives in `bin/codemie.js`; the logger console is nulled for hooks (`:28-29`).
- Exit-code convention: `process.exitCode` per `.ai-run/guides/integration/exposed-api.md:148`; `printProxyError` (`connect-orchestrator.ts:308`) calls `process.exit`.
- `enablePositionalOptions()` on `proxy` and `connect` exists only so the alias subcommands can reuse option names (`proxy/index.ts:94-96,294-297`; `resolveAliasOptions:85`).

### Task Statements Checked Against the Code

- "printConnectDeprecation in proxy/index.ts, LEGACY_FLAGS_REMOVAL_DATE in analytics/index.ts" — holds (`proxy/index.ts:64`, `analytics/index.ts:30`).
- "past Nov 1 2026 removal date" — holds (`analytics/index.ts:30`; today 2026-11-17).
- "mixed `Run:`/`Next step:`/`Repair:`/`Hint:` styles" — holds; additional variants `run:`, `Next:`, `To withdraw it, run:` exist (see P2).
- "reuse doctor HealthCheck types" — holds (`doctor/types.ts`); keeps `doctor/formatter.displaySummary` exit-on-any-`success:false` in place (consumer: every doctor check). A ProxyCheck reporting warn with `success:false` makes `codemie doctor` exit 1.
- "--verbose absorbs `proxy inspect desktop` session detail" — `inspectDesktopProxy` returns structured data (`inspect-desktop.ts:123`); only printer is `printDesktopInspection`.
- "include also adds to Project-scope allowlist" — contradicted as current behavior: include only edits `excludedProjects` (`analytics-command.ts:232-252`); allowlist owned by connector writers (P5).
- "with no connector flag apply to all connected connectors" — contradicted for enable/disable/include/exclude (default Claude, `:76-87`); holds for `status` (`:284`).
- "`--scope user` must not silently reset an existing project list" — current code resets it (`claude-code-otlp.ts:558-563`), documented in help (`proxy/index.ts:316`).
- "non-zero exit when no target given" — both connect and disconnect currently exit 0 on bare invocation (`connect-orchestrator.ts:894-897`, `disconnect-orchestrator.ts:224-229`).
- "suppressed for --json/hooks/scheduled" — detection exists only in `bin/codemie.js` (P2); keeps that mechanism in place, consumers: migrations, update check, what's-new.
- "deeper staleness check … subcommand paths and flags" — `collectKnownCommandNames` already yields nested paths; `isKnownVariation` checks only top level (`tips.ts:105-116`).
- "remove `connect desktop`/`connect vscode` aliases" — aliases have no removal date today; `printConnectDeprecation` gives none.

### Consumers of Changed Contracts

- **`proxy status --json` payload** (fields removed/masked): `proxy/__tests__/index.test.ts:1530-2400` (JSON, Desktop line, Analytics line, client notices), `daemon-status-contract.test.ts:217` (stopped shape), `tests/integration/proxy-status-otlp-mismatch.test.ts:59`, `docs/COMMANDS.md:1916`, CHANGELOG:17 (documents prior field removal). No in-repo programmatic reader of `apiKey` found (searched `proxy status --json`, `'status','--json'`).
- **`proxy inspect desktop`**: `src/cli/index.ts:70`, `tips.json:229-232`, `README.md:777,809`, `docs/COMMANDS.md:98,275-296`, `proxy/__tests__/inspect-desktop.test.ts`, `index.test.ts:1319`.
- **`status --deep`**: `tips.json:242`, `index.test.ts:1663,1728`; `checkProxyHealth({deep})` also used by `connect-orchestrator` and `watcher`.
- **`connect desktop`/`connect vscode`**: user-facing error text `proxy/connectors/desktop.ts:145,154,772`; `README.md:723`; `docs/COMMANDS.md:114-116,253`; `index.test.ts:289,1352`; `tests/integration/vscode-models.live.test.ts`; comment `health-check.ts:8`.
- **`connect-folder`/`disconnect-folder`**: `src/agents/plugins/claude-code-otlp/claude-code-otlp.notice.ts:14` (user notice text), `analytics-command.ts:380`, `proxy/__tests__/analytics-consent-command.test.ts`, `src/providers/plugins/sso/proxy/plugins/otlp-spool/__tests__/work-consent-publication.test.ts`, `tests/e2e/subscription-analytics/drive.mjs`.
- **`proxy analytics status --json`** shape (`{delivery, connectors}`): `tests/integration/hook-stdout.test.ts:215,231`, `tests/integration/analytics/claude-analytics-disable.test.ts:58`, `analytics-command.test.ts:213,353`, `analytics-advice.test.ts:200`.
- **`--force`/`--silent`**: user-facing "re-run with --force" texts (six sites, see Decisions); `--silent` text `connect-orchestrator.ts:926`; `connect-orchestrator.test.ts`, `connect-wiring.test.ts`.
- **`--report*` flags**: `analytics/__tests__/analytics-cli-metadata.test.ts:190`, `README.md:586`, `analytics/types.ts` fields.
- **`ReportRow` / `HealthCheckDetail.hint`**: `analytics-status.ts`, `delivery-health.ts`; 11 doctor checks + `type-adapters.ts`; provider-side `HealthCheckDetail` (`providers/core/types.ts:173`) used by `sso.health.ts` and `BaseHealthCheck.ts`.
- **`parseDuration`**: `analytics/index.ts:457` and `analytics sync` (shared).

### Architecture and Layers Affected

- CLI layer only (`src/cli/commands/{proxy,analytics,doctor,tips.ts}`, `src/cli/index.ts`), plus `src/utils/tips.{ts,json}`, `bin/codemie.js` detection helpers. Connector writers under `proxy/connectors/` and `src/agents/core/copilot-connector-scope.ts`, `src/agents/core/evidence/consent-store.ts` (agent-core layer) for story 3/4. No provider/proxy-daemon code is touched by the listed surfaces.

### Integration Points

- Daemon `/health` and `/v1/llm_models` via `checkProxyHealth`; OTLP spool via `summarizeSpoolDelivery`; SSO credentials via `getStoredAnalyticsCredentials` / `CodeMieSSO`.
- Client config files: Claude Desktop config, VS Code `settings.json` / `chatLanguageModels.json`, `~/.codex/config.toml`, Claude Code `settings.json`, Copilot hook files, omp extension.
- Commander (`Command`, `Option`, `.hideHelp()`, `addHelpText`, `enablePositionalOptions`).

### Patterns and Conventions

- Command factories `createXCommand(): Command` registered in `src/cli/index.ts:84-112`.
- Table-driven registries: `ANALYTICS_CONNECTORS`, `CLIENT_CONFIGS`, `HOOK_CONNECTORS`, `DELIVERY_REASONS` (`Record` keyed so a missing entry fails to compile).
- Collect/format split: `collect*` never throws, `format*` renders; `--json` emits the collected object.
- Errors: `ConfigurationError` + `withErrorHandling` setting `process.exitCode = 1` (`analytics-command.ts:112`).

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/integration/exposed-api.md` — CLI surface; `:148` CLI sets `process.exitCode` rather than throwing.
- `.ai-run/guides/architecture/architecture.md:40` — `cli/commands/` = Commander handlers.
- No guide covers deprecation, hint format, help text or tips.

### Architectural Decisions

- `docs/ARCHITECTURE-PROXY.md`, `docs/ARCHITECTURE-OTLP-PLUGIN.md` (connector contracts). CHANGELOG follows Keep a Changelog; `[Unreleased]` has `Added`/`Changed`, no `Deprecated` section anywhere in the file.

### Derived Conventions

- User docs for these commands: `README.md` (`:586`, `:723`, `:777`, `:809`) and `docs/COMMANDS.md` (`:98`, `:114-116`, `:253`, `:275-296`, `:1916`).

---

## 4. Testing Landscape

### Existing Coverage

- `proxy/__tests__/index.test.ts` — registration, start/stop/restart, `connect desktop`/`vscode` aliases, `inspect desktop`, `status` (text, `--json`, `--deep`, Analytics/Desktop lines, client notices).
- `proxy/__tests__/{connect-orchestrator,connect-wiring,disconnect-orchestrator,analytics-command,analytics-consent-command,analytics-status,analytics-advice,analytics-hints,delivery-health,health-check,inspect-desktop,daemon-status-contract}.test.ts`.
- `doctor/checks/__tests__/doctor-checks.test.ts`.
- `analytics/__tests__/analytics-cli-metadata.test.ts` (legacy `--report*` aliases, `--export` exit code).
- `src/utils/__tests__/machine-output.test.ts`.
- Integration: `tests/integration/{proxy-status-otlp-mismatch,hook-stdout,vscode-models.live}.test.ts`, `tests/integration/analytics/claude-analytics-disable.test.ts`.

### Testing Framework and Patterns

- Vitest; commands driven via `createProxyCommand().parseAsync([...], {from:'user'})`; dynamic-import mocking per `.ai-run/guides/testing/testing-patterns.md`; integration via `runIsolatedCli`/`createCLIRunner`.

### Coverage Gaps

- No tests for `commands/tips.ts` staleness logic or `src/utils/tips.ts` (`renderTip`, catalog load) — codegraph reports no covering tests.
- `doctor/index.ts` orchestration and `doctor/formatter.ts` have no covering tests; `HealthCheck`/`HealthCheckResult` flagged "no covering tests".
- `printConnectDeprecation`, `DisconnectTargets`/`DisconnectOptions` flagged without covering tests by codegraph (exercised indirectly via `index.test.ts`).
- `parseFilterOptions` invalid-date paths: no test found asserting warn-and-ignore.

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_TIPS` (tips on/off, `src/utils/tips.ts:132`), `CODEMIE_DEBUG`, `CODEMIE_ANALYTICS_PROJECT_FILTER_ENV` (Claude allowlist in settings.json), `NODE_ENV`/`VITEST` (startup skips in `bin/codemie.js:76`).

### Configuration Files

- `src/utils/tips.json` (shipped catalog), `~/.codemie/.tips-state.json` (rotation), Claude/Copilot analytics preference files, Copilot connector scope file, consent store (`consentStorePath`), daemon state/record files.

### Feature Flags and Deployment Concerns

- None found. Hidden flag `--scheduled` set by the OS job (`analytics/index.ts:168`).

---

## 6. Risk Indicators

- Large blast radius of `proxy status` output: ~40 unit cases in `proxy/__tests__/index.test.ts:1530-2400` plus integration `proxy-status-otlp-mismatch.test.ts` assert diagnostic lines that story 2 removes.
- User-facing strings outside the CLI layer reference forms the epic retires: `connectors/desktop.ts:145,154,772` (`connect desktop`), `claude-code-otlp.notice.ts:14` (`connect-folder`), `src/cli/index.ts:70` (`inspect desktop`), six "re-run with --force" messages.
- `doctor/formatter.displaySummary` exits 1 on any `success:false` (warn included) and calls `process.exit` — interacts with "exit non-zero on error" and a ProxyCheck in `codemie doctor` (see Task Statements).
- Two incompatible `HealthCheckDetail` types (`doctor/types.ts:15` vs `providers/core/types.ts:173`, `warn` vs `warning`) — the "one hint format" touches both.
- `--scope user` reset is current, documented behavior (`claude-code-otlp.ts:558-563`, `proxy/index.ts:316`); Copilot connectors store scope differently — two allowlist stores (see Existing Implementations P5).
- No-flag default (Claude only) for `proxy analytics` subcommands is kept in place by today's code; changing it alters `analytics-command.test.ts` expectations.
- Silent-context detection lives only in `bin/codemie.js`; tests call command factories directly and never pass through it.
- Consent store has no list export (`consent-store.ts`); `consent list` has no existing reader.
- `--report*` removal date already passed; the legacy test (`analytics-cli-metadata.test.ts:190`) asserts the flags are still accepted.
- `tips.ts`/`tips.json` and doctor orchestration have no tests.
- CHANGELOG has no `Deprecated` section precedent.
- Speculative: a shared deprecation helper and related-commands registry are new cross-cutting modules every story would import; story 0 ordering matters for the others.

---

## 7. Summary for Complexity Assessment

The epic is confined to the CLI layer (`src/cli/commands/{proxy,analytics,doctor}`, `tips.ts`, `src/cli/index.ts`, `src/utils/tips.*`) with reach into connector writers (`proxy/connectors/*`, `copilot-connector-scope.ts`) and the consent store for stories 3–4. Nearly every diagnostic `proxy doctor` needs already exists as a never-throwing collector (`checkProxyHealth`, `collectDeliveryHealth`, `collectClientNotices`, `collectDesktopCollection`, `findOlderCliOnPath`, `checkClaudeCodeOtlpEndpoint`, `inspectDesktopProxy`), currently composed inline in the `proxy status` action (`proxy/index.ts:142-288`); the doctor type system (`doctor/types.ts`) and formatter exist, but the formatter exits on any non-success including warnings.

Novel pieces with no existing counterpart: a per-group related-commands registry / `Next:` line, a shared deprecation helper with date-gated test, a silent-context check reachable from command code (today only in `bin/codemie.js`), flag-level tip validation, a VS Code BYOK remover, `disconnect --all`, `proxy clients`, and a consent list. Several task statements contradict current behaviour: `include` does not touch allowlists, no-flag `proxy analytics` targets Claude only, `--scope user` resets the list by design, and bare connect/disconnect exit 0. `--force` carries six distinct meanings across five files.

Test posture is strong for proxy (dense `index.test.ts`, orchestrator, analytics tests) — which also means many assertions change — and weak for tips, doctor orchestration and analytics date parsing. Docs (`README.md`, `docs/COMMANDS.md`, `src/cli/index.ts` help, `tips.json`) and user-facing strings in `connectors/desktop.ts` and `claude-code-otlp.notice.ts` reference forms being retired.

---

## 8. External References

None named by the task.
