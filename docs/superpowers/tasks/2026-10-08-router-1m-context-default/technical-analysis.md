# Technical Research

**Task**: claude router context window
**Generated**: 2026-10-08
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-15754 — Enable 1M context ([1m]) by default for Claude routers, the same way it is already done for regular models (codemie-code PR #589 / commit 7d5d9a7: catalog-driven via LlmModel.max_input_tokens -> applyContextWindow in src/agents/plugins/claude/claude.models.ts). Routers were excluded because their Haiku 4.5 tier capped at 200k; router tiers now use Haiku 5.5 (1M). Agreed design: the backend (~/mdtu_gpt/code-assistant, see its commit 2d050566 which added LLMModel.max_input_tokens) exposes LlmRouterOption.max_input_tokens = minimum max_input_tokens across the router's distinct tier models (None if any tier model is missing/unknown), built in src/codemie/service/llm_service/llm_service.py (_build_switchyard_router_option, _build_litellm_auto_router_option) and src/codemie/configs/llm_config.py. The CLI (this repo) then yields <router>[1m] with no new logic; only stale comments in claude.models.ts (applyContextWindow doc, ~line 209) and src/providers/plugins/sso/sso.http-client.ts (max_input_tokens doc, ~line 167) need fixing. Verify by reading that router catalog entries reach applyContextWindow in buildModelPickerOptions, keepConfiguredModel, replaceRetiredModel, and the statusline. Prior design artifacts: docs/superpowers/specs/2026-10-08-router-1m-context-design.md, docs/superpowers/plans/2026-10-08-router-1m-context.md, docs/superpowers/tasks/2026-09-28-epmcdme-14763-claude-1m-context/technical-analysis.md. Repo policy (AGENTS.md): tests only on explicit user request; git ops only on explicit request. Also research whether RouterTier.model for litellm_auto routers is always a catalog base_name (backend repo).

---

## 2. Codebase Findings

### Existing Implementations (CLI, this repo)
- `src/agents/plugins/claude/claude.models.ts` — all window logic. `applyContextWindow(id, maxInputTokens)` (l.212): `typeof !== 'number'` -> id untouched; `>= 1_000_000` -> `<bare>[1m]`; smaller -> bare id. Doc comment at l.207-211 says "A catalog that reports no window (routers, static-config catalogs) decides nothing" -> stale once backend sends router windows (partially: still true for static catalogs and for routers with an unknown tier).
- `src/providers/plugins/sso/sso.http-client.ts` l.165-169 — `LlmModel.max_input_tokens?: number`; doc says "Absent on routers and on catalogs served from static config rather than the LiteLLM proxy." Stale for routers. The same `LlmModel` interface already models router entries (`is_router`, `router_type`, `tiers`, `litellm_router`), so router entries and plain models share one type; no type change is needed. `fetchCodeMieLlmModels` JSON-parses and casts (no validation), so a new field on router entries arrives as-is.
- Other stale wording (tests, not source): `claude/__tests__/claude.models.test.ts` l.286 test title "never touches [1m] on a router, which carries no window" (still passes because the fixture omits `max_input_tokens`, but the title/premise changes).
- Prior-art artifact: `docs/superpowers/tasks/2026-09-28-epmcdme-14763-claude-1m-context/technical-analysis.md` (catalog-driven design; no hard-coded capability table).

### Verification: do router entries reach applyContextWindow? (all read, all YES)
- **buildModelPickerOptions** (l.337-370): filter is `isServableModel(model) && isClaudeFamilyPickerEntry(model)` (routers included via `counterfactual_model` or name pattern, e.g. `sy-signal-claude-...`); then `applyContextWindow(rankedModel.id, model.max_input_tokens)` at l.365 reads the field straight off the router entry. A router entry has no `features`/`deployment_name`; `getModelId` falls back to `base_name`, `modelIdentifiers` drops undefined values. Works.
- **keepConfiguredModel** (l.394-404): `findServableEntry(catalog, bareId)` matches via `modelIdentifiers` (deployment_name/base_name/label); a router (`enabled: true`, no `features`) is servable -> `.max_input_tokens` -> `applyContextWindow`. Reached from `resolveClaudeModel` via `keepWithContextWindow()` on three paths: explicit `--model` source (l.~470), id in ranked Claude candidates (l.~480), and the "live in unfiltered catalog but outside Claude family" branch (l.~490, which exists specifically so router aliases like `claude-smart-router` aren't replaced). Reasons: `one-million-enabled` / `one-million-unsupported`.
- **replaceRetiredModel** (l.424-437): `findServableEntry(catalog, ranked[0].id)?.max_input_tokens` — only for catalog-ranked candidates; a router that is Claude-named (`isClaudeCompatibleModel` checks base_name/label/provider text) can rank here and gets its own window.
- **claude.plugin.ts** (l.405-445): `[1m]` gain is silent (`reason !== 'one-million-enabled'` gate); a dropped `[1m]` warns "does not support 1M context". New router `[1m]` defaults go through the same silent path. `env[generic]` and native vars (`ANTHROPIC_DEFAULT_*_MODEL`) are overwritten with the suffixed id.
- **Statusline** (`claude/plugin/statusline.ts` l.233-253, 801-810): `isRoutingConfigured` and `lookupNominalLabel` already strip `[1m]` and fall back to the bare id; `listRouterModelIds()` / `buildModelLabelMap()` publish bare ids (`CODEMIE_ROUTER_MODEL_IDS`, `CODEMIE_MODEL_LABELS`, set at claude.plugin.ts l.464/471). Tested in `statusline.test.ts` l.107-131 using `sy-smart-router[1m]`. No change needed.
- Proxy: no `[1m]` handling in `src/providers`, `src/agents/core`, `src/utils` (per 14763 analysis); Claude Code strips the suffix and adds the context-1m beta itself, so the proxy sees the bare router id.

### Backend facts (`~/mdtu_gpt/code-assistant`, HEAD 1c9ab1faf; working tree has unrelated edits to litellm_config.yaml, docker-compose.yml, .codemie config)
- `src/codemie/configs/llm_config.py`: `LLMModel.max_input_tokens: Optional[int]` (l.221, added by 2d050566 in llm_config.py + `enterprise/litellm/models.py` l.161/180). `LlmRouterOption` (l.187-208) has **no** `max_input_tokens` today — the backend change is not yet implemented. `RouterTier{model: str, label: str|None}`; `RouterTiers` has fixed keys simple/medium/complex/reasoning.
- `src/codemie/service/llm_service/llm_service.py`: `_switchyard_tiers(capable, efficient)` (l.113) builds tiers from `efficient.base_name` / `capable.base_name`. `_build_switchyard_router_option` (l.120-158) resolves `capable`/`efficient` via `by_name.get(...)`; either may be `None` (then `tiers=None`). `_build_litellm_auto_router_option` (l.160-190) is a `@staticmethod` taking only `(model, include_all, premium_enabled)` — **no `by_name`**, and passes `tiers=litellm_router.tiers` through verbatim. `get_allowed_router_options` (l.192) already builds `by_name = {m.base_name: m}` from `get_all_llm_model_info()` but does not hand it to the litellm_auto builder.
- `src/codemie/rest_api/routers/llm_models.py` l.37-62: `GET /llm_models` returns `chat_models + router_options`, `response_model=List[Union[LLMModel, LlmRouterOption]]`, `response_model_exclude_none=True`. A `None` window is therefore omitted from JSON (CLI sees `undefined` -> id untouched, matching the agreed design). A new field must be declared on `LlmRouterOption` or it is dropped.
- A litellm_auto router is **excluded** from chat models (`get_allowed_chat_models` filters `is_declared_litellm_router()`, l.~628) so the CLI sees it only as an `LlmRouterOption` — its own `LLMModel.max_input_tokens` (from LiteLLM model_info) is never sent. The router option is the only place the window can come from.

### RouterTier.model for litellm_auto: is it always a catalog base_name? **Not guaranteed.**
- Switchyard: yes by construction (`_switchyard_tiers` uses `LLMModel.base_name`; `_try_build_switchyard_router` skips pairs where capable/efficient are themselves litellm routers).
- litellm_auto: `RouterTier.model` is a free `str` copied from the hand-authored `model_info.litellm_router.tiers` block in LiteLLM's proxy config (comment on `LiteLLMRouterConfig`: "hand-authored directly into this model_name's model_info"). No validator, no lookup against the catalog, and no test asserts membership. Tests use `gpt-5-mini`, `gpt-5`, `gpt-5-pro`. In the live LiteLLM catalog `base_name == deployment_name == model_name` (models.py: `base_name=model_name, deployment_name=model_name`), and LiteLLM auto-router configs reference `model_name`s, so it is *conventionally* a base_name. Failure modes: (a) a tier names an alias/deployment not in `by_name`; (b) a tier names a disabled or non-chat model; (c) a tier names another router (no router-on-router guard on the litellm_auto path in the option builder); (d) `by_name` is built from the global `get_all_llm_model_info()` while chat models are per-user (`get_allowed_models(user)`), so a user with a custom integration may see a window computed from a model they cannot see. A malformed `litellm_router` block is dropped with a warning at parse time (models.py l.~145-152), after which the model is no longer a declared router.
- Consequence: the "None if any tier model is missing/unknown" rule is required, not defensive, for litellm_auto. Also `tiers is None` (strategy-only router) must map to `None`.

### Architecture and Layers Affected
- Backend: config model (`llm_config.py` `LlmRouterOption`), service (`llm_service.py` two builders), REST boundary (no code change; `Union` response). CLI: provider type docs (`sso.http-client.ts`) and agent plugin comments (`claude.models.ts`) only — behavior unchanged.

### Patterns and Conventions
- ES modules, `.js` import suffix, `@/` alias, `logger.debug`, no `any`. Backend: Pydantic models, `response_model_exclude_none=True` for optional fields, `by_name` dict lookups, static builders.

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/` present (architecture, integration/external-integrations, testing, etc.); none mentions router context windows (grep clean). `openwiki/` and `docs/*.md` also contain no router+1M statements, so no other prose needs updating.

### Architectural Decisions
- 14763 design: catalog decides the window; Claude Code owns `[1m]` semantics; never guess `[1m]` onto an id with no reported window. Router-specific exclusion was by omission of the field, not by code (the former `isRouterLikeEntry` was removed in 7d5d9a7).

### Derived Conventions
- Comments say "absent on routers" in exactly two source places (l.209 of claude.models.ts; l.167 of sso.http-client.ts). Suggested replacement wording: window is absent on static-config catalogs and on a router whose tier models are not all known; otherwise it is the minimum across the router's tier models.

---

## 4. Testing Landscape

### Existing Coverage
- `claude/__tests__/claude.models.test.ts` — window cases per tier, picker (l.367-376 router row stays bare without a window), router-with-window listing fixture `routerModel` (l.427-429 already has `max_input_tokens: ONE_MILLION` + `is_router`), `listRouterModelIds` cases.
- `claude/__tests__/claude.plugin.model-swap-warning.test.ts` — silent `[1m]` gain / dropped-window warning.
- `claude/plugin/__tests__/statusline.test.ts` — `[1m]` stripping for router ids/labels.
- Backend: `tests/codemie/configs/test_llm_config.py` (LiteLLMRouterConfig tiers parsing), `tests/enterprise/litellm/test_models.py` (max_input_tokens mapping), router-option tests under `tests/codemie/service/` (not opened).

### Testing Framework and Patterns
- CLI: Vitest ^4.1.5, dynamic-import mocking of `fetchCodeMieLlmModels`. Backend: pytest.

### Coverage Gaps
- No CLI test asserts a router entry *with* a 1M window yields `<router>[1m]` through picker, keepConfiguredModel or replaceRetiredModel (the l.286 test covers only the no-window case). No backend test for min-across-tiers (not yet written). Per AGENTS.md, CLI tests only on explicit request.

---

## 5. Configuration and Environment

### Environment Variables
- `CODEMIE_MODEL`, `CODEMIE_HAIKU_MODEL`, `CODEMIE_SONNET_MODEL`, `CODEMIE_OPUS_MODEL`, `CODEMIE_MODEL_SOURCE` (explicit-model gate), `CODEMIE_ROUTER_MODEL_IDS`, `CODEMIE_MODEL_LABELS` (statusline inputs), `CODEMIE_JWT_TOKEN`/`CODEMIE_BASE_URL`. The catalog has a 5-minute module TTL cache (`CATALOG_TTL_MS`), so a backend rollout takes up to 5 minutes to show in a running process.

### Configuration Files
- Backend router declarations: `litellm_config.yaml` (local copy has no `litellm_router` blocks; real ones live in the deployed LiteLLM proxy config, outside both repos) and static `llm-<env>-config.yaml` (`switchyard:` entries).

### Feature Flags and Deployment Concerns
- None. Rollout order matters: backend must ship the field before the CLI shows `[1m]`; CLI comment fixes are inert and order-independent. Older CLIs ignore the new field (cast, no validation).

---

## 6. Risk Indicators

- Speculative: `RouterTier.model` for litellm_auto is unvalidated free text; an unmatched name must yield `None`, not skip the tier, or the router would be offered `[1m]` on a 200k tier.
- Speculative: `_build_litellm_auto_router_option` is a staticmethod without `by_name`; computing the window requires passing the catalog map (signature change affects its callers/tests).
- Speculative: the min is over the global catalog (`get_all_llm_model_info`) while the visible model list is per-user; a custom-integration user may get a window not matching their tier models.
- Router tier models that are themselves routers, or disabled, are not excluded by the current builder.
- A router that dispatches to a tier whose window is below 1M, while advertised `[1m]`, would fail on long contexts — the min rule is the only guard.
- Stale premise in test title `claude.models.test.ts:286` and two source comments; ~3 files of CLI edits, comments only.
- `.codemie/codemie-cli.config.json` and backend `litellm_config.yaml`/`docker-compose.yml` have unrelated local modifications; do not include them.
- Referenced spec/plan files (2026-10-08-router-1m-context-*) do not exist in this repo.

---

## 7. Summary for Complexity Assessment

The CLI side is trivially small: the router catalog entry already flows through `applyContextWindow` in `buildModelPickerOptions` (l.365), `keepConfiguredModel` (via `findServableEntry` by base_name), `replaceRetiredModel` and the statusline (which already strips `[1m]`), because routers share the `LlmModel` type and the logic keys only on the `max_input_tokens` field. Behavioral CLI change is zero; the work is two stale doc comments (`claude.models.ts` ~l.207-211, `sso.http-client.ts` l.165-169), plus optionally a router-with-window test and a retitled l.286 test (only on explicit request).

The substantive work is in the backend repo: add `max_input_tokens: Optional[int]` to `LlmRouterOption` and compute the minimum across distinct tier models in two builders (`llm_service.py`), returning None when any tier model is unresolved. Switchyard tier models are base_names by construction; litellm_auto `RouterTier.model` is hand-authored in LiteLLM config and unvalidated, so unmatched/absent/None-window tier models must collapse to None. The litellm_auto builder currently lacks the `by_name` map. This is cross-repo and has a rollout ordering dependency, but low novelty (mirrors 2d050566).

Test posture: CLI window logic is well covered for plain models, with a gap for a router that has a window. Risks are data-quality (unvalidated tier names, per-user vs global catalog) rather than architectural.

---

## 8. External References

- `~/mdtu_gpt/code-assistant` — resolved. Facts used: backend HEAD 1c9ab1faf; commit 2d050566 changed `llm_config.py` (+1) and `enterprise/litellm/models.py` (+2) only; `LlmRouterOption` has no `max_input_tokens` yet; builders at `llm_service.py` l.120 and l.160; `/llm_models` returns `Union[LLMModel, LlmRouterOption]` with `response_model_exclude_none=True`; RouterTier.model finding in Section 2.
- `docs/superpowers/tasks/2026-09-28-epmcdme-14763-claude-1m-context/technical-analysis.md` — resolved; facts folded into Sections 2 and 3.
- `docs/superpowers/specs/2026-10-08-router-1m-context-design.md` and `docs/superpowers/plans/2026-10-08-router-1m-context.md` — **unresolved**: do not exist (only the run dir `tasks/2026-10-08-router-1m-context-default/state.local.json` was present).
- codemie-code commit 7d5d9a7 (PR #589) — resolved via git; touched claude.models.ts, claude.plugin.ts, statusline.ts, sso.http-client.ts and tests.
