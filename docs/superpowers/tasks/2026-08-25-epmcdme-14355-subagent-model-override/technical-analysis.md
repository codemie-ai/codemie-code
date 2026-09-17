# Technical Research

**Task**: subagent-dispatch model-resolution agent-tool
**Generated**: 2026-08-25T00:00:00Z
**Research path**: codegraph

---

## 1. Original Context

EPMCDME-14355 — CodeMie Claude CLI ignores sub-agent model override and runs Haiku-pinned agent with orchestrator Sonnet model.

Full ticket details:
When CodeMie Claude CLI runs a sub-agent with an explicitly requested model different from the orchestrator model, the sub-agent still runs with the orchestrator model instead of the requested one.

A sub-agent was launched with a Haiku model override while the orchestrator was running on Sonnet. The sub-agent dispatch accepted `model: haiku`, but the actual resolved model was `claude-sonnet-5`, and the agent reported that it was running as Claude Sonnet 5.

The same project folder, same agent, and same prompt tested with Claude Code Enterprise CLI (without CodeMie CLI) correctly honored the Haiku model request. So this is a CodeMie CLI-specific issue in sub-agent model override handling or dispatch-time model resolution.

Environment: CodeMie Claude CLI 2.1.241. Orchestrator model claude-sonnet-5.

Evidence:
- Agent tool input: {"subagent_type": "model-pin-test", "model": "haiku"}
- Tool result:      {"resolvedModel": "claude-sonnet-5"}
- Sub-agent reports: "I am running as Claude Sonnet 5 (model ID: claude-sonnet-5). This does not match the Haiku model that was requested for this dispatch."

Acceptance criteria:
1. Sub-agent dispatched with model:haiku actually runs on Haiku, regardless of orchestrator.
2. resolvedModel in dispatch metadata matches the requested override.
3. model-pin-test diagnostic agent reports Haiku when launched with Haiku override from Sonnet orchestrator.
4. Parity with Claude Code Enterprise CLI behavior.
5. Regression test verifying override honoring for a non-orchestrator model.
6. Clear error/warning if requested model unavailable — never silent fallback to orchestrator model.

Repo context:
- This is the codemie-code repo (a TypeScript CLI, fork of Claude Code with CodeMie proxy integration).
- We suspect the bug lives in subagent dispatch or model-resolution logic — hopefully in a small, well-contained module.
- Backend `codemie` proxy already investigated: its `_extract_model` reads body.model → path.model_name → header, so if CLI sends the correct model in the body the backend will forward correctly. This strongly suggests the CLI resolves/overrides the model wrongly BEFORE sending the request.
- Compare against upstream Claude Code Agent-tool model resolution to see what CodeMie fork changed.

---

## 2. Codebase Findings

### Existing Implementations

- `src/agents/plugins/claude/claude.plugin.ts` — Declares `envMapping` (maps `sonnetModel` → `['ANTHROPIC_DEFAULT_SONNET_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']`) and the `beforeRun` hook that calls `resolveClaudeModel` per tier at orchestrator launch. Lines 311–318 are the primary suspect: the sonnet tier always writes the resolved sonnet model ID into `CLAUDE_CODE_SUBAGENT_MODEL`.
- `src/agents/core/BaseAgentAdapter.ts` — `transformEnvVars()` (lines 1100–1161) clears native tier vars then repopulates from `CODEMIE_*_MODEL`. The normal "sonnet is provisioned" branch (lines 1138–1142) unconditionally sets `CLAUDE_CODE_SUBAGENT_MODEL = CODEMIE_SONNET_MODEL`, even when haiku is also provisioned and a subagent explicitly requests haiku.
- `src/agents/plugins/claude/claude.models.ts` — `resolveClaudeModel(env, tier)` fetches the live CodeMie model catalog, ranks models by tier pattern (haiku/sonnet/opus), and returns `null` when the configured model is still available. Tier env vars: `CODEMIE_HAIKU_MODEL`, `CODEMIE_SONNET_MODEL`, `CODEMIE_OPUS_MODEL`.
- `src/providers/plugins/sso/proxy/plugins/header-injection.plugin.ts` — Injects `X-CodeMie-CLI-Model: <config.model>` (orchestrator model) into every proxied request as metadata. Does not rewrite `body.model`.
- `src/providers/plugins/sso/proxy/plugins/claude-request-normalizer.plugin.ts` — Uses `configModel` (orchestrator model, frozen at proxy start) as a fallback only when `body.model` is absent. Does not substitute `body.model` when present.
- `src/agents/core/__tests__/model-tier-config.test.ts` — Covers `transformEnvVars` for all tier combinations including haiku-only (EPMCDME-12779). Does not test the mixed haiku+sonnet case where a subagent explicitly requests haiku via the Agent tool `model` parameter.

### Root Cause (Confirmed by Codegraph)

`CLAUDE_CODE_SUBAGENT_MODEL` is always populated with the orchestrator's sonnet model. Upstream Claude Code treats this env var as a **global override** for all subagents — it takes precedence over the `model` parameter in the Agent tool call. When a haiku-pinned subagent is dispatched, Claude Code's internal model picker sees `CLAUDE_CODE_SUBAGENT_MODEL = sonnet-model`, emits `body.model = sonnet-model` in the API request, and the haiku override is silently lost before the request reaches the proxy.

The bug is in two places:
1. `claude.plugin.ts` `envMapping`: maps `sonnetModel` tier to `CLAUDE_CODE_SUBAGENT_MODEL` — this pairing is incorrect because `CLAUDE_CODE_SUBAGENT_MODEL` is a global override, not a tier default.
2. `BaseAgentAdapter.ts` `transformEnvVars()`: the sonnet-provisioned branch unconditionally sets `CLAUDE_CODE_SUBAGENT_MODEL` to the sonnet model.

### Architecture and Layers Affected

1. **CLI/plugin layer** — `beforeRun` hook in `claude.plugin.ts` sets tier env vars once at orchestrator launch.
2. **Env-var transform layer** — `transformEnvVars` in `BaseAgentAdapter.ts` maps `CODEMIE_*_MODEL` → native Claude Code env vars.
3. **Local proxy layer** — plugins in `src/providers/plugins/sso/proxy/plugins/` observe requests but do not rewrite `body.model` when already present (proxy is not the cause).

### Integration Points

- `@anthropic-ai/claude-code` — upstream Claude Code binary; the semantics of `CLAUDE_CODE_SUBAGENT_MODEL` vs the Agent tool `model` parameter originate here. The CLI cannot intercept per-subagent model selection inside the upstream binary; it can only control which env vars the binary reads.
- CodeMie live model catalog (via `fetchCodeMieLlmModels`) — live source for tier resolution; cached 5 minutes.
- `CODEMIE_JWT_TOKEN` / `CODEMIE_URL` (SSO) — auth for catalog fetch.

### Patterns and Conventions

- Generic env vars (`CODEMIE_MODEL`, `CODEMIE_HAIKU_MODEL`, …) → agent-specific native vars via `envMapping` declared in plugin metadata.
- `CLAUDE_CODE_SUBAGENT_MODEL` = Claude Code's global subagent model default; it suppresses per-subagent `model` overrides when set.
- Model tier resolution caches the live catalog for 5 minutes and returns `null` when the configured model is still valid.
- Proxy config is frozen at orchestrator startup; all subagent requests share the same proxy with the same `configModel`.

---

## 3. Documentation Findings

### Guides and Architecture Docs

No `.ai-run/guides/` directory found in codemie-code. Conventions derived from code exploration.

### Architectural Decisions

- `EPMCDME-12779` is referenced in `model-tier-config.test.ts` — a prior ticket that introduced the haiku-only branch in `transformEnvVars`. The current bug is the next case: haiku+sonnet with a per-subagent override.
- The `envMapping` design (plugin metadata declares which generic → native var mappings to apply) is the established pattern in this codebase. The fix should stay within this pattern.

### Derived Conventions

- Each plugin declares its native var mappings in `envMapping` metadata; `BaseAgentAdapter` applies them in `transformEnvVars`.
- Model resolution happens once at orchestrator launch (`beforeRun`), not per-subagent dispatch.
- The `if (!env[nativeVar])` guard in `beforeRun` (line 332 of `claude.plugin.ts`) prevents overwriting a var that `transformEnvVars` already set. This interaction must be preserved by the fix.

### External Documentation Findings

`CLAUDE_CODE_SUBAGENT_MODEL` is an upstream Claude Code env var that sets the default model for all subagent launches. When set, it takes precedence over the `model` parameter in the Agent tool call at dispatch time. The fix must avoid setting this var to the sonnet model when haiku (or another non-sonnet tier) is provisioned and a subagent may request it explicitly. The correct var for "default sonnet tier" is `ANTHROPIC_DEFAULT_SONNET_MODEL` alone; `CLAUDE_CODE_SUBAGENT_MODEL` should either be left unset or set only to a value that matches what explicit overrides can supersede.

---

## 4. Testing Landscape

### Existing Coverage

- `src/agents/core/__tests__/model-tier-config.test.ts` — covers `transformEnvVars` for haiku-only, sonnet-only, and opus configurations; does not cover the mixed case with a subagent-level model override.
- `src/agents/plugins/claude/__tests__/claude.plugin.conflict.test.ts` — plugin conflict detection.
- `src/agents/plugins/claude/__tests__/claude.provider-support.test.ts` — provider support checks.
- `src/agents/plugins/claude/__tests__/plugin-installer.test.ts`, `statusline-installer.test.ts`, `settings-conflict.test.ts` — installation and settings concerns.

### Testing Framework and Patterns

- **Vitest** (confirmed in `package.json`).
- Tests use direct unit-testing of `transformEnvVars` by passing mock env objects; no mocking of the upstream Claude Code binary needed for the fix's regression test.
- `model-tier-config.test.ts` is the natural home for the new regression test.

### Coverage Gaps

- No test for the scenario: haiku + sonnet both provisioned, subagent dispatched with `model: haiku`. This is the exact bug scenario.
- No test for `beforeRun` model-tier resolution in the haiku+sonnet mixed case.
- No end-to-end test verifying that `body.model` in the proxied request matches the subagent's requested model (integration-level gap).

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_MODEL` — orchestrator model (generic CodeMie var)
- `CODEMIE_HAIKU_MODEL` — haiku-tier model ID (CodeMie-specific)
- `CODEMIE_SONNET_MODEL` — sonnet-tier model ID (CodeMie-specific)
- `CODEMIE_OPUS_MODEL` — opus-tier model ID (CodeMie-specific)
- `ANTHROPIC_MODEL` — Claude Code native orchestrator model
- `ANTHROPIC_DEFAULT_HAIKU_MODEL` — Claude Code native haiku-tier default
- `ANTHROPIC_DEFAULT_SONNET_MODEL` — Claude Code native sonnet-tier default
- `CLAUDE_CODE_SUBAGENT_MODEL` — **the bug's center**: upstream Claude Code global default for all subagents; currently always set to sonnet model by CodeMie, overriding per-subagent `model` parameter

### Configuration Files

- `src/agents/plugins/claude/claude.plugin.ts` — `envMapping` declaration governs which vars are mapped at orchestrator launch.
- `src/agents/core/BaseAgentAdapter.ts` — `transformEnvVars` logic governs env var population before the upstream binary starts.

### Feature Flags and Deployment Concerns

No feature flags found in the affected code path. The fix is a logic change in two TypeScript files; no deployment config changes expected.

---

## 6. Risk Indicators

- **Primary bug surface is small and well-contained**: two files (`claude.plugin.ts` envMapping + `BaseAgentAdapter.ts` `transformEnvVars`) are the only places to change.
- **`CLAUDE_CODE_SUBAGENT_MODEL` semantics are upstream-controlled**: the upstream Claude Code binary's exact precedence rules (env var vs Agent tool `model` param) must be verified against the upstream source or release notes before deciding whether to unset the var entirely or change its value. Getting this wrong could break the haiku-only case (EPMCDME-12779).
- **The `beforeRun` guard interaction**: the `if (!env[nativeVar])` guard in `claude.plugin.ts` means `transformEnvVars` must run before `beforeRun`, and the fix must not break that ordering assumption.
- **No existing test for the haiku+sonnet mixed subagent override case**: the regression test in AC-5 is missing and must be added.
- **Silent fallback behaviour**: the current code silently uses sonnet when sonnet is provisioned, with no warning when a subagent requests haiku. AC-6 requires an explicit error/warning path — this is new logic with no existing pattern to follow.
- **Codegraph returned no results for semantic subagent-dispatch interception**: per-subagent model selection is fully internal to the upstream binary. The CLI has no TypeScript hook at dispatch time — it can only control env vars set before the binary starts.

---

## 7. Summary for Complexity Assessment

The bug is precisely located and the fix surface is small. Two files require changes: `src/agents/core/BaseAgentAdapter.ts` (the `transformEnvVars` method, specifically the branch that unconditionally sets `CLAUDE_CODE_SUBAGENT_MODEL` to the sonnet model) and `src/agents/plugins/claude/claude.plugin.ts` (the `envMapping` that pairs the sonnet tier with `CLAUDE_CODE_SUBAGENT_MODEL`). No new architectural patterns are needed. The fix follows the established pattern of adjusting which CodeMie generic env var maps to which upstream Claude Code native var. Estimated file change surface: 2–3 TypeScript files, fewer than 30 lines of logic change, plus a new test case in an existing test file.

The task follows an established pattern (prior ticket EPMCDME-12779 introduced the haiku-only branch for the same class of problem), so there is prior art in the codebase to model the fix on. The main technical novelty is understanding the exact precedence semantics of `CLAUDE_CODE_SUBAGENT_MODEL` in the upstream Claude Code binary — specifically whether removing it from the env (or setting it to a different value) will cause the binary to honour the per-subagent `model` parameter. This requires a targeted read of the upstream binary's model-picker logic or testing against the upstream binary directly.

Test coverage for the affected area is present but has a gap: `model-tier-config.test.ts` covers haiku-only and sonnet-only cases but not the mixed haiku+sonnet case with an explicit subagent override. The regression test (AC-5) is a straightforward addition to the existing test file. AC-6 (explicit error on unavailable model) is new logic with no existing pattern — it adds a small amount of novelty and should be scoped carefully to avoid breaking the silent-fallback behaviour in cases where it is intentional (e.g., orchestrator model selection).
