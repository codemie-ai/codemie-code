# Technical Research

**Task**: analytics pricing cost-report
**Generated**: 2026-09-26
**Research path**: codegraph

---

## 1. Original Context

"codemie-analytics-nikita-levyankov-epam-com-2026-09-25.report.json this result of analytics files with informatoin about prices. there seveeral contradicting codemie analytics command that produce or don't proudce prices in reports. need to
1. unify command and keep only one that will always produce costs
2. drop contradicting codemie analtyics flags and commands to have clear contract
3. there is a need to adjust existing tests to: 1. assert analytics json for presences of fields that are expected, like models, totals, agents, etc. also if unpricedModels is present - build should break. there is a need to catch new models that might not be configured in pricing json. 2. add tests to run simple hi command againsts avaiable models in ai-run proxy to check that analytics works wit htihs sessions. 3. test that asserts configrued modesl in analytics against available models in codemie endpoint for reconciliation"

---

## 2. Codebase Findings

### Existing Implementations
- `src/cli/commands/analytics/index.ts` — `createAnalyticsCommand()` + `runAnalytics()`. Base command and `otel` subcommand share `applyCommonOptions()`: `--session --project --agent --branch --from --to --last -v --export <json|csv> -o/--output --report --open --report-output --report-format <html|json|both>`. Base-only: `--no-scan-native`, `--include-external`. `otel`-only: `--file` (required), `--user`.
- Cost decision in `runAnalytics` (lines 82-103): `wantReport = report||reportOutput||open||reportFormat`. Cost comes from the source (OTEL) if present, else `enrichCosts()` **only when `wantReport`**. The report block (line 135) runs only when `wantReport && costResult`.
- `src/cli/commands/analytics/exporter.ts` — `AnalyticsExporter.exportJSON/exportCSV` serialize `RootAnalytics` (project→branch→session tree). No cost: `ModelStats.costUSD`/`SessionAnalytics.costUSD` are optional and documented "populated only for the HTML report path"; CSV has no cost column.
- `src/cli/commands/analytics/report/payload-builder.ts` — `buildPayload(root, costIndex, summary, ctx)` → `ReportPayload {meta, sessions}`; dedupes sessions, derives `meta.totals`, `meta.agents`, `meta.coverage`, copies `summary.unpricedModels`.
- `src/cli/commands/analytics/report/types.ts` — `ReportMeta` (`generatedAt, capturedAt?, rangeLabel, agents[], projectFilter, totals{sessions,durationMs,turns,files,netLines,toolCallsTotal,toolSuccessRate,totalCostUSD,cacheReadCostUSD,pricedSessions}, unpricedModels[], coverage[], userEmail?, periodStart?, periodEnd?`) and `ReportSessionRecord` (`models: string[]`, `tokens`, `costUSD`, `cacheReadCostUSD`, `perModelCost: ModelCost[]`, `hadLog`, many optional routing/dispatch fields).
- `src/cli/commands/analytics/report/report-generator.ts` — `generateReport` (HTML), `generateReportJson`, default paths `codemie-analytics-<slug>-<date>.html` / `.report.json` (comment: `.report.json` chosen so it never collides with the "cost-less" `--export json` file).
- `src/cli/commands/analytics/report/session-report.ts` — `generateSessionReport()`, called from `src/agents/core/BaseAgentAdapter.ts` (`maybeWriteSessionReport`) on agent exit; always runs `enrichCosts` and writes `docs/codemie/analytics/codemie-analytics-[email-]<sessionId>.json`. Disabled per-run via agent flag `--no-analytics-report`.
- `src/cli/commands/analytics/cost/cost-enricher.ts` — `enrichCosts(rawSessions, deps)`; `priceUsage()` calls `lookupPrice(rawModel)`, pushes normalized model to `unpriced` when null; `priced = perModel.length > 0` (a found log with no usage is `hadLog:true, priced:false`).
- `src/cli/commands/analytics/otel-loader.ts` — `buildCostIndex()` uses event `cost_usd` directly; always returns `unpricedModels: []`.
- `src/utils/pricing.ts` + `src/utils/pricing.json` — vendored table (from agentlytics) + `CODEMIE_PRICES` override (`claude-smart-router`). `lookupPrice`: exact → longest segment-boundary family match → latest Claude same-tier fallback → `null`. Family/tier fallbacks only `logger.debug`, so a new model often resolves to a price and never appears in `unpricedModels`.
- `src/cli/commands/analytics/sources/{sessions-source,otel-source,types}.ts` — `AnalyticsSource` seam; `SessionsSource` returns no cost.
- Model catalog: `src/providers/plugins/sso/sso.http-client.ts` `fetchCodeMieLlmModels(apiUrl, cookies|jwt)` → `GET {apiUrl}/v1/llm_models?include_all=true` returning `LlmModel[]` (`deployment_name|base_name|label`, `enabled`, `cost?`, router flags). `SSOModelProxy.fetchModelsFromAPI` maps to ids. Name matching helpers: `src/cli/commands/proxy/connectors/model-name-resolver.ts` (`resolveTenantModelId`), `src/utils/model-normalizer.ts` (`normalizeModelName`).
- Unrelated same-name code: `src/agents/plugins/claude/plugin/skills/codemie-analytics/scripts/analytics-cli.js` (server-side CodeMie analytics API skill), not the local `codemie analytics` command.

### Architecture and Layers Affected
- CLI layer: `src/cli/commands/analytics/index.ts` (flags/contract), exporter, formatter.
- Analytics domain: aggregator, sources, cost enricher, payload builder, report generator.
- Utils: `src/utils/pricing.ts`, `pricing.json`, `model-normalizer.ts`.
- Agent core: `BaseAgentAdapter.ts` session-exit report hook.
- Provider (SSO): model catalog fetch for reconciliation.

### Integration Points
- Native agent logs (Claude/Codex/Gemini/Pi/OpenCode/Copilot) via `resolveSessionAdapter(...).parseSessionFile` in `realDeps`.
- `~/.codemie/sessions/{id}.json` correlation file (`getCodemiePath`).
- `ConfigLoader.loadMultiProviderConfig()` for `userEmail`; interactive inquirer prompt when TTY and email missing.
- CodeMie API `/v1/llm_models` (SSO cookies or JWT).

### Patterns and Conventions
- Pluggable `AnalyticsSource` (`load({filter, scanNative, includeExternal}) → {rawSessions, cost?}`).
- Lazy dynamic imports for cost/report modules.
- `writeReportWithFallback` (home/tmp fallback only for default paths).
- Public projection allowlist (`pickDefined`) in payload builder.

### Observed contradictions (as coded)
| Invocation | Output | Cost? |
|---|---|---|
| `codemie analytics` | terminal summary | no |
| `--export json` | `codemie-analytics-<date>.json` (`RootAnalytics`) | no |
| `--export csv` | CSV | no |
| `--report` / `--report-format html|json|both` / `--open` / `--report-output` | HTML and/or `.report.json` (`ReportPayload`) | yes (enriched) |
| `--export json --report-format json` | both files, different shapes | only the report |
| `analytics otel --file` | same flags | authoritative `cost_usd`; `unpricedModels` always `[]` |
| agent exit (`generateSessionReport`) | per-session `ReportPayload` JSON | yes (enriched) |

Observed data: the session-exit report `docs/codemie/analytics/codemie-analytics-nikita-levyankov-epam-com-63c39689-...json` has `models:["claude-opus-5"]`, 30 turns, `hadLog:true`, `agentSessionFile` pointing at a transcript with a different id (`0df20821-...jsonl`), all tokens 0, `pricedSessions:0`, `totalCostUSD:0`, `unpricedModels:[]`. So a report with no cost can pass an `unpricedModels`-empty check.

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/quality-gates.md` — vitest projects `unit` (`src/**`), `cli` (`tests/integration/**` minus `agent-*`), `agent` (network). `npm run ci` runs unit+cli only.
- `.ai-run/guides/testing/testing-patterns.md`, `architecture/architecture.md` (not re-read; referenced by AGENTS.md).
- `docs/ANALYTICS-REPORT.md` — the public contract: documents every flag above, the `.report.json` vs `--export json` distinction, "Automatic Per-Session Report on Exit", `analytics otel`, and CLI Reference. `docs/COMMANDS.md` exists (analytics content not verified).

### Architectural Decisions
- Prior designs: `docs/superpowers/specs/2026-07-09-session-exit-analytics-report-design.md`, `2026-07-07-analytics-exclude-external-sessions-design.md`, `plans/2026-06-19-analytics-source-seam.md`.
- Inline: `lookupPrice` "never a silent $0" — null → `unpriced`; family/tier fallback is deliberate.
- Inline: `SessionsSource` "Cost is omitted here ... only when a report is requested, matching the original analytics behavior."

### Derived Conventions
- Report JSON = `ReportPayload`; export JSON = `RootAnalytics`. Two separate JSON schemas for the same command.

---

## 4. Testing Landscape

### Existing Coverage
- Unit (`src/cli/commands/analytics/**/__tests__/`): `payload-builder.test.ts`, `report-generator.test.ts`, `session-report.test.ts`, `cost-enricher.test.ts`, `cost-calculator.test.ts`, `usage-readers.test.ts`, `claude-review-regressions.test.ts`, `codex-agent.test.ts`, `dispatch-extractor.test.ts`, `aggregator.test.ts`, `data-loader.test.ts`, `native-loader*.test.ts`, `otel-loader.test.ts`, `otel-report.integration.test.ts`, `analytics-cli-metadata.test.ts`, `report-views.test.ts`, `modal-focus.test.ts`. `src/utils/__tests__/pricing.test.ts` for lookup. `src/cli/commands/__tests__/cli-misc-coverage.test.ts` touches `RootAnalytics`.
- Integration: `tests/integration/analytics.test.ts` — golden Claude fixture (`tests/integration/metrics/fixtures/claude/`) through `MetricsDataLoader` + `AnalyticsAggregator` only; asserts `RootAnalytics` fields (tools, models percentages, languages, projects). No cost, no `ReportPayload`, no CLI spawn. `tests/integration/analytics-auth-gate.test.ts` is about the `codemie hook` upload gate, not reports.
- Agent/live: `tests/helpers/agent-smoke.ts` `runAgentTaskSmoke({binName, model, prompt})` — isolated `CODEMIE_HOME`, `sso-autotest` profile (`ai-run-sso`, `codeMieUrl`, `baseUrl=<url>/code-assistant-api`), copied SSO creds, `--task "Reply with only the single word READY"`; used by `agent-*.test.ts`. `tests/integration/vscode-models.live.test.ts` — opt-in (`CODEMIE_VSCODE_LIVE=1`) per-model loop through the local proxy, markdown report. `agent-task-session.test.ts` validates session artifacts (SSO or JWT via `CI_IS_LOCAL_RUN`).

### Testing Framework and Patterns
- Vitest with 3 projects (`vitest.config.ts`); `agent` project uses `tests/setup/agent-build-setup.ts` globalSetup, 180s timeout, `describe.runIf(process.env.SSO_AVAILABLE !== 'false')`.
- Env helpers `tests/helpers/test-env.ts`: `CI_CODEMIE_URL` (default `https://codemie.lab.epam.com`), `CI_CODEMIE_MODEL` (default `claude-sonnet-4-6`), `.env.test.local` file-first. `ssoCleanEnv()`, `copySsoCredentials()`, `fetchJwtToken`/`writeJwtProfile`.

### Coverage Gaps
- No test asserts `unpricedModels` is empty or that `pricedSessions == sessions`.
- No test spawns `codemie analytics ... --report-format json` and validates the JSON shape.
- No test runs agent sessions per available model then runs analytics.
- No reconciliation test between `pricing.json` keys and `/v1/llm_models`.
- `ModelStats`, `ReportMeta`, `ReportPayload` have no direct covering tests per codegraph.

---

## 5. Configuration and Environment

### Environment Variables
- Test: `CI_CODEMIE_URL`/`CODEMIE_URL`, `CI_CODEMIE_MODEL`/`CODEMIE_MODEL`, `CI_IS_LOCAL_RUN`, `SSO_AVAILABLE`, `CI_AGENT_MAX_WORKERS`, `DEFAULT_TIMEOUT`, `CODEMIE_HOME`, `CI_CODEMIE_USERNAME/PASSWORD/AUTH_URL` (JWT mode), `CODEMIE_VSCODE_LIVE*`.
- Runtime model catalog: `CODEMIE_JWT_TOKEN`+`CODEMIE_BASE_URL` or `CODEMIE_URL` (SSO).

### Configuration Files
- `src/utils/pricing.json` (vendored; `_meta` keys skipped; USD per 1M tokens; `cacheWrite`, `cacheWrite1h`, `bedrockRegionalMultiplier`).
- `vitest.config.ts`; `.env.test.local` (local).

### Feature Flags and Deployment Concerns
- Agent flag `--no-analytics-report` disables exit report.
- `pricing.json` must be copied into `dist/` at build (loaded via `getDirname(import.meta.url)`).

---

## 6. Risk Indicators

- The reference `codemie-analytics-nikita-levyankov-epam-com-2026-09-25.report.json` is 0 bytes on disk; the report shape was documented from code and a session-exit report instead.
- `unpricedModels` alone does not catch cost gaps: `lookupPrice` family/tier fallbacks silently price unknown models, and sessions with zero extracted usage (`priced:false`, `hadLog:true`) produce `$0` with an empty `unpricedModels` (seen in the 63c39689 exit report).
- The OTEL path hard-codes `unpricedModels: []`.
- Removing `--export`, `--report`, or `--report-format` breaks the documented contract in `docs/ANALYTICS-REPORT.md` and any scripts. `generateSessionReport` and `BaseAgentAdapter` depend on `buildPayload`/`generateReportJson`.
- `runAnalytics` prompts interactively for email when a TTY is present. A CLI-spawn test must be non-TTY or have the email configured.
- Live tests need SSO creds or JWT and network. They belong in the `agent` project, which is not part of `npm run ci`, so "build should break" only holds where that project runs.
- Reconciliation must line up tenant ids (`deployment_name`, dated, `-vertex`, `openai.` prefixes, routers such as `claude-smart-router`) with pricing keys. `normalizeModelName` and `resolveTenantModelId` exist but differ in purpose.
- Speculative: an always-cost default will make every plain `codemie analytics` run parse native logs, which may slow it down on large histories.
- Speculative: `RootAnalytics` consumers (`exporter`, `formatter`, `cli-misc-coverage.test.ts`) may be affected if export JSON is dropped or merged.

---

## 7. Summary for Complexity Assessment

The change touches the CLI layer (`src/cli/commands/analytics/index.ts`, `exporter.ts`) and the analytics report/cost domain (`payload-builder.ts`, `cost-enricher.ts`, `report/types.ts`, `session-report.ts`). It is bounded by `src/utils/pricing.ts`/`pricing.json` and, for the tests, the SSO model catalog (`fetchCodeMieLlmModels`, `/v1/llm_models`). The contradiction is concrete and all in one place: `runAnalytics` computes cost only when a report flag is set. `--export json|csv` and the plain terminal output never carry cost, and they use a different JSON schema (`RootAnalytics`) from `--report-format json` / the session-exit report (`ReportPayload`). `analytics otel` is a third cost path (authoritative `cost_usd`, `unpricedModels` always empty). `docs/ANALYTICS-REPORT.md` documents all of these flags as the public contract.

The patterns are established: the source seam, lazy cost enrichment, a single `buildPayload`. Test infrastructure also exists for every requested test type. There is golden-fixture integration (`tests/integration/analytics.test.ts`), the agent smoke harness (`tests/helpers/agent-smoke.ts`, SSO profile against `CI_CODEMIE_URL`), a live per-model loop (`vscode-models.live.test.ts`), and a model-list client (`fetchCodeMieLlmModels`). What is new is asserting on the `ReportPayload` JSON (meta.totals/agents/unpricedModels/coverage) and cross-checking pricing keys against the tenant catalog.

Current coverage asserts only the cost-less `RootAnalytics` tree. Nothing asserts on costs, `unpricedModels`, or model reconciliation. Key risks:
- `unpricedModels` is an incomplete signal, because of fallback pricing and zero-usage sessions.
- The model-id matching between tenant ids and pricing keys is non-trivial.
- Live tests depend on network and credentials and sit outside `npm run ci`.
- Removing documented flags breaks the published contract.

---

## 8. External References

- `/Users/Nikita_Levyankov/repos/codemie-ai/codemie-code/codemie-analytics-nikita-levyankov-epam-com-2026-09-25.report.json` — resolved, but **0 bytes (empty)**, so none of its content could be read. By default name (`.report.json`), it was produced by `codemie analytics --report-format json|both`, i.e. a `ReportPayload`.
- Shape taken instead from code (`report/types.ts`) and the session-exit report `docs/codemie/analytics/codemie-analytics-nikita-levyankov-epam-com-63c39689-132e-402a-ae12-0f86eef8923c.json`:
  - Top level: `{ meta, sessions }`.
  - `meta`: `generatedAt, rangeLabel, agents:["claude"], projectFilter, totals{sessions, durationMs, turns, files, netLines, toolCallsTotal, toolSuccessRate, totalCostUSD, cacheReadCostUSD, pricedSessions}, unpricedModels:[], coverage:[{agentName,total,priced,withLog}], userEmail, periodStart, periodEnd`.
  - Each session: `sessionId, agentName, provider, title, project, branch, startTime, durationMs, turns, fileOps, linesAdded/Removed/Modified, netLines, filesChanged/Written/Edited, toolCallsTotal/Success/Failure, models:string[], languages, tools[], tokens{input,output,cacheRead,cacheCreation,cacheCreation1h,total}, costUSD, cacheReadCostUSD, perModelCost:[{model,tokens,costUSD,unpriced}], hadLog, agentSessionFile?, dispatches?, dispatchesComplete?, rootOwn*/unlinked*, skill/agent/commandInvocations, sessionSource`.
- Sibling `codemie-analytics-nikita-levyankov-epam-com-2026-09-25.html` (2.8 MB) was not read.
