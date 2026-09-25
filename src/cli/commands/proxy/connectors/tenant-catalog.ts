import { ConfigurationError } from '@/utils/errors.js';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';

interface CodeMieLlmModel {
  id?: string;
  base_name?: string;
  deployment_name?: string;
  label?: string;
  enabled?: boolean;
  provider?: string;
  multimodal?: boolean;
  features?: { tools?: boolean };
}

/** One enabled tenant deployment, as reported by `/v1/llm_models?include_all=true`. */
export interface TenantModelDescriptor {
  /** `id || base_name || deployment_name`, verbatim. */
  id: string;
  label?: string;
  provider?: string;
  multimodal?: boolean;
  /** From `features.tools`. */
  toolCalling?: boolean;
}

interface ModelsListResponse {
  data?: CodeMieLlmModel[];
}

/** Bounds how long a hung gateway can block `codemie proxy connect`. */
const CATALOG_FETCH_TIMEOUT_MS = 10_000;

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Same `id || base_name || deployment_name` fallback chain for every response shape. */
function extractModelId(model: CodeMieLlmModel): string | undefined {
  return model.id || model.base_name || model.deployment_name;
}

function toDescriptor(model: CodeMieLlmModel, id: string): TenantModelDescriptor {
  const descriptor: TenantModelDescriptor = { id };
  if (typeof model.label === 'string') descriptor.label = model.label;
  if (typeof model.provider === 'string') descriptor.provider = model.provider;
  if (typeof model.multimodal === 'boolean') descriptor.multimodal = model.multimodal;
  if (typeof model.features?.tools === 'boolean') descriptor.toolCalling = model.features.tools;
  return descriptor;
}

/**
 * Enabled entries in catalog order, first occurrence wins per id. A missing
 * `enabled` flag means enabled — only an explicit `false` drops an entry.
 */
function parseCatalogResponseDescriptors(json: ModelsListResponse | CodeMieLlmModel[]): TenantModelDescriptor[] {
  const models = Array.isArray(json) ? json : (json.data ?? []);
  const seen = new Set<string>();
  const descriptors: TenantModelDescriptor[] = [];
  for (const model of models) {
    const id = extractModelId(model);
    if (typeof id !== 'string' || model.enabled === false || seen.has(id)) continue;
    seen.add(id);
    descriptors.push(toDescriptor(model, id));
  }
  return descriptors;
}

function buildCatalogHttpError(response: Response, endpoint: string): ConfigurationError {
  return new ConfigurationError(
    response.status === 401
      ? `Local proxy model discovery was rejected with 401 Unauthorized at ${endpoint}. ` +
        'The local gateway key was not accepted by the proxy or was forwarded upstream incorrectly.'
      : `Local proxy model discovery failed at ${endpoint}: ${response.status} ${response.statusText}`
  );
}

function logCatalogFetchStart(endpoint: string, proxyUrl: string, gatewayKey: string): void {
  logger.info(
    '[proxy] Fetching tenant model catalog from gateway',
    ...sanitizeLogArgs({
      endpoint,
      inferenceGatewayBaseUrl: proxyUrl,
      inferenceGatewayApiKey: gatewayKey,
    })
  );
}

function logCatalogFetchFailed(endpoint: string, response: Response, proxyUrl: string): void {
  logger.warn(
    '[proxy] Tenant model catalog discovery failed',
    ...sanitizeLogArgs({
      endpoint,
      status: response.status,
      statusText: response.statusText,
      inferenceGatewayBaseUrl: proxyUrl,
    })
  );
}

function logCatalogFetchCompleted(endpoint: string, count: number): void {
  logger.info(
    '[proxy] Tenant model catalog discovery completed',
    ...sanitizeLogArgs({ endpoint, totalModelCount: count })
  );
}

function logCatalogFetchThrew(endpoint: string, proxyUrl: string, error: unknown): void {
  logger.warn(
    '[proxy] Tenant model catalog discovery threw before completion',
    ...sanitizeLogArgs({
      endpoint,
      inferenceGatewayBaseUrl: proxyUrl,
      error: error instanceof Error ? error.message : String(error),
    })
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Fetch a descriptor for every enabled deployment the tenant's gateway
 * exposes, in catalog order.
 *
 * Modeled on `desktop.ts`'s `fetchClaudeModels`, minus its Claude-family
 * filter and vertex/curated-list fallback — this is a generic catalog read
 * consumed by connectors (VS Code Copilot BYOK) that enrich the result from
 * their own capability table rather than a Claude-specific curated list.
 */
export async function fetchTenantModelDescriptors(
  proxyUrl: string,
  gatewayKey: string
): Promise<TenantModelDescriptor[]> {
  let endpoint: string;
  try {
    endpoint = new URL('/v1/llm_models?include_all=true', proxyUrl).toString();
  } catch (error) {
    throw new ConfigurationError(
      `Local proxy model discovery could not build a request URL from proxyUrl "${proxyUrl}". ` +
      `Reason: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  logCatalogFetchStart(endpoint, proxyUrl, gatewayKey);
  try {
    const response = await fetchWithTimeout(
      endpoint,
      { headers: { Authorization: `Bearer ${gatewayKey}` } },
      CATALOG_FETCH_TIMEOUT_MS
    );
    if (!response.ok) {
      logCatalogFetchFailed(endpoint, response, proxyUrl);
      throw buildCatalogHttpError(response, endpoint);
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      throw new ConfigurationError(
        `Local proxy model discovery received an unexpected response (${contentType || 'no content-type'}) from ${endpoint}. ` +
        `Your SSO session may have expired — run \`codemie proxy stop && codemie profile login\` ` +
        `to re-authenticate, then run \`codemie proxy connect\` again.`
      );
    }
    const json = await response.json() as ModelsListResponse | CodeMieLlmModel[];
    const descriptors = parseCatalogResponseDescriptors(json);
    logCatalogFetchCompleted(endpoint, descriptors.length);
    return descriptors;
  } catch (error) {
    if (error instanceof ConfigurationError) {
      throw error;
    }
    logCatalogFetchThrew(endpoint, proxyUrl, error);
    if (isAbortError(error)) {
      throw new ConfigurationError(
        `Local proxy model discovery timed out after ${CATALOG_FETCH_TIMEOUT_MS}ms reaching ${endpoint}.`
      );
    }
    throw new ConfigurationError(
      `Local proxy model discovery could not reach ${endpoint}. ` +
      `Reason: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** Every enabled deployment id the tenant's gateway exposes, in catalog order. */
export async function fetchTenantModelCatalog(proxyUrl: string, gatewayKey: string): Promise<string[]> {
  return (await fetchTenantModelDescriptors(proxyUrl, gatewayKey)).map((d) => d.id);
}
