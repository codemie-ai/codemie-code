import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ConfigurationError } from '@/utils/errors.js';
import { resolveTenantModelId } from './model-name-resolver.js';
import { fetchTenantModelCatalog } from './tenant-catalog.js';
import {
  VS_CODE_CAPABILITY_TABLE,
  type VsCodeApiType,
  type VsCodeCapabilityEntry,
  type VsCodeReasoningEffort,
} from './vscode-models.js';

const SECRET_REFERENCE_PATTERN = /^\$\{input:chat\.lm\.secret\.[^}]+\}$/;

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
  modelCount: number;
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

export function getVsCodeProductDir(insiders: boolean): string {
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

function buildManagedModel(
  entry: VsCodeCapabilityEntry,
  tenantId: string,
  proxyUrl: string
): VsCodeManagedModel {
  const model: VsCodeManagedModel = {
    id: tenantId,
    name: tenantId,
    url: new URL(getApiPath(entry.apiType), proxyUrl).toString(),
    apiType: entry.apiType,
    toolCalling: true,
    vision: entry.vision,
    streaming: true,
    thinking: entry.thinking,
    maxInputTokens: entry.maxInputTokens,
    maxOutputTokens: entry.maxOutputTokens,
  };

  if (entry.adaptiveThinking) model.adaptiveThinking = true;
  if (entry.zeroDataRetentionEnabled !== undefined) {
    model.zeroDataRetentionEnabled = entry.zeroDataRetentionEnabled;
  }
  if (entry.modelOptions) model.modelOptions = entry.modelOptions;
  if (entry.requestHeaders) model.requestHeaders = entry.requestHeaders;
  if (entry.supportsReasoningEffort) {
    model.supportsReasoningEffort = entry.supportsReasoningEffort;
  }
  if (entry.reasoningEffortFormat) {
    model.reasoningEffortFormat = entry.reasoningEffortFormat;
  }

  return model;
}

/**
 * Fetch the tenant's live model catalog and intersect it against the VS Code
 * capability table via {@link resolveTenantModelId}. A capability family with
 * no tenant match is silently dropped — the VS Code Copilot BYOK picker must
 * never offer a model the tenant does not actually serve. Throws when the
 * intersection is empty, mirroring `desktop.ts`'s zero-match throw.
 *
 * When `profileModel` names a model the active profile is pinned to (e.g. a
 * provider-qualified id like `openai.gpt-5.6-sol`), and it resolves against
 * the same tenant catalog, narrow the result to just that one entry instead
 * of offering every family the tenant serves — the picker should show
 * exactly what the profile is configured to use, under its real tenant id,
 * rather than every reachable model. An unrecognized or unset `profileModel`
 * falls back to the full intersected list.
 */
async function resolveManagedModels(
  proxyUrl: string,
  gatewayKey: string,
  profileModel: string | undefined
): Promise<VsCodeManagedModel[]> {
  const catalog = await fetchTenantModelCatalog(proxyUrl, gatewayKey);
  const models: VsCodeManagedModel[] = [];
  for (const entry of VS_CODE_CAPABILITY_TABLE) {
    const tenantId = resolveTenantModelId(entry.family, catalog);
    if (!tenantId) continue;
    models.push(buildManagedModel(entry, tenantId, proxyUrl));
  }
  if (models.length === 0) {
    throw new ConfigurationError(
      'Local proxy discovered tenant models, but none matched the CodeMie VS Code Copilot capability table.'
    );
  }

  const pinnedModel = profileModel?.trim();
  if (pinnedModel) {
    const pinnedTenantId = resolveTenantModelId(pinnedModel, catalog);
    const pinnedManagedModel = pinnedTenantId
      ? models.find(model => model.id === pinnedTenantId)
      : undefined;
    if (pinnedManagedModel) return [pinnedManagedModel];
  }

  return models;
}

function mergeManagedProviders(
  providers: VsCodeLanguageModelProvider[],
  models: VsCodeManagedModel[]
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
    models,
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

export async function writeAtomically(configPath: string, content: string): Promise<void> {
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

export async function writeVsCodeLanguageModelsConfig(
  proxyUrl: string,
  gatewayKey: string,
  insiders = false,
  profileModel?: string
): Promise<WriteVsCodeConfigResult> {
  return writeVsCodeLanguageModelsConfigAtPath(
    getVsCodeLanguageModelsPath(insiders),
    proxyUrl,
    gatewayKey,
    profileModel
  );
}

export async function writeVsCodeLanguageModelsConfigAtPath(
  configPath: string,
  proxyUrl: string,
  gatewayKey: string,
  profileModel?: string
): Promise<WriteVsCodeConfigResult> {
  const providers = await readProviders(configPath);
  const models = await resolveManagedModels(proxyUrl, gatewayKey, profileModel);
  const managedProviderIndexes = providers
    .map((provider, index) => isManagedProvider(provider) ? index : -1)
    .filter(index => index >= 0);
  const managedProviders = managedProviderIndexes
    .map(index => providers[index])
    .filter(isManagedProvider);
  const { provider: managedProvider, requiresSecretConfiguration } =
    mergeManagedProviders(managedProviders, models);
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

  return { configPath, requiresSecretConfiguration, modelCount: models.length };
}
