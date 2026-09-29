# Technical Analysis — EPMCDME-14763: 1M context window for Claude Code models

**Generated**: 2026-09-29 | **Research path**: filesystem | **Basis**: working tree on branch EPMCDME-14763 (uncommitted changes are authoritative). The previous version of this file described the retired regex-table design and is superseded.

## Overview

CodeMie CLI used to require users to hand-edit their profile, appending `[1m]` to a Claude model id, to get
Claude Code's 1M-context window. The ticket asks CodeMie to apply `[1m]` automatically for any model that
supports it, without breaking models that do not.

The design is now **catalog-driven, not table-driven**. The CodeMie backend (separate repo, already updated)
returns `max_input_tokens` on each model in `GET /v1/llm_models?include_all=true`; routers and static-YAML
catalogs omit it. The CLI reads that number and decides the id form. There is no hard-coded capability table,
no synthesized second picker row, and no `[1m]` carry-over logic. Claude Code owns `[1m]` semantics: it strips
the suffix from the id and adds the `context-1m` beta header itself. No `[1m]` handling exists in proxy or core
code (grep of `src/providers`, `src/agents/core`, `src/utils` found none), so the proxy sees the bare id.

External references: none named by the task.

## Codebase Findings

### 1. Files changed in the working tree (6 modified, none committed)

- `src/providers/plugins/sso/sso.http-client.ts` — `LlmModel.max_input_tokens?: number` (+5 lines, doc comment
  says "absent on routers and static-config catalogs"). `fetchCodeMieLlmModels` (line 238) is untouched: it
  `JSON.parse`s and casts the array, so the field arrives with no validation. `CODEMIE_ENDPOINTS.MODELS` is
  `/v1/llm_models?include_all=true` (line 20).
- `src/agents/plugins/claude/claude.models.ts` — the core change (500 lines now; -179/+ net smaller).
- `src/agents/plugins/claude/claude.plugin.ts` — warning gate only (+7/-1 around line 405).
- `src/agents/plugins/claude/__tests__/claude.models.test.ts` (rewritten) and
  `claude.plugin.model-swap-warning.test.ts` (+1 case).
- `.codemie/codemie-cli.config.json` — **unrelated local edit** (profile renamed `epm-cdme` -> `codemie-sso`,
  `opusModel` `claude-opus-5-5`, `codemieAssistants`/`codemieSkills` removed). Not part of the feature.
- Unchanged and already committed from the first implementation: `plugin/statusline.ts` (see finding 6).

### 2. `claude.models.ts` — the context-window helpers

- `applyContextWindow(id, maxInputTokens)` (line 213) is the single decision point. `typeof maxInputTokens !==
  'number'` -> id returned untouched (never guess, never strip). `>= 1_000_000` -> `<bareId>[1m]`. Smaller ->
  bare id (strips an existing `[1m]`). `null`, numeric strings and `NaN` all fall in the "untouched" branch or
  the "smaller" branch of the comparison; there is no runtime validation of the backend value.
- `stripOneMillionSuffix` / `ONE_MILLION_SUFFIX_PATTERN` (`/\[1m\]$/i`, case-insensitive, trailing) are the only
  suffix helpers. `ONE_MILLION_TOKENS = 1_000_000` is the only threshold.
- `findServableEntry(catalog, id)` (line 219) — first catalog entry that `isServableModel` (enabled,
  tools/streaming not `false`, not embedding/rerank/etc.) and whose `modelIdentifiers()` (deployment_name,
  base_name, label) includes `id`. A disabled or non-servable entry yields no window, so the id stays untouched.
- Removed: the regex capability table, `supportsOneMillionContext`, `isRouterLikeEntry`,
  `splitOneMillionSuffix`, and the strip/carry-over logic. Confirmed by grep: none of these symbols remain
  anywhere in `src/`, `tests/`, `docs/` (outside old task artifacts) or `openwiki/`.
- `ClaudeModelResolutionReason = 'unavailable' | 'one-million-enabled' | 'one-million-unsupported'` (line 15).

### 3. `resolveClaudeModel(env, tier)` — decision flow (line 389)

1. Read the tier var (`CODEMIE_MODEL` / `CODEMIE_HAIKU_MODEL` / `CODEMIE_SONNET_MODEL` / `CODEMIE_OPUS_MODEL`).
2. `fetchCatalog(env)`; on failure: configured model -> return `null` (kept as-is); nothing configured ->
   `ConfigurationError`.
3. Rank Claude-compatible candidates for the tier (`isClaudeCompatibleModel`, `rankModel`, default bonus +
   version parts) -> `availableModels`.
4. `keepWithContextWindow()` closure: look up `currentBareId` via `findServableEntry`, run `applyContextWindow`
   on `currentModel`; if unchanged return `null`, else return `one-million-enabled` (result has `[1m]`) or
   `one-million-unsupported` (result lost it).
5. **Explicit source** (`tier === 'model'` and `CODEMIE_MODEL_SOURCE` in `cli`/`env`): no longer returns early
   with `null`; it returns `keepWithContextWindow()`. The catalog is fetched first, so a fetch failure keeps the
   model as-is and an id absent from the catalog stays untouched (no window known).
6. Model (bare or `[1m]` form) is in `availableModels` -> `keepWithContextWindow()`.
7. Model is outside the Claude family but live and servable in the catalog (router alias pinned to a tier) ->
   `keepWithContextWindow()`.
8. Otherwise model is retired: top-ranked replacement gets its own window via
   `applyContextWindow(ranked[0].id, findServableEntry(catalog, ranked[0].id)?.max_input_tokens)`; reason
   `unavailable`; a `logger.notice` names the swap. Nothing carries over from the retired model.

Consequences: `[1m]` is now applied to a bare configured id automatically (profile, `--model`, env, tier vars),
and removed from a configured `[1m]` id whose live entry reports a smaller window. Routers and any entry
without the field are never touched in either direction. The stale-looking log line at line 449-451 still says
"skipping catalog resolution" although the catalog is now consulted for the window.

### 4. `buildModelPickerOptions(env)` (line 338)

Filters `isServableModel && isClaudeFamilyPickerEntry`, sorts by `rankModel`/`compareRankedModels`, dedupes on
the ranked id, and emits **one row per model**: `model = applyContextWindow(id, model.max_input_tokens)`,
`label = model.label || id` (unchanged, no "(1M context)" text), `description = describeRouter(...)`. Returns
`[]` on any error. Because the label is unchanged, the picker gives no visual cue which rows run at 1M; the
only difference is the `model` value.

### 5. Data flow (catalog -> env / `--settings` -> Claude Code -> statusline)

1. `claude.plugin.ts` `beforeRun` (line ~382), skipped for `anthropic-subscription`: loops the four tiers
   calling `resolveClaudeModel`. On a non-null result it writes `env[CODEMIE_*]` and the native vars
   (`ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL`). Each tier is try/caught independently.
2. Stderr warning (tier `model` only, when `previousModel !== selectedModel`): skipped for
   `one-million-enabled`; `one-million-unsupported` prints "does not support 1M context"; `unavailable` prints
   "not available in this CodeMie catalog" plus the `codemie models list` hint.
3. Same `beforeRun` then exports `CODEMIE_ROUTER_MODEL_IDS` (`listRouterModelIds`) and `CODEMIE_MODEL_LABELS`
   (`buildModelLabelMap`) for the detached statusline, and calls `buildModelPickerOptions`; a non-empty result is
   written as `{modelPicker:{options, replaceBuiltInOptions:true}}` to a temp file and exported as
   `CODEMIE_CLAUDE_MODEL_PICKER_SETTINGS`.
4. `src/providers/core/default-agent-hooks.ts` `enrichArgs` (lines ~73-90) prepends `--model $CODEMIE_MODEL`
   (unless `--model` present) and `--settings <picker file>` (unless `--settings` present). So the `[1m]` id
   reaches Claude Code through `--model`, which outranks `settings.json`.
5. All four calls share one `fetchCatalog` result (module-level 5-minute TTL cache keyed
   `jwt:<baseUrl>` or `sso:<CODEMIE_URL>`), so there is one network call per run.
6. `plugin/statusline.ts` (committed, unchanged in the working tree): `isRoutingConfigured` and
   `lookupNominalLabel` strip a trailing `[1m]` before router-id and label lookups, because Claude Code reports
   `<id>[1m]` in `model.id` while the catalog lists carry bare ids. `statusline.test.ts` covers this
   (lines ~105-125) and is unchanged.
7. Auth path for local runs: `--jwt-token` sets `CODEMIE_AUTH_METHOD=jwt` in `AgentCLI.ts` (~line 359); provider
   stays `ai-run-sso`; `fetchCatalog` takes the JWT branch (`CODEMIE_JWT_TOKEN` + `CODEMIE_BASE_URL`) before the
   SSO branch.

### 6. Model source marker

`AgentCLI.ts` sets `CODEMIE_MODEL_SOURCE` to `cli` (`--model`), `env` (`CODEMIE_MODEL` already in process env) or
`default` (profile) at ~line 374; `bin/codemie-copilot.js` sets it for Copilot. `EXPLICIT_MODEL_SOURCES` is now
consumed only to choose between two branches that both call `keepWithContextWindow`, so its practical effect for
the `model` tier is reduced to "skip the retired-model swap and the family-outside checks".
`codex/codex-models.ts` has its own copy of the marker set and is unaffected.

### 7. Other consumers of `LlmModel` / the catalog

`fetchCodeMieLlmModels` is also used by `sso.models.ts`, the gemini/codex/pi/kimi/opencode/copilot-cli model
modules and two proxy normalizer plugins. The new field is optional and read only by `claude.models.ts`, so
those are unaffected. `anthropic-subscription` bypasses all of this (its template still carries a literal
`claude-opus-4-6[1m]` in a test fixture).

### 8. Test surface

Framework: Vitest. `.ai-run/guides/testing/testing-patterns.md` is the convention source (dynamic imports after
mocks). I did not run the suite (repo policy: tests only on explicit request); the brief reports tsc, eslint (0
warnings) and 219 passing tests under `src/agents/plugins/claude`.

- `claude.models.test.ts` mocks `fetchCodeMieLlmModels`, uses a unique `CODEMIE_BASE_URL` per test to defeat the
  TTL cache, and builds entries with a `model()` factory that carries `max_input_tokens`. Groups: explicit
  `--model` override (7 cases, including fetch-failure keeps model and explicit model gaining `[1m]`);
  "catalog context window" (add `[1m]`, keep `[1m]`, drop `[1m]` on smaller window, leave bare, no-window
  `it.each` on both forms, router untouched, tier vars sized regardless of source, replacement gets its own
  window, no double suffix); `buildModelPickerOptions` (one row per model, no "(1M context)" row, no window ->
  bare, no double suffix).
- `claude.plugin.model-swap-warning.test.ts` — new case: `one-million-enabled` yields empty stderr and
  `env.CODEMIE_MODEL === 'claude-opus-5[1m]'`; existing cases keep the "not available" + hint and "does not
  support 1M context" messages.
- Other Claude tests that mock `claude.models.js` (`claude.plugin.subagent-warning.test.ts`) return `null` from
  `resolveClaudeModel` and are unaffected. `AgentCLI-model-source.test.ts` covers the source marker with a `[1m]`
  id.
- Gaps: no test for a non-numeric `max_input_tokens` (string/`null`/`NaN`); no test for the exact 1_000_000
  boundary vs 999_999; no test that a disabled/non-servable entry with a window is ignored; no test of
  `CODEMIE_SONNET_MODEL`-style tier var interacting with the subagent pin (finding under Risk Indicators); no
  automated test of the end-to-end `--settings` picker file content (only the brief's manual run).

## Risk Indicators

- **Hard dependency on a backend deploy.** Everything hinges on `max_input_tokens` being present in
  `/v1/llm_models`. There is no fallback: when the field is absent (older backend, static-YAML catalog, routers)
  `applyContextWindow` returns the id untouched, so 1M-capable models silently stay at 200k with no warning or
  log at info level. Against an un-updated tenant the feature is a no-op, not an error.
- **Behavior change: every 1M-capable model now always runs at 1M.** Bare ids in profiles, `--model`, env and
  tier vars all gain `[1m]`, including subagent tiers. That means long-context pricing/rate-limits apply on
  every session with no per-run opt-out short of an id the catalog does not list (an unlisted id is untouched).
  The stderr warning is deliberately suppressed for `one-million-enabled`, so users are not told.
- **Explicit `--model` no longer skips the catalog.** It now costs a catalog fetch and can be rewritten (`[1m]`
  added or dropped). Fetch failure falls back to keeping it as-is. A user who passes `--model X[1m]` for a model
  the catalog reports smaller gets `X` plus the "does not support 1M context" warning.
- **Routers get no `[1m]`.** A router entry carries no window, so a router-backed session never opts in, even if
  its target model would support 1M. The user can still type `/model <router>[1m]`, and the statusline handles
  the suffix.
- **Untrusted backend value.** `LlmModel` is a cast over `JSON.parse`; a wrong type (string) is treated as
  "absent", and any number `< 1_000_000` strips an existing `[1m]`. A backend reporting a wrong small number
  would silently downgrade a model a user had deliberately pinned to `[1m]`.
- **Id collision in `findServableEntry`.** It matches deployment_name, base_name or label, first match wins, so
  a label equal to another model's id could pick the wrong entry's window. Same first-match caveat in the picker
  dedupe (`seen` set keyed by ranked id).
- **Picker gives no 1M signal.** Label is unchanged and there is only one row, so users cannot choose the
  smaller window from `/model` (it is intentionally max-window only).
- **Speculative:** `CLAUDE_CODE_SUBAGENT_MODEL` is pinned in `BaseAgentAdapter.transformEnvVars` (runs before
  `beforeRun`) from the bare tier ids, while `beforeRun` only rewrites `ANTHROPIC_*` vars. A pinned subagent
  model could therefore stay bare while the session model gains `[1m]`; it would also be compared against
  `CODEMIE_MODEL` before it changed. Not verified against Claude Code.
- **Speculative:** `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` (set for every provider except `ai-run-sso` and
  `litellm`, `claude.plugin.ts` ~line 237) may also suppress the `context-1m` beta header on Bedrock/JWT-only
  providers. Carried over from the earlier analysis; still unverified.
- **Stale text left behind.** The log at `claude.models.ts:449-451` ("skipping catalog resolution"), and the
  comment at `claude.plugin.ts:431-433` ("non-null only when the model was stale/absent") no longer describe the
  code. Also `.codemie/codemie-cli.config.json` has an unrelated local edit that must not ship with this change.
- **No documentation.** Neither `.ai-run/guides/` nor `openwiki/` nor `docs/` mentions `[1m]` or
  `max_input_tokens`, so the behavior is undocumented for users and for the next reader.

## Summary

- The feature is a small, catalog-driven change touching three source files: one optional field on `LlmModel`
  (`sso.http-client.ts`), one helper plus rewritten resolution and picker logic (`claude.models.ts`), and a
  warning gate (`claude.plugin.ts`). The statusline already strips `[1m]` for lookups and is unchanged. Layers
  affected: provider HTTP client, agent plugin model resolution, plugin `beforeRun` lifecycle, and Claude Code's
  launch args and env. Net code shrank (~-244/+230 including tests), and the earlier regex table is gone.
- `resolveClaudeModel` now normalizes every model that stays to its catalog window and gives a retired model's
  replacement its own window. `buildModelPickerOptions` lists one row per model at max window. A catalog without
  `max_input_tokens` is a no-op by design (routers, static catalogs, older backends).
- Test coverage is solid for the resolution, picker and warning paths (Vitest, mocked catalog). Gaps are edge
  values of the backend field and the subagent pin interaction. The main non-code risks are the backend
  deployment dependency and the always-on 1M behavior change (pricing), plus the two unverified interactions
  with `CLAUDE_CODE_SUBAGENT_MODEL` and `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`.
