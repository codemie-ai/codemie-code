# Proxy and Analytics CLI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** Redesign the `codemie proxy` / `codemie analytics` CLI surface per spec WP0→WP6.
**Architecture:** WP0 adds shared modules (program factory, invocation context, deprecation registry, related-commands registry, hint renderer, staleness validator) that every later task imports. Later WPs recompose existing never-throwing collectors; CLI layer plus connector writers and the consent store only.
**Tech Stack:** TypeScript ESM, Commander, Vitest.
**Spec:** `spec.md` (binds `story.md` ACs) and `technical-analysis.md`, same dir. Paths below are relative to `src/cli/commands/` unless rooted.

Commit per task using the repository's existing convention.

## Global Constraints
- ES modules, `.js` import extensions, `@/` alias; `logger.debug` not `console.log`; specific error classes; `process.exitCode`, never `process.exit`, in new/changed code.
- Vitest, commands driven via `createXCommand().parseAsync([...], {from:'user'})`, dynamic-import mocking.
- `DEPRECATION_REMOVE_ON = '2026-12-31'`, one constant for every form this release deprecates.
- Hint format: `<reason> — run: <command>` or `<reason> — <action>`.
- Deprecation notice: exactly one stderr line (also under `--json`); silent in hooks and the scheduled job.
- Each task leaves the build green: a task that deprecates/removes a form rewrites the tips, docs and product strings teaching it (the Task 6 scan enforces it) and adds its rows to the marked CHANGELOG deprecation block (created in Task 9); a task that adds a command adds its related-commands entry (the Task 4 test enforces it).

## Review Focus
1. Corrupt Copilot scope + no-flag `disable` → Copilot named as unreadable, preference written (test in Task 10).
2. `connect desktop --profile x` → replacement message, not Commander "unknown option" (test in Task 15).
3. `codemie analytics --include-external otel` → clear error, not a policy (test in Task 17).
4. `disconnect --all` run twice → second run reports nothing connected, exit 0, files unchanged (test in Task 14).
5. Non-TTY stdout or `--json` → no `Next:` line (test in Task 4).

---

**WP0 — Shared foundation**

## Task 1: Program factory (createProgram)
**Files:** Create `src/cli/program.ts`, test `src/cli/__tests__/program.test.ts`; Modify `src/cli/index.ts:61-112`.
**Produces:** `createProgram(): Command` (no argv parse, no side effects).
- Test-first: yes — `createProgram()` exposes `proxy status`, `proxy connect`, `analytics sync`, `doctor`, `tips` without parsing `process.argv`.
- [ ] Move the tree build into `createProgram`; `index.ts` calls it then parses. Root `addHelpText` moves with it.

## Task 2: Invocation context (getInvocationContext)
**Files:** Create `src/utils/invocation-context.ts` + test; Modify `bin/codemie.js:27-42`.
**Produces:** `getInvocationContext({argv?: string[], json?: boolean}): {hook: boolean, scheduled: boolean, json: boolean, silent: boolean}` (`silent` = hook || scheduled).
- Test-first: yes — argv `['node','codemie','hook']` → `hook:true, silent:true`; `--scheduled` → `scheduled:true`; `{json:true}` → `json:true, silent:false`; default argv is `process.argv`.
- [ ] Reuse `isScheduledSyncRun` and `isMachineOutputInvocation`; `bin/codemie.js` calls it instead of its inline checks.

## Task 3: Deprecation registry and removal-date check
**Files:** Create `src/cli/deprecation.ts`, tests `src/cli/__tests__/deprecation.test.ts`, `src/cli/__tests__/removal-date.test.ts`.
**Produces:**
```ts
interface DeprecationEntry { kind: 'deprecated'|'removed'; old: string; replacement: string; removeOn?: string; dropOn?: string }
export const DEPRECATION_REMOVE_ON = '2026-12-31';
export function deprecate(entry: DeprecationEntry, ctx?: {json?: boolean}): void;
export function deprecatedOption(entry: DeprecationEntry, flags: string, description: string): Option; // hidden
export function deprecatedCommand(entry: DeprecationEntry, name: string): Command;                   // hidden, calls deprecate() before action
export function removedCommand(entry: DeprecationEntry, name: string): Command; // hidden, allowUnknownOption+allowExcessArguments, fails naming replacement, exitCode 1
export function removedOption(entry: DeprecationEntry, flags: string): Option;  // hidden, use fails naming replacement, exitCode 1
export function listDeprecations(): readonly DeprecationEntry[];
```
- Test-first: yes — `deprecate` writes one stderr line containing old, replacement and `2026-12-31`; nothing under a hook/scheduled context; still writes under `{json:true}`; a `deprecatedOption` is absent from `helpInformation()`; using a `removedOption` sets `exitCode 1` naming the replacement.
- [ ] Removal-date test walks `createProgram()` + `listDeprecations()`: any entry past `removeOn`/`dropOn` still registered fails when `GITHUB_REF==='refs/heads/main'`, starts with `refs/tags/`, or `GITHUB_EVENT_NAME==='release'`; otherwise `console.warn`. Unit-test the gate predicate with stubbed env.

## Task 4: Related-commands registry and Next: line
**Files:** Create `src/cli/related-commands.ts` + test; Modify `proxy/index.ts`, `proxy/analytics-command.ts`, `analytics/index.ts` (apply help).
**Produces:** `RELATED: Record<string, {related: {path: string, purpose: string}[], next: {default?: string, byOutcome?: Record<string,string>}}>`; `applyRelatedHelp(root: Command): void` (`addHelpText('after', 'Related commands…')` on every proxy/analytics node); `printNext(path: string, outcome?: string, ctx?: {json?: boolean}): void`.
- Test-first: yes — over `createProgram()` every `proxy*`/`analytics*` node has a `RELATED` key and every target resolves; `--help` of `proxy status` ends with "Related commands"; `printNext` prints nothing when `process.stdout.isTTY` is false, under `{json:true}`, or in a silent context; `byOutcome` overrides `default`.
- [ ] Call `printNext` at the success end of existing proxy/analytics actions (one line max).

## Task 5: Hint renderer and format migration
**Files:** Create `src/utils/hint.ts` + test, `src/cli/__tests__/hint-prefix-ban.test.ts`; Modify `doctor/formatter.ts:68,91,117`, `proxy/analytics-report.ts`, `proxy/delivery-health.ts:51` (`DELIVERY_REASONS`), `proxy/analytics-hints.ts`, the analysis P2 hint sites under `src/cli/commands/{proxy,analytics,doctor}` (including lowercase `run:` at `analytics-delivery-lines.ts:99,274`), `src/providers/plugins/sso/sso.health.ts:49,70,93`. Not `graphify.plugin.ts`, `bmad.plugin.ts` or `src/utils/errors.ts` (NG4).
**Produces:** `renderHint(a: {reason: string, command?: string, action?: string}): string`.
- Test-first: yes — `renderHint({reason:'Daemon stopped', command:'codemie proxy start'})` → `'Daemon stopped — run: codemie proxy start'`; action variant; ban test fails on any of the case-sensitive prefixes `Run:`, `Next step:`, `Repair:`, `Hint:`, `To withdraw it, run:` under `src/cli/commands/{proxy,analytics,doctor}` and `src/providers/**/*.health.ts` (lowercase `run:` is not banned; it is the new format).
- [ ] Migrate sites; fold the formatter's three hint blocks into one helper. The doctor and provider `HealthCheckDetail` types are not merged.

## Task 6: Tip and doc staleness validator
**Files:** Modify `tips.ts:61-116`; Create `src/utils/tips-validator.ts`, test `src/utils/__tests__/tips-validator.test.ts`.
**Produces:** `validateCommandExample(program: Command, example: string): {ok: true} | {ok: false, reason: string}`; `scanDocs(paths: string[]): Finding[]` skipping blocks between `<!-- deprecation-table:start -->` / `<!-- deprecation-table:end -->`; `checkDeprecationTables(paths: string[]): Finding[]` (every marked row matches a registry entry and every registry entry has a row; no marked block and empty registry → ok).
- Test-first: yes — `codemie proxy nope` → not ok (bad subcommand); `codemie proxy status --bogus` → not ok (bad flag); a form in `listDeprecations()` → not ok; every `tips.json` entry passes; scan over README, `docs/COMMANDS.md`, `docs/ARCHITECTURE-PROXY.md`, `docs/ANALYTICS-REPORT.md`, `docs/ANALYTICS-SYNC.md` and root help finds no registered old form; `checkDeprecationTables` over `CHANGELOG.md` and `docs/PROXY-AND-ANALYTICS.md` (when present) passes.
- [ ] `codemie tips` flags stale tips instead of dropping them silently.

**WP1 — `proxy doctor`**

## Task 7: Doctor composition module
**Files:** Create `proxy/doctor/compose.ts` + `proxy/__tests__/doctor-compose.test.ts`.
**Consumes:** collectors from analysis P1; `doctor/types.ts`; Task 5; connector scope read directly from the existing stores (Claude settings env `connectors/claude-code-otlp.ts:549-563`, `src/agents/core/copilot-connector-scope.ts`) until Task 10.
**Produces:** `composeProxyDoctor(opts: {authProbe: boolean, verbose: boolean}): Promise<ProxyDoctorReport>` with `sections: {id, status: HealthStatus, message, hint?}[]`, `nothingConnected: boolean`, `verbose?`.
- Test-first: yes — awaiting-login daemon (`/health` reports `analytics.credentials:'stale'`) → auth section `error` naming `codemie profile login`, and no keyed request is made (sign-in mock not called); pid mismatch → daemon `error`; a throwing collector → `error` section; nothing connected + daemon stopped → `nothingConnected:true`, no error, hint `codemie proxy connect`; connector repair hint contains its current `--scope`.
- [ ] State via `readDaemonStatus` (never `checkStatus`), `/health` with `expectedPid: state.pid`, authenticated probe with timeout, skipped when stopped/stale/`authProbe:false`. Client section uses `collectClientNotices` for now (Task 13 switches it to the client table).

## Task 8: proxy doctor command and ProxyCheck
**Files:** Create `proxy/doctor/command.ts`, `doctor/checks/ProxyCheck.ts`; Modify `proxy/index.ts`, `doctor/index.ts:93-105`, `src/cli/related-commands.ts`; tests `proxy/__tests__/doctor-command.test.ts`, `doctor/checks/__tests__/doctor-checks.test.ts`.
- Test-first: yes — error section → `exitCode 1`, warn-only → 0; `--json` stdout is one parseable document with every section; `--json --verbose` output contains no `gatewayKey`/`apiKey`; `--verbose` includes Desktop dirs, sessions with reasons, config paths; `ProxyCheck` (no auth probe) → `success:false` only on error, nothing connected → `info`, never rejects.
- [ ] `--verbose` maps `inspectDesktopProxy` to `{directories, sessions, hasCredentials, credentialsUrl}` (no `daemonState`); `--verbose` detail throw → `warn`.

**WP2 — `proxy status`**

## Task 9: Facts-only proxy status, key masking, --deep/inspect deprecations
**Files:** Modify `proxy/index.ts:142-288,431-446`, `src/cli/program.ts` root help, `src/utils/tips.json:229-242`, `README.md:777,809`, `docs/COMMANDS.md:98,275-296,1916`, `CHANGELOG.md`; tests `proxy/__tests__/index.test.ts:1530-2400`, `inspect-desktop.test.ts`, `daemon-status-contract.test.ts`, `tests/integration/proxy-status-otlp-mismatch.test.ts`.
- Test-first: yes — text and `--json` print only state/url/port/profile/project/version/uptime; key masked (including `Client keys:` line) unless `--show-key`; `Issues found — run: codemie proxy doctor` when compose reports warn/error; stopped → `{"status":"stopped"}`; `--deep` and `inspect desktop` still work, hidden, one stderr notice pointing to `proxy doctor` / `proxy doctor --verbose`.
- [ ] `--deep` via `deprecatedOption`, `inspect desktop` via `deprecatedCommand`; rewrite the ~40 status cases. Create the CHANGELOG `[Unreleased]` `Deprecated` section with a marked deprecation-table block (old → new → date) holding these two rows.

**WP3 — `proxy analytics`**

## Task 10: Connector scope interface and no-flag fan-out
**Files:** Modify `proxy/analytics-connectors.ts:31`, `proxy/analytics-command.ts:76-252`, `proxy/connectors/claude-code-otlp.ts:549-563`, `src/agents/core/copilot-connector-scope.ts`, `proxy/doctor/compose.ts`; tests `analytics-command.test.ts`, `doctor-compose.test.ts`.
**Produces:** `AnalyticsConnector.readScope(): {scope: 'user'|'project', paths: string[]} | {invalid: string}`; `addProject(path: string): Promise<void>`; `selectTargetConnectors(verb, flags): {targets, unreadable}`.
- Test-first: yes — no flag `disable` with corrupt Copilot scope → Copilot preference written and named as unreadable; second connector throwing → third still attempted, each reported, `exitCode 1`; no connected connector → non-zero, names `codemie proxy connect` and flags; `exclude` then `include` restores tracking for every connector; `include` writes project list before removing exclusion and on second-step failure names the step owed and that a re-run is safe; parent-folder exclusion → explained, no success.
- [ ] enable/disable target preference-set-or-unreadable connectors; include/exclude target `listActiveAnalyticsConnectors`. Switch `compose.ts` scope reads to `readScope` (Task 7 tests stay green).

## Task 11: consent grant|revoke|list
**Files:** Modify `src/agents/core/evidence/consent-store.ts`, `proxy/analytics-command.ts:380,392-430`, `src/agents/plugins/claude-code-otlp/claude-code-otlp.notice.ts:14`, `tests/e2e/subscription-analytics/drive.mjs`, `CHANGELOG.md` deprecation block; tests `analytics-consent-command.test.ts`, `work-consent-publication.test.ts`.
**Produces:** `listConsents(): ConsentEntry[]`.
- Test-first: yes — `consent grant/revoke` match today's confirmation and coverage output; `consent list` prints all entries; `connect-folder`/`disconnect-folder` still work via `deprecatedCommand` with one stderr notice.

## Task 12: analytics status shows configuration only
**Files:** Modify `proxy/analytics-command.ts:290-312`, `proxy/analytics-status.ts`; tests `analytics-status.test.ts`, `tests/integration/hook-stdout.test.ts`, `tests/integration/analytics/claude-analytics-disable.test.ts`.
- Test-first: yes — text shows per connector scope, tracked, excluded, collection, consented folders and a hint to `proxy doctor`, no delivery lines; `--json` keeps `delivery` and adds `consentedFolders`.

**WP4 — connect / disconnect**

## Task 13: Client-target table and proxy clients
**Files:** Create `proxy/client-targets.ts`, `proxy/clients-command.ts`; Modify `proxy/analytics-delivery-lines.ts:169,226`, `proxy/connectors/claude-code-otlp.ts:818,835`, `proxy/doctor/compose.ts`; tests.
**Produces:** `CLIENT_TARGETS: ClientTarget[]` with `{id, flag, label, isConnected(): Promise<boolean>, configLocation, disconnect?(): Promise<void>, carriesAnalytics}`, includes omp.
- Test-first: yes — fixture with Desktop + Claude Code connected: `proxy clients --json`, doctor client section and the `--all` target set agree; analytics rows show scope (via `readScope`), no project lists.
- [ ] `CLIENT_CONFIGS`/`HOOK_CONNECTORS` become views; one Claude Code connected predicate. Commander flags and `TARGET_LIST` unchanged.

## Task 14: VS Code BYOK remover, disconnect --vscode and --all
**Files:** Modify `proxy/connectors/vscode.ts:280-318`, `proxy/disconnect-orchestrator.ts:222`, `proxy/index.ts:347-390`; tests `disconnect-orchestrator.test.ts`.
**Produces:** `removeVsCodeLanguageModelsConfig(opts: {insiders: boolean}): Promise<{removed: boolean}>`.
- Test-first: yes — removes the `CodeMie`/`customendpoint` provider only when all model URLs are loopback, keeps user models and a non-loopback "CodeMie"; `--all` continues past a failure, reports each, `exitCode 1` on any failure, daemon kept unless `--stop`; second `--all` run is a no-op with exit 0.

## Task 15: Connect flag cleanup and alias removal
**Files:** Modify `proxy/index.ts:64-96,291-429`, `proxy/connect-orchestrator.ts`, the six `--force` sites (analysis Decisions), `proxy/connectors/desktop.ts:145,154,772`, `proxy/health-check.ts:8`, `README.md:723`, `docs/COMMANDS.md:114-116,253`, `src/utils/tips.json` (connect/disconnect `--force`/`--silent` tips), `CHANGELOG.md` deprecation block; tests `connect-orchestrator.test.ts`, `connect-wiring.test.ts`, `index.test.ts:289,1352`, `tests/integration/vscode-models.live.test.ts`.
- Test-first: yes — foreign config without `--overwrite` → unchanged, error names `--overwrite`; `--restart-daemon` replaces daemon only; `--force` = both + notice naming both; `--silent` = `--yes` + notice; `--scope`/`--yes`/`--insiders`/`--model` without an applicable target warn; bare connect/disconnect print the list, `exitCode 1`; `connect desktop --profile x` fails naming `connect --claude-desktop`.
- [ ] `--scope` loses `.default('user')` on connect and disconnect; orchestrators coalesce after checks. Aliases become `removedCommand`; delete `printConnectDeprecation`, `resolveAliasOptions` and alias-only `enablePositionalOptions()`.

## Task 16: Scope confirmation pre-flight
**Files:** Modify `proxy/connect-orchestrator.ts:921-1057`, connector writers via `readScope`; tests `connect-orchestrator.test.ts`.
- Test-first: yes — project-scope connector with paths + `--scope user` or no `--scope`, TTY: lists dropped projects, decline changes nothing for it; non-TTY without `--yes` → `exitCode 1` naming `--yes` before `verifySsoCredentials`/`ensureDaemon` are called; list changed after confirmation → writer skips with message.
- [ ] Runs in the pre-lock phase beside the existing Claude confirmation, for all three connectors.

**WP5 — `codemie analytics`**

## Task 17: codemie analytics reporting cleanup
**Files:** Modify `analytics/index.ts:30-460`, `analytics/types.ts`, `analytics/sync/bootstrap/guided-late-steps.ts:185`, `README.md:586`, `src/utils/tips.json:680`, `CHANGELOG.md` deprecation block (Removed rows for `--report*`, Deprecated row for bare `--include-external`); test `analytics/__tests__/analytics-cli-metadata.test.ts`.
- Test-first: yes — `--report*` fail naming `--export`/`-o`; invalid `--from`/`--to`/`--last` → `exitCode 1` with accepted format; `--include-external never` maps via `includeExternalFor`; bare form → `always` + notice; `otel`/`sync` as value → error; failure path sets `process.exitCode` (no `process.exit`); scheduled sync with stored setting unchanged.
- [ ] Remove `LEGACY_FLAGS_REMOVAL_DATE` and the report fields; `--report*` via `removedOption`.

**WP6 — Documentation**

## Task 18: Docs page, tips, CHANGELOG
**Files:** Create `docs/PROXY-AND-ANALYTICS.md`; Modify `src/utils/tips.json`, `docs/ARCHITECTURE-PROXY.md`, `docs/ANALYTICS-REPORT.md`, `docs/ANALYTICS-SYNC.md`, remaining README/`docs/COMMANDS.md` sections, `CHANGELOG.md`, root help in `src/cli/program.ts`; test `src/utils/__tests__/tips-coverage.test.ts`.
- Test-first: yes — tips exist for `proxy doctor`, `proxy analytics` enable/disable, include/exclude, consent, Claude Code and Copilot connectors, `proxy clients`, `analytics sync`.
- [ ] Page covers groups and the seven AC45 use cases, with its own marked deprecation table (old → new → date); finish the CHANGELOG `Deprecated`/`Removed` sections with a note that the removal ticket is owed.
