# Claude Model Auto-Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CodeMie-proxied Claude always resolves each model tier (`model`/`haiku`/`sonnet`/`opus`) from the live CodeMie catalog instead of a stale hardcoded list, without ever clobbering a value the user set; anthropic-subscription stops forcing its own separate hardcoded model list.

**Architecture:** New `claude.models.ts` mirrors the existing `resolveCopilotModel` fetch/filter/rank/select/fallback pattern (`src/agents/plugins/copilot-cli/copilot-cli.models.ts`), one call per tier. Wired into `ClaudePlugin`'s existing `beforeRun` hook, writing results onto both the generic `CODEMIE_*` vars and the already-projected native `ANTHROPIC_*`/`CLAUDE_CODE_SUBAGENT_MODEL` vars (since `transformEnvVars` already ran before `beforeRun`). `anthropic-subscription.template.ts` loses its independent hardcoded model source. No change to `BaseAgentAdapter`, `ConfigLoader`, `AgentCLI`, or any other agent plugin.

**Tech Stack:** TypeScript, Vitest (existing conventions), `fetchCodeMieLlmModels`/`CodeMieSSO` (existing SSO/JWT auth), `ConfigurationError` (`src/utils/errors.ts`), `logger` (`src/utils/logger.ts`).

**Spec:** `docs/superpowers/tasks/2026-08-19-claude-model-autoupdate/spec.md`

## Global Constraints

- Never silently override a tier the user explicitly configured (spec Goal 2).
- Claude-plugin-local + one provider-template change only — no edits to `BaseAgentAdapter`, `ConfigLoader`, `AgentCLI`, or Codex/Kimi/Copilot/Pi/OpenCode (spec Goal 4, Non-Goals).
- Fetch failure never blocks a run: silent fallback, `logger.debug` only (spec Error Handling table).
- No compatible model + no fallback: throw `ConfigurationError` naming the tier, never a generic `Error` (repo convention).
- Commit per task using the repository's existing convention.

---

### Task 1: `claude.models.ts` — per-tier live model resolver

**Files:**
- Create: `src/agents/plugins/claude/claude.models.ts`

**Interfaces:**
- Produces: `export type ClaudeModelTier = 'model' | 'haiku' | 'sonnet' | 'opus'`; `export async function resolveClaudeModel(env: NodeJS.ProcessEnv, tier: ClaudeModelTier): Promise<{ selectedModel: string; availableModels: string[] } | null>` (returns `null` when the tier's current value is non-empty and still present in the live catalog — nothing to change).
- Consumes: `fetchCodeMieLlmModels`, `LlmModel` (`src/providers/plugins/sso/sso.http-client.ts`); `CodeMieSSO` (`src/providers/plugins/sso/sso.auth.ts`); `ConfigurationError` (`src/utils/errors.ts`); `logger` (`src/utils/logger.ts`).

Verified fact overriding the spec's `CODEMIE_MODEL_SOURCE` reference: that env var is only ever set inside `bin/codemie-copilot.js`'s own wrapper and never reaches Claude. Use the signal that's actually there instead — `ConfigLoader.exportProviderEnvVars` (`src/utils/config.ts:1403`) always emits `CODEMIE_MODEL`/`CODEMIE_HAIKU_MODEL`/`CODEMIE_SONNET_MODEL`/`CODEMIE_OPUS_MODEL`, using `''` when a tier has no configured value at any layer. So: empty → nothing explicit, safe to auto-fill. Non-empty → explicit, but the catalog must still be checked for whether that value is still live (spec Error Handling row 4: a retired model id is never honored regardless of source), so the fetch always runs.

Auth/fetch, filter, rank, and fallback-on-error mechanics mirror `resolveCopilotModel`/`rankModel`/`compareRankedModels`/`extractVersionParts`/`fetchCodeMieModelsForCopilot` in `src/agents/plugins/copilot-cli/copilot-cli.models.ts:148-227` line-for-line, adapted as follows:

- [ ] **Step 1: Implement the file**

```typescript
import type { LlmModel } from '../../../providers/plugins/sso/sso.http-client.js';
import { fetchCodeMieLlmModels } from '../../../providers/plugins/sso/sso.http-client.js';
import { CodeMieSSO } from '../../../providers/plugins/sso/sso.auth.js';
import { ConfigurationError } from '../../../utils/errors.js';
import { logger } from '../../../utils/logger.js';
import { ClaudePluginMetadata } from './claude.plugin.js';

export type ClaudeModelTier = 'model' | 'haiku' | 'sonnet' | 'opus';

const TIER_ENV_VAR: Record<ClaudeModelTier, string> = {
  model: 'CODEMIE_MODEL',
  haiku: 'CODEMIE_HAIKU_MODEL',
  sonnet: 'CODEMIE_SONNET_MODEL',
  opus: 'CODEMIE_OPUS_MODEL',
};

const INCOMPATIBLE = [/embedding/i, /rerank/i, /whisper/i, /tts/i, /moderation/i, /image/i];
const CLAUDE_FAMILY = [/claude/i, /anthropic/i, /sonnet/i, /opus/i, /haiku/i];
const TIER_PATTERN: Record<ClaudeModelTier, RegExp | null> = {
  model: null,
  haiku: /haiku/i,
  sonnet: /sonnet/i,
  opus: /opus/i,
};

function getId(m: LlmModel): string | undefined {
  return m.deployment_name || m.base_name || m.label;
}
function searchText(m: LlmModel): string {
  return [m.deployment_name, m.base_name, m.label, m.provider].filter(Boolean).join(' ').toLowerCase();
}
function isCompatible(m: LlmModel, tier: ClaudeModelTier): boolean {
  if (!m.enabled || m.features?.tools === false || m.features?.streaming === false) return false;
  const text = searchText(m);
  if (INCOMPATIBLE.some((p) => p.test(text))) return false;
  if (!CLAUDE_FAMILY.some((p) => p.test(text))) return false;
  const tierPattern = TIER_PATTERN[tier];
  return tierPattern ? tierPattern.test(text) : true;
}
function extractVersionParts(text: string): number[] {
  const dateMatch = text.match(/(20\d{2})[-.]?(\d{2})[-.]?(\d{2})/);
  const genMatch = text.match(/claude(?:[-_.]?(\d+))?(?:[-_.](\d+))?/i);
  return [
    genMatch?.[1] ? Number(genMatch[1]) : 0,
    genMatch?.[2] ? Number(genMatch[2]) : 0,
    dateMatch ? Number(dateMatch[1]) : 0,
    dateMatch ? Number(dateMatch[2]) : 0,
    dateMatch ? Number(dateMatch[3]) : 0,
  ];
}
function rank(m: LlmModel): { id: string; score: number[] } {
  const id = getId(m);
  if (!id) throw new ConfigurationError('Cannot rank Claude model without a model identifier');
  const text = searchText(m);
  return { id, score: [m.default ? 1 : 0, ...extractVersionParts(text)] };
}
function compare(a: { id: string; score: number[] }, b: { id: string; score: number[] }): number {
  for (let i = 0; i < Math.max(a.score.length, b.score.length); i++) {
    const diff = (b.score[i] ?? 0) - (a.score[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return a.id.localeCompare(b.id);
}

// Module-level TTL cache: one live-catalog fetch serves all 4 tiers within a run
// and across a short window, matching the Codex/Kimi resolvers' fetch cost profile.
const CATALOG_TTL_MS = 5 * 60 * 1000;
let cachedCatalog: { key: string; fetchedAt: number; models: LlmModel[] } | null = null;

async function fetchCatalog(env: NodeJS.ProcessEnv): Promise<LlmModel[]> {
  const jwtToken = env.CODEMIE_JWT_TOKEN;
  const baseUrl = env.CODEMIE_BASE_URL;
  const codeMieUrl = env.CODEMIE_URL;
  const cacheKey = jwtToken ? `jwt:${baseUrl}` : `sso:${codeMieUrl}`;

  if (cachedCatalog && cachedCatalog.key === cacheKey && Date.now() - cachedCatalog.fetchedAt < CATALOG_TTL_MS) {
    return cachedCatalog.models;
  }

  let models: LlmModel[];
  if (jwtToken && baseUrl) {
    models = await fetchCodeMieLlmModels(baseUrl, jwtToken);
  } else if (codeMieUrl) {
    const sso = new CodeMieSSO();
    const credentials = await sso.getStoredCredentials(codeMieUrl);
    if (!credentials) {
      throw new ConfigurationError(`SSO credentials not found for ${codeMieUrl}. Run: codemie setup`);
    }
    models = await fetchCodeMieLlmModels(credentials.apiUrl, credentials.cookies);
  } else {
    models = [];
  }

  cachedCatalog = { key: cacheKey, fetchedAt: Date.now(), models };
  return models;
}

export async function resolveClaudeModel(
  env: NodeJS.ProcessEnv,
  tier: ClaudeModelTier,
): Promise<{ selectedModel: string; availableModels: string[] } | null> {
  const currentModel = env[TIER_ENV_VAR[tier]] || undefined;

  let catalog: LlmModel[];
  try {
    catalog = await fetchCatalog(env);
  } catch (error) {
    logger.debug(`[claude-models] Catalog fetch failed for tier "${tier}"; keeping configured model`, {
      error: error instanceof Error ? error.message : String(error),
    });
    if (currentModel) return null;
    return { selectedModel: ClaudePluginMetadata.recommendedModels![0], availableModels: [] };
  }

  const ranked = catalog.filter((m) => isCompatible(m, tier)).map(rank).sort(compare);
  const availableModels = ranked.map((r) => r.id);

  if (currentModel && availableModels.includes(currentModel)) {
    return null; // explicit and still live — leave untouched
  }

  if (ranked.length === 0) {
    if (currentModel) return null; // nothing better available; keep what's configured
    throw new ConfigurationError(`No CodeMie model compatible with Claude tier "${tier}" is available.`);
  }

  return { selectedModel: ranked[0].id, availableModels };
}
```

- [ ] **Step 2: Commit**

Commit per the repository's existing convention.

---

### Task 2: Wire `resolveClaudeModel` into `ClaudePlugin.beforeRun`

**Files:**
- Modify: `src/agents/plugins/claude/claude.plugin.ts:158-300` (the `lifecycle.beforeRun` hook), `src/agents/plugins/claude/claude.plugin.ts:96` (`recommendedModels` stays as-is — it is now consumed by Task 1's fallback, not by tier resolution directly)

**Interfaces:**
- Consumes: `resolveClaudeModel`, `ClaudeModelTier` from `./claude.models.js` (Task 1).

**Test-first: no** — single implementation step, matching repo policy (tests only on explicit request).

- [ ] **Step 1: Add tier resolution at the end of `beforeRun`, before `return env;` (`claude.plugin.ts:299`)**

For each of the four tiers, call `resolveClaudeModel(env, tier)`; when it returns a result (non-`null`), write the resolved id onto both the generic var and the native var(s) that `transformEnvVars` already projected earlier in `BaseAgentAdapter.run()` (`envMapping` at `claude.plugin.ts:85-92`): `model` → `env.CODEMIE_MODEL` + `env.ANTHROPIC_MODEL`; `haiku` → `env.CODEMIE_HAIKU_MODEL` + `env.ANTHROPIC_DEFAULT_HAIKU_MODEL`; `sonnet` → `env.CODEMIE_SONNET_MODEL` + `env.ANTHROPIC_DEFAULT_SONNET_MODEL` + `env.CLAUDE_CODE_SUBAGENT_MODEL`; `opus` → `env.CODEMIE_OPUS_MODEL` + `env.ANTHROPIC_DEFAULT_OPUS_MODEL`. Wrap each tier's resolution in its own try/catch so a `ConfigurationError` on one tier doesn't block the others or the run — log via `logger.warn` and leave that tier's vars untouched on error. Import `resolveClaudeModel` and `ClaudeModelTier` from `./claude.models.js` at the top of the file alongside the existing imports.

- [ ] **Step 2: Commit**

Commit per the repository's existing convention.

---

### Task 3: `anthropic-subscription.template.ts` — stop forcing hardcoded models

**Files:**
- Modify: `src/providers/plugins/anthropic-subscription/anthropic-subscription.template.ts:15-41,108-140`

**Test-first: no** — single implementation step.

- [ ] **Step 1: Remove the hardcoded model source and its use in `exportEnvVars`**

Delete `ANTHROPIC_SUBSCRIPTION_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_SUBSCRIPTION_DEFAULT_OPUS_MODEL`, `ANTHROPIC_SUBSCRIPTION_MODEL_ALIASES`, and `normalizeAnthropicSubscriptionModel` (lines 15-26). In the `recommendedModels` array (lines 37-41), replace the two constant references with their literal values so the setup-wizard display list is unchanged: `['claude-sonnet-4-6', 'claude-opus-4-7', 'claude-haiku-4-5-20251001']`. In `exportEnvVars` (lines 108-140), delete the `model`/`haikuModel`/`opusModel` normalization block (current lines 117-129, the three `normalizeAnthropicSubscriptionModel(...)` calls and their `if` blocks) so the function no longer sets `CODEMIE_MODEL`/`CODEMIE_HAIKU_MODEL`/`CODEMIE_OPUS_MODEL` at all — only `CODEMIE_API_KEY`, `CODEMIE_URL`, `CODEMIE_SYNC_API_URL`, and `CODEMIE_PROJECT` remain. Verify `ConfigLoader.exportProviderEnvVars` (`src/utils/config.ts:1403`) does not itself reintroduce an empty-string override for these keys for this provider; if it does, add an explicit `delete env.CODEMIE_MODEL` (etc.) at the end of `exportEnvVars` instead of merely omitting the assignment.

- [ ] **Step 2: Commit**

Commit per the repository's existing convention.

---

## Negative-Constraint Check

- "No changes to `BaseAgentAdapter` or any other agent's plugin" — Tasks 1-3 touch only `claude.models.ts` (new), `claude.plugin.ts`, and `anthropic-subscription.template.ts`; no other agent plugin or `BaseAgentAdapter` file is edited.
- "A user's explicit model choice ... is never silently overridden" — Task 1's `resolveClaudeModel` returns `null` (no change) whenever the tier's current value is non-empty and still present in the live catalog; only a retired/absent value or a genuinely empty tier is replaced.
- "No attempt to unify the two hardcoded sources under one mechanism" — Task 1/2 build the live-catalog resolver only for the CodeMie-proxied path (`claude.models.ts`); Task 3 makes anthropic-subscription defer to the `claude` CLI's own built-in defaults instead of adopting the resolver — the two paths stay independent.
- "No new user-facing command or config UI" — no CLI command, flag, or prompt is added in any task; resolution is transparent inside `beforeRun`.
- "No change to how Codex, Kimi, Copilot, Pi, or OpenCode resolve models" — none of their files appear in this plan.
