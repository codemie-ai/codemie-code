# Spec: Honor explicit `--model` flag in `codemie-codex`

**Status:** Approved  
**Date:** 2026-06-17  
**Area:** `src/agents/plugins/codex/codex-models.ts`

---

## Problem

`codemie-codex --model <model>` silently substitutes a different model instead of honoring the requested one. `resolveCodexModel` always selects `rankedModels[0].id` — which is `gpt-5.4` due to a `preferredDefaultBonus` in `rankModel` — even when `currentModel` (`env.CODEMIE_MODEL`) is a Codex-compatible model present in the available list.

## Fix

**Single function, two logical changes in `src/agents/plugins/codex/codex-models.ts`.**

### 1. Honor `currentModel` in model selection (line 292)

After `rankedModels` is computed, prefer `currentModel` when it is Codex-compatible and present in the ranked set:

```typescript
const rankedIds = rankedModels.map(entry => entry.id);
const selectedModel =
  isCodexCompatibleModelName(currentModel) && rankedIds.includes(currentModel)
    ? currentModel
    : rankedModels[0].id;
```

### 2. Substitution notice — user-visible on stderr (lines 295–299)

Only fire when actually overriding a Codex-compatible requested model, and emit on stderr so the user sees it:

```typescript
if (isCodexCompatibleModelName(currentModel) && currentModel !== selectedModel) {
  console.error(`[codemie-codex] Requested model "${currentModel}" is not available; using ${selectedModel} instead.`);
  logger.info(`[codex-models] Using ${selectedModel} for Codex instead of requested model ${currentModel}`);
}
```

## Behavioral matrix

| `currentModel` (`env.CODEMIE_MODEL`) | Selected model |
|---|---|
| Codex-compatible + in available list (e.g. `gpt-5.3-codex-2026-02-24`) | The requested model |
| Codex-compatible + NOT in available list | Top-ranked + stderr notice |
| Non-Codex (e.g. `claude-sonnet-4-6`) | Top-ranked, silently |
| Unset | Top-ranked (unchanged) |

## Out of scope

- `AgentCLI.ts` — no change needed (Option B rejected).
- `setupProxy` / `enrichArgs` — both already consume the resolved value correctly.
- LiteLLM path (`codex.plugin.ts:511–521`) — already honors `env.CODEMIE_MODEL` directly; not touched.
- Ranking heuristics / `preferredDefaultBonus` — only selection logic changes.

## Acceptance criteria

1. `codemie-codex --model gpt-5.3-codex-2026-02-24 --task "say hi"` spawns `codex … --model gpt-5.3-codex-2026-02-24 exec …`.
2. A non-Codex profile default still auto-selects a Codex model.
3. When a requested Codex-compatible model is unavailable, a stderr notice is shown.
4. LiteLLM path is unchanged.
5. Build, lint, and typecheck pass.
