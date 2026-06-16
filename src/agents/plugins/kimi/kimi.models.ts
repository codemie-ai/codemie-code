import type { LlmModel } from '../../../providers/plugins/sso/sso.http-client.js';
import { fetchCodeMieLlmModels } from '../../../providers/plugins/sso/sso.http-client.js';
import { CodeMieSSO } from '../../../providers/plugins/sso/sso.auth.js';
import { ConfigurationError } from '../../../utils/errors.js';
import { logger } from '../../../utils/logger.js';

export interface KimiModelResolution {
  selectedModel: string;
  availableModels: string[];
}

interface RankedKimiModel {
  model: LlmModel;
  id: string;
  score: number[];
}

const INCOMPATIBLE_MODEL_PATTERNS: RegExp[] = [
  /anthropic/i,
  /claude/i,
  /sonnet/i,
  /opus/i,
  /haiku/i,
  /codex/i,
  /^gpt[-.]?/i,
  /gemini/i,
  /qwen/i,
  /deepseek/i,
  /llama/i,
  /mistral/i,
  /grok/i,
];

const COMPATIBLE_KIMI_MODEL_PATTERNS: RegExp[] = [
  /kimi/i,
  /moonshot/i,
  /moonshotai/i,
];

function getModelId(model: LlmModel): string | undefined {
  const candidates = [
    model.deployment_name,
    model.base_name,
    model.label,
  ];
  const compatibleCandidates = candidates.filter(isKimiCompatibleModelName);
  const apiIdentifier = compatibleCandidates.find(candidate => !/\s/.test(candidate));

  return apiIdentifier || compatibleCandidates[0];
}

function getSearchText(model: LlmModel): string {
  return [
    model.deployment_name,
    model.base_name,
    model.label,
    model.provider,
  ].filter(Boolean).join(' ').toLowerCase();
}

export function isKimiCompatibleModelName(modelName: string | undefined): modelName is string {
  if (!modelName) return false;
  if (INCOMPATIBLE_MODEL_PATTERNS.some(pattern => pattern.test(modelName))) return false;
  return COMPATIBLE_KIMI_MODEL_PATTERNS.some(pattern => pattern.test(modelName));
}

function isKimiCompatibleModel(model: LlmModel): boolean {
  if (!model.enabled) return false;

  const id = getModelId(model);
  if (!id) return false;

  const searchText = getSearchText(model);
  if (INCOMPATIBLE_MODEL_PATTERNS.some(pattern => pattern.test(searchText))) {
    return false;
  }

  return COMPATIBLE_KIMI_MODEL_PATTERNS.some(pattern => pattern.test(searchText));
}

function extractKimiVersionParts(text: string): number[] {
  const lower = text.toLowerCase();
  const k2Match = lower.match(/kimi[-.]?k2(?:[-.](\d+))?(?:[-.](\d+))?/);
  const genericMatch = lower.match(/kimi.*?(\d+)(?:[-.](\d+))?(?:[-.](\d+))?/);

  const match = k2Match || genericMatch;
  return [
    match?.[1],
    match?.[2],
    match?.[3],
  ].map(part => part ? Number(part) : 0);
}

function rankModel(model: LlmModel): RankedKimiModel {
  const id = getModelId(model);
  if (!id) {
    throw new ConfigurationError('Cannot rank Kimi model without a compatible model ID');
  }

  const searchText = getSearchText(model);
  const preferredK26Bonus = /kimi[-_.]?k2[-_.]?6(?:[-_.]|$)/i.test(searchText) ? 1 : 0;
  const k2Bonus = /kimi[-_.]?k2/i.test(searchText) ? 1 : 0;
  const toolBonus = model.features?.tools === false ? 0 : 1;
  const streamingBonus = model.features?.streaming === false ? 0 : 1;
  const defaultBonus = model.default ? 1 : 0;

  return {
    model,
    id,
    score: [
      preferredK26Bonus,
      k2Bonus,
      ...extractKimiVersionParts(searchText),
      toolBonus,
      streamingBonus,
      defaultBonus,
    ],
  };
}

function compareRankedModels(a: RankedKimiModel, b: RankedKimiModel): number {
  const max = Math.max(a.score.length, b.score.length);
  for (let i = 0; i < max; i++) {
    const diff = (b.score[i] ?? 0) - (a.score[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return a.id.localeCompare(b.id);
}

async function fetchCodeMieModelsForKimi(env: NodeJS.ProcessEnv): Promise<LlmModel[]> {
  const jwtToken = env.CODEMIE_JWT_TOKEN;
  const baseUrl = env.CODEMIE_BASE_URL;

  if (jwtToken && baseUrl) {
    logger.debug('[kimi-models] Fetching CodeMie model list via JWT auth');
    return fetchCodeMieLlmModels(baseUrl, jwtToken);
  }

  const codeMieUrl = env.CODEMIE_URL;
  if (codeMieUrl) {
    const sso = new CodeMieSSO();
    const credentials = await sso.getStoredCredentials(codeMieUrl);
    if (!credentials) {
      throw new ConfigurationError(
        `SSO credentials not found for ${codeMieUrl}. Run: codemie profile login --url ${codeMieUrl}`
      );
    }

    logger.debug('[kimi-models] Fetching CodeMie model list via SSO auth');
    return fetchCodeMieLlmModels(credentials.apiUrl, credentials.cookies);
  }

  return [];
}

export async function resolveKimiModel(env: NodeJS.ProcessEnv): Promise<KimiModelResolution> {
  const currentModel = env.CODEMIE_MODEL;

  let rawModels: LlmModel[] = [];
  try {
    rawModels = await fetchCodeMieModelsForKimi(env);
  } catch (error) {
    if (isKimiCompatibleModelName(currentModel)) {
      const configuredModel = currentModel;
      logger.debug('[kimi-models] Failed to fetch CodeMie models; keeping compatible configured model', {
        error: error instanceof Error ? error.message : String(error),
        model: configuredModel,
      });
      return { selectedModel: configuredModel, availableModels: [configuredModel] };
    }
    throw error;
  }

  const rankedModels = rawModels
    .filter(isKimiCompatibleModel)
    .map(rankModel)
    .sort(compareRankedModels);

  if (rankedModels.length === 0) {
    if (isKimiCompatibleModelName(currentModel)) {
      const configuredModel = currentModel;
      logger.debug('[kimi-models] CodeMie returned no compatible Kimi models; keeping configured Kimi model');
      return { selectedModel: configuredModel, availableModels: [configuredModel] };
    }

    throw new ConfigurationError(
      'No CodeMie Kimi model is available for codemie-kimi. ' +
      'Enable a Kimi/Moonshot deployment in CodeMie before running Kimi Code.'
    );
  }

  const selectedModel = rankedModels[0].id;

  if (currentModel && currentModel !== selectedModel) {
    logger.info(
      `[kimi-models] Using ${selectedModel} for Kimi instead of profile model ${currentModel}`
    );
  }

  return {
    selectedModel,
    availableModels: rankedModels.map(entry => entry.id),
  };
}

export function assertExplicitKimiModelAllowed(model: string, availableModels: string[]): void {
  if (!isKimiCompatibleModelName(model)) {
    throw new ConfigurationError(
      `Model "${model}" is not compatible with codemie-kimi. ` +
      `Use a Kimi/Moonshot model${availableModels.length ? ` such as: ${availableModels.join(', ')}` : '.'}`
    );
  }

  if (availableModels.length > 0 && !availableModels.includes(model)) {
    throw new ConfigurationError(
      `Model "${model}" is not available in CodeMie for codemie-kimi. ` +
      `Available models: ${availableModels.join(', ')}`
    );
  }
}
