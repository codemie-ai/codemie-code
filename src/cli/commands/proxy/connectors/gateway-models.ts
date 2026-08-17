import { ConfigurationError } from '@/utils/errors.js';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';

/** SSO-backed catalog endpoint; `include_all` returns every model the tenant may use, not just the defaults. */
const MODELS_PATH = '/v1/llm_models?include_all=true';

interface ModelsListResponse {
  data?: Array<{ id?: string }>;
}

interface CodeMieLlmModel {
  id?: string;
  base_name?: string;
  deployment_name?: string;
}

function extractModelIds(json: ModelsListResponse | CodeMieLlmModel[]): string[] {
  const ids = Array.isArray(json)
    ? json.map((model) => model.id || model.base_name || model.deployment_name)
    : (json.data ?? []).map((model) => model.id);
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
}

/**
 * Fetch every model ID the gateway serves for the active profile.
 *
 * Unlike the Claude Desktop path this applies no family filter — callers decide
 * what to expose. Always throws {@link ConfigurationError} on failure so callers
 * can pick their own fallback instead of silently receiving an empty catalog.
 */
export async function fetchGatewayModelIds(
  proxyUrl: string,
  gatewayKey: string
): Promise<string[]> {
  const endpoint = new URL(MODELS_PATH, proxyUrl).toString();

  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${gatewayKey}` },
    });
  } catch (error) {
    throw new ConfigurationError(
      `Local proxy model discovery could not reach ${endpoint}. ` +
      `Reason: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!response.ok) {
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
      'Your SSO session may have expired — run `codemie proxy stop && codemie profile login` to re-authenticate.'
    );
  }

  const ids = extractModelIds(await response.json() as ModelsListResponse | CodeMieLlmModel[]);
  logger.info(
    '[proxy] Gateway model discovery completed',
    ...sanitizeLogArgs({
      endpoint,
      modelCount: ids.length,
      models: ids,
    })
  );
  return ids;
}
