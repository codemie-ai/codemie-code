# Technical Research

**Task**: claude-code-otlp analytics output_tokens subagent session metrics
**Generated**: 2026-10-22
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-16154 — [CLI Analytics][Preview] Output tokens are undercounted for sessions using a subagent.

CLI Analytics undercounts output_tokens for a Claude Code session that uses a subagent when the model is called directly through the Anthropic API and the subagent runs in the background: interactive plain `claude` and Claude Desktop without the CodeMie gateway. The session total can be smaller than the output of its own subagent. Input, cache and cost are correct; only output tokens are affected.
Does not reproduce: `claude -p` (subagent runs in the foreground) and sessions routed through the CodeMie gateway (`codemie-claude`).

Steps: in a git repo tracked by CLI Analytics, start plain interactive `claude` with Sonnet (or Claude Desktop); send one prompt using exactly one Explore subagent; wait for finish; exit; open session in CLI Analytics -> Sessions and compare output tokens with the OTel `api_request` totals.

Actual: e.g. session 42b807fc: Preview session output 1,283 vs OTel total 2,701, Preview Explore output 1,496. Another: 2,448 vs 8,828 (Explore 6,952). Two Explore parallel: 2,489 vs 4,371 (1,279+1,075). Explore subagent alone shows more output than the whole session. Correct for comparison: `claude -p` sessions and `codemie-claude`.

Expected: session total includes all output tokens of main session and subagents and equals OTel api_request total regardless of launch mode.
Impact: wrong output tokens in Sessions, propagated to Overview, Users, Tools & Models, Cost.

Acceptance criteria:
- For interactive plain `claude` and Claude Desktop (Anthropic API) with one or more subagents, session output_tokens equals the OTel api_request total.
- The subagent ("agent · Explore") output equals the OTel total of the subagent's requests and is never greater than the session total.
- `claude -p` and `codemie-claude` sessions stay correct.

Repo hints: see AGENTS.md; the claude-code-otlp adapter is at src/agents/plugins/claude-code-otlp/ and docs/ARCHITECTURE-OTLP-PLUGIN.md; also look at the Claude session metrics/transcript processing (src/agents/plugins/claude/) and the analytics aggregation of output tokens. Locate where session output_tokens are computed and why background-subagent (sidechain) usage / streaming duplicate usage records would be undercounted or misattributed.

---

## 2. Codebase Findings

### Existing Implementations
All under `/Users/vponkratina/work/ai/codemie-code/src/agents/plugins/claude-code-otlp/`:
- `claude-code-otlp.plugin.ts` — `evaluate()` dispatch. `onSubagentStopEvent` (l.121) builds a `SubagentFile` from `agent_transcript_path` and calls `openSubagentPass`; ignores SubagentStop with empty `agent_type`. Stop/PreCompact/StopFailure/SessionEnd go to main-transcript passes (`openMainTranscriptPass`/`openSessionEndPass`).
- `transcript/usage-request.ts` — `parseUsageLine` turns each JSONL line with `message.usage` into an `OpenUsageRequest` (`outputTokens = usage.output_tokens`). `usageRequestKey` = `${requestId || messageId}::${model}`. `mergeUsageRequest` merges same-key rows with `Math.max` per numeric field (so output = largest output_tokens seen in any row; rows are never summed). `buildUsageRequestEvent` emits `agent.usage.request` (carries `scope_kind` main|skill|agent, `agent_id`, `agent_type`, `output_tokens`).
- `transcript/orchestrator.ts` — `deriveMainEvents` (l.~320) reads only new lines from `state.mainOffset` via `readNewLines`, merges into `state.openRequests`, emits one `agent.usage.request` per touched key, and on Stop/SessionEnd a full-recompute `agent.session.summary` (no token fields; only `api_calls`, models, tools, etc.). `deriveSubagentEvents` (l.~600) does the same for subagent files with `scopeKind:'agent'` and also emits `agent.subagent.usage` whose `usage[]` is built by `buildUsageTotals` (`subagent-usage.ts`, sums output_tokens per model/speed/geo/tier/scope). `openSessionEndPass` backstop scans `findSubagentFiles` and skips files where `subagentAlreadyCovered` (persisted offset == file size).
- `transcript/transcript-reader.ts` — `readNewLines`: byte-offset incremental reader; returns only complete (newline-terminated) lines, advances offset past them.
- `transcript/parse-state.ts` — persisted state at `getCodemiePath('analytics','state',<session>.json)`: `mainOffset`, `subagentOffsets`, `openRequests`, lock file; state saved only when send accepted (`finalize(accepted)`).
- `transcript/subagent-usage.ts` — `findSubagentFiles` (`<dir>/<sessionId>/subagents/agent-*.jsonl` + `.meta.json` sidecar), `buildSubagentUsageEvent`.
- Related, separate pipeline: `src/cli/commands/analytics/cost/usage-readers.ts` `extractClaudeUsageRecords` (main + `parsed.subagents`), dedupe key `message.id::requestId`, keeps the "most complete" row via `isMoreCompleteUsageRecord` (usage weight, then later ts) — header comment explicitly notes Claude Code writes progressive JSONL rows with partial usage for streaming responses.
- `src/agents/plugins/claude/session/processors/claude.conversations-processor.ts:1063` is the only `isSidechain` reference in claude/session; `orchestrator.ts:170` skips `isSidechain` user lines for turn counting only.

### Architecture and Layers Affected
Agent plugin (hook adapter `claude-code-otlp`) -> transcript derivation (`transcript/*`) -> spool/forwarder (proxy daemon, `otlp-spool/forwarder.ts`) -> analytics API (backend, NOT in this repo). The server-side aggregation that computes Preview "session output_tokens" and "agent · Explore" output was not found in this repo (grep for `agent.usage.request` consumers outside the plugin found none), so how session total relates to per-request/subagent events is unverified here.

### Integration Points
Hook payload (`transcript_path`, `agent_transcript_path`, `agent_id`, `agent_type`) from Claude Code; `docs/ARCHITECTURE-OTLP-PLUGIN.md` (event contract, dispatch pattern, transcript module table l.186-190); shared bedrock/routing helpers imported by `usage-request.ts`.

### Patterns and Conventions
One `OtlpAgentAdapter` handler per hook event; commit-after-send passes with per-session lock; max-merge of same-identity rows; replays are tolerated ("backend dedupes/collapses replays" per `finalizeOf` comment). ES modules, `.js` import suffix, `@/` alias.

---

## 3. Documentation Findings

### Guides and Architecture Docs
`.ai-run/guides/` exists (architecture, development, integration, security, standards, testing, usage). `docs/ARCHITECTURE-OTLP-PLUGIN.md` is the relevant contract doc; it mentions subagent passes and transcript modules but no token-accuracy discussion (grep for output_tokens/sidechain/api_request: no hits).

### Architectural Decisions
Comment in `usage-request.ts`: Claude Code can write more than one row per API response (progressive streaming chunks or later row filling `stop_reason`); numeric fields are max-merged "a later row only ever adds usage". Directive journals under `docs/local_docs/work/directives/` not searched.

### Derived Conventions
Request identity: `requestId` (req_...) else `message.id`, plus model.

---

## 4. Testing Landscape

### Existing Coverage
`transcript/__tests__/`: `usage-request.test.ts`, `orchestrator.test.ts`, `parse-state.test.ts`, `subagent-usage.test.ts`, `transcript-reader.test.ts`, `session-summary.test.ts`, `session-signals.test.ts`; fixtures `fixtures/transcript-usage.jsonl` (same `msg_pair_1` appears twice with output 50 then 120 + stop_reason - the max-merge case) and `transcript-usage-direct.jsonl`. Plugin test: `__tests__/claude-code-otlp.plugin.test.ts`.

### Testing Framework and Patterns
Vitest; fixtures of JSONL transcripts; dynamic-import mocking (see `.ai-run/guides/testing/testing-patterns.md`). Tests written only on explicit request per AGENTS.md.

### Coverage Gaps
No fixture mirrors a direct-Anthropic-API interactive transcript with background subagent (row per content block with placeholder output_tokens, streamed rows never updated, or subagent rows flushed after `SubagentStop`). Unverified whether existing `transcript-usage-direct.jsonl` models that.

---

## 5. Configuration and Environment

### Environment Variables
None specific found for this area (not exhaustively searched); `CODEMIE_DEBUG` for logging.

### Configuration Files
State dir via `getCodemiePath('analytics','state')`.

### Feature Flags and Deployment Concerns
None found. Hook registration per `claude-code-otlp.allowlist.ts` / `HOOK_EVENTS`.

---

## 6. Risk Indicators

- Speculative: root cause is most likely that in direct-API streaming mode the Claude Code transcript rows for one `message.id` carry only partial `output_tokens` (the streaming `message_start` placeholder or an intermediate count), and the final count is never written back; max-merge in `mergeUsageRequest` then yields the partial value. Fits "only output affected; input/cache correct" and "not via gateway" (gateway responses give complete usage). Not confirmed by any real transcript in repo; needs a sample from session 42b807fc-type run.
- Speculative: alternative/additional cause is timing: background subagent transcript read at `SubagentStop` or main at `Stop` before the final rows are flushed; `readNewLines` only returns newline-terminated lines, offset is then advanced and later rows are picked up only by a later pass (`openSessionEndPass` skips a file when `size === offset`, so rows written after the last read but before the check are fine, but nothing re-reads if no later hook fires, e.g. background subagent finishing after main `SessionEnd`).
- Observed in data: Explore (6,952) > session (2,448) implies session total is not a sum of all `agent.usage.request` scopes in the backend, or main-scope rows are being collapsed/overwritten by subagent rows. Backend aggregation is outside this repo - cannot be located here; fix may span repos.
- Keying risk: `usageRequestKey` falls back to `messageId` when `requestId` is empty; subagent and main rows share one `state.openRequests` map keyed without `agentId`, so identical keys across transcripts (background subagent replays/inherits parent history rows) would merge into one record and take the first record's scope/agent (b's non-empty wins, so scope may flip). Not verified.
- Divergent logic: the cost pipeline (`usage-readers.ts`, "most complete row") and OTLP pipeline (max-merge) are separate; cost is reported correct, so the cost reader's approach is a reference for expected values.
- No docs on token-accuracy contract; `agent.session.summary` has no token fields, so session output must be derived server-side.

---

## 7. Summary for Complexity Assessment

Output tokens flow from Claude Code transcript JSONL lines -> `parseUsageLine`/`mergeUsageRequest` (max-merge by request key) -> per-request `agent.usage.request` events and per-subagent `agent.subagent.usage` events, emitted at Stop/SubagentStop/SessionEnd hooks through incremental byte-offset passes. The change surface in this repo is concentrated in `transcript/usage-request.ts`, `transcript/orchestrator.ts` and possibly `subagent-usage.ts` (roughly 2-4 source files), but the code that computes the Preview session total and Explore attribution was not found here and likely lives in the backend, which is a significant unknown.

Technical novelty is low (existing merge/dedupe patterns, with a reference "most complete row" implementation in `usage-readers.ts`), but diagnosing requires a real direct-API transcript to confirm whether the transcript itself underreports output tokens (in which case the transcript is not a sufficient source and OTel `api_request`-style data or a different mechanism would be needed) or whether the plugin mis-merges/mis-times rows.

Test posture is good for the transcript modules (unit tests plus JSONL fixtures) but lacks a direct-API/background-subagent scenario. Key risks: unconfirmed root cause, possible cross-repo backend dependency, and the acceptance requirement that session total equals OTel `api_request` totals which may not be derivable from transcripts alone.

---

## 8. External References

None named by the task (only repo paths in the hints, all read above).
