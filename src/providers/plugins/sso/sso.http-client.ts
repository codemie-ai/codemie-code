/**
 * SSO HTTP Client
 *
 * CodeMie-specific HTTP client with SSO cookie handling
 */

import { HTTPClient } from '../../core/base/http-client.js';
import type { CodeMieModel, CodeMieIntegration, CodeMieIntegrationsResponse } from '../../core/types.js';

/**
 * User info response from /v1/user endpoint
 */
export interface CodeMieUserInfo {
  userId: string;
  name: string;
  username: string;
  isAdmin: boolean;
  applications: string[];
  applicationsAdmin: string[];
  picture: string;
  knowledgeBases: string[];
  userType?: string;
}

/**
 * CodeMie API endpoints
 */
export const CODEMIE_ENDPOINTS = {
  MODELS: '/v1/llm_models?include_all=true',
  USER_SETTINGS: '/v1/settings/user',
  USER: '/v1/user',
  ADMIN_APPLICATIONS: '/v1/admin/applications',
  METRICS: '/v1/metrics',
  AUTH_LOGIN: '/v1/auth/login'
} as const;

/**
 * Internal helper: build auth headers from cookies or JWT token
 */
function buildAuthHeaders(auth: Record<string, string> | string): Record<string, string> {
  const cliVersion = process.env.CODEMIE_CLI_VERSION || 'unknown';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': `codemie-cli/${cliVersion}`,
    'X-CodeMie-CLI': `codemie-cli/${cliVersion}`,
    'X-CodeMie-Client': 'codemie-cli'
  };

  if (typeof auth === 'string') {
    // JWT token (string)
    headers['authorization'] = `Bearer ${auth}`;
  } else {
    // SSO cookies (object) - existing behavior
    headers['cookie'] = Object.entries(auth)
      .map(([key, value]) => `${key}=${value}`)
      .join(';');
  }

  return headers;
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
    timeout: 10000,
    maxRetries: 3,
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
 * Fetch user information including accessible applications (supports both cookies and JWT)
 *
 * @param apiUrl - CodeMie API base URL
 * @param auth - SSO session cookies or JWT token
 * @returns User info with applications array
 * @throws Error if request fails or response invalid
 *
 * Overload 1: SSO cookies (backward compatible - existing callers unchanged)
 * Overload 2: JWT token string (new)
 */
/* eslint-disable no-redeclare */
export function fetchCodeMieUserInfo(
  apiUrl: string,
  cookies: Record<string, string>
): Promise<CodeMieUserInfo>;
export function fetchCodeMieUserInfo(
  apiUrl: string,
  jwtToken: string
): Promise<CodeMieUserInfo>;
export async function fetchCodeMieUserInfo(
  apiUrl: string,
  auth: Record<string, string> | string
): Promise<CodeMieUserInfo> {
  const headers = buildAuthHeaders(auth);
  const url = `${apiUrl}${CODEMIE_ENDPOINTS.USER}`;

  const client = new HTTPClient({
    timeout: 10000,
    maxRetries: 3,
    rejectUnauthorized: false
  });

  const response = await client.getRaw(url, headers);

  // Handle HTTP errors
  if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
    if (response.statusCode === 401 || response.statusCode === 403) {
      throw new Error('Authentication failed - invalid or expired credentials');
    }
    throw new Error(`Failed to fetch user info: ${response.statusCode} ${response.statusMessage}`);
  }

  // Parse response
  const userInfo = JSON.parse(response.data) as CodeMieUserInfo;

  // Validate response structure
  if (!userInfo || !Array.isArray(userInfo.applications) || !Array.isArray(userInfo.applicationsAdmin)) {
    throw new Error('Invalid user info response: missing applications arrays');
  }

  return userInfo;
}
/* eslint-enable no-redeclare */

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
  endpointPath: string = CODEMIE_ENDPOINTS.USER_SETTINGS
): Promise<CodeMieIntegration[]> {
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
      }

      const pageIntegrations = await fetchIntegrationsPage(fullUrl, auth);

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
