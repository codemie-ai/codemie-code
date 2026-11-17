# EPMCDME-16292 Pi SSO Provider and Supported Version Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Pi 1.4.0 accept the generated `models.json` so `codemie-anthropic` / `codemie-proxy` / `ollama` providers resolve, and make `codemie install pi --supported` resolve a pinned version.

**Architecture:** Two independent fixes in the Pi agent plugin (`src/agents/plugins/pi/`). Task 1 drops the schema-invalid provider-level `compat.thinkingFormat` from the generated `models.json`. Task 2 adds a `PI_SUPPORTED_VERSION` pin to `PiPluginMetadata`, consumed unchanged by `BaseAgentAdapter.installVersion` (`src/agents/core/BaseAgentAdapter.ts:183-215`).

**Tech Stack:** TypeScript (ES modules, `.js` import suffixes, `@/` alias), Vitest.

**Spec:** Inline requirements (Jira EPMCDME-16292 + clarification decisions). Research: `technical-analysis.md` in this directory.

Commit per task using the repository's existing convention (Conventional Commits, referencing EPMCDME-16292).

## Acceptance criteria

- [ ] With an active SSO profile whose provider and model `codemie doctor` reports operational, `codemie-pi` launches. Pi does not fail with `Unknown provider "codemie-anthropic"` (or `"codemie-proxy"` / `"ollama"`).
- [ ] Generated `models.json` has no provider-level `compat.thinkingFormat` for any provider. All other compat fields (`supportsReasoningEffort`, per-model `compat`) are unchanged.
- [ ] `codemie install pi --supported` installs `@earendil-works/pi-coding-agent@1.4.0`. It does not throw `Pi: No supported version defined in metadata`.
- [ ] `PiPluginMetadata.minimumSupportedVersion` stays unset, so no installed Pi version is blocked from starting.
- [ ] `docs/superpowers/specs/2026-08-07-codemie-pi-design.md:116` no longer documents `thinkingFormat: "reasoning_effort"`.

## Global Constraints

- Supported version: `'1.4.0'`. No minimum supported version.
- Omit `thinkingFormat` entirely. Do not replace it with `'openai'` or any other literal.
- Keep `supportsReasoningEffort: true` and every per-model `compat` field.
- AC3 assumption: no reproduction exists. The only verified start blocker is the invalid `models.json`, fixed by Task 1. Make no speculative changes to `pi.packages.ts`, `pi.extension.ts` or warning handling.

## Review Focus

1. Static fallback path (live model fetch fails): it goes through `buildModelsConfig`, so it must also lack `thinkingFormat`. Covered in Task 1 tests.
2. Non-Claude model on SSO (`codemie-proxy`): it fails the same way as `codemie-anthropic`. Covered in Task 1 tests.
3. Ollama profile (`buildOllamaModelsConfig`): it is a separate code path. Covered in Task 1 tests.
4. Pi installed at an older version than 1.4.0 must still start (notice only, no block). Covered by the `minimumSupportedVersion` assertion in Task 2.

---

### Task 1: Remove provider-level `thinkingFormat` from generated models.json

**Files:**
- Modify: `src/agents/plugins/pi/pi.models.ts:301-304`, `:315-318`, `:389-392`
- Modify: `docs/superpowers/specs/2026-08-07-codemie-pi-design.md:116`
- Test: `src/agents/plugins/pi/__tests__/pi.models.test.ts` (new `describe` block)

**Interfaces:**
- Consumes: `fetchAndBuildPiModels(env, cwd)` (`pi.models.ts:404`) and `getPiModelsPath(cwd)` (`pi.paths.ts:15`).
- Produces: nothing new.

Test-first: yes — `fetchAndBuildPiModels` writes `models.json` in which no provider has `compat.thinkingFormat`. This fails today because all three providers emit `'reasoning_effort'`.

- [ ] **Step 1: Write the failing tests.** Add `describe('fetchAndBuildPiModels — provider compat accepted by Pi', …)`. Each test uses a `mkdtemp` cwd and removes it in `afterEach`, then reads the JSON back via `getPiModelsPath(cwd)`. Cases:
  - `env = { CODEMIE_BASE_URL: 'http://127.0.0.1:4000', CODEMIE_MODEL: 'claude-sonnet-4-6' }` has no JWT/URL. Auth throws, so the code takes the static fallback and emits `providers['codemie-anthropic']`.
  - Same with `CODEMIE_MODEL: 'gpt-5.4'`, which emits `providers['codemie-proxy']`.
  - `CODEMIE_PROVIDER: 'ollama'`, `CODEMIE_MODEL: 'qwen3'`. `vi.mock` `providers/plugins/ollama/ollama.models.js` so `OllamaModelProxy.prototype.fetchModels` rejects. Keep `toCloudOffloadTag` as an identity. This emits `providers.ollama`.

  For every provider in each file, assert:
  ```ts
  expect(provider.compat).not.toHaveProperty('thinkingFormat');
  expect(provider.compat?.supportsReasoningEffort).toBe(true);
  ```
- [ ] **Step 2: Run** `npx vitest run src/agents/plugins/pi/__tests__/pi.models.test.ts`. Expected: the 3 new tests FAIL on `thinkingFormat`.
- [ ] **Step 3: Implement.** Delete the `thinkingFormat: 'reasoning_effort'` line in each of the three `compat` objects. Leave `supportsReasoningEffort: true`. Above `PiModelsConfig` (`pi.models.ts:243`), add a one-line comment: Pi validates provider `compat` against a strict schema, and an unknown `thinkingFormat` literal makes Pi drop the whole file. Then update the design doc line 116: provider-level `compat` is `supportsReasoningEffort: true` only, and `thinkingFormat` is omitted so Pi auto-detects it (its 1.x schema rejects `"reasoning_effort"`).
- [ ] **Step 4: Run** the same command. Expected: PASS, including the existing tests.

### Task 2: Pin Pi supported version 1.4.0

**Files:**
- Modify: `src/agents/plugins/pi/pi.plugin.ts` (constant after the imports, around l.23; field in `PiPluginMetadata` near `npmPackage`, l.167)
- Create: `src/agents/plugins/pi/__tests__/pi.plugin.version-support.test.ts`

**Interfaces:**
- Consumes: `BaseAgentAdapter.installVersion('supported')`, which calls `installGlobal(npmPackage, { version })` from `utils/processes.js`.
- Produces: `PiPluginMetadata.supportedVersion === '1.4.0'`.

Test-first: yes — `PiPluginMetadata.supportedVersion` is `'1.4.0'`, and `installVersion('supported')` installs `@earendil-works/pi-coding-agent` at `1.4.0`. This fails today with `Pi: No supported version defined in metadata`.

- [ ] **Step 1: Write the failing test.** Model it on `src/agents/plugins/codex/__tests__/codex.plugin.version-support.test.ts:1-47,88-100`. Copy its `vi.mock` setup: the provider registry, `utils/processes.js` (`importActual` spread, with `installGlobal`/`exec`/`commandExists` as `vi.fn()`), and the logger. Then add these tests:
  - `expect(PiPluginMetadata.supportedVersion).toBe('1.4.0')`
  - `expect(PiPluginMetadata.minimumSupportedVersion).toBeUndefined()`
  - `await new PiPlugin().installVersion('supported')` and `expect(processes.installGlobal).toHaveBeenCalledWith('@earendil-works/pi-coding-agent', { version: '1.4.0' })`

  Check the exported plugin class name in `pi.plugin.ts` before writing this test.
- [ ] **Step 2: Run** `npx vitest run src/agents/plugins/pi/__tests__/pi.plugin.version-support.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Add `const PI_SUPPORTED_VERSION = '1.4.0';` with the `**UPDATE THIS WHEN BUMPING PI VERSION**` comment, following `kimi.plugin.ts:23-26`. The comment must also say that there is deliberately no minimum version. Add `supportedVersion: PI_SUPPORTED_VERSION,` to `PiPluginMetadata`. Do not add `minimumSupportedVersion`.
- [ ] **Step 4: Run** the same command. Expected: PASS.

<!-- negative-constraints:
- "omit the field entirely" / no replacement literal -> Task 1 deletes the line only; Global Constraints forbid 'openai'.
- "keep all other compat fields" -> Task 1 asserts supportsReasoningEffort stays true; per-model compat untouched.
- "Do NOT set a minimum supported version" -> Task 2 asserts minimumSupportedVersion is undefined.
- "no speculative code changes" (AC3) -> no task touches pi.packages.ts / pi.extension.ts.
-->
