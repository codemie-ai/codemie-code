import { ConfigurationError } from '@/utils/errors.js';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';

interface ModelsListResponse {
  data?: Array<{ id?: string }>;
}

interface CodeMieLlmModel {
  id?: string;
  base_name?: string;
  deployment_name?: string;
}

/**
 * Fetch every deployment id the tenant's gateway exposes, unfiltered.
 *
 * Modeled on `desktop.ts`'s `fetchClaudeModels`, minus its Claude-family
 * filter and vertex/curated-list fallback — this is a generic catalog read
 * consumed by connectors (VS Code Copilot BYOK) that must intersect the
 * result against their own capability table rather than a Claude-specific
 * curated list.
 */
export async function fetchTenantModelCatalog(proxyUrl: string, gatewayKey: string): Promise<string[]> {
  const endpoint = new URL('/v1/llm_models?include_all=true', proxyUrl).toString();
  try {
    logger.info(
      '[proxy] Fetching tenant model catalog from gateway',
      ...sanitizeLogArgs({
        endpoint,
        inferenceGatewayBaseUrl: proxyUrl,
        inferenceGatewayApiKey: gatewayKey,
      })
    );
    const response = await fetch(new URL('/v1/llm_models?include_all=true', proxyUrl), {
      headers: { Authorization: `Bearer ${gatewayKey}` },
    });
    if (!response.ok) {
      logger.warn(
        '[proxy] Tenant model catalog discovery failed',
        ...sanitizeLogArgs({
          endpoint,
          status: response.status,
          statusText: response.statusText,
          inferenceGatewayBaseUrl: proxyUrl,
        })
      );
      throw new ConfigurationError(
        response.status === 401
          ? `Local proxy model discovery was rejected with 401 Unauthorized at ${endpoint}. ` +
            'The local gateway key was not accepted by the proxy or was forwarded upstream incorrectly.'
          : `Local proxy model discovery failed at ${endpoint}: ${response.status} ${response.statusText}`
      );
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
    const ids = Array.isArray(json)
      ? json
        .map((model) => model.id || model.base_name || model.deployment_name)
        .filter((id): id is string => typeof id === 'string')
      : (json.data ?? [])
        .map((m) => m.id)
        .filter((id): id is string => typeof id === 'string');
    logger.info(
      '[proxy] Tenant model catalog discovery completed',
      ...sanitizeLogArgs({
        endpoint,
        totalModelCount: ids.length,
      })
    );
    return ids;
  } catch (error) {
    if (error instanceof ConfigurationError) {
      throw error;
    }
    logger.warn(
      '[proxy] Tenant model catalog discovery threw before completion',
      ...sanitizeLogArgs({
        endpoint,
        inferenceGatewayBaseUrl: proxyUrl,
        error: error instanceof Error ? error.message : String(error),
      })
    );
    throw new ConfigurationError(
      `Local proxy model discovery could not reach ${endpoint}. ` +
      `Reason: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
