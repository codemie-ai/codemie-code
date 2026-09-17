# Technical Research

**Task**: analytics, session-filter, data-loader, CLI
**Generated**: 2026-07-08
**Research path**: filesystem

---

## 1. Original Context

Fix a bug in the `codemie analytics --report --session <id>` CLI command in this repo (codemie-code). Running `codemie analytics --report --session "eddd66b2-0e73-4167-841c-9263207870ae"` produces an HTML report containing ALL local sessions instead of just the one requested session.

Root cause already diagnosed via manual investigation (verify and confirm with your own research, don't just take this at face value):

1. `src/cli/commands/analytics/data-loader.ts`, method `MetricsDataLoader.loadSessions()` (~line 141-148): derives `sessionId` from the session filename by only stripping the `.json` suffix: `const sessionId = sessionFile.replace('.json', '')`. For CodeMie session files that use the `completed_<uuid>.json` naming convention (session finished), this produces `sessionId = "completed_<uuid>"` instead of the bare UUID. When the CLI's `--session <uuid>` filter is applied (`filter?.sessionId && sessionId !== filter.sessionId`), the comparison never matches for completed sessions, so the requested session is silently excluded from the CodeMie-tracked-session path entirely.
   - Compare with `src/cli/commands/log/reader.ts`, `SessionReader.listSessions()`, which correctly does `file.replace('.json', '').replace('completed_', '')` to recover the bare UUID — the log module handles this correctly, the analytics module does not.

2. Same file, private method `MetricsDataLoader.matchesFilter()` (~line 258-299): checks `filter.agentName`, `filter.projectPattern`, `filter.branch`, `filter.fromDate`, `filter.toDate` — but never checks `filter.sessionId` at all. The `sessionId` filtering for CodeMie-tracked sessions currently happens ONLY via the ad-hoc filename check in `loadSessions()` (bug #1 above), not in `matchesFilter()`.
   - This matters because `matchesFilter()` is also exposed as the public `sessionMatchesFilter()` method and reused by `src/cli/commands/analytics/sources/sessions-source.ts` (~line 20-22) to filter NATIVE agent-log-discovered sessions (sessions not tracked in `~/.codemie/sessions/`, discovered via `src/cli/commands/analytics/native-loader.ts` `loadNativeSessions()`). Since `matchesFilter()` never checks `sessionId`, ALL native sessions pass the filter regardless of `--session`, which is the primary reason the report shows every session instead of one.

---

## 2. Codebase Findings

### Existing Implementations

- `src/cli/commands/analytics/index.ts` — CLI command registration (`--session <id>` at line 46), option parsing (`parseFilterOptions()` at line 215 builds `AnalyticsFilter`), orchestrates load → aggregate → report (`runAnalytics()` at line 62).
- `src/cli/commands/analytics/types.ts` — `AnalyticsFilter` interface (lines 221-228): `sessionId?`, `projectPattern?`, `agentName?`, `fromDate?`, `toDate?`, `branch?` — 6 optional fields total.
- `src/cli/commands/analytics/data-loader.ts` — `MetricsDataLoader`: `loadSessions()` (132-169, bug #1 at line 143/146), `loadSession()` (174-245), public `sessionMatchesFilter()` (251-253), private `matchesFilter()` (258-299, bug #2). Both confirmed bugs live in this file.
- `src/cli/commands/analytics/sources/sessions-source.ts` — merges tracked sessions (`loadSessions()`, line 12-13) with native-discovered sessions (`loadNativeSessions()` line 19-20, filtered via `sessionMatchesFilter()` at lines 20-22). This is the path that actually produces "ALL sessions" in the reported symptom, since native sessions get zero sessionId filtering.
- `src/cli/commands/analytics/sources/otel-source.ts` (lines 29-42) — a sibling source that **already discovered this exact gap and worked around it**: comment states `--session is matched explicitly because sessionMatchesFilter does not cover session id`; it manually compares `s.sessionId === opts.filter.sessionId` and passes a `sessionId`-stripped ("structural") filter into `sessionMatchesFilter()` for the remaining fields. `sessions-source.ts` does NOT apply this workaround.
- `src/cli/commands/analytics/native-loader.ts` — `loadNativeSessions()` (477-524) discovers untracked native agent-log sessions; does not filter by sessionId itself, relies entirely on the caller applying `sessionMatchesFilter()`.
- `src/cli/commands/log/reader.ts` — `SessionReader.listSessions()` (line ~309) correctly does `file.replace('.json', '').replace('completed_', '')`. Also `readSession()` (264-269) tries `<id>.json` then falls back to `completed_<id>.json`.
- `src/cli/commands/log/cleaner.ts` (lines 119-127) — correct regex match `^completed_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$` then strips `completed_` and `.json`.
- `src/agents/core/session/SessionStore.ts` (lines 46-55) — correct fallback: reads `completed_{sessionId}.json` when `{sessionId}.json` is not found.
- `src/cli/commands/hook.ts` (lines 963-1029, comment at 688-689) — the producer: on `SessionEnd`, renames `{id}.json → completed_{id}.json`, `{id}_metrics.jsonl → completed_{id}_metrics.jsonl`, `{id}_conversation.jsonl → completed_{id}_conversation.jsonl`.
- `src/agents/plugins/codex/codex.reconciliation.ts` (line 89) — skips files already prefixed `completed_` when scanning for active sessions (correct, unrelated to filtering).
- `src/cli/commands/analytics/report/report-generator.ts` — `generateReport()`/`renderReportHtml()` (lines 16-51), pure rendering, consumes the already-filtered/aggregated `ReportPayload`; no filtering logic here.
- `src/cli/commands/analytics/report/payload-builder.ts` — builds `ReportPayload` from aggregated analytics; not part of the bug.

### Architecture and Layers Affected

- **CLI layer**: `src/cli/commands/analytics/index.ts` (option parsing, orchestration).
- **Data-loading layer**: `src/cli/commands/analytics/data-loader.ts` (`MetricsDataLoader`), `native-loader.ts`, `sources/sessions-source.ts`, `sources/otel-source.ts`.
- **Aggregation layer**: `AnalyticsAggregator.aggregate()` (called at `index.ts:99`) — downstream of the filter bug, not itself broken.
- **Reporting layer**: `report/report-generator.ts`, `report/payload-builder.ts` — pure rendering, consumes whatever session list survives filtering; will correctly narrow to one session once the filter bugs are fixed.

### Integration Points

Confirmed call flow from `--session` flag to HTML report:
1. `index.ts:46` — commander registers `--session <id>`.
2. `index.ts:62` `runAnalytics()` → `index.ts:215` `parseFilterOptions()` builds `AnalyticsFilter { sessionId: options.session, ... }`.
3. `index.ts:65` → `SessionsSource.load({ filter, scanNative })` (default source).
4. `sessions-source.ts:12-13` → `new MetricsDataLoader().loadSessions(filter)` — tracked sessions path (bug #1: `data-loader.ts:143,146`).
5. `sessions-source.ts:19-22` → `loadNativeSessions(filter)` (`native-loader.ts:477`) then `.filter(s => loader.sessionMatchesFilter(s, filter))` — native sessions path (bug #2: delegates to `matchesFilter()`, `data-loader.ts:258-299`, which never checks `sessionId`).
6. `index.ts:99` → `AnalyticsAggregator.aggregate(rawSessions, ...)` on the merged (buggy) session list.
7. `index.ts:128-136` → dynamic import of `payload-builder.ts` `buildPayload()` and `report-generator.ts` `generateReport()` → `renderReportHtml()` writes the self-contained HTML report by templating `template.html` with vendored Chart.js and inlined CSS/JS (no HTML templating library dependency — plain string `.replace()`).

No config file governs this flow; `CODEMIE_HOME` env var is the only override, controlling the base `~/.codemie` directory (and therefore `~/.codemie/sessions`) that both `data-loader.ts` and `native-loader.ts` read from.

### Patterns and Conventions

- `AnalyticsFilter` is a plain optional-field bag; each loader/source implements its own ad-hoc filter-matching function rather than sharing one utility — three independent, slightly diverging implementations exist: `MetricsDataLoader.matchesFilter()` (`data-loader.ts`), `LogReader.matchesFilter()` (`log/reader.ts:169`), `SessionReader.matchesSessionFilter()` (`log/reader.ts:332`).
- Correct idiom for deriving a bare session UUID from a session-directory filename: `file.replace('.json', '').replace('completed_', '')` — used in `log/reader.ts` and `log/cleaner.ts`, absent from `data-loader.ts:143`.
- `RawSessionData` (`data-loader.ts:106-117`) is the common shape produced by three different sources — tracked (`loadSession()`), native-discovered (`native-loader.ts` `synthesizeRawSession`/`synthesizeCodexRawSession`), and OTEL (`otel-loader.ts`) — all expected to pass through the same `sessionMatchesFilter()` gate, which is why the sessionId gap has wide blast radius across sources.
- `otel-source.ts`'s explicit-comparison-plus-stripped-filter pattern is the template already established in this codebase for working around the `matchesFilter()` sessionId gap — though fixing `matchesFilter()` itself to compare `filter.sessionId` against `sessionData.sessionId` (already correctly normalized by `loadSession()`) is the more central fix, and would let the `otel-source.ts` workaround comment/code be removed as a follow-up.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — describes CLI → Registry → Plugin → Core → Utils layering; no analytics/session-filter specifics.
- `.ai-run/guides/development/development-practices.md`, `.ai-run/guides/standards/code-quality.md`, `.ai-run/guides/testing/testing-patterns.md` — general TS/error/testing conventions only; nothing analytics-domain-specific.
- `docs/ANALYTICS-REPORT.md` — documents `--session <id>` as a supported filter flag for both terminal and HTML report output, but gives no implementation detail.
- No guide documents the `completed_` filename convention or the `AnalyticsFilter`/`matchesFilter` contract — conventions must be derived from code.

### Architectural Decisions

Recorded only in code comments, not in guides/docs:
- `src/cli/commands/hook.ts:688-689` — on `SessionEnd`, the hook "marks the record completed (endTime set) and renames `{id}.json → completed_{id}.json`." `loadSession()` transparently falls back to the `completed_` file.
- `src/cli/commands/hook.ts:963-1029` — documents the full rename convention for `.json`, `_metrics.jsonl`, `_conversation.jsonl` files.
- `src/agents/core/session/SessionStore.ts:46-55` — comment explains the `completed_` fallback read path before the final SSO sync runs.
- `src/cli/commands/analytics/sources/otel-source.ts:29-42` — comment explicitly documents the `sessionMatchesFilter` sessionId gap as a known limitation being worked around locally.

### Derived Conventions

- Session files live under `getCodemiePath('sessions')` → `~/.codemie/sessions` (overridable via `CODEMIE_HOME`).
- Active/in-progress metadata: `{sessionId}.json`. Completed metadata: `completed_{sessionId}.json`. Metrics: `{sessionId}_metrics.jsonl` (renamed to `completed_{sessionId}_metrics.jsonl` on completion).
- The correct, established idiom for recovering the bare UUID from either filename shape is `.replace('.json', '').replace('completed_', '')`, already used twice in `src/cli/commands/log/` but absent from `src/cli/commands/analytics/data-loader.ts`.

No TODO/HACK/FIXME markers found in `src/cli/commands/analytics/*.ts` or `src/cli/commands/log/*.ts` — only descriptive `Note:` comments (covered above).

---

## 4. Testing Landscape

### Existing Coverage

- `tests/integration/analytics.test.ts` — E2E golden-dataset test; instantiates `MetricsDataLoader`, calls `loader.loadSessions({ sessionId: testSessionId })`, then `AnalyticsAggregator.aggregate(...)`. Uses fixture filenames as bare `<uuid>.json` / `<uuid>_metrics.jsonl` — **never exercises the `completed_<uuid>.json` naming convention**, so bug #1 is invisible to this test.
- `src/cli/commands/analytics/__tests__/aggregator.test.ts` — unit tests `AnalyticsAggregator.aggregate()` via hand-built `RawSessionData`/`MetricDelta` factories; bypasses the loader and its filtering entirely.
- `src/cli/commands/analytics/__tests__/native-loader.test.ts` — unit tests `synthesizeRawSession`/`loadNativeSessions()` via dependency injection; no real filesystem, no `sessionMatchesFilter`/`matchesFilter` involvement.
- `src/cli/commands/analytics/__tests__/model-normalizer.test.ts`, `otel-loader.test.ts`, `otel-report.integration.test.ts` — unrelated to session-id filename/filter logic.
- No `data-loader.test.ts` or `sessions-source.test.ts` exists anywhere in the repo.
- No `log/__tests__/` directory exists either — the *correct* `completed_` handling pattern in `log/reader.ts`/`log/cleaner.ts` is itself untested (nothing to literally reuse test code from, only the implementation pattern).

### Testing Framework and Patterns

- Vitest `^4.1.5`, with a "projects" split (`vitest run --project unit`, `--project cli`).
- Isolated temp `CODEMIE_HOME` per test file via `tests/helpers/test-isolation.ts` (`setupTestIsolation()`/`getTestHome()`), real filesystem fixtures copied in (`copyFileSync`/`mkdtempSync`/`writeFileSync`) — no fs mocking library used anywhere in analytics tests.
- Dependency-injection style for pure-logic tests (`native-loader.test.ts` passes a `NativeLoaderDeps` object instead of touching disk).
- Inline factory functions (`session()`, `delta()`) build `RawSessionData`/`MetricDelta` objects directly for aggregator tests.
- No snapshot testing of HTML report output observed anywhere.

### Coverage Gaps

- **Zero coverage** for `matchesFilter()`/`sessionMatchesFilter()` sessionId matching — no test constructs a filter with `sessionId` and asserts against these methods directly.
- **Zero coverage** for the `completed_` prefix in `loadSessions()` — the only fixture-based test uses bare-UUID filenames only.
- **Zero coverage** for `sessions-source.ts` — no test file exists for it at all, meaning the exact path that produces the reported symptom (native sessions bypassing `--session` filtering) is completely untested.
- No test covers the merged tracked+native session list that the real CLI command produces end-to-end with a `completed_` session file present.

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_HOME` (`src/utils/paths.ts` `getCodemieHome()`) — overrides the base `~/.codemie` directory, and therefore `~/.codemie/sessions`. This is the only env var that affects where analytics reads session files from. Used for test isolation.
- No analytics-specific env vars (no output-path, report-format, or verbosity env vars) found in production code.

### Configuration Files

- `~/.codemie/codemie-cli.config.json` — global multi-provider CLI config; not analytics-specific, no dedicated analytics settings keys found for `--session`/`--report`.
- No dedicated `analytics.config.*` file — all `--report`/`--session` behavior is driven purely by CLI flags in `src/cli/commands/analytics/index.ts`.

### Feature Flags and Deployment Concerns

CLI options on the `analytics` command (`applyCommonOptions()` in `index.ts`), all relevant to reproducing/verifying the fix:
`--session <id>`, `--project <pattern>`, `--agent <name>`, `--branch <name>`, `--from <date>`, `--to <date>`, `--last <duration>`, `-v/--verbose`, `--export <json|csv>`, `-o/--output <path>`, `--report`, `--open`, `--report-output <path>`, `--report-format <html|json|both>`, `--no-scan-native` (disables native agent-log discovery — the only current workaround for the reported symptom, since it removes the native-sessions path entirely). The `otel` subcommand adds `--file <path>` and `--user <id>`.

No CI/CD, Docker, or release script references this command area — no deployment risk. Noted in passing: `docs/superpowers/work-items/EPMCDME-12992.md` describes a separate, higher-severity issue in the same analytics feature area (CodeMie ingesting non-CodeMie Claude sessions from `.claude/projects`) — unrelated to this bug but touches the same session-provenance/filtering code paths and should be flagged to whoever picks up that item.

---

## 6. Risk Indicators

- **Confirmed, dual root cause**: `data-loader.ts:143/146` (filename parsing drops the `completed_` prefix incorrectly) AND `data-loader.ts:258-299` (`matchesFilter()` never checks `filter.sessionId`) — both must be fixed; fixing only one leaves the bug partially present (e.g. fixing filename parsing alone still leaves native sessions unfiltered by sessionId).
- **Zero existing test coverage** for either bug: no test exercises `completed_<uuid>.json` filenames in `data-loader.ts`, and no test calls `matchesFilter()`/`sessionMatchesFilter()` with a `sessionId` filter. `sessions-source.ts` has no test file at all — the exact path producing the reported symptom is completely unverified.
- **Known workaround already exists and diverges**: `otel-source.ts` (lines 29-42) already worked around the `matchesFilter()` sessionId gap locally with an explicit comparison + stripped-filter pattern; `sessions-source.ts` does not apply this workaround, showing the gap was previously noticed for one source but not fixed at the root or propagated to the sibling source. A root fix in `matchesFilter()` risks needing a corresponding cleanup in `otel-source.ts` to avoid double-filtering or dead code.
- **Duplicated/diverging filter-matching implementations**: `MetricsDataLoader.matchesFilter()`, `LogReader.matchesFilter()`, `SessionReader.matchesSessionFilter()` are three independent implementations of "does this record match filter X" — a targeted fix to `data-loader.ts` will not automatically apply to the other two; verify no code path assumes they behave identically.
- **Blast radius of `matchesFilter()`/`sessionMatchesFilter()`**: called by `loadSessions()` (`data-loader.ts:157`), `sessionMatchesFilter()` (`data-loader.ts:252`), and consumed externally by `sessions-source.ts:21` and `otel-source.ts:42`. Any signature or behavior change must keep both external callers correct.
- **Blast radius of `loadSessions()`**: called only by `sessions-source.ts:13`, low external fan-out, but changing the `sessionId` derivation at line 143 changes the value stored in `RawSessionData.sessionId` for every tracked completed session — downstream consumers of that field (aggregator, report payload) must be checked for any place that expects the `completed_`-prefixed form.
- **`completed_` convention is scattered across 5+ locations** (`log/reader.ts`, `log/cleaner.ts`, `SessionStore.ts`, `hook.ts`, `codex.reconciliation.ts`) with no shared utility function — the fix should ideally extract a single shared helper (e.g. `stripCompletedPrefix(filename)`) rather than duplicating the `.replace()` chain a third time in `data-loader.ts`, but this is a scope decision, not a requirement of the bug fix itself.
- **No guide or documented ADR** for the `completed_` naming convention or the `AnalyticsFilter` contract — all conventions were derived from code and comments (`hook.ts`, `SessionStore.ts`). Low risk since the pattern is simple and consistent, but nothing to link to for prior-art justification.
- **Adjacent, unrelated risk**: `docs/superpowers/work-items/EPMCDME-12992.md` documents a separate provenance/security bug in the same analytics area (non-CodeMie session ingestion) — do not conflate scope, but be aware both bugs touch session filtering code that may see near-term follow-up changes.

---

## 7. Summary for Complexity Assessment

This is a narrowly-scoped, well-diagnosed bug fix confined to two methods in one file (`src/cli/commands/analytics/data-loader.ts`: `loadSessions()` lines 132-169 and `matchesFilter()` lines 258-299), with a probable one-line touch in `sessions-source.ts` if the `otel-source.ts` workaround pattern needs cleanup after the root fix. The estimated file-change surface is small: 1 primary file (`data-loader.ts`), possibly `sessions-source.ts` and/or `otel-source.ts` for consistency, plus new test file(s) since none currently exist for `data-loader.ts` or `sessions-source.ts`. No API, schema, or config changes are involved; the fix is purely internal filtering logic.

Technical novelty is low — the correct pattern (`file.replace('.json', '').replace('completed_', '')`) already exists twice in the codebase (`log/reader.ts`, `log/cleaner.ts`), and the correct sessionId-comparison pattern already exists once (`otel-source.ts`'s explicit workaround). This is a "propagate an established, working pattern" fix rather than novel design. Both root causes have been independently confirmed by codebase research, matching the pre-existing diagnosis exactly (including exact line numbers), which reduces investigation risk for the implementer.

Test coverage posture is a significant risk factor despite the fix's small size: `matchesFilter()`/`sessionMatchesFilter()` sessionId matching has zero test coverage, the `completed_` filename path in `loadSessions()` has zero test coverage, and `sessions-source.ts` — the file that actually produces the reported "all sessions" symptom via the native-session path — has no test file at all. Any fix must add targeted unit tests (matchesFilter with a sessionId filter against both matching and non-matching `RawSessionData`; loadSessions against both `<uuid>.json` and `completed_<uuid>.json` fixtures) to avoid regressing silently again, since the existing E2E test (`tests/integration/analytics.test.ts`) only exercises the bare-UUID filename case and would not have caught either bug. Complexity should be scored low-to-medium: low on design/architecture risk, but nudged up slightly for the mandatory net-new test coverage across two previously-untested code paths.
