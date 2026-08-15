import { mkdir, writeFile } from 'fs/promises';
import type { LlmModel } from '../../../providers/plugins/sso/sso.http-client.js';
import { fetchCodeMieLlmModels } from '../../../providers/plugins/sso/sso.http-client.js';
import { CodeMieSSO } from '../../../providers/plugins/sso/sso.auth.js';
import { logger } from '../../../utils/logger.js';
import type { ModelPrice } from '../../../utils/pricing.js';
import { lookupPrice } from '../../../utils/pricing.js';
import { getPiAgentDir, getPiModelsPath } from './pi.paths.js';

export interface PiModelClassification {
  provider: 'codemie-proxy' | 'codemie-anthropic';
  api?: 'openai-responses';
}

const RESPONSES_API_PATTERNS: RegExp[] = [
  /^gpt-5-2-/,
  /^gpt-5\.2-/,
  /^gpt-5-1-codex/,
  /^gpt-5\.1-codex/,
  /^gpt-5-3-codex/,
  /^gpt-5\.3-codex/,
  /^gpt-5\.4-/,
  /^gpt-5-4-/,
  /^gpt-5\.5-/,
  /^gpt-5-5-/,
  /^gpt-5\.6-/,
  /^gpt-5-6-/,
];

export function classifyPiModel(modelId: string): PiModelClassification {
  if (modelId.startsWith('claude')) {
    return { provider: 'codemie-anthropic' };
  }
  if (RESPONSES_API_PATTERNS.some(pattern => pattern.test(modelId))) {
    return { provider: 'codemie-proxy', api: 'openai-responses' };
  }
  return { provider: 'codemie-proxy' };
}

/**
 * Pi's per-model rates, in USD per 1,000,000 tokens.
 *
 * All four are required together: Pi's schema declares the `cost` block itself optional but
 * every rate inside it mandatory, and one missing rate rejects the whole `models.json` rather
 * than the single entry. Pi has no rate for 1h cache writes — it bills those as `input * 2`.
 */
export interface PiModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface PiModelEntry {
  id: string;
  name: string;
  api?: 'openai-responses';
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input: ('text' | 'image')[];
  contextWindow: number;
  maxTokens: number;
  compat?: Record<string, unknown>;
  cost?: PiModelCost;
}

function detectLimits(id: string): { contextWindow: number; maxTokens: number } {
  if (id.startsWith('claude')) return { contextWindow: 200000, maxTokens: 64000 };
  if (id.startsWith('gemini')) return { contextWindow: 1048576, maxTokens: 65536 };
  if (id.startsWith('gpt-4.1')) return { contextWindow: 1048576, maxTokens: 32768 };
  if (/^gpt-5\.5-/.test(id) || /^gpt-5-5-/.test(id)) return { contextWindow: 1050000, maxTokens: 128000 };
  if (/^gpt-5\.6-/.test(id) || /^gpt-5-6-/.test(id)) return { contextWindow: 1050000, maxTokens: 128000 };
  if (id.startsWith('gpt-5')) return { contextWindow: 400000, maxTokens: 128000 };
  if (/^o[134]-/.test(id) || id === 'o1') return { contextWindow: 200000, maxTokens: 100000 };
  if (id.startsWith('qwen') || id.startsWith('moonshotai') || id.startsWith('kimi')) {
    return { contextWindow: 262144, maxTokens: 131072 };
  }
  if (id.startsWith('deepseek')) return { contextWindow: 65536, maxTokens: 65536 };
  return { contextWindow: 128000, maxTokens: 4096 };
}

function defaultThinkingLevelMap(): Record<string, string | null> {
  return {
    off: null,
    minimal: 'minimal',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'high',
    max: 'high',
  };
}

function isReasoningModel(id: string): boolean {
  return (
    id.startsWith('claude') ||
    id.startsWith('gemini') ||
    id.startsWith('gpt-5') ||
    /^o[134]-/.test(id) ||
    id === 'o1' ||
    id.startsWith('deepseek') ||
    id.startsWith('moonshotai') ||
    id.startsWith('kimi')
  );
}

/**
 * A rate we can hand to Pi. `LlmModel.cost` is typed `number`, but it arrives from
 * `JSON.parse` of an HTTP response, so the type is a claim rather than a guarantee: a string,
 * `NaN` or `Infinity` would serialize into `models.json` as a non-number and cost Pi the entire
 * file, not just this model. A negative rate has no meaning here and would flip the sign of a
 * real estimate, so it falls back too.
 *
 * Screening the payload is not enough on its own: `1e308` passes every check here and still
 * overflows to `Infinity` once scaled to per-million, so the product is checked as well.
 */
function isValidRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** CodeMie reports cost per token; Pi expects it per million. */
function toPerMillion(value: number): number {
  return value * 1_000_000;
}

/**
 * One rate, resolved per field the way Pi resolves its own `modelOverrides`: the live API value
 * wins, then the vendored price table, then zero. An explicit `0` from the API is a price, not a
 * gap, so it too suppresses the table for that field.
 */
function resolveRate(apiPerToken: unknown, vendoredPerMillion: number | undefined): number {
  if (isValidRate(apiPerToken)) {
    const perMillion = toPerMillion(apiPerToken);
    if (isValidRate(perMillion)) {
      return perMillion;
    }
  }
  if (isValidRate(vendoredPerMillion)) {
    return vendoredPerMillion;
  }
  return 0;
}

/**
 * A price table we cannot read is a cost-reporting problem, not a reason to refuse to launch the
 * agent. `lookupPrice` reads a vendored JSON asset on first call, and this runs inside the
 * plugin's `beforeRun`, which nothing guards — an unreadable asset would otherwise abort the
 * user's whole session over missing metrics.
 */
function vendoredPrice(id: string): ModelPrice | null {
  try {
    return lookupPrice(id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.debug(`[pi-models] Price table unavailable for ${id}: ${message}`);
    return null;
  }
}

/**
 * Build the `cost` block, or return `undefined` when no source prices this model.
 *
 * Omitting is what Pi already does with an entry that has no `cost` — it defaults every rate to
 * zero — so an unpriced model behaves exactly as it did before this block existed. Emitting
 * explicit zeros instead would assert "this model is free", which is a different claim from
 * "we have no price for it".
 */
function resolveModelCost(model: LlmModel, id: string): PiModelCost | undefined {
  const vendored = vendoredPrice(id);
  const cost: PiModelCost = {
    input: resolveRate(model.cost?.input, vendored?.input),
    output: resolveRate(model.cost?.output, vendored?.output),
    cacheRead: resolveRate(model.cost?.cache_read_input_token_cost, vendored?.cacheRead),
    cacheWrite: resolveRate(model.cost?.cache_creation_input_token_cost, vendored?.cacheCreation),
  };

  const unpriced = cost.input === 0 && cost.output === 0 && cost.cacheRead === 0 && cost.cacheWrite === 0;
  return unpriced ? undefined : cost;
}

export function convertLlmModelToPiEntry(model: LlmModel): PiModelEntry {
  const id = model.deployment_name || model.base_name || model.label;
  const limits = detectLimits(id);

  const entry: PiModelEntry = {
    id,
    name: model.label || id,
    input: model.multimodal ? ['text', 'image'] : ['text'],
    contextWindow: limits.contextWindow,
    maxTokens: limits.maxTokens,
  };

  const classification = classifyPiModel(id);
  if (classification.api) {
    entry.api = classification.api;
  }

  if (isReasoningModel(id)) {
    entry.reasoning = true;
    entry.thinkingLevelMap = defaultThinkingLevelMap();
  }

  if (
    id.startsWith('claude-sonnet-4-6') ||
    id.startsWith('claude-sonnet-5') ||
    /^claude-opus-4-[6-8]/.test(id) ||
    id.startsWith('claude-opus-5')
  ) {
    entry.compat = { forceAdaptiveThinking: true };
  }

  const cost = resolveModelCost(model, id);
  if (cost) {
    entry.cost = cost;
  }

  return entry;
}

interface PiModelsConfig {
  providers: Record<string, {
    baseUrl: string;
    api: string;
    apiKey: string;
    authHeader?: boolean;
    compat?: Record<string, unknown>;
    models: PiModelEntry[];
  }>;
}

async function fetchCodeMieModels(env: NodeJS.ProcessEnv): Promise<LlmModel[]> {
  const jwtToken = env.CODEMIE_JWT_TOKEN;
  const baseUrl = env.CODEMIE_BASE_URL;

  if (jwtToken && baseUrl) {
    logger.debug('[pi-models] Fetching CodeMie model list via JWT auth');
    return fetchCodeMieLlmModels(baseUrl, jwtToken);
  }

  const codeMieUrl = env.CODEMIE_URL;
  if (codeMieUrl) {
    const sso = new CodeMieSSO();
    const credentials = await sso.getStoredCredentials(codeMieUrl);
    if (!credentials) {
      throw new Error(`SSO credentials not found for ${codeMieUrl}. Run: codemie profile login --url ${codeMieUrl}`);
    }
    logger.debug('[pi-models] Fetching CodeMie model list via SSO auth');
    return fetchCodeMieLlmModels(credentials.apiUrl, credentials.cookies);
  }

  throw new Error('No CodeMie authentication available. Run codemie setup or set CODEMIE_JWT_TOKEN.');
}

function buildModelsConfig(
  entries: PiModelEntry[],
  baseUrl: string,
  apiKey: string,
): PiModelsConfig {
  const proxyModels: PiModelEntry[] = [];
  const anthropicModels: PiModelEntry[] = [];

  for (const entry of entries) {
    const classification = classifyPiModel(entry.id);
    if (classification.provider === 'codemie-anthropic') {
      anthropicModels.push(entry);
    } else {
      proxyModels.push(entry);
    }
  }

  const providers: PiModelsConfig['providers'] = {};

  if (proxyModels.length > 0) {
    providers['codemie-proxy'] = {
      baseUrl: `${baseUrl.replace(/\/$/, '')}/v1`,
      api: 'openai-completions',
      apiKey,
      compat: {
        supportsReasoningEffort: true,
        thinkingFormat: 'reasoning_effort',
      },
      models: proxyModels,
    };
  }

  if (anthropicModels.length > 0) {
    providers['codemie-anthropic'] = {
      baseUrl: baseUrl.replace(/\/$/, ''),
      api: 'anthropic-messages',
      apiKey,
      authHeader: true,
      compat: {
        supportsReasoningEffort: true,
        thinkingFormat: 'reasoning_effort',
      },
      models: anthropicModels,
    };
  }

  return { providers };
}

function createSyntheticLlmModel(modelId: string): LlmModel {
  return {
    base_name: modelId,
    deployment_name: modelId,
    label: modelId,
    enabled: true,
    multimodal: false,
    features: {},
  };
}

function buildStaticFallbackModel(modelId: string, baseUrl: string, apiKey: string): PiModelsConfig {
  const entry = convertLlmModelToPiEntry(createSyntheticLlmModel(modelId));
  return buildModelsConfig([entry], baseUrl, apiKey);
}

export async function fetchAndBuildPiModels(
  env: NodeJS.ProcessEnv,
  cwd: string = process.cwd(),
): Promise<void> {
  const agentDir = getPiAgentDir(cwd);
  await mkdir(agentDir, { recursive: true });

  const baseUrl = env.CODEMIE_BASE_URL || '';
  const apiKey = env.CODEMIE_API_KEY || 'proxy-handled';

  let entries: PiModelEntry[] = [];
  try {
    const rawModels = await fetchCodeMieModels(env);
    entries = rawModels
      .filter(model => model.enabled)
      .map(convertLlmModelToPiEntry);
    logger.debug(`[pi-models] Loaded ${entries.length} models from CodeMie API`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[pi-models] Failed to fetch live models, falling back to static model: ${message}`);
    const configuredModel = env.CODEMIE_MODEL;
    if (!configuredModel) {
      throw new Error('No CodeMie model configured and live model fetch failed.');
    }
    const fallback = buildStaticFallbackModel(configuredModel, baseUrl, apiKey);
    await writeFile(getPiModelsPath(cwd), JSON.stringify(fallback, null, 2), 'utf-8');
    return;
  }

  if (entries.length === 0) {
    throw new Error('CodeMie returned no enabled models for codemie-pi.');
  }

  const config = buildModelsConfig(entries, baseUrl, apiKey);
  await writeFile(getPiModelsPath(cwd), JSON.stringify(config, null, 2), 'utf-8');
}
