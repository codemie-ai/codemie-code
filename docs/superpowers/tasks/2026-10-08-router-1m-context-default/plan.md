# EPMCDME-15754 Router 1M Context Default Implementation Plan

**Goal:** Claude routers get `[1m]` by default like regular models, driven by a new backend `LlmRouterOption.max_input_tokens` (min across tier models). The CLI needs no behavior change, only stale comments fixed.

**Architecture:** Backend (`/Users/Sviatoslav_Likhtarchyk/mdtu_gpt/code-assistant`) computes the window; router entries already reach `applyContextWindow` in the CLI (picker, keepConfiguredModel, replaceRetiredModel, statusline), so `<router>[1m]` follows automatically. Backend must ship before the CLI shows `[1m]` (CLI catalog cache is 5 min).

**Conventions:**
- Commit per task using the repository's existing convention, in codemie-code only (only when the user asks, per AGENTS.md).
- code-assistant: edit files IN PLACE on the current branch. NO commits, branches or stashes there. Do not touch or stage the unrelated edits to `docker-compose.yml` and `litellm_config.yaml`.
- Every task: `Test-first: no — repo policy (AGENTS.md): tests only on explicit user request`. Write and run no tests.

---

### Task 1: Backend — add `max_input_tokens` to `LlmRouterOption`

Test-first: no — repo policy (AGENTS.md): tests only on explicit user request

**Files:** Modify `code-assistant/src/codemie/configs/llm_config.py:187-206`

- [ ] Add `max_input_tokens: int | None = None` to `LlmRouterOption` (after `classifier_model`, l.206) with a one-line comment: minimum context window across the router's distinct tier models; None when any tier is unknown. `/llm_models` uses `response_model_exclude_none=True`, so None is omitted from JSON, which is what the CLI expects.

### Task 2: Backend — compute min tier window in both router builders

Test-first: no — repo policy (AGENTS.md): tests only on explicit user request

**Files:** Modify `code-assistant/src/codemie/service/llm_service/llm_service.py:112-206`

- [ ] Add static helper after `_switchyard_tiers` (l.118):

```python
    @staticmethod
    def _router_max_input_tokens(tiers: RouterTiers | None, by_name: dict[str, LLMModel]) -> int | None:
        """Minimum max_input_tokens across a router's distinct tier models. None when tiers are absent
        or any tier model is unresolved/windowless: an unknown tier must never allow a 1M opt-in."""
        if tiers is None:
            return None
        names = {tiers.simple.model, tiers.medium.model, tiers.complex.model, tiers.reasoning.model}
        windows: list[int] = []
        for name in names:
            tier_model = by_name.get(name)
            if tier_model is None or tier_model.max_input_tokens is None:
                return None
            windows.append(tier_model.max_input_tokens)
        return min(windows)
```

  Match by `base_name` only (`by_name` keys); any unmatched free-string litellm_auto tier value yields None.
- [ ] `_build_switchyard_router_option` (l.146-157): pass `max_input_tokens=self._router_max_input_tokens(tiers, by_name)` to `LlmRouterOption`.
- [ ] `_build_litellm_auto_router_option` (l.160-190): add `by_name: dict[str, LLMModel]` parameter right after `model`; pass `max_input_tokens=LLMService._router_max_input_tokens(litellm_router.tiers, by_name)` (it is a staticmethod, so call via the class). Ignore the router model's own `max_input_tokens`.
- [ ] Update the single call site in `get_allowed_router_options` (l.204) to `self._build_litellm_auto_router_option(model, by_name, include_all, premium_enabled)`.
- [ ] In code-assistant run `make ruff` and `make ruff-format` and fix any findings in these two files only. Leave no git changes beyond the two edited files from this task and Task 1.

### Task 3: CLI — fix stale router-window comments

Test-first: no — repo policy (AGENTS.md): tests only on explicit user request

**Files:** Modify `src/agents/plugins/claude/claude.models.ts:207-210`, `src/providers/plugins/sso/sso.http-client.ts:165-168`, `src/agents/plugins/claude/__tests__/claude.models.test.ts:286`

- [ ] `claude.models.ts` `applyContextWindow` doc: replace "(routers, static-config catalogs)" so only static-config catalogs and routers with an unknown tier are named as reporting no window; add that a router's window is the minimum of its tiers', computed by the backend. Code unchanged.
- [ ] `sso.http-client.ts` `max_input_tokens` doc: state that routers now carry the minimum tier window, absent when any tier is unknown; also absent on static-config catalogs and older backends. Type unchanged.
- [ ] `claude.models.test.ts:286`: reword only the `it(...)` title to drop the "router carries no window" premise (e.g. a router whose catalog entry reports no window); no assertions or fixtures changed, and do not run the test.
- [ ] Run `npm run typecheck` and `npm run lint` in codemie-code.

---

## Negative-constraint pass

- No tests written or run (AGENTS.md): honored by `Test-first: no` on all tasks; no test-writing steps. Task 3 retitles one existing test without executing it.
- No commits/branches/stashes in code-assistant; unrelated `docker-compose.yml`/`litellm_config.yaml` untouched: stated in conventions and Task 2.
- No CLI behavior change: Task 3 edits comments and a test title only.
- Router's own `max_input_tokens` must be ignored: Task 2 litellm_auto bullet.
- Unknown tier must never allow opt-in (no skipping of unmatched tiers): Task 2 helper returns None on any missing/windowless tier or `tiers is None`.
- Gates (CLI typecheck/lint, backend ruff/ruff-format): Tasks 2 and 3 as in-task commands requested by the user, not separate gate tasks.
