import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { clientOfGatewayKey } from '@/providers/plugins/sso/proxy/proxy-clients.js';
import { isLoopbackGatewayUrl } from '@/telemetry/clients/claude-desktop/claude-desktop.gateway.js';
import { ClientNotInstalledError, ConfigurationError } from '@/utils/errors.js';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import { fetchTenantModelDescriptors, type TenantModelDescriptor } from './tenant-catalog.js';
import {
  buildDefaultVsCodeCapability,
  findVsCodeCapabilityEntry,
  resolveVsCodeTokenLimits,
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
  toolCalling: boolean;
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

/**
 * What a connector wrote for the local proxy, as read back: the port of its loopback URL and, when the config
 * holds the key, how the daemon reads it — `shared`, the client name it carries, or `refused`.
 */
export interface ConnectorGateway {
  port: number;
  key?: string;
}

/** The port of a loopback URL that names one, else null. */
export function loopbackPortOf(url: unknown): number | null {
  if (!isLoopbackGatewayUrl(url)) return null;
  const port = Number.parseInt(new URL(url as string).port, 10);
  return Number.isInteger(port) && port > 0 ? port : null;
}

/** How the daemon of gateway key `key` reads an `Authorization` value a connector wrote. */
export function gatewayKeyReading(authorization: string | undefined, key: string): string {
  const named = clientOfGatewayKey(authorization, key);
  if (named === null) return 'refused';
  return named.client ?? 'shared';
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
    throw new ClientNotInstalledError(
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
  descriptor: TenantModelDescriptor,
  name: string,
  proxyUrl: string
): VsCodeManagedModel {
  const { maxInputTokens, maxOutputTokens } = resolveVsCodeTokenLimits(entry, descriptor);
  const model: VsCodeManagedModel = {
    id: descriptor.id,
    name,
    url: new URL(getApiPath(entry.apiType), proxyUrl).toString(),
    apiType: entry.apiType,
    toolCalling: entry.toolCalling ?? true,
    vision: entry.vision,
    streaming: true,
    thinking: entry.thinking,
    maxInputTokens,
    maxOutputTokens,
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

const GITHUB_COPILOT_DEPLOYMENT_PATTERN = /^github-copilot-/i;

/**
 * Fetch the tenant's live model catalog and write one VS Code model per
 * enabled deployment, in catalog order. The capability table only enriches a
 * model whose family it knows ({@link findVsCodeCapabilityEntry}); any other
 * model gets conservative defaults ({@link buildDefaultVsCodeCapability}).
 * The list is rebuilt from the live catalog on every call — never narrowed to
 * the profile model, reordered, or marked with a default.
 *
 * `github-copilot-*` deployments stay excluded (kept product-owner decision).
 * Throws when no enabled model remains, mirroring `desktop.ts`'s zero-match throw.
 */
async function resolveManagedModels(
  proxyUrl: string,
  gatewayKey: string,
  project?: string
): Promise<VsCodeManagedModel[]> {
  const descriptors = await fetchTenantModelDescriptors(proxyUrl, gatewayKey, project);
  const models: VsCodeManagedModel[] = [];
  for (const descriptor of descriptors) {
    if (GITHUB_COPILOT_DEPLOYMENT_PATTERN.test(descriptor.id)) continue;
    const known = findVsCodeCapabilityEntry(descriptor.id);
    const entry = known ?? buildDefaultVsCodeCapability(descriptor);
    const name = known ? descriptor.id : (descriptor.label?.trim() || descriptor.id);
    models.push(buildManagedModel(entry, descriptor, name, proxyUrl));
  }
  if (models.length === 0) {
    throw new ConfigurationError(
      'Local proxy discovered no enabled tenant models to offer in VS Code Copilot.'
    );
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

/**
 * The port the managed CodeMie models of VS Code's (or VS Code Insiders') `chatLanguageModels.json` point at:
 * the first one that differs from the daemon's `port`, else `port`; null when there is no product directory, no
 * readable file, or no managed provider whose model URLs are all loopback (the one the remover removes). The key is not in this file. Never throws, writes nothing.
 */
export async function readVsCodeByokGateway(port: number, insiders = false): Promise<ConnectorGateway | null> {
  try {
    const providers = await readProviders(getVsCodeLanguageModelsPath(insiders));
    // The remover's ownership rule: a managed provider with any non-loopback model is the user's, not connected.
    const ports = providers
      .filter(isCodeMieOwnedProvider)
      .flatMap(provider => Array.isArray(provider.models) ? provider.models : [])
      .map(model => isRecord(model) ? loopbackPortOf(model.url) : null)
      .filter((modelPort): modelPort is number => modelPort !== null);
    if (ports.length === 0) return null;
    return { port: ports.find(modelPort => modelPort !== port) ?? port };
  } catch (error) {
    logger.debug('[proxy] VS Code BYOK models not readable', ...sanitizeLogArgs({ insiders, error: String(error) }));
    return null;
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
  project?: string
): Promise<WriteVsCodeConfigResult> {
  return writeVsCodeLanguageModelsConfigAtPath(
    getVsCodeLanguageModelsPath(insiders),
    proxyUrl,
    gatewayKey,
    project
  );
}

export async function writeVsCodeLanguageModelsConfigAtPath(
  configPath: string,
  proxyUrl: string,
  gatewayKey: string,
  project?: string
): Promise<WriteVsCodeConfigResult> {
  const providers = await readProviders(configPath);
  const models = await resolveManagedModels(proxyUrl, gatewayKey, project);
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

/** A managed provider is the proxy's own only when every model URL it holds is loopback; the reader and the remover share it. */
function isCodeMieOwnedProvider(provider: unknown): provider is VsCodeLanguageModelProvider {
  if (!isManagedProvider(provider)) return false;
  const models = Array.isArray(provider.models) ? provider.models : [];
  return models.length > 0 && models.every(model => isRecord(model) && loopbackPortOf(model.url) !== null);
}

/**
 * Removes the `CodeMie`/`customendpoint` provider `writeVsCodeLanguageModelsConfig` wrote, only when all its model
 * URLs are loopback; user-added providers, and a non-loopback provider that happens to be named CodeMie, stay.
 * Writes nothing when there is nothing to remove.
 */
export async function removeVsCodeLanguageModelsConfigAtPath(configPath: string): Promise<{ removed: boolean }> {
  const providers = await readProviders(configPath);
  const kept = providers.filter(provider => !isCodeMieOwnedProvider(provider));
  if (kept.length === providers.length) return { removed: false };
  try {
    await writeAtomically(configPath, `${JSON.stringify(kept, null, '\t')}\n`);
  } catch (error) {
    throw new ConfigurationError(
      `Failed to update VS Code language model configuration at ${configPath}: ` +
      `${error instanceof Error ? error.message : String(error)}`
    );
  }
  return { removed: true };
}

export async function removeVsCodeLanguageModelsConfig(opts: { insiders: boolean }): Promise<{ removed: boolean }> {
  if (!existsSync(getVsCodeProductDir(opts.insiders))) return { removed: false };
  return removeVsCodeLanguageModelsConfigAtPath(getVsCodeLanguageModelsPath(opts.insiders));
}
