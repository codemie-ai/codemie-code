# EPMCDME-13643 — Analytics report always populates userEmail / periodStart / periodEnd

## Goal

`codemie analytics --report` must return a JSON/HTML report whose `meta` block contains `userEmail`, `periodStart`, and `periodEnd` for every invocation shape that produces at least one session, not just for `--from/--to`.

## Observed today (0.10.1 linked build, Windows)

| Invocation | userEmail | periodStart | periodEnd |
|---|---|---|---|
| `--report` (bare) | ✅ | ❌ | ❌ |
| `--last 7d --report` | ✅ | ✅ (now-7d) | ❌ |
| `--session <real-uuid> --report` | ✅ | ❌ | ❌ |
| `--project X --branch Y --report` | ✅ | ❌ | ❌ |
| `--from A --to B --report` | ✅ | ✅ | ✅ |

## Root causes

1. `parseFilterOptions()` in `src/cli/commands/analytics/index.ts` sets `filter.fromDate` for `--last` but never sets `filter.toDate`. The `periodEnd` guard `filter.toDate !== undefined` is structurally unreachable in that mode.
2. For `--session`, `--project`, `--branch`, and bare invocations, neither `filter.fromDate` nor `filter.toDate` is ever set, so both period fields are always absent.
3. Separately, `BaseAgentAdapter.maybeWriteSessionReport()` reads `userEmail` only from the `CODEMIE_PROFILE_CONFIG` env var. When that env var is missing or the serialized profile lacks `userEmail`, the agent-exit report has no email even though `~/.codemie/codemie-cli.config.json` may hold one.

## Design

### 1. Fallback period derivation inside `buildPayload()`

`buildPayload(analytics, costIndex, summary, ctx)` in `src/cli/commands/analytics/report/payload-builder.ts` already iterates every flattened `ReportSessionRecord`. Each record carries `startTime: number` (unix ms) and `durationMs: number`. In the same pass, track:

```
minStartMs = min(record.startTime  where record.startTime > 0)
maxEndMs   = max(record.startTime + max(record.durationMs, 0))
```

Assemble `meta` with this precedence:

| Field | Precedence |
|---|---|
| `userEmail` | `ctx.userEmail` if defined, else omit (unchanged) |
| `periodStart` | `ctx.periodStart` if defined, else `new Date(minStartMs).toISOString()` if `minStartMs` was set, else omit |
| `periodEnd` | `ctx.periodEnd` if defined, else `new Date(maxEndMs).toISOString()` if `maxEndMs` was set, else omit |

**No fallback to `generatedAt`.** When no session data exists to derive from, the fields are omitted — the zero-sessions edge case is not worth polluting the schema with a synthetic period.

`buildPayload` remains pure: no I/O, no config reads, no env access. It uses only data already in its arguments. This single edit covers the CLI path, the OTEL path, and any future caller.

### 2. `--last` sets both `fromDate` and `toDate`

In `parseFilterOptions()` (`src/cli/commands/analytics/index.ts`), after computing `filter.fromDate = new Date(Date.now() - duration)`, also set `filter.toDate = new Date()`. This is semantically honest: the user asked for "last N to now", and callers other than the report builder (aggregators, session filters) also gain the correct upper bound. The `buildPayload` fallback would catch this anyway, but this fix is one line and improves the contract.

### 3. Agent-exit `userEmail` — `ConfigLoader` fallback

In `src/agents/core/BaseAgentAdapter.ts:maybeWriteSessionReport()`, when the value pulled from `CODEMIE_PROFILE_CONFIG` (parsed `ProviderProfile.userEmail`) is missing, fall back to `ConfigLoader.loadMultiProviderConfig().userEmail`. Wrap the fallback lookup in the existing try/catch pattern (`try/catch` returning `undefined` on any failure). This closes the gap where user reports of "email missing on agent-exit reports" originated.

## Non-changes

- `ReportMeta` schema — fields stay optional in TypeScript (backward-compatible with older report files). Only the JSDoc contract is updated: "always present when the report contains any sessions".
- `rangeLabel` — still describes the filter mode (`'all' | 'custom' | '7d'`). Now that periodStart/periodEnd may be present even for `'all'`, the label still meaningfully signals "no explicit range filter was applied".
- `session-report.ts` — already correctly derives from `startEvent`/`endEvent`. Unchanged.
- CLI surface, help text, exit codes — unchanged.
- No new dependencies, no schema break, no config-file migration.

## Files touched

1. `src/cli/commands/analytics/report/payload-builder.ts` — add fallback derivation inside `buildPayload()`.
2. `src/cli/commands/analytics/index.ts` — `parseFilterOptions()` sets `filter.toDate = new Date()` for `--last`.
3. `src/agents/core/BaseAgentAdapter.ts` — `maybeWriteSessionReport()` ConfigLoader fallback for `userEmail`.
4. `src/cli/commands/analytics/report/__tests__/payload-builder.test.ts` — new fallback cases.
5. `src/cli/commands/analytics/__tests__/analytics-cli-metadata.test.ts` — new cases for `--last`, `--session`, `--project/--branch`, bare.
6. `src/agents/core/__tests__/` (existing suite for BaseAgentAdapter) — new case for ConfigLoader userEmail fallback (only if the harness allows testing this without heavy scaffolding; otherwise cover via a `session-report.test.ts` case where ConfigLoader is mocked).

Approximate diff: ~40 lines of production code + ~120 lines of test code.

## Tests (Vitest)

Following the existing `analytics-cli-metadata.test.ts` and `payload-builder.test.ts` conventions (inline `vi.fn()` mocks, dynamic-import mock pattern).

### `payload-builder.test.ts`

- Given `ctx.periodStart` defined → meta.periodStart equals `ctx.periodStart` (regression guard).
- Given `ctx.periodStart` undefined and records with `startTime > 0` → meta.periodStart equals ISO of `min(startTime)`.
- Given `ctx.periodEnd` undefined and records with `durationMs > 0` → meta.periodEnd equals ISO of `max(startTime + durationMs)`.
- Given `ctx.periodEnd` undefined and records where all have `durationMs === 0` → meta.periodEnd equals ISO of `max(startTime)`.
- Given zero records (empty analytics) → meta.periodStart and meta.periodEnd are OMITTED.
- Given records where some have `startTime <= 0` (defensive guard) → those are skipped from the min/max.

### `analytics-cli-metadata.test.ts`

For each of `--last 7d`, `--session <id>`, `--project X --branch Y`, and bare invocation:

- meta.userEmail is present (from mocked ConfigLoader).
- meta.periodStart is present.
- meta.periodEnd is present.

Also add a targeted test for `parseFilterOptions()` internals (or a spy on the `buildPayload` context argument) confirming that `--last` produces both `fromDate` and `toDate`.

### `BaseAgentAdapter` / `session-report.test.ts`

- Given `CODEMIE_PROFILE_CONFIG` unset and `ConfigLoader.loadMultiProviderConfig` returns `{ userEmail: 'x@y' }` → generated session report has `meta.userEmail === 'x@y'`.
- Given both sources fail → `meta.userEmail` is omitted (existing behavior; regression guard).

## Acceptance

- All four failing modes now produce reports with populated `meta.userEmail`, `meta.periodStart`, `meta.periodEnd`.
- `--from/--to` behavior unchanged (regression-guarded).
- All new tests green under `npm run test`.
- `npm run lint`, `npm run typecheck`, `npm run build` all clean.
- No changes to CLI help text or exit codes.
