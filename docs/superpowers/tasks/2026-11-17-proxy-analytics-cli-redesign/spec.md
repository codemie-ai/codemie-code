# Proxy and Analytics CLI Redesign — Spec

**Story**: `story.md` (approved; its ACs, NGs and decisions bind). **Research**: `technical-analysis.md`. **Size**: XL, one story (D1).

## Why

Proxy diagnosis is split over four commands with no verdict, the gateway key prints in clear, project tracking has three lists with mismatched verbs, connect/disconnect are asymmetric with a six-meaning `--force`, and deprecation is ad hoc. Work packages ship in order WP0→WP6, each leaving the CLI releasable.

## Design

**WP0 — shared foundation (new modules, imported by every later WP).**
- *Program factory*: `createProgram(): Command` holds what `src/cli/index.ts:61-112` builds today; `index.ts` calls it and parses. Every tree-walking test (tips, related commands, removal date) loads `createProgram()`, never a hand-kept list.
- *Invocation context*: move hook / scheduled-run / `--json` detection out of `bin/codemie.js:27-42` (today `isHookProcess`, `src/utils/scheduled-run.ts:20`, `src/utils/machine-output.ts:13`) into one `src/utils/` module, `getInvocationContext({argv = process.argv, json?})`; commands pass their parsed `opts.json`, `bin/codemie.js` passes argv. The deprecation helper, the `Next:` line and tips all call it. Unit-tested.
- *Deprecation registry*: one table of every deprecated form `{old, replacement, removeOn}` plus `deprecate(form)` that writes exactly one stderr line (also under `--json`; silent in hooks and the scheduled job). Forms are created only through `deprecatedOption(entry)` / `deprecatedCommand(entry)`, which build the hidden Commander node and call `deprecate()` on use, so a deprecated form cannot exist without its entry. One shared constant `DEPRECATION_REMOVE_ON = 2026-12-31` for every form this release deprecates. Removed forms are entries of kind `removed` with a `dropOn`, built as stubs that accept any options and arguments and fail naming the replacement; the alias plumbing (`resolveAliasOptions`, `proxy/index.ts:85-88`, and the alias-only `enablePositionalOptions()` calls) goes. Replaces `printConnectDeprecation` (`proxy/index.ts:64`) and `LEGACY_FLAGS_REMOVAL_DATE` (`analytics/index.ts:30`).
- *Related-commands registry*: keyed by command path → `{related[], next: {default, byOutcome?}}`, each related path with a one-line purpose; applied to every `proxy`/`analytics` command via `addHelpText('after')`. `printNext(path, outcome?)` prints the single `Next:` line after success when stdout is a TTY and the invocation context is not silent, so commands sharing one path (`connect --claude-code-otlp` vs `--claude-desktop`, partial `--all`) pick the right follow-up. A test over `createProgram()` requires every `proxy`/`analytics` node to have an entry whose key and targets resolve.
- *Hint renderer*: `src/utils/hint.ts`, taking `{reason, command?, action?}` (the `NotTrackedAdvice` shape, `analytics-hints.ts:14-20`, which `DELIVERY_REASONS` maps onto) and rendering `<reason> — run: <command>` or `<reason> — <action>`. Used by `ReportRow.hint` (`proxy/analytics-report.ts:4-10`), doctor `HealthCheckDetail.hint` (`doctor/types.ts:18`; the formatter's three hint blocks, `doctor/formatter.ts:68,91,117`, fold into one) and the provider `HealthCheckDetail` (`providers/core/types.ts:173`, `warning` status). The two detail types are not merged; both carry the rendered string. A unit test fails on `Run:`, `Next step:`, `Repair:`, `Hint:`, `To withdraw it, run:` under `src/cli/commands/{proxy,analytics,doctor}` and `src/providers/**/*.health.ts`.
- *Tip/doc staleness*: a validator walking `createProgram()` checks each tip's `commands[]` subcommand path and flags (today only the top-level token, `commands/tips.ts:105-116`) and rejects forms in the deprecation registry; `codemie tips` flags them, and a unit test over `tips.json` and the listed docs fails the build. The docs scan skips one marked deprecation-table block (the AC46 page table, the CHANGELOG section), and a test checks that block's rows against the registry.
- *Removal-date check*: a unit test over the registry and `createProgram()`. It fails when `GITHUB_REF` is `refs/heads/main`, starts with `refs/tags/`, or `GITHUB_EVENT_NAME=release` (the publish build, `.github/workflows/publish.yml:10-11,55`); elsewhere it warns.

**WP1 — `proxy doctor`.** One composition module builds sections from the existing never-throwing collectors (today inlined in `proxy/index.ts:142-288`): `checkProxyHealth`, `collectClientNotices`, `collectDeliveryHealth`, `collectDesktopCollection`, `findOlderCliOnPath`, `checkClaudeCodeOtlpEndpoint`, analytics connector prefs/scope; the client section reads the WP4 client-target table. `--verbose` adds `inspectDesktopProxy` (`inspect-desktop.ts:123`) mapped to doctor's own shape (directories, sessions, `hasCredentials`, `credentialsUrl`, no `daemonState`) and config paths. Each section is wrapped so a throw becomes an `error` section (`warn` for `--verbose` detail); `ProxyCheck.run` never rejects. Daemon contact rules: state is read with `readDaemonStatus`, never `checkStatus`; every `/health` call passes `expectedPid: state.pid`, and a mismatch is a daemon `error`; when the pid-checked `/health` reports `analytics.credentials === 'stale'`, the authentication section is an error naming `codemie profile login` and the authenticated probe is skipped (an awaiting-login daemon starts a sign-in on any keyed request, `awaiting-login-listener.ts:96-106`). The authenticated probe has a timeout and is skipped when the daemon is not running. Output reuses `doctor/types.ts`; exit via `process.exitCode`. The condensed `ProxyCheck` in `codemie doctor` uses the same module without the authenticated probe, and sets `success:false` only on error, because `doctor/formatter.ts:129-133` exits 1 on any `success:false`. A test with an awaiting-login daemon proves no sign-in starts; a test proves `proxy doctor --json --verbose` contains no `gatewayKey` or `apiKey`.

**WP2 — `proxy status`.** Facts only, key masked unless `--show-key` (including the `Client keys:` line, `proxy/index.ts:244`), one `Issues found — run: codemie proxy doctor` line when the composition module reports warn/error.

**WP3 — `proxy analytics`.** `AnalyticsConnector` (`analytics-connectors.ts:31`) gains `readScope(): {scope, paths} | {invalid}` and `addProject(path)`, delegating to the existing stores (Claude settings env, `connectors/claude-code-otlp.ts:549-563`; Copilot `copilot-connector-scope.ts`); `include`, the WP4 scope pre-flight, `proxy clients` and doctor's `--scope` hint call them. No connector flag:
- `enable`/`disable` act on every connector whose preference is set or whose state cannot be read, not only those `listActiveAnalyticsConnectors` reports (it drops unreadable ones, `analytics-connectors.ts:58-61,77-89`), and name any connector that could not be read. `disable` writes the preference even when the scope is corrupt; the Copilot gate checks the preference before the scope (`copilot-analytics-gate.ts:31-40`), so a later scope repair does not resume collection.
- `include`/`exclude` act on every connected connector (`listActiveAnalyticsConnectors`).
- The fan-out continues per connector, reports each result, and sets `process.exitCode = 1` if any failed, as `disconnect --all` does.
`include` in project scope writes the connector's project list first and removes the exclusion second; it confirms "tracked" only after both succeed, otherwise it names the step still owed and says a re-run is safe. `consent grant|revoke|list` wrap `consent-store.ts`, which gains a list export.

**WP4 — connect/disconnect.** One client-target table in `proxy/` owns the connectable set: per entry id, flag, label, `isConnected()`, config location, optional `disconnect`, carries-analytics; it includes omp. `proxy clients`, `disconnect --all` and the doctor client section read only this table; `CLIENT_CONFIGS` and `HOOK_CONNECTORS` (`analytics-delivery-lines.ts:169,226`) become views of it, and Claude Code gets one connected predicate (resolving `hasClaudeCodeOtlpHooks` `:818` vs `readClaudeCodeHookInstall` `:835` in `claude-code-otlp.ts`). Commander flags and `TARGET_LIST` stay as they are. VS Code BYOK remover beside `writeVsCodeLanguageModelsConfig` (`connectors/vscode.ts:318`) keeps user-added models and removes a `CodeMie`/`customendpoint` provider only when every model URL is loopback (as `readVsCodeByokGateway`, `:280-289`). `--all` continues past a failing connector, reports each, exits non-zero if any failed. Every scope pre-flight (D18, all three connectors) runs in the pre-lock phase beside the existing Claude Code confirmation (`connect-orchestrator.ts:921-986`), before `verifySsoCredentials` and `ensureDaemon`: it reads the project lists, asks, and fails without a TTY when `--yes` is absent; each writer later resets a list only if it still equals the confirmed one, otherwise skips that connector with a message. `--scope` loses its Commander default on both `connect` (`proxy/index.ts:313-320`) and `disconnect` (`:358-365`); the orchestrators coalesce to `user` after the confirmation and ignored-flag checks. `--force` call sites (six, listed in the analysis) split into `--restart-daemon` (daemon replace) and `--overwrite` (the five config sites).

**WP5/WP6** as the story states; new page `docs/PROXY-AND-ANALYTICS.md`. `--include-external [policy]` rejects subcommand names (`otel`, `sync`, `analytics/index.ts:47-65`) with a clear error and maps the value through `includeExternalFor` (`analytics/sync/policy.ts:11`); the bare-form string at `analytics/sync/bootstrap/guided-late-steps.ts:185` is rewritten under AC47.

## Acceptance criteria

- Every `proxy`/`analytics` command's `--help` ends with "Related commands", and an interactive success prints at most one `Next:` line (story AC1, AC2).
- `--json` prints only JSON plus stderr deprecation notices; hooks and the scheduled job print nothing extra (story AC3).
- All fix advice from `proxy`, `analytics` and `doctor` uses the single hint format (story AC4).
- The tip catalog covers `proxy doctor`, `proxy analytics` (enable/disable, include/exclude, consent), the Claude Code and Copilot connectors, `proxy clients` and `analytics sync`, teaches no deprecated form, and the staleness check flags bad subcommands/flags and fails the build (story AC5, AC6).
- A deprecated form still works, prints one stderr line with replacement and removal date, and is hidden from help (story AC7).
- Past its removal date a still-registered form fails the build on the default branch and on tag/release builds, and warns on PR, feature and hotfix branches.
- A removal ticket lists the deprecated forms, date and owner (story AC8a); CHANGELOG has a Deprecated/Removed section old → new → date (story AC9).
- `proxy doctor` meets story AC10–AC16 unchanged (story AC10, AC11, AC12, AC13, AC14, AC15, AC16).
- `codemie doctor` has a condensed proxy section; proxy warn does not fail it, proxy error does, nothing connected is info (story AC17).
- `proxy status` meets story AC18–AC21 unchanged (story AC18, AC19, AC20, AC21).
- `proxy analytics` meets story AC22–AC28 unchanged (story AC22, AC23, AC24, AC25, AC26, AC27, AC28).
- A no-flag `enable`/`disable` names any connector whose state could not be read, and any per-connector failure exits non-zero after every connector was attempted.
- `connect`/`disconnect` meet story AC29–AC40 unchanged; `--force` acts as `--restart-daemon --overwrite` during the deprecation period (story AC29, AC30, AC31, AC32, AC33, AC34, AC35, AC36, AC37, AC38, AC39, AC40).
- `proxy clients`, `disconnect --all` and the doctor client section agree on what is connected.
- `codemie analytics` meets story AC41–AC44 unchanged (story AC41, AC42, AC43, AC43a, AC44).
- Docs meet story AC45–AC47, with a docs scan in the automated check (story AC45, AC46, AC47).

## Non-goals

- Renaming the `proxy analytics` group (story NG1).
- Changing daemon collection, the analytics backend contract or report contents (story NG2).
- `proxy doctor --fix` (story NG3).
- Commands outside `proxy`/`analytics`, except hints pointing at retired forms (story NG4).
- Changing what "user" scope means; only the confirmation is new (story NG5).
- `mcp-proxy` changes (story NG6).
- Code that creates Jira tickets; the removal ticket is a handoff action.
- A per-install random gateway key.

## Decisions

- D1: One story, WP0–WP6 in order, no split — user
- D2: Deprecated forms work until a fixed removal date, default one month; past-due `--report*` and `connect desktop`/`vscode` are removed now — user
- D3: Related commands in help, `Next:` line, one hint format, deeper tip staleness check — user
- D4: Run with `sdlc-autonomous` — user
- D5: The run opens a PR — user
- D6: Documentation page, deprecation table, doc updates and CHANGELOG are in scope — user
- D7: `--scope user` keeps resetting the list but confirms first; `--yes` skips, required non-interactive — user
- D8: `proxy status` stays, facts only — user
- D9: `proxy doctor` exits non-zero on error only
- D10: No connector flag acts on every connected connector; errors when none
- D11: Gateway key masked in `proxy status` unless `--show-key`; never in `proxy doctor`
- D12: `--force` splits into `--restart-daemon` and `--overwrite`; kept as both during deprecation
- D13: `include` adds to each connector's own project list in project scope
- D14: `--include-external <windows|always|never>` is the one form; stored sync settings untouched
- D15: Proxy warn does not fail `codemie doctor`; nothing connected is info
- D16: Deprecation notices go to stderr under `--json`; silent in hooks and scheduled sync
- D17: Only `proxy analytics status` lists tracked/excluded projects
- D18: The scope confirmation applies to all three connectors, on `--scope user` and on no `--scope` — user
- The removal-date check fails the default branch and tag/release builds (`refs/tags/*` or `GITHUB_EVENT_NAME=release`), over failing the default branch only; PR, feature and hotfix branches warn (revises D19) — user, answers AR-7
- Each deprecating release gets a dated removal ticket with an owner — user
- AC34 and D12 win over AC32's last sentence: `--force` keeps overwriting during the deprecation period, and AC32's sentence applies once `--force` is removed — user
- Removal date 2026-12-31 for every form this release deprecates, in one shared constant used by `deprecate()` and the check, over 2026-12-17 or a release-time value — user
- The removal ticket is created at handoff in Jira EPM-CDME via codemie-jira-assistant, owner the PR author, after user confirmation; fallback is a PR checklist plus CHANGELOG saying the ticket is owed — user
- "Connected" for a no-flag `enable`/`disable` means preference set or state unreadable, over `isActive`, so a skipped connector cannot keep collecting (answers AR-1)
- The removal-date check is a unit test reading `GITHUB_REF`/`GITHUB_EVENT_NAME`, over a separate CI job
- The Commander tree is the source for the WP0 registries (`createProgram()` plus `deprecatedOption`/`deprecatedCommand` factories), over hand-kept registrations beside the tree (answers AR-3)
- One client-target table owns the connectable set, with `CLIENT_CONFIGS`/`HOOK_CONNECTORS` as views, over each consumer keeping its own list (answers AR-2)
- Removed forms stay as stubs of kind `removed` with a `dropOn`, accepting any arguments and failing naming the replacement, over deleting them outright; the removal-date check treats `dropOn` like `removeOn`
- `proxy analytics status --json` keeps its `delivery` key and adds consented folders, over dropping `delivery` from the JSON
- `--include-external [policy]` takes an optional value, with the bare form mapped to `always` plus a notice and subcommand names rejected, over a separate flag
- The `--scope` default moves from Commander into the orchestrators of both `connect` and `disconnect`, so an omitted `--scope` is detectable
- One shared hint renderer in `src/utils/hint.ts` taking structured advice, over merging the doctor and provider `HealthCheckDetail` types
- The condensed `ProxyCheck` skips the authenticated upstream probe, over running it inside `codemie doctor` (answers AR-4)
- D11's masking is output hygiene and consistency, over a security control (answers AR-6)

## Assumptions and risks

- The gateway key is the fixed, non-secret string `codemie-proxy` (`daemon-manager.ts:24,385`); the daemon relies on its loopback bind. Masking does not close local access.
- `--include-external [policy]` sits beside the `otel`/`sync` subcommands; rejecting their names as policies is the guard.
- About 40 `proxy status` cases (`proxy/__tests__/index.test.ts:1530-2400`) and the integration tests in the analysis's Consumers list are rewritten.
- If the release ships after about 2026-12-01, the release owner moves the date in the one constant.
- Unifying the Claude Code connected predicate may change one existing line of `proxy status`/`analytics status` output.
