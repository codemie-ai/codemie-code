# Codex Explicit Model Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `resolveCodexModel` honor `env.CODEMIE_MODEL` when it is a Codex-compatible model present in the available list, instead of always selecting the top-ranked model.

**Architecture:** Two changes in `resolveCodexModel` (`src/agents/plugins/codex/codex-models.ts`): (1) replace the unconditional `rankedModels[0].id` selection with a conditional that prefers `currentModel` when it is Codex-compatible and present in the ranked set; (2) replace the silent `logger.info` substitution notice with a `console.error` that is visible to the user when a Codex-compatible requested model is unavailable and falls back to the top-ranked one. No other files require changes.

**Tech Stack:** TypeScript, Node.js ESM, existing `isCodexCompatibleModelName` predicate, `logger` (file-only), `console.error` (stderr, user-visible).

---

### Task 1: Fix model selection and substitution notice in `resolveCodexModel`

**Test-first:** no — no tests requested; validate via build + typecheck + manual reproduction command.

**Files:**
- Modify: `src/agents/plugins/codex/codex-models.ts:292-299`

- [ ] **Step 1: Read the current function**

  Open `src/agents/plugins/codex/codex-models.ts` and locate `resolveCodexModel` (starts at line 256). Confirm the exact text at lines 292–299:

  ```typescript
  const selectedModel = rankedModels[0].id;
  const catalogPath = await writeCatalogFile(buildCodexCatalog(rankedModels));

  if (currentModel && currentModel !== selectedModel) {
    logger.info(
      `[codex-models] Using ${selectedModel} for Codex instead of profile model ${currentModel}`
    );
  }
  ```

- [ ] **Step 2: Replace the selection logic and substitution notice**

  Replace lines 292–299 with:

  ```typescript
  const rankedIds = rankedModels.map(entry => entry.id);
  const selectedModel =
    isCodexCompatibleModelName(currentModel) && rankedIds.includes(currentModel)
      ? currentModel
      : rankedModels[0].id;
  const catalogPath = await writeCatalogFile(buildCodexCatalog(rankedModels));

  if (isCodexCompatibleModelName(currentModel) && currentModel !== selectedModel) {
    console.error(`[codemie-codex] Requested model "${currentModel}" is not available; using ${selectedModel} instead.`);
    logger.info(
      `[codex-models] Using ${selectedModel} for Codex instead of requested model ${currentModel}`
    );
  }
  ```

  Key points:
  - `rankedIds` is derived from `rankedModels` (the already-filtered, available set) — this is the correct membership check.
  - `isCodexCompatibleModelName(currentModel)` gates both the selection preference and the notice: non-Codex profile defaults (e.g. `claude-sonnet-4-6`) fall through to `rankedModels[0].id` silently, matching existing behavior.
  - `console.error` writes to stderr; `logger.info` preserves the file log. The notice fires only when a Codex-compatible model was requested but is unavailable — not on every run.
  - `writeCatalogFile(buildCodexCatalog(rankedModels))` is unchanged — the catalog is always built from all ranked models, independent of the selected model.

- [ ] **Step 3: Run typecheck**

  ```bash
  npm run typecheck
  ```

  Expected: zero errors. If TypeScript reports `currentModel` narrowing issues (since `isCodexCompatibleModelName` is a type guard returning `modelName is string`), the guard on the ternary already narrows `currentModel` to `string` inside the true branch — no cast needed.

- [ ] **Step 4: Run lint**

  ```bash
  npm run lint
  ```

  Expected: zero warnings (zero-warning policy).

- [ ] **Step 5: Run build**

  ```bash
  npm run build
  ```

  Expected: builds to `dist/` without errors.

- [ ] **Step 6: Commit**

  ```bash
  git add src/agents/plugins/codex/codex-models.ts
  git commit -m "fix(codex): honor explicit --model flag in resolveCodexModel"
  ```

---

## Verification

After the commit, confirm the fix against the reproduction command from the spec:

```bash
node ./bin/codemie-codex.js --model gpt-5.3-codex-2026-02-24 --reasoning-effort high --task "say hi"
```

Expected: the spawned `codex` command includes `--model gpt-5.3-codex-2026-02-24`, not `gpt-5.4-*`.

Also confirm the fallback case — with a non-Codex profile default (e.g. `CODEMIE_MODEL=claude-sonnet-4-6`):

```bash
CODEMIE_MODEL=claude-sonnet-4-6 node ./bin/codemie-codex.js --task "say hi"
```

Expected: auto-selects a Codex model (gpt-5.4 or equivalent), no stderr notice (because `claude-sonnet-4-6` is not Codex-compatible, so the notice condition is false).
