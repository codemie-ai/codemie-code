import type { LlmModel } from '@/providers/plugins/sso/sso.http-client.js';
import { ConfigurationError } from '@/utils/errors.js';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';

const MODEL_DISCOVERY_TIMEOUT_MS = 10000;

export type VsCodeProtocolType = 'chat-completions' | 'responses' | 'messages';

export type VsCodeReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

export interface VsCodeProtocolMetadata {
  type: VsCodeProtocolType;
  zero_data_retention?: boolean;
  adaptive_thinking?: boolean;
  reasoning_efforts?: VsCodeReasoningEffort[];
  reasoning_effort_format?: 'chat-completions' | 'responses';
}

export interface VsCodeCatalogModel extends LlmModel {
  request_model?: string;
  max_input_tokens?: number;
  max_output_tokens?: number;
  protocol?: unknown;
}

export interface VsCodeModelDescriptor {
  requestId: string;
  baseName: string;
  deploymentName: string;
  label: string;
  provider?: string;
  features: NonNullable<LlmModel['features']>;
  default: boolean;
  multimodal: boolean;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  protocol?: VsCodeProtocolMetadata;
  protocolMetadataPresent: boolean;
}

export interface VsCodeModelCatalog {
  models: VsCodeModelDescriptor[];
  discoveredCount: number;
  enabledCount: number;
}

interface ModelsListResponse {
  data?: VsCodeCatalogModel[];
}

const PROTOCOL_TYPES = new Set<VsCodeProtocolType>([
  'chat-completions',
  'responses',
  'messages',
]);

const REASONING_EFFORTS = new Set<VsCodeReasoningEffort>([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

function getRawModels(value: unknown): VsCodeCatalogModel[] | undefined {
  if (Array.isArray(value)) return value as VsCodeCatalogModel[];
  if (typeof value !== 'object' || value === null) return undefined;
  const data = (value as ModelsListResponse).data;
  return Array.isArray(data) ? data : undefined;
}

function trimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function normalizeProtocol(value: unknown): VsCodeProtocolMetadata | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;

  const protocol = value as Record<string, unknown>;
  if (!PROTOCOL_TYPES.has(protocol.type as VsCodeProtocolType)) return undefined;
  const efforts = Array.isArray(protocol.reasoning_efforts)
    ? protocol.reasoning_efforts.filter(
      (effort): effort is VsCodeReasoningEffort =>
        REASONING_EFFORTS.has(effort as VsCodeReasoningEffort)
    )
    : undefined;
  const format = protocol.reasoning_effort_format === 'chat-completions' ||
    protocol.reasoning_effort_format === 'responses'
    ? protocol.reasoning_effort_format
    : undefined;

  return {
    type: protocol.type as VsCodeProtocolType,
    ...(typeof protocol.zero_data_retention === 'boolean' && {
      zero_data_retention: protocol.zero_data_retention,
    }),
    ...(typeof protocol.adaptive_thinking === 'boolean' && {
      adaptive_thinking: protocol.adaptive_thinking,
    }),
    ...(efforts && efforts.length > 0 && { reasoning_efforts: efforts }),
    ...(format && { reasoning_effort_format: format }),
  };
}

function normalizeModel(model: VsCodeCatalogModel): VsCodeModelDescriptor | undefined {
  if (model.enabled !== true) return undefined;
  const deploymentName = trimmedString(model.deployment_name);
  const requestId = trimmedString(model.request_model) ?? deploymentName;
  if (!deploymentName || !requestId) return undefined;

  const protocol = normalizeProtocol(model.protocol);
  const maxInputTokens = positiveInteger(model.max_input_tokens);
  const maxOutputTokens = positiveInteger(model.max_output_tokens);
  const provider = trimmedString(model.provider);
  return {
    requestId,
    deploymentName,
    baseName: trimmedString(model.base_name) ?? deploymentName,
    label: trimmedString(model.label) ?? requestId,
    ...(provider && { provider }),
    features: model.features ?? {},
    default: model.default === true,
    multimodal: model.multimodal === true,
    ...(maxInputTokens && { maxInputTokens }),
    ...(maxOutputTokens && { maxOutputTokens }),
    ...(protocol && { protocol }),
    protocolMetadataPresent: model.protocol !== undefined && model.protocol !== null,
  };
}

function compareModels(a: VsCodeModelDescriptor, b: VsCodeModelDescriptor): number {
  if (a.default !== b.default) return a.default ? -1 : 1;
  const labelDifference = a.label.localeCompare(b.label);
  return labelDifference !== 0 ? labelDifference : a.requestId.localeCompare(b.requestId);
}

export function normalizeVsCodeModelCatalog(
  rawModels: readonly VsCodeCatalogModel[]
): VsCodeModelCatalog {
  const modelsByRequestId = new Map<string, VsCodeModelDescriptor>();
  for (const rawModel of rawModels) {
    const model = normalizeModel(rawModel);
    const existing = model ? modelsByRequestId.get(model.requestId) : undefined;
    if (model && (!existing || (model.default && !existing.default))) {
      modelsByRequestId.set(model.requestId, model);
    }
  }

  const models = [...modelsByRequestId.values()].sort(compareModels);
  return {
    models,
    discoveredCount: rawModels.length,
    enabledCount: models.length,
  };
}

/** Fetch the selected profile/project catalog through the authenticated local proxy. */
export async function fetchVsCodeModelCatalog(
  proxyUrl: string,
  gatewayKey: string
): Promise<VsCodeModelCatalog> {
  const endpoint = new URL('/v1/llm_models?include_all=true', proxyUrl).toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODEL_DISCOVERY_TIMEOUT_MS);

  try {
    logger.info(
      '[proxy] Fetching VS Code model catalog from local gateway',
      ...sanitizeLogArgs({ endpoint })
    );
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${gatewayKey}`,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new ConfigurationError(
          `Local proxy model discovery was rejected with ${response.status}. ` +
          'Run `codemie proxy stop && codemie profile login`, then reconnect VS Code.'
        );
      }
      throw new ConfigurationError(
        `Local proxy model discovery failed at ${endpoint}: ` +
        `${response.status} ${response.statusText}`
      );
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      throw new ConfigurationError(
        `Local proxy model discovery received an unexpected response ` +
        `(${contentType || 'no content-type'}) from ${endpoint}. ` +
        'Your SSO session may have expired — run `codemie proxy stop && codemie profile login`, ' +
        'then run `codemie proxy connect vscode` again.'
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new ConfigurationError(
        `Local proxy model discovery returned invalid JSON from ${endpoint}: ` +
        `${error instanceof Error ? error.message : String(error)}`
      );
    }

    const rawModels = getRawModels(payload);
    if (!rawModels) {
      throw new ConfigurationError(
        `Local proxy model discovery returned an unsupported catalog shape from ${endpoint}.`
      );
    }

    const catalog = normalizeVsCodeModelCatalog(rawModels);
    if (catalog.models.length === 0) {
      throw new ConfigurationError(
        'Local proxy model discovery did not return any enabled models with a valid request ID. ' +
        'The existing VS Code configuration was not changed.'
      );
    }

    logger.info(
      '[proxy] VS Code model catalog discovery completed',
      ...sanitizeLogArgs({
        endpoint,
        discoveredCount: catalog.discoveredCount,
        enabledCount: catalog.enabledCount,
      })
    );
    return catalog;
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    logger.warn(
      '[proxy] VS Code model catalog discovery failed',
      ...sanitizeLogArgs({
        endpoint,
        error: error instanceof Error ? error.message : String(error),
      })
    );
    throw new ConfigurationError(
      `Local proxy model discovery could not reach ${endpoint}. ` +
      `Reason: ${error instanceof Error ? error.message : String(error)}. ` +
      'The existing VS Code configuration was not changed.'
    );
  } finally {
    clearTimeout(timeout);
  }
}
