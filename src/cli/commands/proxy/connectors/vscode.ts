import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ConfigurationError } from '@/utils/errors.js';
import {
  VS_CODE_SUPPORTED_MODELS,
  type VsCodeApiType,
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

function buildManagedModels(proxyUrl: string): VsCodeManagedModel[] {
  return VS_CODE_SUPPORTED_MODELS.map(definition => {
    const model: VsCodeManagedModel = {
      id: definition.id,
      name: definition.id,
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
    if (definition.modelOptions) model.modelOptions = definition.modelOptions;
    if (definition.requestHeaders) model.requestHeaders = definition.requestHeaders;
    if (definition.supportsReasoningEffort) {
      model.supportsReasoningEffort = definition.supportsReasoningEffort;
    }
    if (definition.reasoningEffortFormat) {
      model.reasoningEffortFormat = definition.reasoningEffortFormat;
    }

    return model;
  });
}

function mergeManagedProviders(
  providers: VsCodeLanguageModelProvider[],
  proxyUrl: string
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
    models: buildManagedModels(proxyUrl),
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

export async function writeVsCodeLanguageModelsConfig(
  proxyUrl: string,
  insiders = false
): Promise<WriteVsCodeConfigResult> {
  return writeVsCodeLanguageModelsConfigAtPath(
    getVsCodeLanguageModelsPath(insiders),
    proxyUrl
  );
}

export async function writeVsCodeLanguageModelsConfigAtPath(
  configPath: string,
  proxyUrl: string
): Promise<WriteVsCodeConfigResult> {
  const providers = await readProviders(configPath);
  const managedProviderIndexes = providers
    .map((provider, index) => isManagedProvider(provider) ? index : -1)
    .filter(index => index >= 0);
  const managedProviders = managedProviderIndexes
    .map(index => providers[index])
    .filter(isManagedProvider);
  const { provider: managedProvider, requiresSecretConfiguration } =
    mergeManagedProviders(managedProviders, proxyUrl);
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

  return { configPath, requiresSecretConfiguration };
}
