# Design: Exclude non-CodeMie-owned sessions from analytics (EPMCDME-13367)

## Problem

The parent issue (EPMCDME-12992, merged via PR #403) added ownership validation that gates the
RESUME path — the analytics command was left out of scope. `codemie analytics` still scans and
reports every native session it discovers, whether or not CodeMie owns it. Today,
`src/cli/commands/analytics/native-loader.ts` already computes ownership via
`hasOwnershipMarker(descriptor.filePath)` and tags unowned sessions
`startEvent.data.provider = 'native-external'` — but the session is still pushed unfiltered into
the returned array (`out.push(raw)`) and flows through aggregation and output uncounted-but-present.
`formatter.ts` only shows a cosmetic yellow warning; it never excludes the session from totals.

This intentionally reverses one line of the original PR #403 design decision ("No sessions are
hidden — all are surfaced, external ones are clearly marked") — but only for the analytics
pipeline. The RESUME-path UX (informing/blocking on external session resume) is unaffected.

## Goals

- By default, `codemie analytics` (console, JSON/CSV export, HTML report) excludes non-CodeMie-owned
  native sessions from output and from all aggregated totals.
- Provide an opt-in escape hatch (`--include-external`) for diagnostics that restores today's
  exact behavior (included, tagged, contributing to totals, shown with the existing warning label).
- Add regression coverage proving the default path no longer "blindly scrapes" external sessions.
- Do not touch the RESUME-path ownership primitives (`session-ownership.ts`,
  `session-origin-audit.ts`) or the plugin layer (`claude.plugin.ts`, `codex.plugin.ts`) — they are
  already correct and out of scope.
- Preserve prior code-review fixes in `native-loader.ts` (CR-002 bounded scan, CR-003 index-first
  ordering, CR-R-002 `_metrics.json` suffix check) by not touching that file at all.

## Non-goals

- Reconciling `native-loader.ts`'s parallel ownership-index implementation with
  `session-ownership.ts`'s `scanSessionsForClaudeId` — left as a separate future concern; both
  already work correctly for their respective use cases (bulk scan vs. single-id lookup).
- A "diagnostic-only, excluded from totals" mode for `--include-external`. `aggregator.ts` computes
  every total (duration, turns, file ops, tool calls, lines, model calls, etc.) by reducing directly
  over the same session list that's displayed — there is no separate display-only channel. Building
  one would mean threading an exclusion flag through 15+ reduce call sites across an 868-line file,
  well beyond this ticket's scope. `--include-external` therefore means "go back to today's exact
  behavior" — an explicit, opt-in escape hatch, not a hidden data leak.
- An integration-level (`tests/integration/`) end-to-end CLI test. Unit coverage at the exact seam
  where the fix lives is sufficient and matches existing test conventions.

## Design

### Fix point: `src/cli/commands/analytics/sources/sessions-source.ts`

This is the single place where natively-discovered sessions merge into the pipeline shared by
console output, JSON/CSV export, and the HTML report (`SessionsSource.load()` is called once by
`analytics/index.ts`, upstream of the aggregator and all output formats). Today:

```ts
if (opts.scanNative !== false) {
  const { loadNativeSessions } = await import('../native-loader.js');
  const natives = (await loadNativeSessions(opts.filter)).filter((s) =>
    loader.sessionMatchesFilter(s, opts.filter)
  );
  rawSessions.push(...natives);
}
```

Change: after the existing `sessionMatchesFilter` filter, drop any session tagged
`native-external` unless `opts.includeExternal` is set:

```ts
const natives = (await loadNativeSessions(opts.filter))
  .filter((s) => loader.sessionMatchesFilter(s, opts.filter))
  .filter((s) => opts.includeExternal || s.startEvent?.data.provider !== 'native-external');
```

`native-loader.ts` itself is **not modified** — it keeps computing `hasOwnershipMarker` and tagging
`provider = 'native-external'` exactly as it does today. `aggregator.ts` and `formatter.ts` are also
**not modified**: by the time a `RawSessionData` reaches them, it has already been excluded (default)
or is meant to be fully counted (`--include-external`), so the existing warning-label branch in
`formatter.ts` becomes the diagnostic display for the flagged case rather than dead code.

### Flag wiring

| Layer | Change |
|---|---|
| `src/cli/commands/analytics/types.ts` | Add `includeExternal?: boolean` to `AnalyticsOptions`, doc-commented like the existing `scanNative` field. |
| `src/cli/commands/analytics/sources/types.ts` | Add `includeExternal?: boolean` to `SourceLoadOptions`, mirroring `scanNative`. |
| `src/cli/commands/analytics/index.ts` | Add `.option('--include-external', 'Include non-CodeMie-owned native sessions in output (opt-in; matches pre-fix behavior)')`; thread `options.includeExternal` into `source.load({ filter, scanNative: options.scanNative, includeExternal: options.includeExternal })`. |
| `src/cli/commands/analytics/sources/sessions-source.ts` | Consume `opts.includeExternal` in the filter above. |

No changes needed to `AnalyticsFilter` (date/session/project matching stays untouched —
`includeExternal` is a source-level behavior modifier, not a filter criterion, so it lives on
`SourceLoadOptions`/`AnalyticsOptions` alongside `scanNative`, not on `AnalyticsFilter`).

This applies uniformly across output modes (console table, `--export json|csv`, `--report`)
because they all consume the same `rawSessions` returned by `SessionsSource.load()`.

## Testing

- New file `src/cli/commands/analytics/sources/__tests__/sessions-source.test.ts` (no prior coverage
  exists for this file): asserts (a) default mode excludes a `native-external`-tagged session from
  `rawSessions`, (b) `includeExternal: true` restores it, (c) owned native sessions are always
  included, (d) existing `sessionMatchesFilter`-based filtering (date range etc.) is unaffected.
  Follows the project's dependency-injection/dynamic-import mocking convention
  (`.ai-run/guides/testing/testing-patterns.md`) by mocking `../native-loader.js`'s
  `loadNativeSessions` export via `vi.mock`/dynamic import, and a `MetricsDataLoader` stub —
  no real filesystem access needed.
- `native-loader.test.ts` and `aggregator.test.ts`: **no changes** — neither file's behavior
  changes under this design, so existing tests (including the "external session labeling" suite in
  `native-loader.test.ts`, which still accurately describes current tag-only behavior in that file)
  remain correct as-is.

This satisfies the ticket's acceptance criterion that "regression coverage confirms analytics does
not scrape all sessions blindly and excludes external sessions" at the exact seam where the
exclusion is implemented.

## Risks

- `--include-external` restores full inclusion in totals, not diagnostic-only display, per the
  non-goals section above — must be documented in the CLI help text and the ticket/PR description
  so it isn't mistaken for a safe always-on diagnostic mode.
- `codex.plugin.ts` has no `resolveResumeOwnership` implementation (pre-existing, RESUME-path-only
  gap, unrelated to this fix) — verified not to matter here since `hasOwnershipMarker` in
  `native-loader.ts` is already agent-agnostic and unchanged by this design.
