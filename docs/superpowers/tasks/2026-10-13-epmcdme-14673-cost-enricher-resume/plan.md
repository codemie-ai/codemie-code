# EPMCDME-14673 Same-log resumed sessions: time-window cost attribution

**Goal:** Each session only counts messages inside its own window `[startTime, next sibling startTime on the same file)`. This replaces first-come claim for sessions that share one native log. Cross-file replay dedup (earliest session owns, CR-012) is unchanged.

**Architecture:** Analytics cost layer only. One mechanism, a `UsageWindow`, covers both bounds. The lower bound drops replayed history older than the session. The upper bound is the next sibling on the same `filePath`, and `endTime` is never used because it is unreliable. Records with a null `ts` stay with the first session on the file. Agent-agnostic. Commit per task using the repository's existing convention.

## Acceptance criteria
- Two sessions on one log file: messages at or after the new session's start count for the new session, and earlier ones (including ones written after the old session's end) count for the old session.
- Totals across the two sessions equal the log total, with no double count and no loss.
- `generateSessionReport` for a lone resumed session counts only its own window of the shared log.
- Sessions on different files still dedup by "earliest session owns the replayed response" (CR-012 and the existing cross-session tests pass unchanged).
- A record with a null `ts` or null key never throws and stays with the earliest session on that file.
- A session file carrying `agentName`/`startTime` at top level resolves its agent and start time (Task 2).

### Task 1: Window filter in usage readers

**Files:** `src/cli/commands/analytics/cost/usage-readers.ts:143` (`takeUnseenRecords`), `:859` (`gatherUsageDeduped`), `:906` (`gatherDedupedUsageRecords`)

- Add `export interface UsageWindow { from: number; to: number; keepUntimed: boolean }` and an optional trailing `window?: UsageWindow` on both gather functions, passed through to `takeUnseenRecords`.
- In `takeUnseenRecords`, test the window BEFORE the `seen` check, and skip an out-of-window record without adding its key to `seen`. A record is out when `ts != null && (ts < from || ts >= to)`, or when `ts == null && !keepUntimed`. This covers the requested lower bound (`minTs`) and the sibling upper bound in one parameter.
- With no `window`, behavior is identical to today.

Test-first: yes — in `usage-readers.test.ts`, `gatherDedupedUsageRecords` with window `{from:100,to:200,keepUntimed:false}` over records at ts 50/150/250/null returns only the 150 record, and the other keys stay out of `seen`.

### Task 2: Build windows in `enrichCosts` and fix old-format fallbacks

**Files:** `src/cli/commands/analytics/cost/cost-enricher.ts:62` (`realDeps.resolveAgentName`), `:117` (`parseOne`), `:402-447` (`enrichCosts`); `src/cli/commands/analytics/data-loader.ts:120` (`RawSessionData`)

- Fix A: `resolveAgentName: (raw) => raw.startEvent?.agentName ?? raw.agentName ?? ''` and `startTime: raw.startEvent?.data?.startTime ?? raw.startTime ?? 0`. Add optional `agentName?: string` and `startTime?: number` to `RawSessionData`, because the type has neither today. Only these two sites read `startEvent` for these values in the cost layer. The other readers (`aggregator.ts:401-412`, `data-loader.ts:321-352`, `session-report.ts:49-52`) need `startEvent` and skip a session without one, so leave them alone.
- After the phase-2 sort, group `ordered` by non-null `filePath`. Each entry's window is `from = startTime`, `to` = the next entry's `startTime` on that file (`Infinity` if none), and `keepUntimed` = it is the first on its file. Pass the window to the gather calls at lines 433 and 446 for every entry with a `filePath`. Entries with a null `filePath` get no window.
- Add `extraSiblings: RawSessionData[] = []` as a third param. Resolve each one's `loadAgentSessionFile` and `startTime` (no parse) and include them in the grouping as boundary-only entries with no output.
- Dispatches: `DispatchEvent.start` is epoch ms (`cost/types.ts:86`), so after `extractDispatchResult` drop dispatches with `start < from || start >= to` before enrichment (for the first session on a file, only the `to` bound applies).

Test-first: yes — in `cost-enricher.test.ts`:
(a) Two raws whose `loadAgentSessionFile` returns the same path, starting at T0 and T1, with messages at T0+1, T1-1 (after the old one ended) and T1+1. The old session gets the first two, the new one gets T1+1 with tokens > 0, and the totals sum to the log total. A dispatch whose `start` is after T1 appears only on the new session.
(b) A raw with only top-level `agentName`/`startTime` (no `startEvent`) resolves the agent and orders by that start time.
CR-012 and the cross-session dedup tests must still pass.

### Task 3: Lone-session report path

**Files:** `src/cli/commands/analytics/report/session-report.ts:31-39`

- Load all sessions with `new SessionsSource().load({})` and pass those with `sessionId !== options.sessionId` as `extraSiblings` to `enrichCosts`. Keep `rawSessions` filtered to the target so the aggregation and payload logic stay unchanged.

Test-first: yes — `enrichCosts([newRaw], deps, [oldRaw])` over one shared log returns only the new session's window. If a mockable `generateSessionReport` test already exists, add the same case there.

## Negative-constraint pass
- "Cross-file replay dedup must be preserved": the window only filters and never touches `seen` for out-of-window records, and `seen` stays shared across files. Task 1 and Task 2 honor it.
- "endTime unreliable": no task uses `endTime`.
- "Keep minimal": no new modules or dependencies, and one window mechanism instead of two.
- Fix B alone does not fix the repro, because the earlier session would still claim later messages first. The upper bound in Task 2 is what fixes it.
