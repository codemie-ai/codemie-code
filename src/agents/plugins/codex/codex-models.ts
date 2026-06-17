import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import type { LlmModel } from '../../../providers/plugins/sso/sso.http-client.js';
import { fetchCodeMieLlmModels } from '../../../providers/plugins/sso/sso.http-client.js';
import { CodeMieSSO } from '../../../providers/plugins/sso/sso.auth.js';
import { ConfigurationError } from '../../../utils/errors.js';
import { logger } from '../../../utils/logger.js';
import { resolveHomeDir } from '../../../utils/paths.js';

interface CodexCatalogReasoningLevel {
  effort: 'low' | 'medium' | 'high' | 'xhigh';
  description: string;
}

interface CodexCatalogModel {
  slug: string;
  display_name: string;
  description: string;
  default_reasoning_level: 'medium';
  supported_reasoning_levels: CodexCatalogReasoningLevel[];
  shell_type: 'shell_command';
  visibility: 'list';
  supported_in_api: true;
  priority: number;
  additional_speed_tiers: string[];
  service_tiers: string[];
  availability_nux: null;
  upgrade: null;
  base_instructions: string;
  supports_reasoning_summaries: boolean;
  default_reasoning_summary: 'none';
  support_verbosity: boolean;
  default_verbosity: 'medium';
  apply_patch_tool_type: 'freeform';
  web_search_tool_type: 'text_and_image';
  truncation_policy: {
    mode: 'tokens';
    limit: number;
  };
  supports_parallel_tool_calls: boolean;
  supports_image_detail_original: boolean;
  context_window: number;
  max_context_window: number;
  effective_context_window_percent: number;
  experimental_supported_tools: string[];
  input_modalities: string[];
  supports_search_tool: boolean;
}

interface CodexModelCatalog {
  models: CodexCatalogModel[];
}

export interface CodexModelResolution {
  selectedModel: string;
  catalogPath?: string;
  availableModels: string[];
}

interface RankedModel {
  model: LlmModel;
  id: string;
  score: number[];
}

const INCOMPATIBLE_MODEL_PATTERNS: RegExp[] = [
  /claude/i,
  /sonnet/i,
  /opus/i,
  /haiku/i,
  /anthropic/i,
  /gemini/i,
  /qwen/i,
  /deepseek/i,
  /llama/i,
  /mistral/i,
  /grok/i,
];

const COMPATIBLE_CODEX_MODEL_PATTERNS: RegExp[] = [
  /codex/i,
  /^gpt[-.]?5(?:[-.]|\b)/i,
  /^gpt[-.]?6(?:[-.]|\b)/i,
];

const REASONING_LEVELS: CodexCatalogReasoningLevel[] = [
  { effort: 'low', description: 'Fast responses with lighter reasoning' },
  { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
  { effort: 'high', description: 'Greater reasoning depth for complex problems' },
  { effort: 'xhigh', description: 'Extra high reasoning depth for complex problems' },
];

function getModelId(model: LlmModel): string {
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

export function isCodexCompatibleModelName(modelName: string | undefined): modelName is string {
  if (!modelName) return false;
  if (INCOMPATIBLE_MODEL_PATTERNS.some(pattern => pattern.test(modelName))) return false;
  return COMPATIBLE_CODEX_MODEL_PATTERNS.some(pattern => pattern.test(modelName));
}

function isCodexCompatibleModel(model: LlmModel): boolean {
  if (!model.enabled) return false;

  const id = getModelId(model);
  if (!id) return false;

  const searchText = getSearchText(model);
  if (INCOMPATIBLE_MODEL_PATTERNS.some(pattern => pattern.test(searchText))) {
    return false;
  }

  return COMPATIBLE_CODEX_MODEL_PATTERNS.some(pattern => pattern.test(searchText));
}

function extractVersionParts(text: string): number[] {
  const lower = text.toLowerCase();
  const gptMatch = lower.match(/gpt[-.]?(\d+)(?:[-.](\d+))?(?:[-.](\d+))?/);
  const dateMatch = lower.match(/(20\d{2})[-.]?(\d{2})[-.]?(\d{2})/);

  const version = [
    gptMatch?.[1],
    gptMatch?.[2],
    gptMatch?.[3],
  ].map(part => part ? Number(part) : 0);

  if (dateMatch) {
    version.push(Number(dateMatch[1]), Number(dateMatch[2]), Number(dateMatch[3]));
  } else {
    version.push(0, 0, 0);
  }

  return version;
}

function rankModel(model: LlmModel): RankedModel {
  const id = getModelId(model);
  const searchText = getSearchText(model);
  const preferredDefaultBonus = /gpt[-.]?5[-.]?4(?:[-.]|\b)/i.test(searchText) ? 1 : 0;
  const codexBonus = /codex/i.test(searchText) ? 1 : 0;
  const defaultBonus = model.default ? 1 : 0;
  const toolBonus = model.features?.tools === false ? 0 : 1;
  const streamingBonus = model.features?.streaming === false ? 0 : 1;

  return {
    model,
    id,
    score: [
      preferredDefaultBonus,
      ...extractVersionParts(searchText),
      codexBonus,
      toolBonus,
      streamingBonus,
      defaultBonus,
    ],
  };
}

function compareRankedModels(a: RankedModel, b: RankedModel): number {
  const max = Math.max(a.score.length, b.score.length);
  for (let i = 0; i < max; i++) {
    const diff = (b.score[i] ?? 0) - (a.score[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return a.id.localeCompare(b.id);
}

function buildCodexCatalog(models: RankedModel[]): CodexModelCatalog {
  return {
    models: models.map((entry, index) => ({
      slug: entry.id,
      display_name: entry.model.label || entry.id,
      description: 'CodeMie model available for Codex through the Responses API.',
      default_reasoning_level: 'medium',
      supported_reasoning_levels: REASONING_LEVELS,
      shell_type: 'shell_command',
      visibility: 'list',
      supported_in_api: true,
      priority: index,
      additional_speed_tiers: [],
      service_tiers: [],
      availability_nux: null,
      upgrade: null,
      base_instructions: '',
      supports_reasoning_summaries: true,
      default_reasoning_summary: 'none',
      support_verbosity: true,
      default_verbosity: 'medium',
      apply_patch_tool_type: 'freeform',
      web_search_tool_type: 'text_and_image',
      truncation_policy: {
        mode: 'tokens',
        limit: 10000,
      },
      supports_parallel_tool_calls: true,
      supports_image_detail_original: true,
      context_window: 400000,
      max_context_window: 400000,
      effective_context_window_percent: 95,
      experimental_supported_tools: [],
      input_modalities: entry.model.multimodal ? ['text', 'image'] : ['text'],
      supports_search_tool: true,
    })),
  };
}

async function fetchCodeMieModelsForCodex(env: NodeJS.ProcessEnv): Promise<LlmModel[]> {
  const jwtToken = env.CODEMIE_JWT_TOKEN;
  const baseUrl = env.CODEMIE_BASE_URL;

  if (jwtToken && baseUrl) {
    logger.debug('[codex-models] Fetching CodeMie model list via JWT auth');
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

    logger.debug('[codex-models] Fetching CodeMie model list via SSO auth');
    return fetchCodeMieLlmModels(credentials.apiUrl, credentials.cookies);
  }

  return [];
}

async function writeCatalogFile(catalog: CodexModelCatalog): Promise<string> {
  const dir = resolveHomeDir('.codex/codemie');
  await mkdir(dir, { recursive: true });

  const catalogPath = join(dir, 'models.json');
  await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf-8');
  return catalogPath;
}

function formatAvailableModelIds(modelIds: string[]): string {
  return modelIds.join(', ');
}

export async function resolveCodexModel(env: NodeJS.ProcessEnv): Promise<CodexModelResolution> {
  const currentModel = env.CODEMIE_MODEL;

  let rawModels: LlmModel[] = [];
  try {
    rawModels = await fetchCodeMieModelsForCodex(env);
  } catch (error) {
    if (isCodexCompatibleModelName(currentModel)) {
      const configuredModel = currentModel;
      logger.debug('[codex-models] Failed to fetch CodeMie models; keeping compatible configured model', {
        error: error instanceof Error ? error.message : String(error),
        model: configuredModel,
      });
      return { selectedModel: configuredModel, availableModels: [configuredModel] };
    }
    throw error;
  }

  const rankedModels = rawModels
    .filter(isCodexCompatibleModel)
    .map(rankModel)
    .sort(compareRankedModels);

  if (rankedModels.length === 0) {
    if (isCodexCompatibleModelName(currentModel)) {
      const configuredModel = currentModel;
      logger.debug('[codex-models] CodeMie returned no compatible Codex models; keeping configured GPT/Codex model');
      return { selectedModel: configuredModel, availableModels: [configuredModel] };
    }

    throw new ConfigurationError(
      'No CodeMie GPT/Codex model is available for codemie-codex. ' +
      'Enable a GPT-5/Codex deployment in CodeMie before running Codex.'
    );
  }

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

  return {
    selectedModel,
    catalogPath,
    availableModels: rankedModels.map(entry => entry.id),
  };
}

export function assertExplicitCodexModelAllowed(model: string, availableModels: string[]): void {
  if (!isCodexCompatibleModelName(model)) {
    throw new ConfigurationError(
      `Model "${model}" is not compatible with codemie-codex. ` +
      `Use a GPT/Codex model${availableModels.length ? ` such as: ${formatAvailableModelIds(availableModels)}` : '.'}`
    );
  }

  if (availableModels.length > 0 && !availableModels.includes(model)) {
    throw new ConfigurationError(
      `Model "${model}" is not available in CodeMie for codemie-codex. ` +
      `Available models: ${availableModels.join(', ')}`
    );
  }
}
