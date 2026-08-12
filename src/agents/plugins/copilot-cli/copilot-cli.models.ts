import type { LlmModel } from '../../../providers/plugins/sso/sso.http-client.js';
import { fetchCodeMieLlmModels } from '../../../providers/plugins/sso/sso.http-client.js';
import { CodeMieSSO } from '../../../providers/plugins/sso/sso.auth.js';
import { ConfigurationError } from '../../../utils/errors.js';
import { logger } from '../../../utils/logger.js';

export interface CopilotModelResolution {
  selectedModel: string;
  availableModels: string[];
}

interface RankedCopilotModel {
  model: LlmModel;
  id: string;
  score: number[];
}

type ConfigSource = 'default' | 'global' | 'project' | 'env' | 'cli';

const COPILOT_INCOMPATIBLE_MODEL_PATTERNS: RegExp[] = [
  /embedding/i,
  /rerank/i,
  /whisper/i,
  /tts/i,
  /moderation/i,
  /image/i,
  /vision-only/i,
];

const GPT_FAMILY_PATTERNS: RegExp[] = [
  /\bgpt\b/i,
];

const CLAUDE_FAMILY_PATTERNS: RegExp[] = [
  /claude/i,
  /anthropic/i,
  /sonnet/i,
  /opus/i,
  /haiku/i,
];

function getModelId(model: LlmModel): string | undefined {
  return model.deployment_name || model.base_name || model.label;
}

function getSearchText(model: LlmModel): string {
  return [
    model.deployment_name,
    model.base_name,
    model.label,
    model.provider,
  ].filter(Boolean).join(' ').toLowerCase();
}

export function isCopilotCompatibleModelName(modelName: string | undefined): modelName is string {
  if (!modelName) return false;
  if (COPILOT_INCOMPATIBLE_MODEL_PATTERNS.some((pattern) => pattern.test(modelName))) {
    return false;
  }
  return GPT_FAMILY_PATTERNS.some((pattern) => pattern.test(modelName))
    || CLAUDE_FAMILY_PATTERNS.some((pattern) => pattern.test(modelName));
}

function isCopilotCompatibleModel(model: LlmModel): boolean {
  if (!model.enabled) return false;
  if (model.features?.tools === false || model.features?.streaming === false) {
    return false;
  }

  const id = getModelId(model);
  if (!id || !isCopilotCompatibleModelName(id)) {
    const searchText = getSearchText(model);
    if (!isCopilotCompatibleModelName(searchText)) {
      return false;
    }
  }

  return true;
}

function extractVersionParts(text: string): number[] {
  const lower = text.toLowerCase();
  const gptMatch = lower.match(/gpt[-.]?(\d+)(?:[-.](\d+))?(?:[-.](\d+))?/);
  const claudeDateMatch = lower.match(/(20\d{2})[-.]?(\d{2})[-.]?(\d{2})/);
  const claudeGenMatch = lower.match(/claude(?:[-_.]?(\d+))?(?:[-_.](\d+))?/);

  const version = [
    gptMatch?.[1] ?? claudeGenMatch?.[1],
    gptMatch?.[2] ?? claudeGenMatch?.[2],
    gptMatch?.[3],
  ].map((part) => (part ? Number(part) : 0));

  if (claudeDateMatch) {
    version.push(Number(claudeDateMatch[1]), Number(claudeDateMatch[2]), Number(claudeDateMatch[3]));
  } else {
    version.push(0, 0, 0);
  }

  return version;
}

function rankModel(model: LlmModel): RankedCopilotModel {
  const id = getModelId(model);
  if (!id) {
    throw new ConfigurationError('Cannot rank Copilot model without a model identifier');
  }

  const searchText = getSearchText(model);
  const preferredGpt55Bonus = /gpt[-_.]?5[-_.]?5(?:[-_.]|$)/i.test(searchText) ? 1 : 0;
  const preferredGpt54Bonus = /gpt[-_.]?5[-_.]?4(?:[-_.]|$)/i.test(searchText) ? 1 : 0;
  const preferredGptCodexBonus = /gpt[-_.]?5[-_.]?[23].*codex/i.test(searchText) ? 1 : 0;
  const preferredClaudeBonus = /claude[-_.]?(?:sonnet[-_.]?)?(?:4(?:[-_.]5|[-_.]6)?|5)(?:[-_.]|$)/i.test(searchText) ? 1 : 0;
  const gptFamilyBonus = GPT_FAMILY_PATTERNS.some((pattern) => pattern.test(searchText)) ? 1 : 0;
  const claudeFamilyBonus = CLAUDE_FAMILY_PATTERNS.some((pattern) => pattern.test(searchText)) ? 1 : 0;
  const defaultBonus = model.default ? 1 : 0;
  const toolBonus = model.features?.tools === false ? 0 : 1;
  const streamingBonus = model.features?.streaming === false ? 0 : 1;
  const temperatureBonus = model.features?.temperature === false ? 1 : 0;

  return {
    model,
    id,
    score: [
      preferredGpt55Bonus,
      preferredGpt54Bonus,
      preferredGptCodexBonus,
      gptFamilyBonus,
      preferredClaudeBonus,
      claudeFamilyBonus,
      temperatureBonus,
      toolBonus,
      streamingBonus,
      ...extractVersionParts(searchText),
      defaultBonus,
    ],
  };
}

function compareRankedModels(a: RankedCopilotModel, b: RankedCopilotModel): number {
  const max = Math.max(a.score.length, b.score.length);
  for (let i = 0; i < max; i++) {
    const diff = (b.score[i] ?? 0) - (a.score[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return a.id.localeCompare(b.id);
}

async function fetchCodeMieModelsForCopilot(env: NodeJS.ProcessEnv): Promise<LlmModel[]> {
  const jwtToken = env.CODEMIE_JWT_TOKEN;
  const baseUrl = env.CODEMIE_BASE_URL;

  if (jwtToken && baseUrl) {
    logger.debug('[copilot-cli-models] Fetching CodeMie model list via JWT auth');
    return fetchCodeMieLlmModels(baseUrl, jwtToken);
  }

  const codeMieUrl = env.CODEMIE_URL;
  if (codeMieUrl) {
    const sso = new CodeMieSSO();
    const credentials = await sso.getStoredCredentials(codeMieUrl);
    if (!credentials) {
      throw new ConfigurationError(
        `SSO credentials not found for ${codeMieUrl}. Run: codemie setup or codemie profile login --url ${codeMieUrl}`
      );
    }

    logger.debug('[copilot-cli-models] Fetching CodeMie model list via SSO auth');
    return fetchCodeMieLlmModels(credentials.apiUrl, credentials.cookies);
  }

  return [];
}

export async function resolveCopilotModel(env: NodeJS.ProcessEnv): Promise<CopilotModelResolution> {
  const currentModel = env.CODEMIE_MODEL;
  const modelSource = (env.CODEMIE_MODEL_SOURCE || 'default') as ConfigSource;

  let rawModels: LlmModel[] = [];
  try {
    rawModels = await fetchCodeMieModelsForCopilot(env);
  } catch (error) {
    if (isCopilotCompatibleModelName(currentModel)) {
      const configuredModel = currentModel;
      logger.debug('[copilot-cli-models] Failed to fetch CodeMie models; keeping compatible configured model', {
        error: error instanceof Error ? error.message : String(error),
        model: configuredModel,
      });
      return { selectedModel: configuredModel, availableModels: [configuredModel] };
    }
    throw error;
  }

  const rankedModels = rawModels
    .filter(isCopilotCompatibleModel)
    .map(rankModel)
    .sort(compareRankedModels);

  if (rankedModels.length === 0) {
    if (isCopilotCompatibleModelName(currentModel)) {
      const configuredModel = currentModel;
      logger.debug('[copilot-cli-models] CodeMie returned no explicitly compatible Copilot models; keeping configured model');
      return { selectedModel: configuredModel, availableModels: [configuredModel] };
    }

    throw new ConfigurationError(
      'No CodeMie model compatible with GitHub Copilot CLI is available. ' +
      'Use a model with tool calling and streaming support, such as gpt-5.5 or claude-sonnet-4.6.'
    );
  }

  const selectedModel = rankedModels[0].id;
  const rankedIds = rankedModels.map((entry) => entry.id);
  const shouldPreserveConfiguredModel = modelSource === 'cli' || modelSource === 'env';
  const effectiveModel =
    shouldPreserveConfiguredModel && currentModel && rankedIds.includes(currentModel)
      ? currentModel
      : selectedModel;

  if (currentModel && currentModel !== effectiveModel) {
    logger.info(`[copilot-cli-models] Using ${effectiveModel} for Copilot instead of profile model ${currentModel}`);
  }

  return {
    selectedModel: effectiveModel,
    availableModels: rankedModels.map((entry) => entry.id),
  };
}

export function assertExplicitCopilotModelAllowed(model: string, availableModels: string[]): void {
  if (!isCopilotCompatibleModelName(model)) {
    throw new ConfigurationError(
      `Model "${model}" is not compatible with codemie-copilot. ` +
      `Use a GPT-family or Claude-family model with tool calling and streaming support` +
      `${availableModels.length ? ` such as: ${availableModels.join(', ')}` : '.'}`
    );
  }

  if (availableModels.length > 0 && !availableModels.includes(model)) {
    throw new ConfigurationError(
      `Model "${model}" is not available in CodeMie for codemie-copilot. ` +
      `Available models: ${availableModels.join(', ')}`
    );
  }
}
