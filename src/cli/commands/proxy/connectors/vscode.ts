import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ConfigurationError } from '@/utils/errors.js';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import { fetchGatewayModelIds } from './gateway-models.js';
import {
  VS_CODE_SUPPORTED_MODELS,
  type VsCodeApiType,
  type VsCodeModelDefinition,
  type VsCodeReasoningEffort,
} from './vscode-models.js';

const SECRET_REFERENCE_PATTERN = /^\$\{input:chat\.lm\.secret\.[^}]+\}$/;

/** Capabilities assumed for a gateway model the curated catalog does not describe. */
const UNCATALOGED_MODEL_DEFAULTS: Omit<VsCodeModelDefinition, 'id'> = {
  apiType: 'chat-completions',
  vision: false,
  thinking: false,
  maxInputTokens: 128000,
  maxOutputTokens: 16384,
};

interface VsCodeLanguageModelProvider {
  [key: string]: unknown;
  name?: string;
  vendor?: string;
  apiKey?: string;
  apiType?: string;
  models?: unknown[];
  settings?: Record<string, unknown>;
}

interface VsCodeManagedModel {
  id: string;
  name: string;
  url: string;
  apiType: VsCodeApiType;
  toolCalling: true;
  vision: boolean;
  streaming: true;
  thinking: boolean;
  zeroDataRetentionEnabled?: boolean;
  adaptiveThinking?: true;
  modelOptions?: Readonly<{
    temperature?: number | null;
    top_p?: number | null;
  }>;
  requestHeaders?: Readonly<Record<string, string>>;
  supportsReasoningEffort?: readonly VsCodeReasoningEffort[];
  reasoningEffortFormat?: 'chat-completions' | 'responses';
  maxInputTokens: number;
  maxOutputTokens: number;
}

export interface WriteVsCodeConfigResult {
  configPath: string;
  requiresSecretConfiguration: boolean;
  /** Model IDs written under the CodeMie provider, in the order VS Code will see them. */
  modelIds: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isManagedProvider(provider: unknown): provider is VsCodeLanguageModelProvider {
  return isRecord(provider) &&
    provider.vendor === 'customendpoint' &&
    provider.name === 'CodeMie';
}

export function isVsCodeSecretReference(value: unknown): value is string {
  return typeof value === 'string' && SECRET_REFERENCE_PATTERN.test(value);
}

function getVsCodeProductDir(insiders: boolean): string {
  const productName = insiders ? 'Code - Insiders' : 'Code';

  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', productName);
  }

  if (process.platform === 'win32') {
    const roamingDir = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    return join(roamingDir, productName);
  }

  if (process.platform === 'linux') {
    const configDir = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
    return join(configDir, productName);
  }

  throw new ConfigurationError(
    `VS Code BYOK configuration is not supported on platform "${process.platform}".`
  );
}

export function getVsCodeLanguageModelsPath(insiders = false): string {
  const productDir = getVsCodeProductDir(insiders);
  if (!existsSync(productDir)) {
    const edition = insiders ? 'VS Code Insiders' : 'VS Code';
    const alternative = insiders
      ? 'Remove --insiders to configure stable VS Code.'
      : 'Use --insiders if only VS Code Insiders is installed.';
    throw new ConfigurationError(
      `${edition} user data directory was not found at ${productDir}.\n${alternative}`
    );
  }
  return join(productDir, 'User', 'chatLanguageModels.json');
}

function getApiPath(apiType: VsCodeApiType): string {
  if (apiType === 'responses') return '/v1/responses';
  if (apiType === 'messages') return '/v1/messages';
  return '/v1/chat/completions';
}

const CATALOG_BY_ID = new Map(VS_CODE_SUPPORTED_MODELS.map(definition => [definition.id, definition]));
const CATALOG_ORDER = new Map(VS_CODE_SUPPORTED_MODELS.map((definition, index) => [definition.id, index]));

/**
 * Match a gateway model ID against the curated catalog, tolerating the suffixes
 * the gateway adds to its registrations (`-YYYYMMDD` snapshots, `-vertex`
 * deployments). Returns undefined when the catalog says nothing about the model,
 * which is not an error: the model is still exposed, with default capabilities.
 */
export function resolveModelDefinition(id: string): VsCodeModelDefinition | undefined {
  const stripVertex = (value: string): string => value.replace(/-vertex$/i, '');
  const stripSnapshot = (value: string): string => value.replace(/-\d{6,10}$/, '');
  const candidates = new Set([
    id,
    stripVertex(id),
    stripSnapshot(id),
    stripSnapshot(stripVertex(id)),
  ]);

  for (const candidate of candidates) {
    const definition = CATALOG_BY_ID.get(candidate);
    if (definition) return definition;
  }
  return undefined;
}

/** Cataloged models first (in catalog order) so the familiar picker ordering survives. */
function orderModelIds(availableIds: readonly string[]): string[] {
  const known: Array<{ id: string; rank: number }> = [];
  const unknown: string[] = [];

  for (const id of new Set(availableIds)) {
    const rank = CATALOG_ORDER.get(resolveModelDefinition(id)?.id ?? '');
    if (rank === undefined) unknown.push(id);
    else known.push({ id, rank });
  }

  known.sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
  unknown.sort((a, b) => a.localeCompare(b));
  return [...known.map(entry => entry.id), ...unknown];
}

function toManagedModel(proxyUrl: string, id: string): VsCodeManagedModel {
  const definition = resolveModelDefinition(id) ?? UNCATALOGED_MODEL_DEFAULTS;
  const model: VsCodeManagedModel = {
    id,
    name: id,
    url: new URL(getApiPath(definition.apiType), proxyUrl).toString(),
    apiType: definition.apiType,
    toolCalling: true,
    vision: definition.vision,
    streaming: true,
    thinking: definition.thinking,
    maxInputTokens: definition.maxInputTokens,
    maxOutputTokens: definition.maxOutputTokens,
  };

  if (definition.adaptiveThinking) model.adaptiveThinking = true;
  if (definition.zeroDataRetentionEnabled !== undefined) {
    model.zeroDataRetentionEnabled = definition.zeroDataRetentionEnabled;
  }
  if (definition.modelOptions) model.modelOptions = definition.modelOptions;
  if (definition.requestHeaders) model.requestHeaders = definition.requestHeaders;
  if (definition.supportsReasoningEffort) {
    model.supportsReasoningEffort = definition.supportsReasoningEffort;
  }
  if (definition.reasoningEffortFormat) {
    model.reasoningEffortFormat = definition.reasoningEffortFormat;
  }

  return model;
}

/**
 * Build the provider's model list. `availableIds` is what the gateway actually
 * serves; omitting it falls back to the curated catalog, which is only correct
 * when discovery could not run.
 */
function buildManagedModels(proxyUrl: string, availableIds?: readonly string[]): VsCodeManagedModel[] {
  const ids = availableIds
    ? orderModelIds(availableIds)
    : VS_CODE_SUPPORTED_MODELS.map(definition => definition.id);
  return ids.map(id => toManagedModel(proxyUrl, id));
}

function mergeManagedProviders(
  providers: VsCodeLanguageModelProvider[],
  proxyUrl: string,
  availableIds?: readonly string[]
): { provider: VsCodeLanguageModelProvider; requiresSecretConfiguration: boolean } {
  const existingProvider = Object.assign({}, ...providers);
  const existingSettings = Object.assign(
    {},
    ...providers.map(provider => isRecord(provider.settings) ? provider.settings : {})
  );
  const existingSecretReference = providers
    .map(provider => provider.apiKey)
    .find(isVsCodeSecretReference);

  const provider: VsCodeLanguageModelProvider = {
    ...existingProvider,
    name: 'CodeMie',
    vendor: 'customendpoint',
    apiType: 'chat-completions',
    models: buildManagedModels(proxyUrl, availableIds),
  };

  // VS Code owns effort selections. Preserve them instead of racing with the editor.
  if (Object.keys(existingSettings).length > 0) provider.settings = existingSettings;
  else delete provider.settings;

  if (existingSecretReference) provider.apiKey = existingSecretReference;
  else delete provider.apiKey;

  return {
    provider,
    requiresSecretConfiguration: !existingSecretReference,
  };
}

async function readProviders(configPath: string): Promise<unknown[]> {
  if (!existsSync(configPath)) return [];

  let raw: string;
  try {
    raw = await readFile(configPath, 'utf-8');
  } catch (error) {
    throw new ConfigurationError(
      `Failed to read VS Code language model configuration at ${configPath}: ` +
      `${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (raw.trim().length === 0) return [];

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new ConfigurationError(
        `VS Code language model configuration must contain a JSON array: ${configPath}`
      );
    }
    return parsed;
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError(
      `VS Code language model configuration is not valid JSON and was not changed: ${configPath}`
    );
  }
}

async function writeAtomically(configPath: string, content: string): Promise<void> {
  const configDir = dirname(configPath);
  await mkdir(configDir, { recursive: true });

  const tempPath = `${configPath}.${process.pid}.tmp`;
  const mode = existsSync(configPath)
    ? (await stat(configPath)).mode & 0o777
    : 0o600;

  try {
    await writeFile(tempPath, content, { encoding: 'utf-8', mode });
    await rename(tempPath, configPath);
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch {
      // The temporary file may not have been created or may already be renamed.
    }
    throw error;
  }
}

/**
 * Resolve what the gateway serves, falling back to the curated catalog when
 * discovery fails so a transient backend outage cannot leave VS Code with no
 * CodeMie models at all.
 */
async function discoverModelIds(
  proxyUrl: string,
  gatewayKey: string
): Promise<string[] | undefined> {
  try {
    const ids = await fetchGatewayModelIds(proxyUrl, gatewayKey);
    if (ids.length > 0) return ids;
    logger.warn('[proxy] Gateway returned no models — falling back to the curated VS Code catalog');
  } catch (error) {
    logger.warn(
      '[proxy] Gateway model discovery failed — falling back to the curated VS Code catalog',
      ...sanitizeLogArgs({
        error: error instanceof Error ? error.message : String(error),
      })
    );
  }
  return undefined;
}

export async function writeVsCodeLanguageModelsConfig(
  proxyUrl: string,
  gatewayKey: string,
  insiders = false
): Promise<WriteVsCodeConfigResult> {
  const configPath = getVsCodeLanguageModelsPath(insiders);
  return writeVsCodeLanguageModelsConfigAtPath(
    configPath,
    proxyUrl,
    await discoverModelIds(proxyUrl, gatewayKey)
  );
}

export async function writeVsCodeLanguageModelsConfigAtPath(
  configPath: string,
  proxyUrl: string,
  availableModelIds?: readonly string[]
): Promise<WriteVsCodeConfigResult> {
  const providers = await readProviders(configPath);
  const managedProviderIndexes = providers
    .map((provider, index) => isManagedProvider(provider) ? index : -1)
    .filter(index => index >= 0);
  const managedProviders = managedProviderIndexes
    .map(index => providers[index])
    .filter(isManagedProvider);
  const { provider: managedProvider, requiresSecretConfiguration } =
    mergeManagedProviders(managedProviders, proxyUrl, availableModelIds);
  const firstManagedProviderIndex = managedProviderIndexes[0] ?? providers.length;
  const managedProviderIndexSet = new Set(managedProviderIndexes);
  const reconciledProviders = providers.flatMap((provider, index) => {
    if (index === firstManagedProviderIndex) return [managedProvider];
    if (managedProviderIndexSet.has(index)) return [];
    return [provider];
  });
  if (managedProviderIndexes.length === 0) reconciledProviders.push(managedProvider);

  try {
    await writeAtomically(configPath, `${JSON.stringify(reconciledProviders, null, '\t')}\n`);
  } catch (error) {
    throw new ConfigurationError(
      `Failed to update VS Code language model configuration at ${configPath}: ` +
      `${error instanceof Error ? error.message : String(error)}`
    );
  }

  const modelIds = (managedProvider.models as VsCodeManagedModel[]).map(model => model.id);
  logger.info(
    '[proxy] VS Code managed model catalog resolved',
    ...sanitizeLogArgs({
      configPath,
      proxyUrl,
      discoveredModelCount: availableModelIds?.length ?? 0,
      usedCuratedFallback: availableModelIds === undefined,
      writtenModelCount: modelIds.length,
      writtenModels: modelIds,
    })
  );

  return { configPath, requiresSecretConfiguration, modelIds };
}
