import { CodeMieModel, CodeMieIntegration, CodeMieIntegrationsResponse } from '../types/sso.js';
import { CredentialStore } from './credential-store.js';
import https from 'https';
import http from 'http';
import { URL } from 'url';
import { logger } from './logger.js';
import { sanitizeHeaders } from './sanitize.js';

// Common endpoint paths
export const CODEMIE_ENDPOINTS = {
  MODELS: '/v1/llm_models',
  USER_SETTINGS: '/v1/settings/user'
} as const;

// Configuration
const MAX_REDIRECTS = 5;
const MAX_RETRIES = 3;

/**
 * Make HTTPS/HTTP request with automatic redirect following
 * Handles 301, 302, 303, 307, 308 redirects following HTTP standards
 */
async function makeRequestWithRedirects(
  url: string,
  requestOptions: https.RequestOptions,
  redirectCount: number = 0
): Promise<{ statusCode?: number; statusMessage?: string; headers: http.IncomingHttpHeaders; data: string }> {
  if (redirectCount >= MAX_REDIRECTS) {
    throw new Error(`Too many redirects (${redirectCount}). Possible redirect loop.`);
  }

  const parsedUrl = new URL(url);
  const protocol = parsedUrl.protocol === 'https:' ? https : http;

  const options: https.RequestOptions = {
    ...requestOptions,
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
    path: parsedUrl.pathname + parsedUrl.search,
  };

  if (logger.isDebugMode()) {
    logger.debug(`[HTTP Request] ${options.method} ${url}`);
    logger.debug(`[Headers]`, sanitizeHeaders(requestOptions.headers as Record<string, unknown>));
    if (redirectCount > 0) {
      logger.debug(`[Redirect] Following redirect #${redirectCount}`);
    }
  }

  return new Promise((resolve, reject) => {
    const req = protocol.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', async () => {
        const statusCode = res.statusCode || 0;

        if (logger.isDebugMode()) {
          logger.debug(`[HTTP Response] ${statusCode} ${res.statusMessage}`);
          logger.debug(`[Response Headers]`, sanitizeHeaders(res.headers as Record<string, unknown>));
        }

        // Handle redirects (301, 302, 303, 307, 308)
        if (statusCode >= 300 && statusCode < 400) {
          const location = res.headers['location'];

          if (!location) {
            reject(new Error(`Redirect ${statusCode} without Location header`));
            return;
          }

          // Resolve relative URLs against current URL
          const redirectUrl = new URL(location, url).toString();

          logger.info(`[Redirect] ${statusCode} -> ${redirectUrl}`);

          // Update cookies from Set-Cookie headers if present
          const setCookieHeaders = res.headers['set-cookie'];
          if (setCookieHeaders && requestOptions.headers) {
            const existingCookies = (requestOptions.headers['cookie'] as string) || '';
            const newCookies = setCookieHeaders
              .map(cookie => cookie.split(';')[0]) // Extract cookie name=value
              .join('; ');

            requestOptions.headers['cookie'] = existingCookies
              ? `${existingCookies}; ${newCookies}`
              : newCookies;
          }

          // For 303, change POST/PUT to GET
          if (statusCode === 303 && options.method !== 'GET' && options.method !== 'HEAD') {
            requestOptions.method = 'GET';
            delete requestOptions.headers?.['content-length'];
            delete requestOptions.headers?.['content-type'];
          }

          try {
            // Follow the redirect
            const redirectResponse = await makeRequestWithRedirects(
              redirectUrl,
              requestOptions,
              redirectCount + 1
            );
            resolve(redirectResponse);
          } catch (error) {
            reject(error);
          }
          return;
        }

        // Not a redirect, return response
        resolve({
          statusCode,
          statusMessage: res.statusMessage,
          headers: res.headers,
          data
        });
      });
    });

    req.on('error', (error) => {
      if (logger.isDebugMode()) {
        logger.error(`[HTTP Error]`, error);
      }
      reject(error);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.end();
  });
}

/**
 * Retry wrapper with exponential backoff
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  operation: string,
  maxRetries: number = MAX_RETRIES
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      // Don't retry auth errors
      if (lastError.message.includes('SSO session expired') ||
          lastError.message.includes('401') ||
          lastError.message.includes('403')) {
        throw lastError;
      }

      // Log retry attempt
      logger.warn(`[Retry] ${operation} failed (attempt ${attempt}/${maxRetries}): ${lastError.message}`);

      if (attempt < maxRetries) {
        // Exponential backoff: 1s, 2s, 4s
        const delay = Math.pow(2, attempt - 1) * 1000;
        logger.debug(`[Retry] Waiting ${delay}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

export async function fetchCodeMieModels(
  apiUrl: string,
  cookies: Record<string, string>
): Promise<string[]> {
  return withRetry(async () => {
    const cookieString = Object.entries(cookies)
      .map(([key, value]) => `${key}=${value}`)
      .join(';');

    const url = `${apiUrl}${CODEMIE_ENDPOINTS.MODELS}`;

    const requestOptions: https.RequestOptions = {
      method: 'GET',
      headers: {
        'cookie': cookieString,
        'Content-Type': 'application/json',
        'User-Agent': 'CodeMie-CLI/1.0.0',
        'X-CodeMie-Client': 'codemie-cli'
      },
      // Handle certificate issues commonly found in enterprise environments
      rejectUnauthorized: false, // Allow self-signed certificates
      timeout: 10000
    };

    const response = await makeRequestWithRedirects(url, requestOptions);

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
  }, 'fetchCodeMieModels');
}

export async function fetchCodeMieModelsFromConfig(): Promise<string[]> {
  const store = CredentialStore.getInstance();
  const credentials = await store.retrieveSSOCredentials();

  if (!credentials) {
    throw new Error('No SSO credentials found - please run setup');
  }

  return fetchCodeMieModels(credentials.apiUrl, credentials.cookies);
}

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
    } catch {
      hasMorePages = false;
    }
  }
  return allIntegrations;
}

async function fetchIntegrationsPage(fullUrl: string, cookieString: string): Promise<CodeMieIntegration[]> {
  return withRetry(async () => {
    const requestOptions: https.RequestOptions = {
      method: 'GET',
      headers: {
        'cookie': cookieString,
        'Content-Type': 'application/json',
        'User-Agent': 'CodeMie-CLI/1.0.0',
        'X-CodeMie-Client': 'codemie-cli'
      },
      // Handle certificate issues commonly found in enterprise environments
      rejectUnauthorized: false, // Allow self-signed certificates
      timeout: 10000
    };

    const response = await makeRequestWithRedirects(fullUrl, requestOptions);

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
  }, 'fetchIntegrationsPage');
}

export async function fetchCodeMieIntegrationsFromConfig(): Promise<CodeMieIntegration[]> {
  const store = CredentialStore.getInstance();
  const credentials = await store.retrieveSSOCredentials();

  if (!credentials) {
    throw new Error('No SSO credentials found - please run setup');
  }

  return fetchCodeMieIntegrations(credentials.apiUrl, credentials.cookies);
}

export async function validateCodeMieConnectivity(): Promise<void> {
  // Following the codemie-ide-plugin pattern, we don't perform connectivity validation
  // Instead, we trust that the SSO flow will handle any connectivity issues
  // This function is kept for compatibility but essentially becomes a no-op
  return Promise.resolve();
}