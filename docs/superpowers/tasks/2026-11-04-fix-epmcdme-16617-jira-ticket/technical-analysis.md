# Technical Research

**Task**: analytics date filter cli
**Generated**: 2026-11-04
**Research path**: filesystem

---

## 1. Original Context

task_context: fix EPMCDME-16617 jira ticket

Ticket body (fetched from Jira):
EPMCDME-16617 (Bug, Major): [Local Analytics] `codemie analytics --to YYYY-MM-DD` excludes sessions from the selected end date; single-day range returns no sessions.

`codemie analytics --to YYYY-MM-DD` is documented as "End date (inclusive)" but is parsed as midnight UTC at the start of that day, so all sessions from the selected end date are excluded. `--from D --to D` returns "No sessions found".

Repro: 4 completed sessions starting 2026-10-24T12:00Z, 2026-10-25T09:00Z, 2026-10-25T18:00Z, 2026-10-26T09:00Z. `codemie analytics --to 2026-10-25 --export json -o out.json` yields only the 10-24 session, periodEnd 2026-10-25T00:00:00.000Z. `codemie analytics --from 2026-10-25 --to 2026-10-25` prints "No sessions found matching the specified criteria." Same in TZ=UTC, Europe/Warsaw, America/New_York.

Expected: date-only `--to` includes the full selected day, per docs/ANALYTICS-REPORT.md:349 "End date (inclusive)", with one documented time-zone policy for --from/--to.

Reported root cause: src/cli/commands/analytics/index.ts `parseFilterOptions` (~L318-322) sets `filter.toDate = parseDate(options.to)` with no end-of-day adjustment; `parseDate` (~L343-352) returns `new Date('YYYY-MM-DD')` = 00:00 UTC. src/cli/commands/analytics/data-loader.ts (~L355): `startEvent.data.startTime > filter.toDate.getTime()` drops sessions after midnight of end date. Contrast: src/cli/commands/log/index.ts (~L380) extends --to with setHours(23,59,59,999), so the two commands disagree. (Line numbers are from the ticket - verify them.)

Recommended fix: parse date-only values as calendar dates and use an exclusive upper bound of next-day 00:00 (or end-of-day 23:59:59.999) in a single documented TZ (local or UTC), applied to both --from and --to; share the helper with `codemie log`.

Acceptance criteria:
1. `--to 2026-10-25` includes sessions starting at any time on 2026-10-25 in the documented TZ; `--from D --to D` returns that day's sessions.
2. --from/--to use the same documented TZ policy; `periodEnd` reflects the inclusive end.
3. Unit tests for parse/filter boundaries (start of day, 23:59, next day 00:00) under at least UTC and a negative-offset TZ.

Research focus: where --from/--to are parsed and consumed (analytics command, data-loader, any other consumers of filter.fromDate/toDate and periodEnd), how `codemie log` handles it, existing date helpers in src/utils, docs mentioning the flags (docs/ANALYTICS-REPORT.md, COMMANDS.md), existing tests for these paths, and what TZ policy the codebase already uses elsewhere. Note: the repo guide policy says do not write/run tests unless user asks - this is research only.

---

## 2. Codebase Findings

### Existing Implementations (ticket claims verified; line numbers corrected)
- `src/cli/commands/analytics/index.ts`
  - L60-62: `--from/--to <date>` descriptions say only "(YYYY-MM-DD)"; no inclusive/TZ wording. Options registered in a shared function used by both `analytics` and `analytics otel`.
  - L134: `parseFilterOptions(options)` called once in `runAnalytics`.
  - L308-324 (`parseFilterOptions`): `--from` -> `filter.fromDate = parseDate(from)`; `--to` -> `filter.toDate = parseDate(to)` with no end-of-day adjustment (confirmed bug).
  - L326-335: `--last` sets `fromDate = now - duration`, `toDate = new Date()` (instant, not date-only; must stay unchanged). `--last` overrides `--from/--to` when both given.
  - L343-352 `parseDate` (file-local, not exported): regex-enforces `^\d{4}-\d{2}-\d{2}$` then `new Date(str)` -> 00:00 UTC for date-only ISO strings. Returns null on invalid -> caller warns and ignores filter.
  - L218-219: `periodStart: filter.fromDate.toISOString()`, `periodEnd: filter.toDate.toISOString()` put directly into the report `ctx`. So `periodEnd` simply mirrors whatever `filter.toDate` is; fixing `toDate` fixes `periodEnd` (AC2) with no change here. Also affects `--last` (periodEnd = now).
  - L214: `rangeLabel = options.last ?? (from||to ? 'custom' : 'all')`.
- `src/cli/commands/analytics/data-loader.ts` L373-380 (`sessionMatchesFilter`): `startTime < fromDate.getTime()` -> drop; `startTime > toDate.getTime()` -> drop. Inclusive on both bounds, compares on session START time only. (Ticket said ~L355; actual L374/L378.)
- `src/cli/commands/analytics/types.ts` L226-227: `AnalyticsFilter { fromDate?: Date; toDate?: Date }`.
- Other consumers of `filter.fromDate/toDate` (full list, grep across src):
  - `sources/sessions-source.ts` L20 -> `loader.sessionMatchesFilter(s, filter)` (the data-loader path above).
  - `sources/otel-source.ts` L21 -> maps to `{since: fromDate, until: toDate}`; `otel-loader.ts` L105-111 keeps events with `sinceMs <= ms <= untilMs` (inclusive, same semantics). Also benefits from a fix to `toDate`.
  - `native-loader.ts` L626-628 `windowDays(filter)`: only `fromDate`, `ceil((now - fromDate)/86400000)+1` discovery window; unaffected by toDate. A shift of `fromDate` from UTC midnight to local midnight changes this by <1 day, covered by the `+1`.
- `src/cli/commands/log/index.ts` L364-383: `--from` unchanged `parseDate`; `--to` does `toDate.setHours(23,59,59,999)` -- this is LOCAL-time `setHours` applied to a UTC-midnight Date. In negative-offset TZs (America/New_York) 00:00Z is the previous local day, so this sets 23:59:59.999 on the PREVIOUS local day (still the UTC-midnight date's evening in local = wrong); in positive-offset TZs it lands on the correct date. So `codemie log` is itself TZ-inconsistent, not a clean reference. Its `parseDate` (L407-417) has no regex guard (accepts any `new Date()` string). `--last` there sets only `fromDate`.
  - Log consumers: `log/types.ts` L45-46, `log/filter.ts` L55-63 `byDateRange` (inclusive `>=`/`<=` on entry.timestamp), L118; `log/reader.ts` L118-136 expands file range by +/-24h; L198 filters entries.
- No shared date helper exists: `src/utils/` has no date/range util (`parsers.ts` only has JSON/JSONL parsers). Two duplicated, divergent `parseDate` copies (analytics L343, log L407) and duplicated `parseDuration`.

### Architecture and Layers Affected
CLI layer only: command option parsing (`analytics/index.ts`, `log/index.ts`) -> filter objects -> data-loader/otel-loader filtering. Report layer (`report/payload-builder.ts` L18-19, L242-250) just passes `ctx.periodStart/periodEnd` through (prefers ctx over derived min/max).

### Integration Points
- `AnalyticsFilter` is consumed by SessionsSource/OtelSource/native-loader; `AnalyticsOptions` (from/to/last strings) from commander.
- `periodStart/periodEnd` are exported in the report JSON meta (`report/types.ts` L124-125) and rendered in HTML; downstream consumers read ISO strings.
- Import conventions: ES modules, `.js` extension, `@/` alias (AGENTS.md).

### Patterns and Conventions
- Shared utilities live in `src/utils/*.ts` (flat); would be the natural home for a shared date helper (Speculative, see Section 6).
- Invalid input policy: warn via `console.warn(chalk.yellow(...))` and ignore the filter.
- Error/logging rules: `logger.debug`, no `console.log` debug.

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/` exists (architecture, development, standards/code-quality, testing/testing-patterns, quality-gates). No guide covers date/TZ handling. Not read in depth (research scoped to filter code).
- `docs/ANALYTICS-REPORT.md` L365-366 CLI reference: `--from <YYYY-MM-DD>  Start date (inclusive)`, `--to <YYYY-MM-DD>  End date (inclusive)` (ticket said L349; actual L365-366). No time-zone statement anywhere; only mention is L117 "weekday x hour of day (local time)" for the heat map. L17 example uses `--from 2025-01-01 --to 2025-01-31`; L303 and L347 mention `--from/--to`.
- `docs/COMMANDS.md`: analytics options L1390-1391 (`--from <date>` "Filter sessions from date (YYYY-MM-DD)", `--to` likewise; no inclusivity/TZ); L637 and L740 examples; `codemie log` L764-765 examples and L1426-1427, L1476-1477 option lists (other commands' `--from/--to`, no TZ policy). No `COMMANDS.md` in repo root; only `docs/COMMANDS.md`.

### Architectural Decisions
None recorded for date/TZ semantics. `parseDate` comment (analytics L344-346) records only the YYYY-MM-DD shape enforcement rationale.

### Derived Conventions
- TZ policy in the codebase is implicit and mixed: filters use UTC (`new Date('YYYY-MM-DD')`), `log` mixes UTC parse with local `setHours`, the heat map uses local time, and Codex/log dir lookup uses local `getFullYear()` (`agents/plugins/codex/codex.paths.ts` L83, `codexUploadsDetector.ts` L63). Env fields record `Intl.DateTimeFormat().resolvedOptions().timeZone` (`agents/core/event-fields/env-fields.ts` L13). No `process.env.TZ` handling in src or vitest config; no `TZ=` in package.json scripts.

---

## 4. Testing Landscape

### Existing Coverage
- `src/cli/commands/analytics/__tests__/data-loader.test.ts` L33+: `MetricsDataLoader.sessionMatchesFilter` tests for sessionId/agent only; no `fromDate/toDate` boundary tests.
- `analytics-cli-metadata.test.ts`: runs `runAnalytics` with mocked aggregator/formatter/payload-builder (static + dynamic `vi.mock`); does not test date parsing.
- `copilot-managed-report.test.ts`: end-to-end `runAnalytics({last:'24h', export:'json'})` with fixed `NOW = 2026-10-24T12:00Z` and asserts `periodStart/periodEnd` (L114-115) -- good template for an end-to-end `--from/--to` test, and a regression guard that `--last` periodEnd must remain `now`.
- `native-loader.test.ts` L300-341: `windowDays`/fromDate behaviour only.
- `report/__tests__/payload-builder.test.ts` L347-393: ctx `periodStart/periodEnd` pass-through.
- `analytics/__tests__/otel-loader.test.ts` exists (since/until); `otel-report.integration.test.ts` too.
- `log`: only `log/__tests__/reader.sessions.test.ts`; no tests for `parseFilterOptions`/date range.
- `parseFilterOptions` and `parseDate` are not exported in either command, so currently untestable directly.

### Testing Framework and Patterns
Vitest (projects `unit` = `src/**/*.test.ts`, `cli`, `agent`; `globals: true`, node env) per `vitest.config.ts`; dynamic-import mocking after `vi.mock` (see testing-patterns guide). `vi.useFakeTimers/setSystemTime` style via fixed NOW in copilot test. No `TZ` set in vitest config or scripts; Node reads `process.env.TZ` at start, and changing it at runtime inside a test is possible but fragile (set before first Date use, or spawn with `TZ=...`).

### Coverage Gaps
- No tests for `fromDate/toDate` inclusive/exclusive boundaries in `sessionMatchesFilter` or `otel-loader`.
- No tests for either `parseDate` / `parseFilterOptions`.
- No TZ-parameterised tests anywhere in the repo (AC3 needs a new approach).

---

## 5. Configuration and Environment

### Environment Variables
None relevant. `TZ` is not referenced anywhere in src, tests, vitest config or package.json.

### Configuration Files
`vitest.config.ts` (no TZ/env for dates; `env` sets FORCE_COLOR, NODE_ENV, CODEMIE_HOME). `package.json` `scripts.test` = three vitest projects sequentially.

### Feature Flags and Deployment Concerns
None. No flags govern date filtering. Behaviour change is user-visible output (`periodEnd` value in exported JSON/HTML) for existing `--to` users.

---

## 6. Risk Indicators

- Speculative: TZ policy choice (UTC vs local) is the main decision. Using UTC keeps parsing consistent with current `new Date('YYYY-MM-DD')` and with the stable ISO output; using local matches the heat map and typical user expectation but makes results machine-dependent. The ticket repro says all three TZs fail, so either works for the bug itself, but the policy must be documented in `docs/ANALYTICS-REPORT.md` and `docs/COMMANDS.md`, and option help text.
- Speculative: the `log` command cannot be "left as is" if a helper is shared; its `setHours` on a UTC-midnight date is already wrong in negative-offset zones (see Section 2). Switching `log` changes behaviour for a second command and has no tests today (also `log/reader.ts` +/-24h file-range padding masks some boundary effects).
- `--from` is treated as UTC midnight today; moving to local time would shift the lower bound too (AC2 requires both consistent), and `native-loader.windowDays` derives discovery days from `fromDate` (slack of +1 day absorbs it).
- Sessions are matched on START time only (`data-loader` L374-378); a session starting before midnight and running past it is attributed to its start day. Not part of the ticket but relevant to "full selected day" wording.
- `--last` also sets `toDate = new Date()` and flows into `periodEnd`; a shared helper/end-of-day adjustment must not touch the `--last` path.
- `parseFilterOptions`/`parseDate` are file-private; unit tests (AC3) need either an exported helper or driving through `runAnalytics`/`sessionMatchesFilter`. Speculative: a small exported pure helper in `src/utils/` would be the testable seam.
- Test runs under multiple TZs: no precedent in repo; DST-day edge cases (end of day = next-day-00:00 exclusive vs 23:59:59.999) are only relevant if local TZ is chosen.
- Docs are inconsistent (ticket cites ANALYTICS-REPORT.md:349; actual lines 365-366); COMMANDS.md lives under `docs/`.
- Two other commands' `--from/--to` options in `docs/COMMANDS.md` L1426-1427, L1476-1477 were not traced to source (out of stated focus).

---

## 7. Summary for Complexity Assessment

The bug is confirmed and localised to the CLI layer. `analytics/index.ts` `parseFilterOptions` (L317-324) assigns `toDate` as 00:00 UTC of the given day, and the inclusive comparisons in `data-loader.ts` L374-380 (and the equivalent `since/until` in `otel-loader.ts` L105-111) then drop the whole end day. `periodEnd` is a direct `toISOString()` of `filter.toDate` (L219), so fixing the parse also fixes `periodEnd`. Realistic change surface is 2 source files (`analytics/index.ts`, `log/index.ts`) plus optionally one new shared helper in `src/utils/`, doc updates in `docs/ANALYTICS-REPORT.md` and `docs/COMMANDS.md`, and option help text.

Technical novelty is low (pure date arithmetic), but the semantic decision (single TZ policy, inclusive end, shared with `codemie log`) is a product-level choice and the codebase has no existing policy: filters are UTC, `log` is an inconsistent UTC/local mix, the heat map is local. `codemie log`'s current `setHours(23,59,59,999)` is not a reliable reference in negative-offset zones.

Test posture is weak: no `fromDate/toDate` boundary tests for analytics or log, no TZ-parameterised tests, and the parse functions are not exported. `data-loader.test.ts` (sessionMatchesFilter) and `copilot-managed-report.test.ts` (end-to-end with fixed NOW, asserts periodEnd) are the best templates for AC3. Key risks: TZ policy choice, changing `log` behaviour, keeping `--last` unchanged, and testing under multiple TZs.

---

## 8. External References

None named by the task. (Ticket-cited paths `docs/ANALYTICS-REPORT.md`, `src/cli/commands/analytics/index.ts`, `data-loader.ts`, `log/index.ts` are in-repo and were verified; line numbers corrected above.)
