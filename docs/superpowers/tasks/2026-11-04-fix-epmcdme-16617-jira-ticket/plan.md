# EPMCDME-16617 Inclusive `--to` date filter Implementation Plan

**Goal:** Date-only `--to` includes the whole selected day; `analytics` and `log` share one UTC policy.

**Architecture:** One pure helper in `src/utils/` parses date-only filter values; both commands call it. Downstream inclusive comparisons (`data-loader.ts` sessionMatchesFilter, `otel-loader.ts` since/until) stay untouched.

**Conventions:** ESM, `.js` import extensions, `@/` alias, explicit return types, no `any`. Commit per task using the repository's existing convention. Do not run the test suite while planning.

## Acceptance criteria

- `--to 2026-10-25` includes sessions starting at any time on 2026-10-25 (UTC); `--from D --to D` returns that day's sessions.
- `--from`/`--to` share one documented policy (UTC); `periodEnd` for date-only `--to` is `YYYY-MM-DDT23:59:59.999Z`.
- `--last` behaviour and `periodEnd = now` are unchanged.
- `codemie log --to` uses the same helper and is machine-TZ independent.
- Impossible calendar dates (`2026-02-30`, `2026-02-31`) are rejected as invalid, never rolled over to the next month.
- Unit tests cover start of day, 23:59, next-day 00:00 under UTC and a negative-offset TZ.

## Decisions

- TZ policy = UTC (matches current `new Date('YYYY-MM-DD')`, machine-independent).
- Date-only `--to` = 23:59:59.999Z of that UTC day (inclusive upper bound), so existing `<=` comparisons stay correct with no loader edits. `--from` = 00:00:00.000Z.
- A date-only-shaped value must be a real calendar date: the helper round-trips through `toISOString()` and returns null on mismatch (`new Date('2026-02-30')` otherwise rolls over to Mar 2). One shared rule for `--from` and `--to`.
- Sessions are matched on START time only (documented, not changed).
- Out of scope: other commands' `--from/--to` in COMMANDS.md (~L1426-27, L1476-77).

## Task 1: Shared date-filter helper

**Files:** Create `src/utils/date-filter.ts`

New symbols, so full code:

```ts
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** True when the value has the YYYY-MM-DD shape (valid calendar date or not). */
export function isDateOnly(value: string): boolean {
  return DATE_ONLY.test(value);
}

/** Parse a YYYY-MM-DD filter value in UTC. 'from' = 00:00:00.000Z, 'to' = 23:59:59.999Z (inclusive).
 *  Returns null for bad shape or impossible calendar dates (no month rollover). */
export function parseDateOnly(value: string, bound: 'from' | 'to'): Date | null {
  if (!DATE_ONLY.test(value)) return null;
  const start = new Date(value);
  if (Number.isNaN(start.getTime()) || start.toISOString().slice(0, 10) !== value) return null;
  return bound === 'from' ? start : new Date(start.getTime() + 86_400_000 - 1);
}
```

Test-first: no — behaviour is covered by the separable Task 5.

## Task 2: Use helper in `analytics`

**Files:** Modify `src/cli/commands/analytics/index.ts`

- Replace file-local `parseDate` (L343-352) with an import of `parseDateOnly` (`@/utils/date-filter.js`); in `parseFilterOptions` (L308-324) call `parseDateOnly(options.from, 'from')` and `parseDateOnly(options.to, 'to')`. Keep the existing warn-and-ignore handling (impossible dates hit the "Invalid --from/--to date" warning).
- Leave the `--last` block (L326-335) untouched; no end-of-day adjustment there.
- Update `--from`/`--to` help text (L60-61), e.g. "Start date, inclusive (YYYY-MM-DD, UTC)" / "End date, inclusive: the whole day (YYYY-MM-DD, UTC)".
- `periodEnd` (L219) needs no change; it mirrors `filter.toDate`.

Test-first: no — covered by Task 5 (`--to D` keeps a session at D 18:00Z; `periodEnd` ends `T23:59:59.999Z`).

## Task 3: Use helper in `log`

**Files:** Modify `src/cli/commands/log/index.ts`

- In `parseFilterOptions` (L364-383) use `parseDateOnly(options.from, 'from')` / `parseDateOnly(options.to, 'to')`; delete the `setHours(23, 59, 59, 999)` call (L379-380), the TZ-fragile part.
- To avoid rejecting inputs `log` accepts today (full ISO timestamps), fall back to the existing loose `parseDate` (L407-417) ONLY when `!isDateOnly(value)`. A date-only-shaped value that the helper rejects (e.g. `2026-02-30`) is invalid: take the existing "Invalid --from/--to date" warning path and never pass it to the loose parser, which would roll it over. No end-of-day adjustment on the fallback.
- `--last` (L386-393) untouched.

Test-first: no — covered by Task 5 (`--to` under TZ=America/New_York yields 23:59:59.999Z on the given date).

## Task 4: Document the UTC policy

**Files:** Modify `docs/ANALYTICS-REPORT.md` (~L365-366), `docs/COMMANDS.md` (analytics ~L1390-1391 and `codemie log` option/example sections ~L764-765)

- State: dates are UTC calendar days and must be real calendar dates; `--to` includes the entire day; sessions are matched on start time; `periodEnd` reports `23:59:59.999Z` of the end date.
- Do not edit the other commands' `--from/--to` lines.

Test-first: no — documentation only.

## Task 5: Boundary tests (separable; drop at plan approval if tests are not wanted)

**Files:** Create `src/utils/__tests__/date-filter.test.ts`; extend `src/cli/commands/analytics/__tests__/data-loader.test.ts`

- Helper test: table of `from`/`to` for start of day (00:00:00.000Z), 23:59 (included), next-day 00:00 (excluded). Invalid (null): `10/25/2026`, `2026-13-40`, `2026-02-30`, `2026-02-31`, `2025-02-29` (non-leap). Valid: `2028-02-29` (leap) for both bounds. Run every case under `process.env.TZ` = `UTC` and `America/New_York` (set in `beforeEach`, restore in `afterEach`) asserting identical results. Also assert `isDateOnly('2026-02-30')` is true, `isDateOnly('2026-10-25T10:00:00Z')` is false.
- `data-loader.test.ts`: reuse the `sessionMatchesFilter` pattern; with `fromDate`/`toDate` from the helper for `2026-10-25`, assert the ticket fixtures (10-24T12:00Z excluded; 10-25T09:00Z and 18:00Z included; 10-26T09:00Z excluded).
- Optionally mirror `copilot-managed-report.test.ts` to assert `--last` still gives `periodEnd = NOW`.

Test-first: yes — boundary cases fail against the old 00:00Z `--to` (the 10-25 sessions are dropped) and the rollover cases fail against a regex+NaN-only helper; all pass after Tasks 1-2.

## Self-review

- negative-constraints: `--last` must not get end-of-day (Tasks 2, 3 leave it untouched); no other commands traced (Task 4 excludes them); sessions matched on start time only (Decisions, no loader edits); no test run during planning (header). No task violates these.
- Calendar validity: impossible dates are rejected by the one shared helper for both flags; `log`'s loose fallback is gated by `isDateOnly`, so date-only-shaped input cannot reach `new Date()` rollover (Tasks 1, 3; cases in Task 5).
