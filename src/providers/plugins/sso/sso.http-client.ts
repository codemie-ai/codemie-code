/**
 * SSO HTTP Client
 *
 * CodeMie-specific HTTP client with SSO cookie handling
 */

import type { CodeMieModel, CodeMieIntegration, CodeMieIntegrationsResponse } from '../../core/types.js';
import { HTTPClient } from '../../core/base/http-client.js';
import {
  fetchCodeMieUserInfo,
  buildAuthHeaders
} from '../../core/codemie-auth-helpers.js';
export { fetchCodeMieUserInfo };
export type { CodeMieUserInfo } from '../../core/codemie-auth-helpers.js';

/**
 * CodeMie API endpoints
 */
export const CODEMIE_ENDPOINTS = {
  MODELS: '/v1/llm_models?include_all=true',
  USER_SETTINGS_AVAILABLE: '/v1/settings/user/available',
  USER: '/v1/user',
  ADMIN_APPLICATIONS: '/v1/admin/applications',
  METRICS: '/v1/metrics',
  AUTH_LOGIN: '/v1/auth/login'
} as const;


/**
 * Full model descriptor returned by GET /v1/llm_models?include_all=true
 */
export interface LlmModel {
  base_name: string;
  deployment_name: string;
  label: string;
  multimodal?: boolean;
  react_agent?: boolean;
  enabled: boolean;
  provider?: string;
  default?: boolean;
  cost?: {
    input?: number;
    output?: number;
    cache_read_input_token_cost?: number;
    cache_creation_input_token_cost?: number;
  };
  features?: {
    streaming?: boolean;
    tools?: boolean;
    temperature?: boolean;
    parallel_tool_calls?: boolean;
    system_prompt?: boolean;
    max_tokens?: boolean;
    top_p?: boolean;
  };
  forbidden_for_web?: boolean;
}

/**
 * Fetch full model objects from /v1/llm_models?include_all=true (supports both cookies and JWT)
 *
 * Unlike fetchCodeMieModels (which returns only IDs), this returns the complete model
 * descriptor including cost, features, and provider metadata.
 *
 * Overload 1: SSO cookies
 * Overload 2: JWT token string
 */
/* eslint-disable no-redeclare */
export function fetchCodeMieLlmModels(
  apiUrl: string,
  cookies: Record<string, string>
): Promise<LlmModel[]>;
export function fetchCodeMieLlmModels(
  apiUrl: string,
  jwtToken: string
): Promise<LlmModel[]>;
export async function fetchCodeMieLlmModels(
  apiUrl: string,
  auth: Record<string, string> | string
): Promise<LlmModel[]> {
/* eslint-enable no-redeclare */
  const headers = buildAuthHeaders(auth);
  const url = `${apiUrl}${CODEMIE_ENDPOINTS.MODELS}`;

  const client = new HTTPClient({
    timeout: 10000,
    maxRetries: 3,
    rejectUnauthorized: false,
  });

  const response = await client.getRaw(url, headers);

  if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
    if (response.statusCode === 401 || response.statusCode === 403) {
      throw new Error('Authentication failed - invalid or expired credentials');
    }
    throw new Error(`Failed to fetch models: ${response.statusCode} ${response.statusMessage}`);
  }

  const parsed = JSON.parse(response.data);
  if (!Array.isArray(parsed)) return [];
  return parsed as LlmModel[];
}

/**
 * Fetch models from CodeMie API (supports both cookies and JWT)
 *
 * Overload 1: SSO cookies (backward compatible - existing callers unchanged)
 * Overload 2: JWT token string (new)
 */
/* eslint-disable no-redeclare */
export function fetchCodeMieModels(
  apiUrl: string,
  cookies: Record<string, string>
): Promise<string[]>;
export function fetchCodeMieModels(
  apiUrl: string,
  jwtToken: string
): Promise<string[]>;
export async function fetchCodeMieModels(
  apiUrl: string,
  auth: Record<string, string> | string
): Promise<string[]> {
/* eslint-enable no-redeclare */
  const headers = buildAuthHeaders(auth);
  const url = `${apiUrl}${CODEMIE_ENDPOINTS.MODELS}`;

  const client = new HTTPClient({
    timeout: 30000,
    maxRetries: 5,
    rejectUnauthorized: false
  });

  const response = await client.getRaw(url, headers);

  if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
    if (response.statusCode === 401 || response.statusCode === 403) {
      throw new Error('Authentication failed - invalid or expired credentials');
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
 * Fetch application details (non-blocking, best-effort) - supports both cookies and JWT
 *
 * @param apiUrl - CodeMie API base URL
 * @param auth - SSO session cookies or JWT token
 * @returns Application names array (same as /v1/user for now)
 *
 * Overload 1: SSO cookies (backward compatible - existing callers unchanged)
 * Overload 2: JWT token string (new)
 */
/* eslint-disable no-redeclare */
export function fetchApplicationDetails(
  apiUrl: string,
  cookies: Record<string, string>
): Promise<string[]>;
export function fetchApplicationDetails(
  apiUrl: string,
  jwtToken: string
): Promise<string[]>;
export async function fetchApplicationDetails(
  apiUrl: string,
  auth: Record<string, string> | string
): Promise<string[]> {
  try {
    const headers = buildAuthHeaders(auth);
    const url = `${apiUrl}${CODEMIE_ENDPOINTS.ADMIN_APPLICATIONS}?limit=1000`;

    const client = new HTTPClient({
      timeout: 5000,
      maxRetries: 1,
      rejectUnauthorized: false
    });

    const response = await client.getRaw(url, headers);

    if (response.statusCode !== 200) {
      return [];
    }

    const data = JSON.parse(response.data) as { applications: string[] };
    return data.applications || [];
  } catch {
    // Non-blocking: return empty array on error
    return [];
  }
}
/* eslint-enable no-redeclare */

/**
 * Fetch integrations from CodeMie API (paginated) - supports both cookies and JWT
 *
 * Overload 1: SSO cookies (backward compatible - existing callers unchanged)
 * Overload 2: JWT token string (new)
 */
/* eslint-disable no-redeclare */
export function fetchCodeMieIntegrations(
  apiUrl: string,
  cookies: Record<string, string>,
  endpointPath?: string
): Promise<CodeMieIntegration[]>;
export function fetchCodeMieIntegrations(
  apiUrl: string,
  jwtToken: string,
  endpointPath?: string
): Promise<CodeMieIntegration[]>;
export async function fetchCodeMieIntegrations(
  apiUrl: string,
  auth: Record<string, string> | string,
  endpointPath: string = CODEMIE_ENDPOINTS.USER_SETTINGS_AVAILABLE
): Promise<CodeMieIntegration[]> {
  const allIntegrations: CodeMieIntegration[] = [];
  let currentPage = 0;
  const perPage = 50;
  const maxPages = 20; // Safety limit to prevent infinite loops if API ignores pagination params
  let hasMorePages = true;
  let lastError: Error | undefined;
  const seenIds = new Set<string>();

  while (hasMorePages && currentPage < maxPages) {
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
      }

      const pageIntegrations = await fetchIntegrationsPage(fullUrl, auth);

      if (pageIntegrations.length === 0) {
        hasMorePages = false;
      } else {
        // Deduplicate: detect when API returns same items on every page (no real pagination)
        const newIntegrations = pageIntegrations.filter(i => !seenIds.has(i.id));
        if (newIntegrations.length === 0) {
          // All items already seen - API does not support pagination, stop here
          hasMorePages = false;
        } else {
          newIntegrations.forEach(i => seenIds.add(i.id));
          allIntegrations.push(...newIntegrations);

          // If we got fewer items than requested, we've reached the last page
          if (pageIntegrations.length < perPage) {
            hasMorePages = false;
          } else {
            currentPage++;
          }
        }
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      hasMorePages = false;
    }
  }

  if (lastError && allIntegrations.length === 0) {
    throw lastError;
  }

  return allIntegrations;
}
/* eslint-enable no-redeclare */

/**
 * Fetch single page of integrations - supports both cookies and JWT
 */
async function fetchIntegrationsPage(fullUrl: string, auth: Record<string, string> | string): Promise<CodeMieIntegration[]> {
  const headers = buildAuthHeaders(auth);

  const client = new HTTPClient({
    timeout: 10000,
    maxRetries: 3,
    rejectUnauthorized: false
  });

  const response = await client.getRaw(fullUrl, headers);

  if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
    if (response.statusCode === 401 || response.statusCode === 403) {
      throw new Error('Authentication failed - invalid or expired credentials');
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

  // Filter and validate integrations: must be LiteLLM type with a non-empty alias
  const validIntegrations = integrations
    .filter(integration => {
      return integration &&
             integration.alias &&
             integration.alias.trim() !== '' &&
             integration.credential_type === 'LiteLLM';
    })
    .sort((a, b) => a.alias.localeCompare(b.alias));

  return validIntegrations;
}
