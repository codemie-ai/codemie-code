/**
 * SSO HTTP Client
 *
 * CodeMie-specific HTTP client with SSO cookie handling
 */

import { HTTPClient } from '../../core/base/http-client.js';
import type { CodeMieModel, CodeMieIntegration, CodeMieIntegrationsResponse } from '../../core/types.js';

/**
 * CodeMie API endpoints
 */
export const CODEMIE_ENDPOINTS = {
  MODELS: '/v1/llm_models',
  USER_SETTINGS: '/v1/settings/user'
} as const;

/**
 * Fetch models from CodeMie SSO API
 */
export async function fetchCodeMieModels(
  apiUrl: string,
  cookies: Record<string, string>
): Promise<string[]> {
  const cookieString = Object.entries(cookies)
    .map(([key, value]) => `${key}=${value}`)
    .join(';');

  const url = `${apiUrl}${CODEMIE_ENDPOINTS.MODELS}`;

  const client = new HTTPClient({
    timeout: 10000,
    maxRetries: 3,
    rejectUnauthorized: false
  });

  const response = await client.getRaw(url, {
    'cookie': cookieString,
    'Content-Type': 'application/json',
    'User-Agent': 'CodeMie-CLI/1.0.0',
    'X-CodeMie-Client': 'codemie-cli'
  });

  if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
    if (response.statusCode === 401 || response.statusCode === 403) {
      throw new Error('SSO session expired - please run setup again');
    }
    throw new Error(`Failed to fetch models: ${response.statusCode} ${response.statusMessage}`);
  }

  // Parse the response
  const models: CodeMieModel[] = JSON.parse(response.data) as CodeMieModel[];

  if (!Array.isArray(models)) {
    return [];
  }

  // Filter and map models based on the actual API response structure
  const filteredModels = models
    .filter(model => {
      if (!model) return false;
      // Check for different possible model ID fields
      const hasId = model.id && model.id.trim() !== '';
      const hasBaseName = model.base_name && model.base_name.trim() !== '';
      const hasDeploymentName = model.deployment_name && model.deployment_name.trim() !== '';

      return hasId || hasBaseName || hasDeploymentName;
    })
    .map(model => {
      // Use the most appropriate identifier field
      return model.id || model.base_name || model.deployment_name || model.label || 'unknown';
    })
    .filter(id => id !== 'unknown')
    .sort();

  return filteredModels;
}

/**
 * Fetch integrations from CodeMie SSO API (paginated)
 */
export async function fetchCodeMieIntegrations(
  apiUrl: string,
  cookies: Record<string, string>,
  endpointPath: string = CODEMIE_ENDPOINTS.USER_SETTINGS
): Promise<CodeMieIntegration[]> {
  const cookieString = Object.entries(cookies)
    .map(([key, value]) => `${key}=${value}`)
    .join(';');

  const allIntegrations: CodeMieIntegration[] = [];
  let currentPage = 0;
  const perPage = 50;
  let hasMorePages = true;
  let lastError: Error | undefined;

  while (hasMorePages) {
    try {
      // Build URL with query parameters to filter by LiteLLM type
      const filters = JSON.stringify({ type: ['LiteLLM'] });
      const queryParams = new URLSearchParams({
        page: currentPage.toString(),
        per_page: perPage.toString(),
        filters: filters
      });

      const fullUrl = `${apiUrl}${endpointPath}?${queryParams.toString()}`;

      if (process.env.CODEMIE_DEBUG) {
        console.log(`[DEBUG] Fetching integrations from: ${fullUrl}`);
      } else {
        console.log(`[INFO] Requesting integrations from: ${fullUrl}`);
      }

      const pageIntegrations = await fetchIntegrationsPage(fullUrl, cookieString);

      if (pageIntegrations.length === 0) {
        hasMorePages = false;
      } else {
        allIntegrations.push(...pageIntegrations);

        // If we got fewer items than requested, we've reached the last page
        if (pageIntegrations.length < perPage) {
          hasMorePages = false;
        } else {
          currentPage++;
        }
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      hasMorePages = false;
    }
  }

  // If we got no integrations and had an error, throw it
  if (allIntegrations.length === 0 && lastError) {
    throw lastError;
  }

  return allIntegrations;
}

/**
 * Fetch single page of integrations
 */
async function fetchIntegrationsPage(fullUrl: string, cookieString: string): Promise<CodeMieIntegration[]> {
  const client = new HTTPClient({
    timeout: 10000,
    maxRetries: 3,
    rejectUnauthorized: false
  });

  const response = await client.getRaw(fullUrl, {
    'cookie': cookieString,
    'Content-Type': 'application/json',
    'User-Agent': 'CodeMie-CLI/1.0.0',
    'X-CodeMie-Client': 'codemie-cli'
  });

  if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
    if (response.statusCode === 401 || response.statusCode === 403) {
      throw new Error('SSO session expired - please run setup again');
    }
    if (response.statusCode === 404) {
      throw new Error(`Integrations endpoint not found. Response: ${response.data}`);
    }
    throw new Error(`Failed to fetch integrations: ${response.statusCode} ${response.statusMessage}`);
  }

  // Parse the response - handle flexible response structure
  if (process.env.CODEMIE_DEBUG) {
    console.log('[DEBUG] Integration API response:', response.data.substring(0, 500));
  }

  const responseData = JSON.parse(response.data) as CodeMieIntegrationsResponse;

  // Extract integrations from response - try all possible locations
  let integrations: CodeMieIntegration[] = [];

  // Try different possible property names and structures
  const possibleArrays = [
    responseData, // Direct array
    responseData.integrations,
    responseData.credentials,
    responseData.data,
    responseData.items,
    responseData.results,
    responseData.user_integrations,
    responseData.personal_integrations,
    responseData.available_integrations
  ].filter(arr => Array.isArray(arr));

  if (possibleArrays.length > 0) {
    integrations = possibleArrays[0] as CodeMieIntegration[];
  } else {
    // Try to find nested objects that might contain arrays
    for (const value of Object.values(responseData)) {
      if (typeof value === 'object' && value !== null) {
        const nestedArrays = Object.values(value).filter(Array.isArray);
        if (nestedArrays.length > 0) {
          integrations = nestedArrays[0] as CodeMieIntegration[];
          break;
        }
      }
    }
  }

  // Filter and validate integrations (already filtered by API, but double-check)
  const validIntegrations = integrations
    .filter(integration => {
      return integration &&
             integration.alias &&
             integration.credential_type &&
             integration.alias.trim() !== '' &&
             integration.credential_type.trim() !== '';
    })
    .sort((a, b) => a.alias.localeCompare(b.alias));

  return validIntegrations;
}
