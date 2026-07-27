# Technical Research

**Task**: analytics report metadata userEmail periodStart periodEnd session filter
**Generated**: 2026-07-27T00:00:00Z
**Research path**: filesystem

---

## 1. Original Context

Ticket EPMCDME-13643 was partially implemented in commit 6c3447a (feat(analytics): embed userEmail and period metadata into JSON/HTML reports #433). The intent was to always populate three metadata fields in analytics report output: userEmail, periodStart, periodEnd. However the fix is incomplete. Observed behavior (reproduced on Windows against local branch):

Test 1 - bare command 'codemie analytics --report --report-format json':
  meta.userEmail: PRESENT
  meta.periodStart: ABSENT (undefined)
  meta.periodEnd: ABSENT (undefined)

Test 2 - 'codemie analytics --last 7d --report --report-format json':
  meta.userEmail: PRESENT
  meta.periodStart: PRESENT (2026-07-20T09:35:55.001Z, computed as now-7d)
  meta.periodEnd: ABSENT (undefined)

Test 3 - 'codemie analytics --session <real-uuid> --report --report-format json':
  meta.userEmail: PRESENT
  meta.periodStart: ABSENT
  meta.periodEnd: ABSENT

Test 4 - 'codemie analytics --project X --branch Y --report --report-format json':
  Reported same as Test 3 - only userEmail.

Test 5 - 'codemie analytics --from 2026-07-01 --to 2026-07-27 --report --report-format json':
  All three fields PRESENT correctly.

Only --from/--to fully populates the period fields. Every other invocation shape leaks partial or missing period metadata.

The fix must:
1. Always populate meta.userEmail, meta.periodStart, meta.periodEnd in the JSON/HTML report, regardless of which filter mode the user invoked (--from/--to, --last, --session, --project/--branch, or no filter at all).
2. When neither --from nor --to is supplied, infer periodStart/periodEnd from the data actually included in the report:
   - For --last N: periodStart = now-N (already works), periodEnd should default to 'now' (generatedAt).
   - For --session: derive periodStart/periodEnd from that session's first and last message timestamps.
   - For --project/--branch and for bare: derive from earliest and latest session timestamps in the filtered set.
3. Investigate the user's report of cases where userEmail was NOT present, and identify all code paths that skip email population. Determine whether such paths still exist.

---

## 2. Codebase Findings

### Existing Implementations

- `src/cli/commands/analytics/index.ts` — CLI entry point: `createAnalyticsCommand()`, `runAnalytics()`, `parseFilterOptions()`; constructs the `PayloadContext` stamped into `buildPayload()`; the site of the primary bug
- `src/cli/commands/analytics/report/payload-builder.ts` — `buildPayload()`: pure function assembling `ReportPayload` from `RootAnalytics` + cost index; stamps `meta` including optional `userEmail`/`periodStart`/`periodEnd` from caller-supplied context; already iterates all flat session records to compute totals and coverage
- `src/cli/commands/analytics/report/report-generator.ts` — `generateReport()` (HTML), `generateReportJson()` (JSON), `getDefaultReportPath()`, `getDefaultReportJsonPath()`, `emailSlug()`, `writeReportWithFallback()`; has explicit constraint at line 28 requiring function-style replacements in HTML templates to prevent `$`/`<` injection
- `src/cli/commands/analytics/report/session-report.ts` — `generateSessionReport()`: agent-exit report path; correctly derives `periodStart`/`periodEnd` from `rawSessions[0].startEvent?.data.startTime` and `rawSessions[0].endEvent?.data.endTime`; this is the reference pattern for data-driven period inference
- `src/cli/commands/analytics/report/types.ts` — defines `ReportMeta`, `ReportPayload`, `ReportSessionRecord`; all three target fields (`userEmail?`, `periodStart?`, `periodEnd?`) are `?: string`, typed optional with JSDoc "absent for unfiltered reports"
- `src/cli/commands/analytics/types.ts` — `AnalyticsFilter` with `fromDate?: Date` / `toDate?: Date`; `AnalyticsOptions` with `from?`, `to?`, `last?`, `session?`, `project?`, `branch?`, `reportFormat?`
- `src/cli/commands/analytics/data-loader.ts` — `RawSessionData` interface: carries `startEvent?: SessionStartEvent` (with `data.startTime` in unix ms) and `endEvent?: SessionEndEvent` (with `data.endTime` in unix ms)
- `src/agents/core/BaseAgentAdapter.ts` — `maybeWriteSessionReport()` hook: extracts `userEmail` from `CODEMIE_PROFILE_CONFIG` env var (serialized `ProviderProfile` JSON), calls `generateSessionReport()`; wrapped in `try/catch` non-fatal pattern
- `src/utils/config.ts` — `ConfigLoader.loadMultiProviderConfig()`: reads `~/.codemie/codemie-cli.config.json`; `userEmail` sits at the top level of `MultiProviderConfig` (not inside a profile); `saveUserEmail()` persists it there

### The Bug — Exact Code

Context assembly in `runAnalytics()` (`src/cli/commands/analytics/index.ts`, lines 154–161):

```typescript
const payload = buildPayload(analytics, costIndex, summary, {
  rangeLabel: options.last ?? (options.from || options.to ? 'custom' : 'all'),
  projectFilter: options.project ?? 'all',
  generatedAt: new Date().toISOString(),
  ...(userEmail !== undefined && { userEmail }),
  ...(filter.fromDate !== undefined && { periodStart: filter.fromDate.toISOString() }),
  ...(filter.toDate !== undefined && { periodEnd: filter.toDate.toISOString() }),
});
```

`parseFilterOptions()` for `--last` (index.ts lines 272–279):

```typescript
if (options.last) {
  const duration = parseDuration(options.last);
  if (!duration) {
    console.warn(...);
  } else {
    filter.fromDate = new Date(Date.now() - duration);
    // NOTE: filter.toDate is NOT set here — root cause of Test 2 missing periodEnd
  }
}
```

For `--session`, `--project`, `--branch`, or bare invocations, neither `filter.fromDate` nor `filter.toDate` is set, so both `periodStart` and `periodEnd` are always absent.

`buildPayload` meta construction (payload-builder.ts lines 125–147):

```typescript
const meta: ReportMeta = {
  generatedAt: ctx.generatedAt,
  rangeLabel: ctx.rangeLabel,
  agents: [...agents],
  projectFilter: ctx.projectFilter,
  totals: { ... },
  unpricedModels: summary.unpricedModels,
  coverage: [...coverageMap.values()].sort((a, b) => b.total - a.total),
  ...(ctx.userEmail !== undefined && { userEmail: ctx.userEmail }),
  ...(ctx.periodStart !== undefined && { periodStart: ctx.periodStart }),
  ...(ctx.periodEnd !== undefined && { periodEnd: ctx.periodEnd }),
};
```

`buildPayload` is pure — it only writes what callers pass in context. The conditionally-absent fields are the intended extension point for the fix.

`session-report.ts` reference pattern for period inference (lines 52–66):

```typescript
const session = rawSessions[0];
const periodStart = session.startEvent?.data.startTime
  ? new Date(session.startEvent.data.startTime).toISOString()
  : undefined;
const periodEnd = session.endEvent?.data.endTime
  ? new Date(session.endEvent.data.endTime).toISOString()
  : undefined;
```

### Architecture and Layers Affected

| Layer | Component | Change surface |
|---|---|---|
| CLI parsing | `analytics/index.ts` → `parseFilterOptions()`, `runAnalytics()` | Primary site: must compute/forward period from data when filters are absent |
| Report-build | `analytics/report/payload-builder.ts` → `buildPayload()` | Secondary option: fallback period derivation from `ReportSessionRecord[]` data |
| Serialization | `analytics/report/report-generator.ts` | Affected only if HTML template embeds periodStart/periodEnd (must use function replacements) |
| Agent-exit | `analytics/report/session-report.ts`, `agents/core/BaseAgentAdapter.ts` | Already correct for single-session path; `generateSessionReport` may need config fallback for userEmail |
| Config/auth | `utils/config.ts` → `ConfigLoader` | Unchanged; `loadMultiProviderConfig()` already used correctly |

### Integration Points

Internal dependencies of the analytics report build path:

```
CLI (analytics/index.ts)
  → parseFilterOptions()        → AnalyticsFilter (fromDate?/toDate? from --from/--to; fromDate from --last)
  → SessionsSource.load()       → RawSessionData[] (startEvent, endEvent, deltas)
  → MetricsDataLoader.load()    → aggregated metrics per session
  → AnalyticsAggregator.run()   → RootAnalytics tree
  → buildPayload()              → ReportPayload { meta: ReportMeta, sessions: ReportSessionRecord[] }
  → generateReport() / generateReportJson()  → HTML/JSON file on disk
```

`ReportSessionRecord` (types.ts): carries `startTime: number` (unix ms) and `durationMs: number`. `endTime` is computable as `startTime + durationMs`. This means `buildPayload` already has all data needed to derive `periodStart`/`periodEnd` from the sessions it flattens, without any additional I/O.

External service: `ConfigLoader` reads `~/.codemie/codemie-cli.config.json` from disk. This is the only I/O in the `userEmail` resolution path.

### Patterns and Conventions

- `buildPayload` is a pure function — it accepts all metadata via `PayloadContext` and never reads `ConfigLoader`, env vars, or filesystem. This is an explicit recorded architectural decision. Any fix must either (a) pass computed values from the caller, or (b) derive them from data already in `buildPayload`'s arguments. Both are valid; (b) is the most surgical.
- Conditional spread idiom used universally: `...(value !== undefined && { key: value })` — fields are omitted rather than set to `null` or empty string when unavailable.
- Non-fatal finalization pattern: email resolution and session report writing are wrapped in `try/catch`; failures are logged at `warn` level and do not surface to the user.
- ES module conventions: all imports end in `.js`; no `require()`; `getDirname(import.meta.url)` instead of `__dirname`.
- HTML template injection: `report-generator.ts:28` has an explicit `IMPORTANT: use FUNCTION replacements` constraint; any new string metadata embedded in the HTML template must use `replace(pattern, () => value)` form, not string concatenation, to prevent `$1`-style back-reference expansion from email or ISO-date strings.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — 5-layer architecture (`CLI → Registry → Plugin → Core → Utils`); analytics lives under `src/analytics/` for usage tracking, with its report surface in `src/cli/commands/analytics/report/`
- `.ai-run/guides/development/development-practices.md` — mandates non-fatal finalization via `try/catch` + `logger.warn()`; async/await only; no `console.log` in library code; Vitest dynamic-import mock pattern
- `.ai-run/guides/integration/exposed-api.md` — confirms `userEmail` is obtained via SSO auth and stored at config level; `ConfigLoader.loadMultiProviderConfig()` is the canonical CLI-path source
- `.ai-run/guides/usage/project-config.md` — describes `ConfigLoader` priority chain; `userEmail` is stored at the global config level via `ConfigLoader.saveUserEmail()`; `loadMultiProviderConfig()` reads it back
- `docs/superpowers/tasks/2026-07-21-analytics-metadata-json-session-reports/technical-analysis.md` — prior analysis covering the initial metadata wiring feature; QA report for branch `analytics-enhance` was PASSED on 2026-07-21; that implementation covered `--from`/`--to` forwarding and `session-report.ts` derivation but not the remaining filter modes now under repair
- `docs/superpowers/specs/2026-07-09-session-exit-analytics-report-design.md` — design spec for `generateSessionReport()` API and `maybeWriteSessionReport()` hook (baseline before metadata wiring)

### Architectural Decisions

- **Caller-stamps-context, `buildPayload` stays pure**: `buildPayload()` never reads `ConfigLoader` or env vars; all metadata must be assembled by callers. Recorded in both the 2026-07-21 tech analysis and enforced by `buildPayload`'s function signature.
- **Optional-first schema**: all three `ReportMeta` fields are `?`; absent when unavailable rather than `null` or empty string; backward-compatible with report files produced before the metadata feature.
- **`userEmail` dual-source design**: CLI path reads `MultiProviderConfig.userEmail` via `ConfigLoader`; agent-exit path reads `ProviderProfile.userEmail` from `CODEMIE_PROFILE_CONFIG` env var. The two sources are independent and may hold different values if the profile was customized post-setup.
- **Non-fatal email omission**: both paths use `try/catch` and omit `userEmail` silently on failure rather than aborting the report generation.
- **`periodStart`/`periodEnd` JSDoc in `ReportMeta`**: currently docummented as "absent for unfiltered reports" — the fix changes this contract to "always present when report data exists."
- **`sessionAnalyticsReport: true`** on Claude, Codex, and OpenCode plugin metadata; env kill-switch `CODEMIE_SESSION_ANALYTICS_REPORT='0'` maps to `--no-analytics-report` CLI flag.

### Derived Conventions

- When implementing period inference inside `buildPayload`, the pattern from `session-report.ts` (read `startEvent.data.startTime`, guard with optional chaining) should be mirrored.
- `endTime = startTime + durationMs` can be computed from `ReportSessionRecord` fields already available inside `buildPayload` — no new argument or interface change needed if fallback derivation is done there.
- `generatedAt` (already stamped in context) is the natural `periodEnd` candidate for `--last` invocations where data end time = "now".

---

## 4. Testing Landscape

### Existing Coverage

- `src/cli/commands/analytics/__tests__/analytics-cli-metadata.test.ts` — unit tests for `runAnalytics()` metadata wiring; covers: `userEmail` read from `ConfigLoader.loadMultiProviderConfig()`, `userEmail` fallback to `undefined` when `ConfigLoader` throws, `periodStart` + `periodEnd` populated from `--from`/`--to`. Does NOT cover `--last`, `--session`, `--project/--branch`, or bare invocations.
- `src/cli/commands/analytics/report/__tests__/payload-builder.test.ts` — unit tests for `buildPayload()`; asserts `meta.userEmail`, `meta.periodStart`, `meta.periodEnd` appear when provided in context and are absent when not. Tests the mapping contract, not the upstream derivation.
- `src/cli/commands/analytics/report/__tests__/session-report.test.ts` — tests `generateSessionReport()` (`--session` agent-exit path): `userEmail` propagation, `periodStart`/`periodEnd` derived from `session.startEvent`/`session.endEvent`.
- `src/cli/commands/analytics/report/__tests__/report-generator.test.ts` — tests `renderReportHtml`, `getDefaultReportPath`, `getDefaultReportJsonPath`; verifies email slug in filename; no meta-field content coverage.
- `src/cli/commands/analytics/__tests__/otel-report.integration.test.ts` — integration test for OTEL source → aggregator → `buildPayload` → `generateReport`; passes no `userEmail`/`periodStart`/`periodEnd` in context and asserts nothing about them.
- `tests/integration/analytics.test.ts` — E2E golden dataset validation using `MetricsDataLoader` + `AnalyticsAggregator` with `--session` filter; never calls `buildPayload` or inspects `meta.*` fields.
- `src/agents/core/__tests__/AgentCLI-analytics-report.test.ts` — tests `--no-analytics-report` CLI flag / env var wiring; unrelated to meta fields.
- `src/agents/plugins/__tests__/session-analytics-report-metadata.test.ts` — tests plugin-level `sessionAnalyticsReport` opt-in flag; unrelated to report meta content.

### Testing Framework and Patterns

- Framework: Vitest (three projects: `unit` for `src/**/*.test.ts`, `cli` for `tests/integration/**/*.test.ts`, `agent` for network tests)
- Config: `vitest.config.ts`; coverage provider: v8
- Pattern: inline `vi.fn()` mocks and `vi.mock()` for module-level overrides; no shared mock-factory helpers
- Integration test isolation: `setupTestIsolation()` / `getTestHome()` from `tests/helpers/test-isolation.ts`
- `buildPayload` context shape `{ rangeLabel, projectFilter, generatedAt, userEmail?, periodStart?, periodEnd? }` is the central fixture pattern across payload and CLI-metadata tests; inline factories (not exported) in `payload-builder.test.ts`
- Vitest dynamic-import mock pattern required for modules with side effects (per `development-practices.md`)

### Coverage Gaps

- `runAnalytics()` with `--last` and no `--from`/`--to`: no test confirms `periodEnd` is absent (matches Test 2 bug) or that any fix correctly sets it
- `runAnalytics()` with `--session` alone: no test for what `periodStart`/`periodEnd` are passed to `buildPayload` (matches Test 3 bug)
- `runAnalytics()` with `--project` and/or `--branch` and no date range: no test for meta fields in this mode (matches Test 4 bug)
- `runAnalytics()` bare (no filter flags): no test confirming `periodStart`/`periodEnd` behavior
- `otel-report.integration.test.ts`: exercises `buildPayload` end-to-end without any meta-field assertions
- `tests/integration/analytics.test.ts`: full E2E pipeline with no report metadata assertions at all
- `generateSessionReport()` userEmail fallback to `ConfigLoader`: no test for the case where `options.userEmail` is absent but config file has `userEmail`

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_PROFILE_CONFIG` — JSON-serialized active `ProviderProfile`; set by `AgentCLI.ts:314` as `JSON.stringify(config)`; parsed by `BaseAgentAdapter` to extract `userEmail` for agent-exit session reports; optional field `ProviderProfile.userEmail`
- `CODEMIE_SESSION_ID` — current session identifier; required for session-scoped report generation
- `CODEMIE_SESSION_ANALYTICS_REPORT` — set to `'0'` to suppress auto-generated session analytics report at session end; mapped from `--no-analytics-report` CLI flag

### Configuration Files

- `~/.codemie/codemie-cli.config.json` (global, resolved via `getCodemiePath('codemie-cli.config.json')`) — `MultiProviderConfig` v2 schema; top-level `userEmail` field is the canonical source for the CLI analytics path; written by `ConfigLoader.saveUserEmail()` during SSO/subscription setup
- `.codemie/codemie-cli.config.json` (local project override) — same schema; takes priority over global when present

### Feature Flags and Deployment Concerns

- No feature flags specific to analytics report metadata
- `CODEMIE_SESSION_ANALYTICS_REPORT=0` / `--no-analytics-report`: suppresses session-end report entirely; not relevant to the metadata fix
- The HTML injection constraint in `report-generator.ts:28` applies to any future embedding of `periodStart`, `periodEnd`, or `userEmail` in the HTML report template — must use function-style replacements, not string concatenation

---

## 6. Risk Indicators

- **Missing `periodEnd` for `--last`**: `parseFilterOptions()` sets `filter.fromDate` but never sets `filter.toDate`; the fix needs to set `filter.toDate = new Date()` in `parseFilterOptions` or derive it elsewhere — a one-line change that is well-bounded
- **Missing both period fields for `--session`, `--project`, `--branch`, and bare**: these filter modes set neither `filter.fromDate` nor `filter.toDate`; the fix requires either computing min/max from the loaded session data in `runAnalytics()` or adding fallback derivation inside `buildPayload()` from `ReportSessionRecord.startTime` + `durationMs`
- **`buildPayload` pure-function contract**: the architectural decision that `buildPayload` never does I/O or reads config must be respected; any period derivation inside it must use only data already in its arguments (which is possible via `ReportSessionRecord` fields)
- **`ReportSessionRecord.durationMs` reliability**: the fallback `endTime = startTime + durationMs` inside `buildPayload` assumes `durationMs` is always populated; if sessions lack `endEvent`, `durationMs` may be 0 or missing — needs guarding
- **`--session` path in `runAnalytics()` vs `generateSessionReport()`**: the CLI `analytics --session <id>` path calls `buildPayload` via `runAnalytics()`, not `generateSessionReport()`; it loads a single session as part of the aggregated result set; `generateSessionReport()` correctly derives period from raw event timestamps, but that logic is not reused in the CLI path — a behavioral discrepancy
- **`userEmail` absent when config file is missing or pre-SSO**: users who ran `npm install -g` without SSO setup will have no `userEmail` in `MultiProviderConfig`; this is gracefully handled (`try/catch`, field omitted) and was present before commit 6c3447a; not a regression. The task asks to "always populate" userEmail — this is not achievable when the config has no email; the fix can only ensure the field is populated when the data exists
- **`generateSessionReport()` userEmail fallback**: if `BaseAgentAdapter` runs without `CODEMIE_PROFILE_CONFIG` or if the env var carries a profile without `userEmail`, the agent-exit report will have no email even if `~/.codemie/codemie-cli.config.json` has one; no config-fallback currently exists in `session-report.ts` or `BaseAgentAdapter`
- **No test for `--last` periodEnd gap**: the exact regression in Test 2 is not covered by any existing test; a new test in `analytics-cli-metadata.test.ts` is needed to prevent regression
- **No test for `--session`, `--project`, `--branch`, bare period fields**: three additional test gaps; without them the fix cannot be validated or guarded against regression
- **HTML template function-replacement constraint** (`report-generator.ts:28`): if the HTML template currently embeds `periodStart`/`periodEnd` as string replacements (inherited from the prior implementation), they must use the function form — verify before editing
- **Commit `6c3447a` not found in project docs**: the commit hash referenced in the ticket does not appear in any changelog, plan, or work-item doc; the prior `analytics-enhance` implementation (branch QA-PASSED 2026-07-21) is the closest documented baseline but may differ in detail

---

## 7. Summary for Complexity Assessment

The task touches four files directly (with possible changes to a fifth) across three architectural layers. The primary bug sites are in the CLI layer (`src/cli/commands/analytics/index.ts`) where `PayloadContext` is assembled before calling `buildPayload`. Two distinct root causes exist: (1) `parseFilterOptions()` never sets `filter.toDate` for `--last`, so `periodEnd` is structurally impossible to reach the meta object via the current `filter.toDate !== undefined` guard; and (2) for all non-date filter modes (`--session`, `--project`, `--branch`, bare), neither `filter.fromDate` nor `filter.toDate` is set, so both period fields are always absent. The report-build layer (`payload-builder.ts`) is already structured to accept fallback values — `ReportSessionRecord` records that `buildPayload` iterates contain `startTime` (unix ms) and `durationMs`, making `min(startTime)` and `max(startTime + durationMs)` computable inside the function without any new I/O or interface changes. The agent-exit path (`session-report.ts` + `BaseAgentAdapter`) is already correct for the single-session case and serves as the reference pattern.

The fix does not introduce novel patterns. Both the conditional spread idiom and the data-driven period inference pattern (`startEvent?.data.startTime`, `endEvent?.data.endTime`) already exist in the codebase. The most contained approach is a two-site fix: add `filter.toDate = new Date()` in `parseFilterOptions()` when `--last` is present, and add fallback `periodStart`/`periodEnd` derivation in `runAnalytics()` after loading sessions (reading `min(startTime)` / `max(startTime + durationMs)` from the aggregated data) when `filter.fromDate` or `filter.toDate` is still undefined. Alternatively, the fallback derivation can be placed entirely inside `buildPayload()` from `ReportSessionRecord[]` — this would cover all callers including the OTEL path. Either approach is one-to-two function edits.

Test coverage posture for this area is mixed: `--from/--to` and single-session period derivation are covered, but `--last` `periodEnd`, `--session` period fields, `--project/--branch` period fields, and bare invocation period fields have zero test coverage — exactly matching the four failing test observations in the ticket. The fix should be accompanied by new test cases in `analytics-cli-metadata.test.ts` for each gap (when the user explicitly requests test work). The key risks to complexity are: (a) ensuring the `buildPayload` pure-function contract is not violated by any fix approach, (b) guarding against `durationMs === 0` or missing `endEvent` when computing `maxEndMs`, and (c) the HTML template function-replacement constraint that must be respected if `periodStart`/`periodEnd` are embedded in the HTML report output.
