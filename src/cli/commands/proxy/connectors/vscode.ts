import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ConfigurationError } from '@/utils/errors.js';

const MANAGED_MODEL_NAME = 'CodeMie Profile Model';
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
  toolCalling: true;
  vision: true;
  streaming: true;
  thinking: true;
  supportsReasoningEffort: readonly ['minimal', 'low', 'medium', 'high'];
  reasoningEffortFormat: 'chat-completions';
  maxInputTokens: 224000;
  maxOutputTokens: 32000;
}

export interface WriteVsCodeConfigResult {
  configPath: string;
  requiresSecretConfiguration: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isManagedModel(model: unknown, currentModelId?: string): boolean {
  if (!isRecord(model)) return false;
  return model.name === MANAGED_MODEL_NAME ||
    (currentModelId !== undefined && model.id === currentModelId);
}

function isManagedProvider(provider: unknown): provider is VsCodeLanguageModelProvider {
  if (!isRecord(provider)) return false;

  const hasManagedModel = Array.isArray(provider.models) &&
    provider.models.some(model => isManagedModel(model));
  return hasManagedModel || (provider.vendor === 'customendpoint' && provider.name === 'CodeMie');
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

function buildManagedModel(proxyUrl: string, profileModel: string): VsCodeManagedModel {
  return {
    id: profileModel,
    name: MANAGED_MODEL_NAME,
    url: new URL('/v1/chat/completions', proxyUrl).toString(),
    toolCalling: true,
    vision: true,
    streaming: true,
    thinking: true,
    supportsReasoningEffort: ['minimal', 'low', 'medium', 'high'],
    reasoningEffortFormat: 'chat-completions',
    maxInputTokens: 224000,
    maxOutputTokens: 32000,
  };
}

function reconcileModels(existingModels: unknown, managedModel: VsCodeManagedModel): unknown[] {
  const models = Array.isArray(existingModels) ? existingModels : [];
  const reconciled: unknown[] = [];
  let inserted = false;

  for (const model of models) {
    if (isManagedModel(model, managedModel.id)) {
      if (!inserted) {
        reconciled.push(managedModel);
        inserted = true;
      }
      continue;
    }
    reconciled.push(model);
  }

  if (!inserted) reconciled.push(managedModel);
  return reconciled;
}

function mergeManagedProviders(
  providers: VsCodeLanguageModelProvider[],
  proxyUrl: string,
  profileModel: string
): { provider: VsCodeLanguageModelProvider; requiresSecretConfiguration: boolean } {
  const existingProvider = Object.assign({}, ...providers);
  const existingModels = providers.flatMap(provider =>
    Array.isArray(provider.models) ? provider.models : []
  );
  const existingSettings = Object.assign(
    {},
    ...providers.map(provider => isRecord(provider.settings) ? provider.settings : {})
  );
  const previousManagedModelIds = existingModels
    .filter(model => isManagedModel(model))
    .map(model => isRecord(model) ? model.id : undefined)
    .filter((id): id is string => typeof id === 'string');
  for (const modelId of new Set([
    profileModel,
    ...previousManagedModelIds,
  ])) {
    delete existingSettings[modelId];
  }
  const existingSecretReference = providers
    .map(provider => provider.apiKey)
    .find(isVsCodeSecretReference);

  const provider: VsCodeLanguageModelProvider = {
    ...existingProvider,
    name: 'CodeMie',
    vendor: 'customendpoint',
    apiType: 'chat-completions',
    models: reconcileModels(existingModels, buildManagedModel(proxyUrl, profileModel)),
  };

  // VS Code owns model configuration state and derives "medium" as the default for this
  // non-Claude model. Writing the same setting here races with VS Code's editor and can
  // produce duplicate `settings` keys in its unsaved buffer.
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
  profileModel: string,
  insiders = false
): Promise<WriteVsCodeConfigResult> {
  return writeVsCodeLanguageModelsConfigAtPath(
    getVsCodeLanguageModelsPath(insiders),
    proxyUrl,
    profileModel
  );
}

export async function writeVsCodeLanguageModelsConfigAtPath(
  configPath: string,
  proxyUrl: string,
  profileModel: string
): Promise<WriteVsCodeConfigResult> {
  const normalizedProfileModel = profileModel.trim();
  if (!normalizedProfileModel) {
    throw new ConfigurationError('VS Code model configuration requires a profile model.');
  }

  const providers = await readProviders(configPath);
  const managedProviderIndexes = providers
    .map((provider, index) => isManagedProvider(provider) ? index : -1)
    .filter(index => index >= 0);
  const managedProviders = managedProviderIndexes
    .map(index => providers[index])
    .filter(isManagedProvider);
  const { provider: managedProvider, requiresSecretConfiguration } =
    mergeManagedProviders(managedProviders, proxyUrl, normalizedProfileModel);
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
