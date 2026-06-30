# Complexity Assessment: Codex Analytics Report Parity

**Task:** Add full Codex analytics parity to `codemie analytics --report` — native session discovery, token/cost pricing from Codex rollout `token_count` events, per-turn cost series, dispatch timeline for spawn_agent/skills, skill/agent invocation charts. Match Claude Code coverage.

**Generated:** 2026-06-23

---

## Size: M (19/36)

## Dimension Scores

| Dimension            | Score | Label |
|----------------------|-------|-------|
| Component Scope      | 5     | XL    |
| Requirements Clarity | 3     | M     |
| Technical Risk       | 3     | M     |
| File Change Estimate | 4     | L     |
| Dependencies         | 1     | XS    |
| Affected Layers      | 3     | M     |

**Total:** 19/36

---

## Key Reasoning

- **Component Scope (XL):** Seven coordinated components must change together — `native-loader`, `usage-readers`, `dispatch-extractor`, `cost-enricher`, `codex.session`, new `codex-named-invocations`, and `codex-message-types`. All sit on the analytics ingestion/enrichment path; partial delivery leaves report tabs empty.
- **File Change Estimate (L):** ~8–12 production files, 1 new module, 4–6 test files, and 2–3 JSONL fixtures across `cli/commands/analytics/`, `cost/`, and `agents/plugins/codex/`.
- **Requirements Clarity (M):** "Match Claude Code coverage" is a strong reference anchor, but subagent parent/child dedup policy and `last_token_usage` vs `total_token_usage` semantics need explicit design before implementation.
- **Technical Risk (M):** Claude and Kimi readers provide templates; Codex novelty is in `token_count`/`turn_context` correlation, `function_call`-based dispatch pairing, and separate rollout files for subagents (not Claude's `subagents/` directory model).
- **Affected Layers (M):** Three layers — CLI analytics, cost subpipeline, Codex agent plugin. Report UI needs no changes if cost index and aggregator fields populate correctly.
- **Dependencies (XS):** No new packages; `pricing.json` already includes OpenAI/Codex models.

## Red Flags Applied

- **Component Scope bumped L → XL:** Touches core shared analytics utilities (`usage-readers`, `dispatch-extractor`, `cost-enricher`, `native-loader`) used by all agents.

## Affected Components

| Component | Path | Nature of change |
|-----------|------|------------------|
| Native loader | `src/cli/commands/analytics/native-loader.ts` | Add `'codex'` to `NATIVE_AGENTS`; Codex-aware synthesis for user text, turns, assistant detection |
| Usage readers | `src/cli/commands/analytics/cost/usage-readers.ts` | New `extractCodexUsageRecords` / `readCodex`; wire `case 'codex'` in gather functions |
| Dispatch extractor | `src/cli/commands/analytics/cost/dispatch-extractor.ts` | Codex `spawn_agent`/`wait_agent` and collab event pairing |
| Cost enricher | `src/cli/commands/analytics/cost/cost-enricher.ts` | Agent-aware dispatch routing; fix hardcoded `'claude'` in subagent pricing |
| Codex session adapter | `src/agents/plugins/codex/codex.session.ts` | Parse-time `extractMetrics`, optional subagent rollout discovery |
| Codex named invocations | `src/agents/plugins/codex/codex-named-invocations.ts` **(new)** | Skills from `exec_command` SKILL.md paths; agents from spawn/collab events |
| Codex message types | `src/agents/plugins/codex/codex-message-types.ts` | Extend types for `token_count`, task/collab events |
| Tests & fixtures | `cost/__tests__/`, `analytics/__tests__/`, `fixtures/codex/` | Unit coverage for readers, dispatch, native synthesis; spawn/skill fixtures |

## Risk Factors

- Subagent double-counting if parent and child rollout files are both discovered as native sessions without dedup policy.
- Wrong token field choice (`last_token_usage` per turn vs cumulative `total_token_usage`) over/under-counts session totals or per-turn series.
- `synthesizeRawSession` Claude-shaped helpers will miscount Codex turns and miss opening prompts without adapter-specific logic.
- Incomplete `codex-message-types` may silently skip `token_count` and collab events during extraction.

## Routing Verdict

**→ `brainstorming`**

Total score 19 (M tier). Proceed with brainstorming before implementation planning. The work is well-bounded by Claude/Kimi reference implementations, but design decisions on subagent dedup and per-turn token semantics should be resolved in brainstorming before coding.

**Not split-required.** Scope is large within one subsystem but does not cross services or require architectural decomposition. A phased implementation (usage readers → dispatch → native discovery → invocation metrics) is advisable but can ship as one story with clear design upfront.
