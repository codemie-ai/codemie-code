# Anthropic-Subscription Live Metrics Token Propagation

## Overview

`claude.metrics-processor.ts` already scans each assistant message group for
`message.usage` to detect a completed streaming turn (`processDelta`,
`claude.metrics-processor.ts:257-268`), but discards the usage object once
found. This change captures the token counts from that same object into
`MetricDelta`, then threads accumulated totals through the existing
tool-usage (periodic) and session-end (lifecycle) sync paths into the live
`/v1/metrics` payload, as two new flat, optional, backend-facing field
groups. No cost/money value is ever computed or sent — token counts are raw
usage facts; pricing stays server-side, matching the Codex pattern
(`.ai-run/guides/integration/external-integrations.md`, "Codex Cost &
Metrics").

The new fields populate for every session that uses the `claude` agent
(SSO, JWT, and anthropic-subscription alike) — there is no
`provider === 'anthropic-subscription'` gate anywhere in this change. No
existing provider-conditional branch exists in this transport layer today,
and none is introduced by this task; token counts are non-monetary and
harmless to emit redundantly for providers that already get cost data via
proxied LiteLLM usage.

## Data shapes

`MetricDelta` (`src/agents/core/metrics/types.ts:41-97`) gains one optional
nested field, following the existing camelCase/nested-object convention
already used by `fileOperations` and `toolStatus`:

```ts
tokens?: {
  input: number;
  output: number;
  cacheRead?: number;
  cacheCreation?: number;
};
```

This is the local per-turn JSONL record — not the wire payload — so the
backend's "no dict-shaped fields" ban does not apply here.

`SessionLifecycleAttributes` and `ToolUsageAttributes`
(`src/providers/plugins/sso/session/processors/metrics/metrics-types.ts:25-108`)
each gain the same four flat, optional, snake_case numeric fields — the
proposed backend-facing naming convention, since no in-repo backend
agreement exists today:

```ts
input_tokens?: number;
output_tokens?: number;
cache_read_tokens?: number;
cache_creation_tokens?: number;
```

Names are shortened from Anthropic's raw `cache_read_input_tokens` /
`cache_creation_input_tokens` to match the flat-numeric naming style already
used by fields like `total_lines_added`. No `schema_version` bump — these
are purely additive optional numbers, the same category of change as the
earlier `active_duration_ms` addition.

## Capture: claude.metrics-processor.ts

In `processDelta`, once `completedMsg` is found (`claude.metrics-processor.ts:264`),
read `completedMsg.message.usage.input_tokens`, `.output_tokens`,
`.cache_read_input_tokens`, and `.cache_creation_input_tokens`, and populate
the new `MetricDelta.tokens` field. This exact usage-object shape is already
parsed elsewhere in this codebase for local cost reporting
(`src/cli/commands/analytics/cost/usage-readers.ts:55-61`), which confirms
the real field names against live transcript data without needing a fresh
sample. Only `claude.metrics-processor.ts` changes in this task; the five
sibling processors are untouched (see Non-goals).

## Propagation: tool-usage sync (incremental)

`metrics-aggregator.ts:buildSessionAttributes` (accumulation block around
lines 233-265) gains a token accumulator parallel to the existing
`toolCounts`/file-op accumulators, summing `delta.tokens` across the same
per-branch, per-sync-window set of pending deltas already used for tool and
file metrics. The four `ToolUsageAttributes` token fields are therefore
incremental-since-last-sync totals, consistent with how tool/file counts
already behave in this metric. Fields are spread onto the attributes object
only when a total is non-zero/defined, matching the existing
`...(x !== undefined && { field: x })` convention used for the v2
error-array fields.

## Propagation: session-end (cumulative)

`hook.ts:sendSessionEndMetrics` (~line 1187-1274) currently never touches
per-delta metrics at all. This task adds a read path: instantiate the same
`MetricsWriter` used elsewhere for the session, call `readAll()`, and sum
`delta.tokens` across every row regardless of `syncStatus` (session-end
wants the whole-session total, not just unsynced deltas). `readAll()`
already returns `[]` when the delta file is missing
(`MetricsWriter.ts:62-64`), so a missing/empty file yields zeroed/omitted
token fields rather than a sync failure — no new error handling is needed
beyond relying on this existing tolerance.

The summed totals are passed into `MetricsSender.sendSessionEnd`
(`metrics-api-client.ts:489-538`) as new optional trailing parameters,
mirroring the existing `activeDurationMs?: number` precedent at the same
call site, and spread into the built `SessionLifecycleAttributes` only when
defined — same pattern as `active_duration_ms` (line 517).
`DesktopTelemetryRuntime.sendSessionEndMetric`
(`DesktopTelemetryRuntime.ts:274-296`), the second caller of
`sendSessionEnd`, simply omits the new optional parameters: it has no
per-delta token data available and needs no code change beyond staying
source-compatible with the new (optional) signature.

## Debug logging and dry-run parity

`MetricsApiClient.sendRequest`'s debug-log field allow-list
(`metrics-api-client.ts:116-147`) and `MetricsSender`'s dry-run log
projections must both list the four new fields alongside the actual POST
body, so debug/dry-run visibility stays in sync with what is actually sent.

## Acceptance Criteria

- `MetricDelta` has an optional `tokens` field with the shape above; existing processors that don't populate it are unaffected (field stays `undefined`).
- `claude.metrics-processor.ts` populates `tokens` (input/output/cacheRead/cacheCreation) from `completedMsg.message.usage` for every completed assistant turn where usage is present.
- `SessionLifecycleAttributes` and `ToolUsageAttributes` each carry the four new flat optional numeric fields; no dict/map-shaped field is introduced anywhere in the wire payload.
- `ToolUsageAttributes` token fields reflect incremental (since-last-sync) totals; `SessionLifecycleAttributes` token fields reflect whole-session cumulative totals.
- A missing or empty per-session metrics-delta file results in omitted/zero token fields at session-end, never a thrown error or failed sync.
- `MetricsSender.sendSessionEnd`'s new parameters are optional; `DesktopTelemetryRuntime.sendSessionEndMetric` compiles and runs unchanged.
- No code path in this change computes or transmits a monetary/cost value.
- Debug-log and dry-run log projections include the four new fields.
- Populated fields appear identically for `claude`-agent sessions regardless of provider (SSO, JWT, anthropic-subscription) — no provider-conditional branch is introduced.

## Non-goals

- No `provider === 'anthropic-subscription'` gate anywhere — token fields populate for all `claude`-agent sessions by design (explicit override of the story's title framing).
- No cost, price, or `money_spent` computation or transmission by the client, under any circumstance — cost stays server-side only.
- No changes to `gemini.metrics-processor.ts`, `kimi.metrics-processor.ts`, `codex.metrics-processor.ts`, `pi.metrics-processor.ts`, or `opencode.metrics-processor.ts` in this task — token capture is scoped to `claude.metrics-processor.ts` only.
- No `schema_version` bump on either attributes interface — these fields are purely additive optional numbers, not a shape migration.
- No new backend-schema negotiation process or ticket — the field names proposed here are this spec's deliverable, pending downstream backend review.
