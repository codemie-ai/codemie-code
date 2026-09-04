# Technical Research

**Task**: metrics analytics token anthropic
**Generated**: 2026-09-03T00:00:00Z
**Research path**: codegraph

---

## 1. Original Context

Implement the story "Anthropic-Subscription Live Metrics Token Propagation" — extend MetricDelta (src/agents/core/metrics/types.ts) and each agent's metrics processor that writes it (especially claude.metrics-processor.ts) to actually capture token usage per turn (input/output counts) — today claude.metrics-processor.ts reads msg.message.usage only to detect a completed stream chunk (messages.find(m => m.message?.usage)) and discards the actual counts. Then add backend-agreed token fields to the live /v1/metrics payload types (SessionLifecycleAttributes, ToolUsageAttributes in metrics-types.ts) for anthropic-subscription sessions, propagated through MetricsApiClient.sendRequest and MetricsSender (sendSessionEnd / tool-usage sender). Constraints: cost must NEVER be computed or sent by the client (server-side only, same pattern as Codex per .ai-run/guides/integration/external-integrations.md "Codex Cost & Metrics"); changes must be additive/non-breaking for other providers (ToolUsageAttributes currently has a `never`-typed banned tool_counts field with a NOTE: No token fields comment — backend is known to silently drop payloads containing unrecognized fields); a missing/empty local metrics-delta file must not fail session-end sync, tokens should just be omitted/zeroed. Also verify whether an empty CODEMIE_API_KEY (set by anthropic-subscription.exportEnvVars) affects whether MetricsApiClient sends these new token fields.

---

## 2. Codebase Findings

### Existing Implementations

- `src/agents/core/metrics/types.ts` — `MetricDelta` interface (line 41), the JSONL delta record shape. Currently carries `tools`, `toolStatus`, `fileOperations`, `models`, `userPrompts`, `skillInvocations`/`agentInvocations`/`commandInvocations`, `apiErrorMessage`, sync bookkeeping. **No token fields exist today.**
- `src/agents/plugins/claude/session/processors/claude.metrics-processor.ts` — `MetricsProcessor` (implements `SessionProcessor`, priority 1). `extractDeltasFromMessages` (line 153) groups streaming JSONL chunks by `message.id` into `messageGroups`, then `processDelta` (line 257) does `const completedMsg = messages.find(m => m.message?.usage)` (line 264) purely to detect a completed turn and pull `model`; the `usage` object's contents (`input_tokens`, `output_tokens`, cache fields per Anthropic's SDK shape) are never read into the emitted delta.
- `src/providers/plugins/sso/session/processors/metrics/metrics-types.ts` — `SessionLifecycleAttributes` (line 25, for `codemie_cli_session_total`) and `ToolUsageAttributes` (line 82, for `codemie_cli_tool_usage_total`). `ToolUsageAttributes` has `tool_counts?: never` (line 97) with an explicit comment "NOTE: No token fields" (line 80) — the ban is enforced at the type level because the backend/Elastic pipeline silently drops documents containing unrecognized/dict-shaped fields.
- `src/providers/plugins/sso/session/processors/metrics/MetricsWriter.ts` — `appendDelta`/`readAll` for the per-session `{sessionId}_metrics.jsonl`. `readAll()` (line 62) already returns `[]` when the file does not exist (`existsSync` guard, line 64) — a missing metrics-delta file is already tolerated at this layer without throwing.
- `src/providers/plugins/sso/session/processors/metrics/metrics-aggregator.ts` — `aggregateDeltas`/`buildSessionAttributes` (periodic "tool usage" sync path). Iterates `MetricDelta[]` grouped by branch, accumulates `toolCounts`, `toolStatus`, file ops, model counts, user prompts, errors into a `ToolUsageAttributes` object (lines 233-265). No token accumulation exists; would need a new accumulator (e.g. `inputTokens`/`outputTokens` running totals) parallel to the existing ones if deltas start carrying tokens.
- `src/providers/plugins/sso/session/processors/metrics/metrics-api-client.ts` — `MetricsApiClient` (private `sendRequest`, line 108) builds the debug-log projection of `metric.attributes` field-by-field (lines 116-147) and does `JSON.stringify(metric)` (line 110) as the actual POST body — the body always includes whatever is on the `attributes` object; the debug-log projection is a separate allow-list that would also need updating for visibility but does not gate what is sent. `MetricsSender` (line 306) wraps the client and exposes `sendSessionEnd` (line 489, builds `SessionLifecycleAttributes`) and `sendSessionMetric` (line 585, forwards an already-built `SessionMetric`, used by the tool-usage aggregator path).
- `src/providers/plugins/sso/session/processors/metrics/metrics-sync-processor.ts` — `MetricsSyncProcessor.process` (periodic/incremental "tool usage" sender): loads pending deltas, calls `aggregateDeltas`, writes them back via `writeJSONLAtomic`, then `sender.sendSessionMetric(...)` for each branch metric. This is the "tool-usage sender" referenced in the task.
- `src/cli/commands/hook.ts` — `handleSessionEnd` (line 209) → `sendSessionEndMetrics` (line 1187, the session-end sender referenced in the task). This function loads `Session` via `SessionStore` and calls `sender.sendSessionEnd(...)` with `wallClockDurationMs` and `session.activeDurationMs`. **It does not currently read the metrics-delta JSONL file at all** — no `MetricsWriter` import/usage here — so any token totals surfaced in `SessionLifecycleAttributes` at session end would be new logic that reads `MetricsWriter(sessionId).readAll()` (or equivalent) and sums per-delta token fields; that read must tolerate the file being absent/empty exactly as `MetricsWriter.readAll()` already does.
- `src/telemetry/runtime/DesktopTelemetryRuntime.ts` — `sendSessionEndMetric` (line 274) is a second, independent caller of the same `MetricsSender.sendSessionEnd` (desktop/local-telemetry discovery path, not the `codemie hook` flow). Any signature change to `sendSessionEnd` affects both call sites.
- `src/providers/plugins/anthropic-subscription/anthropic-subscription.template.ts` — `exportEnvVars` (line 109) unconditionally sets `CODEMIE_API_KEY: ''` (line 113) with an explanatory comment: native Claude subscription auth relies on Claude Code's own stored login, and `beforeRun` (line 36) actively deletes `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL` from the spawned process's env. This provider still reuses the Claude Code plugin's hooks (`installer.install()`, line 76) so local metrics/conversation JSONL files are produced even though model traffic is not proxied through CodeMie — i.e. the local `claude.metrics-processor.ts` → `MetricsWriter` → session-end/tool-usage sender pipeline runs the same way for anthropic-subscription sessions as for SSO/JWT sessions.

### Architecture and Layers Affected

- **Core metrics types** (`src/agents/core/metrics/types.ts`) — `MetricDelta` shape.
- **Agent plugin / session processor layer** (`src/agents/plugins/claude/session/processors/claude.metrics-processor.ts`, and by the same pattern the other agents' metrics processors — `gemini.metrics-processor.ts`, `kimi.metrics-processor.ts`, `codex.metrics-processor.ts`, `pi.metrics-processor.ts`, `opencode.metrics-processor.ts` — all implement `SessionProcessor` and write `MetricDelta`s via the shared `MetricsWriter`).
- **Provider/SSO metrics transport layer** (`src/providers/plugins/sso/session/processors/metrics/`: `metrics-types.ts`, `metrics-api-client.ts` (`MetricsApiClient`, `MetricsSender`), `metrics-aggregator.ts`, `metrics-sync-processor.ts`, `MetricsWriter.ts`).
- **Provider template layer** (`src/providers/plugins/anthropic-subscription/anthropic-subscription.template.ts` — `exportEnvVars`, `agentHooks`).
- **CLI hook layer** (`src/cli/commands/hook.ts` — `handleSessionEnd`/`sendSessionEndMetrics`).
- **Desktop telemetry runtime layer** (`src/telemetry/runtime/DesktopTelemetryRuntime.ts` — shares `MetricsSender.sendSessionEnd`).

### Integration Points

- `claude.metrics-processor.ts` → `MetricsWriter.appendDelta` (writes `MetricDelta` JSONL).
- `MetricsSyncProcessor.process` → `MetricsWriter`/`aggregateDeltas` → `MetricsSender.sendSessionMetric` → `MetricsApiClient.sendMetric` → `sendRequest` (POST `/v1/metrics`, `CODEMIE_ENDPOINTS.METRICS`).
- `hook.ts:sendSessionEndMetrics` and `DesktopTelemetryRuntime.sendSessionEndMetric` both → `MetricsSender.sendSessionEnd` → same `MetricsApiClient.sendMetric`/`sendRequest`.
- `MetricsApiClient` constructor (line 52) folds `apiKey`/`cookies` into `Required<MetricsApiConfig>`; `sendRequest` (lines 150-164) sets header `user-id` when `this.config.apiKey` is truthy, else `Cookie` when `this.config.cookies` is truthy, else neither. The request **body** (`JSON.stringify(metric)`, line 110) is built independently of which auth branch is taken — an empty `apiKey` does not remove or gate any attribute field, it only removes the `user-id` header. For `anthropic-subscription` sessions specifically, `exportEnvVars` sets `CODEMIE_API_KEY: ''`; whether metrics requests authenticate successfully then depends entirely on whether SSO `cookies` are separately available (via `CodeMieSSO().getStoredCredentials`) — if neither is present, `authMode` logs as `'none'` and the backend may reject with 401/403 (handled generically as `isAuthFailure`), which is an auth/delivery concern, not a payload-shape concern.

### Patterns and Conventions

- Every metrics processor implements `SessionProcessor` (`shouldProcess`/`process`) from `src/agents/core/session/BaseProcessor.ts` and is invoked either directly (message-transform mode) or via `SessionSyncer`/`MetricsSyncProcessor` (sync mode, using an empty `ParsedSession.messages` to force pending-JSONL processing — see `SessionSyncer.sync`, line 125).
- `ToolUsageAttributes.tool_counts?: never` is the established pattern for "banned field the backend silently drops" — any new token fields should follow the same additive, backend-agreed, explicitly-typed approach (plain optional numeric fields, not dict/map shapes) rather than reintroducing a banned shape.
- Codex's cost/metrics split (`.ai-run/guides/integration/external-integrations.md`, "Codex Cost & Metrics") is the explicit precedent cited by the task: cost is always server-computed from `cost_config`, the CLI only ever sends usage/lifecycle facts, never `money_spent`.
- `v2` schema fields across both attribute interfaces use `schema_version?: number` plus parallel arrays (`error_tools`/`error_messages`) instead of dict-shaped fields — same rationale (ES/backend rejects unbounded-key dicts) that produced the `tool_counts: never` ban.
- Missing-file tolerance pattern: `MetricsWriter.readAll()` returns `[]` on `!existsSync(this.filePath)` rather than throwing; `metrics-sync-processor.ts`/`SessionSyncer.sync` are built around that no-op-when-empty contract already.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/integration/external-integrations.md` — "Codex Cost & Metrics" section (lines 213-227) is the explicit precedent named by the task: two pipelines (CLI tool/lifecycle → `POST /v1/metrics`; LLM proxy traffic → `codemie_litellm_proxy_usage`), cost always computed server-side, CLI never sends `money_spent`.
- Same guide's Task Classifier (in `AGENTS.md`) maps `session`, `metrics`, `analytics` keywords to the `architecture` P0 guide and `external-integrations` P1 guide — both were consulted.
- No guide file specifically documents the anthropic-subscription provider's metrics behavior beyond the general "provider template" pattern; its native-auth quirks were derived from source (`anthropic-subscription.template.ts`).

### Architectural Decisions

- Inline code comments in `metrics-types.ts` (lines 80, 92-95) record the decision to ban `tool_counts` (dict field) and omit token fields — both because the backend/Elastic pipeline "accepts the request but drops documents containing that field." This is the binding constraint for how any new token fields must be shaped (flat optional numeric fields, not maps).
- `SessionSyncer.sync` inline comment (lines 101-103) records the "central ingestion gate" decision: a confirmed external-resume session must never sync anything, referenced as `EPMCDME-12992`.

### Derived Conventions

- New attribute fields are added as flat optional properties on `SessionLifecycleAttributes`/`ToolUsageAttributes`, guarded with `schema_version` bumps only when the shape materially changes (current `schema_version: 2` covers the v2 parallel-array error fields; adding new optional numeric fields is additive and would not by itself require a version bump, matching how `active_duration_ms` was added as a plain optional field without touching `schema_version`).
- Optional fields are spread conditionally into attribute-building object literals (`...(x !== undefined && { field: x })`) rather than always present with a zero default — see `active_duration_ms` in `sendSessionEnd` (line 517) and the error-array fields in `buildSessionAttributes` (lines 268-273).

---

## 4. Testing Landscape

### Existing Coverage

- `src/agents/plugins/claude/session/processors/__tests__/claude.metrics-processor-clear.test.ts` and `claude.metrics-processor-names.test.ts` cover `MetricsProcessor` but not token/usage extraction — codegraph reports no covering tests for `extractDeltasFromMessages`'s usage-handling path specifically.
- `src/providers/plugins/sso/session/processors/metrics/__tests__/metrics-upload-contract.test.ts` covers `MetricsSender` (including `sendSessionEnd`).
- `tests/integration/session/metrics-processor.test.ts`, `tests/integration/session/orchestrator/unified-plugin.test.ts` cover `MetricsWriter`.
- `tests/integration/metrics/metrics-post-processing.test.ts`, `tests/integration/session/opencode-metrics-basic.test.ts` cover `aggregateDeltas`.
- `src/providers/plugins/anthropic-subscription/__tests__/anthropic-subscription.setup-steps.test.ts` and `anthropic-subscription.template.test.ts` cover the provider template, including presumably `exportEnvVars`.

### Testing Framework and Patterns

- Vitest, per `.ai-run/guides/testing/testing-patterns.md` (not re-read in full here; guide-first policy already satisfied by reading `external-integrations.md` for the domain-specific pattern named by the task).

### Coverage Gaps

- `MetricsApiClient` (constructor, `sendRequest`) — codegraph flags "no covering tests found" directly, though it is exercised indirectly via `metrics-upload-contract.test.ts` through `MetricsSender`.
- `SessionLifecycleAttributes`/`ToolUsageAttributes` interfaces themselves — no direct type-contract tests found (flagged by codegraph).
- `buildSessionAttributes` in `metrics-aggregator.ts` — no direct unit test found (flagged by codegraph); only exercised via `aggregateDeltas` integration tests.
- `hook.ts:sendSessionEndMetrics` — no test file found for this specific function; it is the session-end call site the task requires reading token totals into, currently untested for that behavior because the behavior does not exist yet.
- No test exists exercising `claude.metrics-processor.ts`'s `msg.message.usage` value being read (as opposed to merely checked for truthiness) — confirms the task's premise that the counts are currently discarded, untested because unimplemented.

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_API_KEY` — set to `''` unconditionally by `anthropic-subscription.template.ts:exportEnvVars` (line 113); consumed by `MetricsApiConfig.apiKey` / `MetricsApiClient` header selection (`user-id` header only sent when truthy).
- `CODEMIE_URL`, `CODEMIE_SYNC_API_URL`, `CODEMIE_PROJECT` — also set conditionally by the same `exportEnvVars` when `config.codeMieUrl`/`config.codeMieProject` are present.
- `CODEMIE_MODEL`, `CODEMIE_HAIKU_MODEL`, `CODEMIE_SONNET_MODEL`, `CODEMIE_OPUS_MODEL` — blanked (`''`) by the same function since this provider has no CodeMie model catalog to resolve against.
- `CODEMIE_CLIENT_TYPE`, `CODEMIE_CLI_VERSION`, `CODEMIE_PROVIDER`, `CODEMIE_AGENT` — read by `hook.ts:sendSessionEndMetrics` via `getConfigValue` to build the `MetricsSender`.

### Configuration Files

- No dedicated config file for metrics token fields; behavior is driven entirely by env vars threaded through `ProcessingContext`/`MetricsApiConfig`/`MetricsSenderOptions`.
- `WorkspaceConfig.metrics` (`src/env/types.ts`, lines 135-143) holds `enabled`/`sync.enabled`/`sync.interval`/`sync.maxRetries`/`sync.dryRun` — governs whether/how often the tool-usage sync path runs, not the payload shape.

### Feature Flags and Deployment Concerns

- `dryRun` (constructor option on `MetricsSender`/config on `WorkspaceConfig.metrics.sync`) — when true, both `sendSessionEnd` and `sendSessionMetric` log the would-be payload and skip the network call; any new token fields must be added to these dry-run log projections too for parity, though this is a logging nicety, not a functional requirement.
- No feature flag currently gates whether token fields would be included per-provider; the task requires the fields to be additive so no gating is architecturally necessary, but the constraint that "changes must be additive/non-breaking for other providers" implies the same `SessionLifecycleAttributes`/`ToolUsageAttributes` fields would end up populated (or zero/omitted) for every agent, not scoped to anthropic-subscription specifically, since the type is shared across all providers/agents.

---

## 6. Risk Indicators

- The backend is documented (inline comment, `metrics-types.ts:80,92-95`) to **silently drop entire payloads** containing unrecognized/dict-shaped fields — any new token field must be pre-agreed with the backend schema and shaped as flat optional numbers, not a map; getting this wrong causes silent metric loss with no client-side error, which is very hard to detect after the fact.
- `hook.ts:sendSessionEndMetrics` currently has **zero visibility into per-turn token data** — it never touches `MetricsWriter`/the deltas file. Adding token totals to `SessionLifecycleAttributes` requires new logic here (reading and summing deltas) that does not exist today; this is a genuine new code path, not a wiring change, and increases the file-change surface beyond the three files the task names.
- `claude.metrics-processor.ts`'s `processDelta` groups multiple streaming JSONL chunks per `message.id` (lines 244-254) and finds "the completed message" via `messages.find(m => m.message?.usage)` — Claude's Anthropic API `usage` object shape (input/output/cache-read/cache-write token fields) is read from `completedMsg.message.usage`, which is untyped (`any`) in this processor; confirming the exact field names present in the raw JSONL (e.g. `input_tokens` vs `cache_creation_input_tokens`) needs source verification against a live transcript sample, not assumed from the Anthropic SDK docs alone, since `ParsedSession.metrics.tokens` (in `BaseSessionAdapter.ts`) already models a `{ input, output, cacheRead?, cacheWrite? }` shape — worth checking for reuse/consistency.
- `ToolUsageAttributes`/`SessionLifecycleAttributes` and `MetricsApiClient`/`buildSessionAttributes` have **no direct unit tests** (flagged "no covering tests found" for all four); a change here is more likely to regress silently, and any change should add coverage even though the project's testing policy is "only on explicit request" — flag this discrepancy for the requester before implementation.
- The `metrics-aggregator.ts:buildSessionAttributes` function has no token accumulation logic and no per-branch summation todo for tokens; adding this requires new local accumulator variables mirroring `toolCounts`/`modelCounts`, a genuinely new code path in an already dense function (335 lines).
- `MetricsApiClient.sendRequest`'s debug-log field allow-list (lines 116-147) is separate from the actual POST body; a token-field change could ship correctly in the wire payload while leaving debug logs blind to it (or vice-versa if only the log allow-list is touched) — both spots need updating together.
- `DesktopTelemetryRuntime.sendSessionEndMetric` is a second caller of `MetricsSender.sendSessionEnd` outside the `codemie hook` flow (local/desktop-discovered sessions, e.g. Claude Desktop); any signature change to `sendSessionEnd` (e.g. adding a token-totals parameter) must account for this second call site, which does not currently pass or have access to per-delta token data either.
- Empty-`CODEMIE_API_KEY` risk: confirmed that an empty `apiKey` only affects the `user-id` auth header selection in `MetricsApiClient.sendRequest`, not the request body/attribute fields — so it does **not** gate whether token fields are sent. However, for anthropic-subscription specifically, if SSO `cookies` are also unavailable, `authMode` is `'none'` and the whole request may be rejected by the backend (401/403), which would silently drop the *entire* metric (tokens included) for reasons unrelated to the token feature itself — worth flagging as a pre-existing, orthogonal risk rather than something this task should attempt to fix.
- No guide or ADR documents the exact backend-agreed field names for token attributes (e.g. `input_tokens`/`output_tokens` vs `prompt_tokens`/`completion_tokens`) — the task says "backend-agreed token fields" but no such agreement is discoverable in this repository; this must come from the spec/ticket or an explicit conversation with the backend team, not invented here.

---

## 7. Summary for Complexity Assessment

This task touches five architectural layers: the core metrics type (`MetricDelta` in `src/agents/core/metrics/types.ts`), one agent-plugin session processor (`claude.metrics-processor.ts`, with five sibling processors following the identical pattern but not named by the task), the provider/SSO metrics transport layer (`metrics-types.ts`, `metrics-api-client.ts`, `metrics-aggregator.ts`, `metrics-sync-processor.ts`), the CLI hook layer (`hook.ts:sendSessionEndMetrics`, which has no existing per-delta read path and needs new logic added), and the anthropic-subscription provider template (verification-only, no code change expected per current findings). The file-change surface named explicitly by the task (four files) understates the real surface once `hook.ts`'s missing token-read path and `metrics-aggregator.ts`'s missing token-accumulation logic are accounted for.

Technical novelty is low for the wire-protocol mechanics (JSON body construction, optional-field spreading, and the missing-file-tolerance pattern all have direct precedent in the codebase — `active_duration_ms` and the v2 error-array fields are close analogues) but is non-trivial for the actual Anthropic `usage` object shape, which is read as `any` today and has never been typed or tested in this processor; the exact field names to extract need source verification against a live transcript, not assumption. The `tool_counts: never` ban and its documented "backend silently drops unrecognized-field payloads" behavior is the dominant risk: an incorrectly shaped or unagreed field name causes silent, undetectable metric loss rather than a visible error.

Test coverage posture is weak across every symbol this task touches directly (`MetricsApiClient`, `SessionLifecycleAttributes`/`ToolUsageAttributes`, `buildSessionAttributes`, and the `claude.metrics-processor.ts` usage-extraction path all show "no covering tests found"), and the one new code path this task requires — reading token totals into `hook.ts:sendSessionEndMetrics` — has no existing structure to extend, it must be written from scratch. Key risk factors: (1) the backend field-name agreement is undiscoverable in-repo and must come from the ticket/spec, not be invented; (2) a second caller of `MetricsSender.sendSessionEnd` (`DesktopTelemetryRuntime`) is affected by any signature change and easy to miss; (3) the empty-`CODEMIE_API_KEY` behavior for anthropic-subscription is orthogonal to the token feature (it affects auth-header selection and whole-request delivery, not payload shape) and should not be conflated with the token propagation work itself.

---

## 8. External References

None named by the task. The only source-of-truth reference the task names — `.ai-run/guides/integration/external-integrations.md`, "Codex Cost & Metrics" — is inside the repository and was read directly; its relevant facts are captured in Sections 2 and 3 above (server-side-only cost computation, CLI never sends `money_spent`, two-pipeline pattern keyed by `session_id`).
