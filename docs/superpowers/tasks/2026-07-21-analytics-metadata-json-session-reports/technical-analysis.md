# Technical Research

**Task**: analytics report generation session JSON HTML metadata
**Generated**: 2026-07-21T00:00:00Z
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-13643: Update the codemie analytics data to be used in the team-report skill. Each JSON session report generated via `codemie analytics` must include metadata identifying the user email, the report period start date/time, and the report period end date/time. The metadata must flow through to HTML and other report formats. Acceptance criteria: JSON session reports include metadata with user email; JSON session reports include metadata with report period start and end date/time; team-report skill uses JSON metadata as primary source for team member identification and report period identification; skill falls back to file name parsing when metadata is absent; multiple JSON files for the same team member are aggregated when each fits the reporting period.

---

## 2. Codebase Findings

### Existing Implementations

The analytics report pipeline is fully implemented. The changes required are targeted additions to an already structured pipeline rather than greenfield work — except for the team-report skill, which does not exist yet.

**Report schema layer:**
- `src/cli/commands/analytics/report/types.ts` — defines `ReportPayload { meta: ReportMeta, sessions: ReportSessionRecord[] }`; `ReportMeta` currently has `generatedAt`, `rangeLabel`, `agents`, `projectFilter`, `totals`, `unpricedModels`, `coverage` — **no `userEmail`, `periodStart`, or `periodEnd`**; this is the primary target for new fields
- `src/cli/commands/analytics/report/payload-builder.ts` — `buildPayload(data, context: PayloadContext)` assembles the report; `PayloadContext` currently only has `rangeLabel`, `projectFilter`, `generatedAt` — needs `userEmail?`, `periodStart?`, `periodEnd?` added

**Report generation layer:**
- `src/cli/commands/analytics/report/session-report.ts` — `generateSessionReport(options)` entry point for per-session auto-written reports; `SessionReportOptions` has `sessionId`, `outputPath`, `scanNative` only; hardcodes `rangeLabel: 'all'` and `projectFilter: 'all'`; no email or period injected
- `src/cli/commands/analytics/report/report-generator.ts` — `generateReportJson(payload, outputPath)` writes `JSON.stringify(payload)`; also `renderReportHtml(payload)` for HTML format; note at line 28: `IMPORTANT: use FUNCTION replacements` (HTML injection safety pattern — any new metadata values embedded in HTML must follow this)

**Session lifecycle layer:**
- `src/agents/core/BaseAgentAdapter.ts` — triggers `maybeWriteSessionReport()` on agent exit; writes to `<cwd>/docs/codemie/analytics/codemie-analytics-<sessionId>.json`; does NOT currently read `userEmail`; parses `CODEMIE_PROFILE_CONFIG` env at lines 918–924 — the email is available there as `JSON.parse(env.CODEMIE_PROFILE_CONFIG).userEmail`

**CLI entry layer:**
- `src/cli/commands/analytics/index.ts` — parses `--from`, `--to`, `--last` into `AnalyticsFilter.fromDate`/`toDate`; builds `PayloadContext.rangeLabel` from the options but does **not** pass `fromDate`/`toDate` as ISO timestamps into `PayloadContext`; these values must be forwarded to close the gap
- `src/cli/commands/analytics/types.ts` — `AnalyticsFilter` has `fromDate?: Date`, `toDate?: Date`; `AnalyticsOptions` has `from`, `to`, `last`; `SessionAnalytics` has no user email field

**Data loading layer:**
- `src/cli/commands/analytics/data-loader.ts` — `MetricsDataLoader` reads `~/.codemie/sessions/{id}.json`; `SessionStartEvent.data` has `provider`, `workingDirectory`, `startTime` but no `userEmail`
- `src/agents/core/session/types.ts` — `Session` (on-disk record) has `sessionId`, `agentName`, `provider`, `project`, `startTime`, `endTime`, `workingDirectory`, `gitBranch`, `repository`, `status`, `activeDurationMs` — **no `userEmail`**

**User identity layer:**
- `src/utils/config.ts` — `ConfigLoader.saveUserEmail(email)` stores email to `~/.codemie/codemie-cli.config.json`; `loadMultiProviderConfig()` reads it back; `ConfigLoader` is **not imported anywhere in the analytics pipeline today**
- `src/env/types.ts` — `MultiProviderConfig.userEmail?: string`; `ProviderProfile.userEmail?: string`

**Output paths:**
- `<cwd>/docs/codemie/analytics/codemie-analytics-<sessionId>.json` — per-session JSON (UUID in filename, not email or date)
- `<cwd>/codemie-analytics-<YYYY-MM-DD>.report.json` — interactive CLI cost-enriched JSON report
- `<cwd>/codemie-analytics-<YYYY-MM-DD>.html` — HTML report
- `~/.codemie/sessions/<sessionId>.json` / `completed_<sessionId>.json` — session metadata files

**Team-report skill:**
- No `team-report` skill exists anywhere in the repo (checked `src/agents/plugins/claude/plugin/skills/`, `.claude/skills/`); this is a greenfield deliverable

### Architecture and Layers Affected

| Layer | Component | Change type |
|---|---|---|
| CLI entry | `analytics/index.ts` | Pass `fromDate`/`toDate` as ISO strings to `PayloadContext` |
| Session lifecycle | `BaseAgentAdapter.ts` | Extract `userEmail` from `CODEMIE_PROFILE_CONFIG` env; pass to `generateSessionReport` |
| Report options | `report/session-report.ts` → `SessionReportOptions` | Add `userEmail?: string` field |
| Report context | `report/payload-builder.ts` → `PayloadContext` | Add `userEmail?`, `periodStart?`, `periodEnd?` |
| Report schema | `report/types.ts` → `ReportMeta` | Add `userEmail?`, `periodStart?`, `periodEnd?` |
| HTML/JSON serializer | `report/report-generator.ts` | Ensure new fields flow through HTML template using FUNCTION replacements |
| New skill | `skills/team-report/` (does not exist) | Greenfield skill: read JSON meta, aggregate across files per user, fallback to filename parsing |

### Integration Points

**Internal:**
- `BaseAgentAdapter` → `session-report` → `payload-builder` → `report-generator` (existing chain; new metadata must flow end-to-end)
- `utils/config.ts` (ConfigLoader) must be integrated into `BaseAgentAdapter.maybeWriteSessionReport()` to supply `userEmail` (currently no import exists)
- `analytics/index.ts` → `payload-builder` path must also receive `fromDate`/`toDate` from `AnalyticsFilter`

**External:**
- `CODEMIE_PROFILE_CONFIG` env var — already available in `BaseAgentAdapter`; contains serialized `ProviderProfile` including `userEmail`; the email extraction already exists in the adapter for other purposes (lines 918–924)
- `~/.codemie/codemie-cli.config.json` — stores `userEmail` from SSO auth; read via `ConfigLoader.loadMultiProviderConfig()`

### Patterns and Conventions

- **Optional-first schema extension**: all new `ReportMeta` / `PayloadContext` fields must be optional (`?`) for backward compatibility — matches the MCP metrics pattern in `docs/SPEC-mcp-session-metrics.md`
- **Caller-stamps context, `buildPayload` stays pure**: `PayloadContext` fields are stamped by the caller (`session-report.ts` or `analytics/index.ts`); `buildPayload` must not read config or call `ConfigLoader` — keep it deterministic for unit tests
- **Non-fatal finalization**: `maybeWriteSessionReport` catches all errors; any email-reading failure must be handled gracefully (email omitted, not thrown)
- **HTML injection safety**: `report-generator.ts:28` has an explicit `IMPORTANT` note — all new string metadata values embedded in HTML must use the function replacement pattern, not string concatenation
- **ES module imports**: `.js` extension on every relative import; no `require`/`__dirname`; use `getDirname(import.meta.url)`

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — 5-layer plugin architecture; `src/analytics/` documented as "Usage tracking"; strict `CLI → Registry → Plugin → Core → Utils` flow
- `.ai-run/guides/integration/exposed-api.md` — `userEmail` is stored in `ProviderProfile` and serialized into `CODEMIE_PROFILE_CONFIG` env var at session launch; this is the recommended access path
- `.ai-run/guides/development/development-practices.md` — ESM `.js` imports required; `async/await` only; no `console.log` in library code; `vi.mock` + dynamic import pattern for Vitest
- `docs/ANALYTICS-REPORT.md` — full analytics feature spec; documents `ReportPayload` shape, per-session JSON auto-write behavior, and HTML/JSON/both formats
- `docs/SPEC-mcp-session-metrics.md` — reference spec (EPMCDME-10048) for extending `ReportMeta`/`SessionAttributes` with new optional backward-compatible fields; the pattern this ticket must follow

### Architectural Decisions

- **Session-exit report design** (`docs/superpowers/specs/2026-07-09-session-exit-analytics-report-design.md`): `generateSessionReport` is the programmatic API; `BaseAgentAdapter.maybeWriteSessionReport()` is the finalization hook; failure is always non-fatal
- **OTEL source seam** (`docs/superpowers/plans/2026-06-19-analytics-source-seam.md`): `runAnalytics(options, source)` as the single shared runner; future backends are a one-file drop-in
- **Exclude external sessions** (`docs/superpowers/specs/2026-07-07-analytics-exclude-external-sessions-design.md`): single seam at `SessionsSource.load()` upstream of all output formats
- **Per-session filename convention**: `codemie-analytics-<UUID>.json` — encodes only the session UUID; email cannot be recovered from the filename, confirming JSON metadata is the only reliable source for team-report aggregation

### Derived Conventions

- `ConfigLoader` must be imported at the `BaseAgentAdapter` level for email access (not inside `payload-builder`)
- `SessionReportOptions` is the public API boundary; new fields go there first, then flow down to `PayloadContext`
- Team-report skill should follow the `codemie-analytics` SKILL.md structure as a reference template
- Per-session `periodStart` and `periodEnd` should map to `session.startTime` and `session.endTime` from the loaded session record; for multi-session CLI path they map to `filter.fromDate` and `filter.toDate`

### Todos

- `src/cli/commands/analytics/otel-loader.ts:19` — `NOTE: native Claude Code emits NO cwd or git branch` (informational; no action needed for this ticket)
- `src/cli/commands/analytics/report/report-generator.ts:28` — `IMPORTANT: use FUNCTION replacements` (must be followed when embedding new metadata in HTML)

---

## 4. Testing Landscape

### Existing Coverage

- `src/cli/commands/analytics/report/__tests__/payload-builder.test.ts` — tests `buildPayload` with current `PayloadContext` shape (`rangeLabel`, `projectFilter`, `generatedAt`); no coverage for `userEmail`, `periodStart`, `periodEnd`
- `src/cli/commands/analytics/report/__tests__/session-report.test.ts` — tests `generateSessionReport` write/skip/guard behavior via `vi.mock` stubs; no email or period injection tests
- `src/cli/commands/analytics/report/__tests__/report-generator.test.ts` — tests `renderReportHtml` CSS/JS injection, `$`-pattern safety, `</script>` escaping; will need extending for new metadata fields in HTML output
- `src/agents/core/__tests__/BaseAgentAdapter-session-report.test.ts` — tests `maybeWriteSessionReport` enabled/disabled/non-fatal paths; no tests for email extraction from `CODEMIE_PROFILE_CONFIG`
- `src/agents/core/__tests__/AgentCLI-analytics-report.test.ts` — tests `--no-analytics-report` flag and `CODEMIE_SESSION_ANALYTICS_REPORT` env kill-switch
- `src/cli/commands/analytics/__tests__/aggregator.test.ts` — unit tests for `AnalyticsAggregator`; no metadata coverage
- `src/cli/commands/analytics/__tests__/data-loader.test.ts` — unit tests for `MetricsDataLoader` session filter and file loading
- `tests/integration/analytics.test.ts` — E2E golden-dataset test: loads session fixture → aggregates → asserts fields; no metadata coverage
- `src/cli/commands/analytics/__tests__/otel-report.integration.test.ts` — full OTEL pipeline test including `buildPayload` → `generateReport`; no metadata coverage

### Testing Framework and Patterns

- **Framework**: Vitest `^4.1.5`; three projects: `unit` (src/**/*.test.ts), `cli` (tests/integration/ non-agent), `agent` (tests/integration/agent-*.test.ts); coverage via v8 provider
- **Mock pattern**: `vi.mock(module, factory)` at module scope with `vi.fn()` handles; dynamic `await import(...)` inside `it()` / `beforeEach()` after spies are set up
- **Inline object factories**: `function session(over)`, `function delta(id, branch, i)` — no external fixture files for unit tests
- **Filesystem isolation**: `setupTestIsolation()` + `getTestHome()` (`tests/helpers/test-isolation.ts`) creates per-test-file tmpdir and sets `CODEMIE_HOME`
- **Reset**: `beforeEach(() => vi.clearAllMocks())` in mock-heavy tests

### Coverage Gaps

- `ReportMeta` new fields (`userEmail`, `periodStart`, `periodEnd`) — no tests exist for these fields anywhere in the pipeline
- `PayloadContext` with new fields — `payload-builder.test.ts` does not cover the extended context
- `BaseAgentAdapter.maybeWriteSessionReport` + email extraction from `CODEMIE_PROFILE_CONFIG` — no test for this data flow
- `generateSessionReport` with `userEmail` option — no test for email passing through to `ReportMeta`
- `analytics/index.ts` forwarding `fromDate`/`toDate` as ISO strings to `PayloadContext` — no test
- Team-report skill (entire skill) — does not exist, zero coverage
- Multi-file aggregation per team member — no test
- Filename-based fallback parsing of user identity — no test
- JSON metadata used as primary source vs. fallback precedence — no test

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_HOME` — overrides `~/.codemie` base directory; key for test isolation
- `CODEMIE_SESSION_ID` — UUID injected by `BaseAgentAdapter` for per-session report naming
- `CODEMIE_SESSION_ANALYTICS_REPORT` — runtime toggle; `'0'` suppresses per-session report on agent exit
- `CODEMIE_PROFILE_CONFIG` — full serialized `ProviderProfile` JSON in child agent env; contains `userEmail`; parsed in `BaseAgentAdapter` at lines 918–924
- `CODEMIE_METRICS_DISABLED` — suppresses all metrics collection

### Configuration Files

- `~/.codemie/codemie-cli.config.json` — stores `userEmail` (written by `ConfigLoader.saveUserEmail()`; read by `loadMultiProviderConfig()`)
- `src/utils/config.ts` — `ConfigLoader` class; priority chain for all config values; the `userEmail` source of truth
- `src/utils/paths.ts` — `getCodemieHome()`, `getCodemiePath()` utilities governing all disk paths

### Feature Flags and Deployment Concerns

- `sessionAnalyticsReport: true` in agent plugin metadata (`claude.plugin.ts`, `codex.plugin.ts`, `opencode.plugin.ts`) — opt-in flag for per-session auto-report
- `userEmail` is optional (`?`) in `MultiProviderConfig`; users who have not authenticated via SSO will have no email — all new metadata fields must be optional and gracefully absent
- Per-session report filename (`codemie-analytics-<UUID>.json`) encodes no user identity — the team-report skill **cannot** do a reliable filename fallback for per-session files; the fallback mentioned in the ACs applies to the interactive `codemie-analytics-<date>.report.json` filenames and must be clearly scoped in the skill design
- No migration or schema versioning mechanism in the report format — backward compatibility relies solely on optional fields

---

## 6. Risk Indicators

- **Team-report skill is greenfield**: no existing implementation, no tests, no design doc; the largest unknown in this ticket — skill scope, file discovery pattern, and aggregation semantics all need to be defined
- **Filename fallback is unreliable for per-session reports**: `codemie-analytics-<UUID>.json` contains no user email or date; the AC for filename fallback only makes sense for interactive CLI reports (`codemie-analytics-YYYY-MM-DD.report.json`); the fallback strategy must be explicitly scoped or the skill will silently misattribute sessions
- **HTML injection surface**: `report-generator.ts:28` explicitly warns about `FUNCTION replacements`; embedding `userEmail` in HTML without following this pattern risks XSS or rendering breakage (e.g., email addresses containing `$` or `<`)
- **`userEmail` may be absent**: `ProviderProfile.userEmail` is `?`; `CODEMIE_PROFILE_CONFIG` may not contain an email for non-SSO users; the per-session report must omit the field gracefully without throwing
- **`ConfigLoader` not imported in analytics pipeline**: today `buildPayload` and `generateSessionReport` have zero dependency on `utils/config.ts`; adding it creates a new coupling; must be added only at the `BaseAgentAdapter` boundary (caller stamps context), not inside `buildPayload`, to preserve testability
- **`fromDate`/`toDate` not in output today**: `analytics/index.ts` already parses these into `AnalyticsFilter` but drops them from the JSON output; the fix is small but the omission means all existing `.report.json` files have no period metadata — the team-report skill must handle pre-existing files without period fields
- **Multi-file aggregation semantics not defined**: the AC says "multiple JSON files for the same team member are aggregated when each fits the reporting period" — the aggregation logic (dedup by sessionId? sum totals? merge session arrays?) is not documented and has no existing implementation to reference
- **No codegraph indexing**: `mcp__codegraph__search` is not available; this analysis is based on filesystem search only; there may be additional files not discovered if feature keywords are used under different naming

---

## 7. Summary for Complexity Assessment

This task spans two conceptually distinct deliverables. The first is a targeted schema extension to the existing analytics report pipeline: adding `userEmail`, `periodStart`, and `periodEnd` to `ReportMeta` and `PayloadContext`, wiring the email from `CODEMIE_PROFILE_CONFIG` in `BaseAgentAdapter`, and forwarding `fromDate`/`toDate` from `AnalyticsFilter` in `analytics/index.ts`. This part touches approximately 5–7 files in an already well-structured pipeline (`report/types.ts`, `report/payload-builder.ts`, `report/session-report.ts`, `analytics/index.ts`, `BaseAgentAdapter.ts`, and optionally `report/report-generator.ts` for the HTML embedding path). All changed files have existing test coverage that will need extending; the pattern is clearly established in `docs/SPEC-mcp-session-metrics.md`.

The second deliverable — the team-report skill — is fully greenfield. No skill file, no implementation, no tests, and no design document exist. The skill must read multiple JSON report files from disk, use `meta.userEmail` as the primary identity key (falling back to filename-based parsing for files that predate this change), filter by `meta.periodStart`/`meta.periodEnd` (falling back to session-level timestamps), and aggregate across multiple files per team member. The aggregation semantics (dedup strategy, total merging, session array handling) are not specified anywhere in the codebase or guides, making this the primary requirements risk. Skill structure can be modeled on `skills/codemie-analytics/SKILL.md` but the implementation is non-trivial due to multi-file aggregation and the dual-path fallback requirement.

Key risk factors: (1) the filename fallback for per-session reports (`codemie-analytics-<UUID>.json`) cannot yield a user email — the fallback AC is only meaningful for interactive CLI reports; this needs clarification to avoid silent misattribution; (2) HTML embedding of `userEmail` must follow the existing `FUNCTION replacements` injection safety pattern; (3) `userEmail` may be absent for non-SSO users — all new fields must be optional throughout; (4) the team-report skill aggregation semantics need to be defined before implementation begins, as there is no reference implementation in the codebase.
