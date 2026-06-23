# Technical Research

**Task**: analytics codex report native-loader usage-readers dispatch-extractor
**Generated**: 2026-06-23T00:00:00.000Z
**Research path**: filesystem

---

## 1. Original Context

Add full Codex analytics parity to `codemie analytics --report`, matching Claude Code coverage: native session discovery, token/cost pricing, per-turn cost series, dispatch timeline (agents/skills), skill/agent/command invocation charts.

Repository: /Users/Vadym_Vlasenko/AI/projects/codemie-code

Key context already known:
- `src/cli/commands/analytics/native-loader.ts` only discovers `claude` native logs; codex missing
- `src/cli/commands/analytics/cost/usage-readers.ts` returns empty for codex
- `src/cli/commands/analytics/cost/dispatch-extractor.ts` is Claude-shaped (tool_use/tool_result)
- Codex rollout files at ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
- Codex adapter exists: `src/agents/plugins/codex/codex.session.ts` with discoverSessions + parseSessionFile but metrics empty at parse time
- Codex events: token_count (total_token_usage, last_token_usage), spawn_agent/wait_agent, collab_agent_spawn_end/collab_waiting_end, function_call (exec_command, apply_patch), turn_context.model
- Skills invoked via exec_command reading paths like .../skills/{name}/SKILL.md
- Subagents spawn separate rollout files (new_thread_id in filename)

---

## 2. Codebase Findings

### Existing Implementations

**Analytics pipeline entry (`src/cli/commands/analytics/index.ts`)**
- Loads CodeMie-tracked sessions via `MetricsDataLoader`, then merges native sessions from `loadNativeSessions()` when `--scan-native` is enabled (default).
- For `--report`, runs `enrichCosts()` **before** aggregation so zero-delta sessions with recoverable token usage are retained.
- Report payload built by `report/payload-builder.ts` from aggregated analytics + `SessionCostIndex`.

**Native discovery gap (`src/cli/commands/analytics/native-loader.ts`)**
- `NATIVE_AGENTS = ['claude']` — Codex is excluded despite `CodexSessionAdapter.discoverSessions` existing.
- Uses `AgentRegistry.getAgent(agentName)?.getSessionAdapter()` for discover + parse.
- `synthesizeRawSession()` is Claude-transcript-shaped:
  - `firstUserText()` expects `message.role === 'user'` with string/array text blocks — Codex rollouts use `event_msg.user_message` and `response_item` with `role: "user"` nested under `payload`.
  - `isAssistant()` checks `type === 'assistant'` or `message.role === 'assistant'` — Codex uses `response_item` with `payload.role === 'assistant'`.
  - `stripClear()` is Claude `/clear` sentinel handling (imported from claude plugin).
  - Carries `parsed.metrics.*` onto first delta including `skillInvocations`, `agentInvocations`, `commandInvocations` — but Codex `parseSessionFile` returns empty invocation maps.

**Cost enrichment (`src/cli/commands/analytics/cost/cost-enricher.ts`)**
- Resolves native log via `raw.agentSessionFile` (native-discovered) or `~/.codemie/sessions/{id}.json` correlation.
- `gatherDedupedUsageRecords()` → per-turn `costSeries`; `gatherUsageDeduped()` → session totals.
- `extractDispatchEvents(parsed)` called for every parsed session; `enrichDispatchCosts()` hardcodes `'claude'` when pricing subagent transcripts.

**Token usage readers (`src/cli/commands/analytics/cost/usage-readers.ts`)**
- Supported agents: `claude`, `claude-acp`, `claude-desktop`, `gemini`, `kimi`.
- Explicit fallthrough for codex: `gatherUsageDeduped` line ~339 returns `new Map()`; `gatherDedupedUsageRecords` returns `[]` for non-claude/kimi.
- Claude pattern: per-assistant-message `usage` blocks + optional SDK `result.modelUsage` rollup.
- Kimi pattern: `usage.record` events — closest analogue to Codex per-turn metering.

**Dispatch extractor (`src/cli/commands/analytics/cost/dispatch-extractor.ts`)**
- Walks Claude `tool_use` / `tool_result` blocks for `Agent`/`Task`/`Skill` tools.
- Slash commands via `<command-name>` / `<command-message>` XML in user text.
- Skips `isSidechain === true` messages.
- No Codex `function_call` (`spawn_agent`, `wait_agent`) or `collab_*` event handling.

**Codex session adapter (`src/agents/plugins/codex/codex.session.ts`)**
- `discoverSessions()`: 4-level traversal of `~/.codex/sessions/YYYY/MM/DD/`, mtime age filter, UUID from filename regex `rollout-.*-{uuid}.jsonl`.
- `parseSessionFile()`: tolerant JSONL read; extracts `session_meta`, last `turn_context` for model; returns `messages: records` (full rollout lines).
- Returns stub metrics: `{ tools: {}, toolStatus: {}, fileOperations: [] }` — no tools, tokens, or named invocations at parse time.
- **No `subagents` discovery** — unlike `claude.session.ts` which scans `{sessionId}/subagents/agent-*.jsonl` and attaches `toolUseId` from `.meta.json`.
- Processors (`CodexMetricsProcessor`, `CodexConversationsProcessor`) run on `processSession()` path (CodeMie-tracked sync), not on analytics re-parse.

**Codex metrics processor (`src/agents/plugins/codex/session/processors/codex.metrics-processor.ts`)**
- Extracts `function_call` / `function_call_output` pairs by `call_id`.
- Writes per-call `MetricDelta` to `MetricsWriter` — intentionally omits tokens ("Codex rollout files do not carry per-call usage" — outdated relative to `token_count` events).
- Tool names lowercased: `exec_command`, `apply_patch`, etc.

**Codex message types (`src/agents/plugins/codex/codex-message-types.ts`)**
- `CodexRolloutRecord.type`: `session_meta | turn_context | response_item | event_msg`.
- `CodexEventMsg` typed minimally (`user_message`); missing types for `token_count`, `task_started`, `task_complete`, `spawn_agent`, collab events.
- `CodexTurnContext` has `model`, `turn_id` (present in fixtures, not in interface).

**Claude reference implementation (`src/agents/plugins/claude/claude.session.ts` + `claude-named-invocations.ts`)**
- `extractMetrics()` at parse time: tools, file ops, `extractNamedInvocations()`.
- Subagent files discovered and attached to `parsed.subagents` for cost/dispatch enrichment.
- Shared `extractNamedInvocations()` used by both live metrics processor and native analytics re-parse.

**Pricing (`src/cli/commands/analytics/cost/pricing.json`, `pricing.ts`)**
- Table already includes OpenAI/Codex models: `gpt-5-*-codex`, `o3`, `o4-mini`, `codex-mini`, etc.
- Keys use dashes not dots (`gpt-5-4` not `gpt-5.4`); `normalizeModelName()` does not dot→dash — pricing lookup may need extension or models must be normalized before lookup (verify against `lookupPrice` implementation).

**Integration fixtures (`tests/integration/session/fixtures/codex/`)**
- `turn-1.jsonl`, `turn-2.jsonl`: realistic rollout with `turn_context.model`, `token_count` (null info then populated), `task_started`/`task_complete`, multi-turn.
- Token fields: `input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`, `total_tokens`.
- No fixtures yet for `spawn_agent`, skill-via-`exec_command`, or subagent rollout files.

**Report consumer (`src/cli/commands/analytics/report/payload-builder.ts`, `report/client/app.js`)**
- Expects per-session `tokens`, `costUSD`, `costSeries`, `dispatches` from cost index.
- Aggregator rolls up `skillInvocations`, `agentInvocations`, `commandInvocations` from metric deltas into charts (Tools & Models tab).

### Architecture and Layers Affected

| Layer | Components |
|---|---|
| **CLI / Analytics** | `native-loader.ts`, `index.ts`, `aggregator.ts` |
| **Cost pipeline** | `usage-readers.ts`, `dispatch-extractor.ts`, `cost-enricher.ts`, `pricing.ts` |
| **Agent plugin (Codex)** | `codex.session.ts`, new `codex-named-invocations.ts` (recommended), `codex-message-types.ts` |
| **Report** | No template changes expected if cost index + aggregator fields populate correctly |
| **Tests** | Unit tests under `cost/__tests__/`, `analytics/__tests__/`, codex plugin tests, optional integration |

### Integration Points

1. **AgentRegistry** — `native-loader` and `cost-enricher` resolve adapters via `AgentRegistry.getAgent('codex')`. Codex plugin must expose `getSessionAdapter()`.
2. **ParsedSession contract** (`src/agents/core/session/BaseSessionAdapter.ts`) — `messages`, optional `subagents`, `metrics` with `skillInvocations` / `agentInvocations` / `commandInvocations`.
3. **TokenUsage mapping** — Codex `cached_input_tokens` → `cacheRead`; no cache creation fields in fixtures (set 0).
4. **Per-turn series** — `buildCostSeries()` consumes ordered `UsageRecord[]` with `ts` + `model` + `usage`; Codex must emit one record per completed turn (from `token_count` + correlated `turn_context.model`).
5. **Subagent rollouts** — Codex spawns separate `rollout-*-{new_thread_id}.jsonl` files (per task context); parent session references via `spawn_agent` / collab events. Cross-file correlation differs from Claude's `subagents/` directory model.
6. **Deduplication** — Native discovery skips logs already in `correlation.agentSessionFile`; subagent rollouts discovered as separate sessions may double-count parent+child tokens unless dedup strategy is defined (e.g. skip child rollouts linked to parent, or only count parent `total_token_usage`).

### Patterns and Conventions

- **Shared extractors** — Claude uses `claude-named-invocations.ts` for both processor and analytics; Codex should mirror with `codex-named-invocations.ts` called from `parseSessionFile` → `extractMetrics`.
- **Parse-time metrics** — Analytics re-parse path does not run processors; all data needed for native synthesis must be on `ParsedSession.metrics` at parse time (see `native-loader.ts` lines 228–232).
- **Defensive parsing** — `usage-readers.ts` uses `messagesOf()`, `allMessageArrays()` with array guards; Codex reader should tolerate malformed lines (already skipped by `readCodexJsonlTolerant`).
- **Agent-aware dispatch** — `extractDispatchEvents` is agent-agnostic in signature but Claude-specific in implementation; extend via agent parameter or separate `extractCodexDispatchEvents` merged in enricher.
- **Vitest + injected deps** — `native-loader` and `cost-enricher` use dependency injection for unit tests without fs/registry.

### Recommended File Changes

| File | Change |
|---|---|
| `src/cli/commands/analytics/native-loader.ts` | Add `'codex'` to `NATIVE_AGENTS`; add Codex-aware `firstUserText` / turn counting / assistant detection OR delegate title/turn derivation to adapter metadata |
| `src/agents/plugins/codex/codex.session.ts` | Add `extractMetrics()` at parse time (tools, file ops from `apply_patch`, named invocations); optionally discover linked subagent rollout files; populate `metrics` and `subagents` |
| `src/agents/plugins/codex/codex-named-invocations.ts` **(new)** | Extract skills from `exec_command` args containing `/skills/{name}/SKILL.md`; agents from `spawn_agent` / collab events; commands from Codex slash-command patterns (if any — confirm wire format) |
| `src/agents/plugins/codex/codex-message-types.ts` | Extend `CodexEventMsg` for `token_count`, `task_*`, collab/spawn payloads; add `turn_id` to `CodexTurnContext` |
| `src/cli/commands/analytics/cost/usage-readers.ts` | Add `extractCodexUsageRecords()`, `readCodex()`; wire `case 'codex'` in `readUsageByModel`, `gatherUsageDeduped`, `gatherDedupedUsageRecords`; include subagent rollout message arrays in `allMessageArrays` when attached |
| `src/cli/commands/analytics/cost/dispatch-extractor.ts` | Add Codex branch: pair `spawn_agent`/`wait_agent` function_calls by `call_id`; handle `collab_agent_spawn_end`/`collab_waiting_end` timestamps; or split to `codex-dispatch-extractor.ts` and merge in enricher |
| `src/cli/commands/analytics/cost/cost-enricher.ts` | Route dispatch extraction by agent; fix `enrichDispatchCosts` to use entry's `agentName` not hardcoded `'claude'`; subagent token join for Codex child rollouts |
| `src/cli/commands/analytics/model-normalizer.ts` | Optionally map Codex model aliases (e.g. dot variants) to pricing keys |
| `tests/integration/session/fixtures/codex/` | Add fixtures: spawn_agent turn, exec_command skill path, subagent rollout file |
| `src/cli/commands/analytics/cost/__tests__/usage-readers.test.ts` | Codex token extraction + per-turn series |
| `src/cli/commands/analytics/cost/__tests__/dispatch-extractor.test.ts` | Codex dispatch pairing |
| `src/cli/commands/analytics/__tests__/native-loader.test.ts` | Codex synthesis path |
| `src/agents/plugins/codex/__tests__/codex.session.test.ts` **(new or extend)** | Parse-time metrics + invocations |

**Out of scope (likely):** `report/template.html`, `report/client/app.js` — already consume generic fields. `CodexMetricsProcessor` token comment can be updated but analytics does not depend on processor path.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `docs/ANALYTICS-REPORT.md` — documents eight report views including cost coverage banner, per-turn cost series, dispatch timeline, skill/agent/command charts. States Codex is in scope at doc level but implementation gaps match this task.
- `.ai-run/guides/architecture/architecture.md` — plugin-based 5-layer architecture; analytics is CLI layer consuming agent session adapters.
- `.ai-run/guides/testing/testing-patterns.md` — Vitest, dynamic import mocking patterns.
- No dedicated Codex analytics guide.

### Architectural Decisions

- **Report-time cost** — Token pricing is not stored in metrics JSONL; re-parse native logs at report generation (`cost-enricher.ts` header comment).
- **Native discovery dedup** — Tracked CodeMie sessions correlated via `agentSessionFile` are excluded from native merge to prevent double counting.
- **Claude cross-session dedup** — `(message.id, requestId)` keys in `gatherUsageDeduped`; Codex dedup key TBD (`turn_id` + session file UUID?).
- **Dispatch cost allocation** — Subagent tokens are allocation of session total, not additive (`cost-enricher.ts` `enrichDispatchCosts` comment).
- **Codex metrics processor** — Per-call deltas without tokens; analytics path must read `token_count` events directly, not reuse processor output.

### Derived Conventions

- ES modules with `.js` import extensions.
- Lowercase tool names in metrics (`exec_command`, `apply_patch`).
- `logger.debug` for graceful degradation; single bad session must not abort report.
- Fixture-driven tests for rollout JSONL under `tests/integration/session/fixtures/codex/`.

---

## 4. Testing Landscape

### Existing Coverage

| Area | Tests | Codex coverage |
|---|---|---|
| Native loader | `__tests__/native-loader.test.ts` | Claude only |
| Usage readers | `cost/__tests__/usage-readers.test.ts` | Claude, Gemini, Kimi, claude-desktop — **no codex** |
| Dispatch extractor | `cost/__tests__/dispatch-extractor.test.ts` | Claude tool_use only |
| Cost enricher | `cost/__tests__/cost-enricher.test.ts` | Claude dispatch + subagent cost |
| Codex metrics | `codex/__tests__/codex.metrics-processor.test.ts` | Tool deltas, not tokens |
| Codex conversations | `codex/__tests__/codex.conversations-processor.test.ts` | Transcript shape, exec_command thoughts |
| Analytics E2E | `tests/integration/analytics.test.ts` | Claude golden dataset only |
| Rollout fixtures | `tests/integration/session/fixtures/codex/turn-{1,2}.jsonl` | Token + multi-turn, no spawn/skill |

### Testing Framework and Patterns

- **Vitest** unit tests with injected deps (`NativeLoaderDeps`, `EnricherDeps`).
- **Fixture JSONL** files for integration-style reader tests (see `usage-readers.test.ts` Claude/Kimi patterns).
- **test-isolation** helper for E2E (`tests/helpers/test-isolation.js`).
- Dynamic `vi.mock` for registry/adapter in plugin tests.

### Test Strategy (recommended)

1. **Unit: `extractCodexUsageRecords`**
   - Parse `turn-1.jsonl` → one usage record, model `o4-mini`, correct token mapping (`cached_input_tokens` → `cacheRead`).
   - Parse `turn-2.jsonl` → two records in chronological order; per-turn `last_token_usage` used for series; session total from final `total_token_usage` or sum policy (document chosen rule in test name).
   - `info: null` token_count lines skipped.

2. **Unit: `gatherDedupedUsageRecords('codex', ...)`**
   - Returns records suitable for `buildCostSeries` (≥2 points → non-empty series).
   - Subagent rollout messages included when `parsed.subagents` populated.

3. **Unit: Codex dispatch extraction**
   - Pair `spawn_agent` function_call with `wait_agent` output by `call_id`; duration from timestamps.
   - `collab_agent_spawn_end` / `collab_waiting_end` as alternative pairing if wire format uses events not function_call_output.
   - Skill detection: `exec_command` with `{"cmd":"cat .../skills/foo/SKILL.md"}` → skill name `foo`.

4. **Unit: `extractMetrics` / named invocations**
   - Mirrors `claude-named-invocations.test.ts` patterns for Codex wire shapes.

5. **Unit: `synthesizeRawSession('codex', ...)`**
   - Opening prompt from `user_message` event; turn count from `task_complete` or assistant messages; metrics carried to delta.

6. **Unit: `enrichCosts` with codex agent**
   - Session gets `priced: true`, non-zero `costUSD` for `o4-mini`, `costSeries` populated.

7. **Integration (optional, if user requests)**
   - Extend `tests/integration/analytics.test.ts` or add `analytics-codex.test.ts` with copied rollout fixture + native discovery mock.

8. **Fixtures to add**
   - `turn-spawn-agent.jsonl` — spawn/wait agent function_calls.
   - `turn-skill-exec.jsonl` — exec_command referencing SKILL.md path.
   - `rollout-subagent-{uuid}.jsonl` — child thread file for subagent correlation tests.

### Coverage Gaps

- Entire Codex path in analytics cost pipeline (readers, dispatch, enricher, native discovery).
- Parse-time metrics on `CodexSessionAdapter` (blocks skill/agent/command charts for native Codex sessions).
- Subagent rollout discovery and parent/child dedup policy.
- `firstUserText` / turn synthesis for non-Claude message shapes.
- No codegraph index in repo (research used filesystem only).

---

## 5. Configuration and Environment

### Environment Variables

| Variable | Used by | Relevance |
|---|---|---|
| `CODEX_HOME` | `codex.paths.ts` | Overrides `~/.codex` for rollout discovery |
| `CODEMIE_HOME` | `getCodemiePath()` | Tracked session + correlation paths |
| `CODEMIE_DEBUG` | logger | Debug discovery/parse failures |

### Configuration Files

- `src/cli/commands/analytics/cost/pricing.json` — model prices (Codex/OpenAI models already present).
- `.codemie/codemie-cli.config.json` — not analytics-specific.

### Feature Flags and Deployment Concerns

- `--no-scan-native` disables native discovery entirely (Codex-only users relying on plain `codex` CLI need native path).
- Report generation is offline/local — no server deployment; reads user home directories.
- `CODEX_HOME` must be respected consistently in discovery and any subagent rollout scan.

---

## 6. Risk Indicators

- **No parse-time Codex metrics** — `parseSessionFile` returns empty `metrics`; native sessions will show zero tools and empty invocation charts until `extractMetrics` is added (`codex.session.ts` lines 297–301).
- **Claude-shaped native synthesis** — `synthesizeRawSession` will miscount turns and miss opening prompts for Codex rollouts without adapter-specific helpers (`native-loader.ts` `firstUserText`, `isAssistant`).
- **Empty usage reader** — `gatherUsageDeduped` explicitly returns empty map for codex (`usage-readers.ts` ~339); coverage banner shows "no token reader" at $0.
- **No per-turn cost series** — `gatherDedupedUsageRecords` returns `[]` for codex; Cost tab session modal lacks series chart.
- **Dispatch extractor mismatch** — Codex `function_call` events invisible to `extractDispatchEvents`; dispatch timeline empty for Codex sessions.
- **Hardcoded claude in enrichDispatchCosts** — Subagent dispatch pricing uses `'claude'` agent name even when parent is codex (`cost-enricher.ts` ~217).
- **Subagent model difference** — Claude: `subagents/agent-*.jsonl` beside parent; Codex: separate rollout files with `new_thread_id` in filename — no discovery implementation yet; risk of double-counting if both parent and child discovered as native sessions.
- **Token semantics ambiguity** — `last_token_usage` vs `total_token_usage` across turns; wrong choice over/under-counts session totals or per-turn deltas (fixtures show `total_token_usage` growing 1036→1120).
- **Model pricing normalization** — `o4-mini` in fixtures must resolve via `lookupPrice`; verify dot/dash normalization does not miss OpenAI model strings.
- **Missing wire types** — `codex-message-types.ts` incomplete for `token_count` / collab events; risks silent skip during extraction.
- **codegraph not initialized** — repo has no `.codegraph/`; structural research relied on filesystem grep/read.
- **Processor vs analytics divergence** — `CodexMetricsProcessor` comment claims no per-call usage; `token_count` events contradict this for analytics path.

---

## 7. Summary for Complexity Assessment

This task closes a deliberate coverage gap: the analytics report pipeline is agent-extensible but Codex stops at discovery — `CodexSessionAdapter.discoverSessions` exists, yet `NATIVE_AGENTS` excludes `'codex'`, usage readers return empty maps, and dispatch extraction only understands Claude `tool_use` blocks. Full parity requires coordinated changes across **three architectural layers**: the Codex plugin (parse-time `extractMetrics`, named invocations, optional subagent rollout linking), the cost subpipeline (`usage-readers`, `dispatch-extractor`, `cost-enricher` agent routing), and thin native-loader adjustments for Codex message shapes. Estimated surface: **8–12 files** touched, **1 new module** (`codex-named-invocations.ts`), plus **4–6 test files** and **2–3 JSONL fixtures**.

Technical novelty is moderate — patterns are established by Claude and Kimi implementations. Codex-specific novelty lies in (1) `token_count` / `turn_context` correlation for per-turn `UsageRecord` series, (2) `function_call`-based dispatch pairing instead of `tool_use`/`tool_result`, and (3) subagent representation as separate rollout files rather than Claude's `subagents/` directory. The Kimi `usage.record` reader is the closest template for per-turn metering; Claude's `extractNamedInvocations` and subagent attachment are the templates for invocation charts and dispatch cost allocation.

Test coverage for the affected domain is **Claude-heavy and Codex-absent** in analytics tests, though Codex rollout fixtures exist for session sync. New unit tests should follow existing `usage-readers.test.ts` and `dispatch-extractor.test.ts` patterns with fixture JSONL from `tests/integration/session/fixtures/codex/`. Key risks for complexity scoring: subagent double-counting policy (needs explicit design), token field semantics (`last_token_usage` per turn vs cumulative `total_token_usage`), and native-loader synthesis assumptions baked for Claude transcripts. Pricing table readiness reduces risk on the cost calculation side; the main work is extraction and wiring, not new report UI.
