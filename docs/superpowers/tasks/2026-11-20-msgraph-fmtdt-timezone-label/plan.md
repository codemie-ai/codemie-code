# msgraph calendar time label (EPMCDME-16957) Implementation Plan

**Goal:** Calendar/meeting times print as local time with an offset label, e.g. `2026-11-20 12:00 (UTC+3)`, `(UTC)` on UTC machines. All-day events print the date only, e.g. `2026-11-23 (all day)`.

**Architecture:** One new helper next to `fmtDtTz` in `msgraph.js`; five calendar call sites switch to it, and the four `/me/calendarView` calls also select `isAllDay`. `fmtDt` stays untouched so mail/chat/drive/task columns and `--json` output are unchanged.

Commit per task using the repository's existing convention. Repo policy: no test files (tests only on explicit request). The ticket branch `fix/msgraph-timezone-label` already exists and is checked out, so no branch-creation step is needed.

File: `src/agents/plugins/claude/plugin/skills/msgraph/scripts/msgraph.js`

### Task 1: Add `fmtCalDt` helper

- Test-first: no - repo policy, tests only on explicit request
- Modify: after `fmtDtTz` (`msgraph.js:399-404`).

Add `fmtCalDt(ev, which)` where `ev` is the Graph event and `which` is `'start'` or `'end'`; it reads `ev[which]` (`{dateTime, timeZone}`) and `ev.isAllDay`.
- Missing `dateTime`: return `'N/A'`.
- `ev.isAllDay`: return the first 10 characters of `dateTime` plus ` (all day)`, with no timezone conversion.
- Otherwise: append `Z` to a zone-less value when `timeZone` is UTC (same rule as `fmtDtTz`), build a `Date`, and render `YYYY-MM-DD HH:MM` from its local getters. If the Date is invalid, fall back to `fmtDtTz(ev[which])`.
- Offset comes from `-d.getTimezoneOffset()` of that event instant, so DST is correct. Label is `(UTC)` for 0, otherwise `(UTC+3)`, `(UTC-5)`, `(UTC+5:30)`, `(UTC+5:45)`: sign, unpadded hours, `:MM` only when minutes are non-zero.
- Add a code comment: zone-less values with a non-UTC `timeZone` are not handled; this cannot happen today because no `Prefer: outlook.timezone` header is sent.

```js
function fmtCalDt(ev, which) { /* see description above */ }
```

### Task 2: Select `isAllDay` and switch calendar call sites

- Test-first: no - repo policy, tests only on explicit request
- Modify: `$select` at `msgraph.js:706`, `:727`, `:1219`, `:1258` (append `isAllDay` to each); call sites at `:715`, `:742`, `:1239`, `:1272`, `:1309`.

Replace `fmtDt(e.start?.dateTime)` and `fmtDt(e.end.dateTime)` with `fmtCalDt(e, 'start')` and `fmtCalDt(e, 'end')` at 715 (start and end), 1239 and 1272. At 742 and 1309 also use `fmtCalDt(e, 'start')` and widen `.padEnd(20)` to `.padEnd(28)`, the longest label being `2026-11-20 12:00 (UTC+5:30)`. Widen the `'Date & Time'.padEnd(20)` header at 735 to 28 and keep the 4-space gap. Do not touch the other `fmtDt` callers (640, 667, 920, 1582, 1608) or any `--json` path.

### Task 3: Manual verification

- Test-first: no - repo policy, tests only on explicit request
- `node --check` on `msgraph.js`. (`npm run lint` does not cover this file: eslint only runs on `{src,tests}/**/*.ts` and the pi extension `.js`.)
- Offline: run a throwaway `node -e` snippet outside the repo containing `fmtDt`, `fmtDtTz` and `fmtCalDt` (the fallback calls `fmtDtTz`, which calls `fmtDt`; omitting them throws a ReferenceError). Run it under `TZ=UTC`, `TZ=Europe/Kiev`, `TZ=Asia/Kolkata`, `TZ=Asia/Kathmandu`, `TZ=America/New_York`, with these inputs:
  - `{start:{dateTime:'2026-11-20T09:00:00.0000000', timeZone:'UTC'}}`, expected `09:00 (UTC)`, `11:00 (UTC+2)`, `14:30 (UTC+5:30)`, `14:45 (UTC+5:45)`, `04:00 (UTC-5)`. A July date in Kiev shows `(UTC+3)`.
  - An invalid `dateTime` (e.g. `'garbage'`): takes the `fmtDtTz` fallback, no throw.
  - An all-day event `{isAllDay:true, start:{dateTime:'2026-11-23T00:00:00.0000000', timeZone:'UTC'}}`: `2026-11-23 (all day)` in every TZ.
- Live: run `node msgraph.js calendar --limit 5` and compare with the raw Graph start times. Expected on a UTC+4 machine: Daily Sync at 08:30 UTC shows `12:30 (UTC+4)`, the holiday shows `2026-11-23 (all day)`.

## Notes

- The call-notes .docx subtitle is out of scope because that skill is not in this repo. This fix changes the CLI `Start  :` line it most likely reads, but that is not verified.
- Zone-less values with a non-UTC `timeZone` are not handled (see Task 1 comment).

## Negative-constraint pass

- Do not change non-calendar `fmtDt` callers or their `padEnd` widths: honored by Tasks 1-2, which leave `fmtDt` and the other call sites alone.
- `--json` output unchanged: honored, the JSON paths are not touched (adding `isAllDay` to `$select` only adds a field to the raw objects).
- All-day events must not get a fake converted time: honored by the `isAllDay` branch in Task 1.
- No tests, no git operations in tasks: honored.

## Changes after plan approval

Requested during code review, so the implementation differs from the tasks above:

- All-day end dates: Graph sends the end as next-day midnight (exclusive), so `fmtCalDt` subtracts one day for `end` and shows the last day. Task 1 described the same date-only slice for start and end.
- Regression test: `tests/integration/msgraph-calendar-timezone.test.ts` was explicitly requested, replacing the "no test files" constraint.
