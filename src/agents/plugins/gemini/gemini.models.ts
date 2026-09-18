/**
 * Gemini model validation.
 *
 * Unlike Codex (which fuzzy-resolves) and Kimi (which ranks+selects), the Gemini
 * adapter forwards the configured model verbatim as `-m <model>`. If that model
 * is not a real Gemini deployment in the CodeMie catalog, the upstream rejects
 * the request with an opaque HTTP 400 ("Invalid model name…"). This module lets
 * the plugin validate the configured model against the catalog BEFORE launch and
 * fail with a clear, actionable message listing the available Gemini models.
 *
 * It is BEST-EFFORT: if the catalog cannot be fetched (offline, no creds) or
 * exposes no Gemini models, validation is skipped so it never blocks a run it
 * cannot adjudicate — the request simply proceeds as before.
 *
 * Ref: EPMCDME-14421.
 */

import type { LlmModel } from '../../../providers/plugins/sso/sso.http-client.js';
import { fetchCodeMieLlmModels } from '../../../providers/plugins/sso/sso.http-client.js';
import { CodeMieSSO } from '../../../providers/plugins/sso/sso.auth.js';
import { ConfigurationError } from '../../../utils/errors.js';
import { logger } from '../../../utils/logger.js';

/** Models Gemini cannot run — the catalog mixes providers, so exclude the others. */
const INCOMPATIBLE_MODEL_PATTERNS: RegExp[] = [
  /anthropic/i,
  /claude/i,
  /sonnet/i,
  /opus/i,
  /haiku/i,
  /codex/i,
  /^gpt[-.]?/i,
  /kimi/i,
  /moonshot/i,
  /qwen/i,
  /deepseek/i,
  /llama/i,
  /mistral/i,
  /grok/i,
];

/** A model name is Gemini-compatible when it names gemini and nothing else. */
export function isGeminiCompatibleModelName(modelName: string | undefined): modelName is string {
  if (!modelName) return false;
  if (INCOMPATIBLE_MODEL_PATTERNS.some((p) => p.test(modelName))) return false;
  return /gemini/i.test(modelName);
}

function getModelId(model: LlmModel): string | undefined {
  const candidates = [model.deployment_name, model.base_name, model.label].filter(
    isGeminiCompatibleModelName,
  );
  // Prefer an API identifier without whitespace (labels can be "Gemini 3.1 Pro").
  return candidates.find((c) => !/\s/.test(c)) ?? candidates[0];
}

/** Enabled, Gemini-compatible deployment ids from a raw catalog. */
export function getGeminiModelIds(models: LlmModel[]): string[] {
  const ids = new Set<string>();
  for (const model of models) {
    if (model.enabled === false) continue;
    const id = getModelId(model);
    if (id) ids.add(id);
  }
  return [...ids];
}

/**
 * Throw a clear error when `model` is not a usable Gemini deployment.
 * A caller with an empty availableModels list must skip the call (cannot judge).
 */
export function assertGeminiModelAllowed(model: string | undefined, availableModels: string[]): void {
  if (!isGeminiCompatibleModelName(model)) {
    throw new ConfigurationError(
      `Model "${model ?? '(none)'}" is not a Gemini model — codemie-gemini only runs gemini-* models.` +
        (availableModels.length ? ` Available: ${availableModels.join(', ')}.` : ''),
    );
  }
  if (availableModels.length > 0 && !availableModels.includes(model)) {
    throw new ConfigurationError(
      `Model "${model}" is not available in CodeMie for codemie-gemini. ` +
        `Available Gemini models: ${availableModels.join(', ')}. ` +
        'Set a valid model with `codemie setup` or `-m <model>`.',
    );
  }
}

async function fetchCodeMieModelsForGemini(env: NodeJS.ProcessEnv): Promise<LlmModel[]> {
  const jwtToken = env.CODEMIE_JWT_TOKEN;
  const baseUrl = env.CODEMIE_BASE_URL;
  if (jwtToken && baseUrl) {
    logger.debug('[gemini-models] Fetching CodeMie model list via JWT auth');
    return await fetchCodeMieLlmModels(baseUrl, jwtToken);
  }

  const codeMieUrl = env.CODEMIE_URL;
  if (codeMieUrl) {
    const sso = new CodeMieSSO();
    const credentials = await sso.getStoredCredentials(codeMieUrl);
    if (!credentials) return [];
    logger.debug('[gemini-models] Fetching CodeMie model list via SSO auth');
    return await fetchCodeMieLlmModels(credentials.apiUrl, credentials.cookies);
  }

  return [];
}

/**
 * Best-effort pre-launch validation of the configured Gemini model against the
 * live catalog. Throws ConfigurationError with a clear message when the model is
 * known-invalid; silently returns when it cannot fetch/judge the catalog.
 */
export async function validateGeminiModel(env: NodeJS.ProcessEnv): Promise<void> {
  const currentModel = env.CODEMIE_MODEL;
  if (!currentModel) return; // nothing configured to validate

  let models: LlmModel[] = [];
  try {
    models = await fetchCodeMieModelsForGemini(env);
  } catch (error) {
    logger.debug('[gemini-models] Model list fetch failed; skipping validation', {
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const availableGeminiModels = getGeminiModelIds(models);
  if (availableGeminiModels.length === 0) {
    // Catalog unreachable or exposes no Gemini models — cannot adjudicate.
    return;
  }

  assertGeminiModelAllowed(currentModel, availableGeminiModels);
}
