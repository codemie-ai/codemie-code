import https from 'https';
import http from 'http';
import { URL } from 'url';

/**
 * Health check response from provider
 */
interface _HealthResponse {
  status: string;
  [key: string]: any;
}

/**
 * Result of health check
 */
export interface HealthCheckResult {
  success: boolean;
  message: string;
  details?: any;
}

/**
 * Check provider health endpoint
 *
 * For LiteLLM: https://docs.litellm.ai/docs/proxy/health
 * Typically at /health endpoint
 */
export async function checkProviderHealth(
  baseUrl: string,
  apiKey: string
): Promise<HealthCheckResult> {
  try {
    // Try /health endpoint first (LiteLLM, common pattern)
    let result = await tryHealthEndpoint(baseUrl, apiKey, '/health');
    if (result.success) {
      return result;
    }

    // Fallback: Try /v1/models endpoint (OpenAI-compatible)
    result = await tryHealthEndpoint(baseUrl, apiKey, '/v1/models');
    if (result.success) {
      return {
        success: true,
        message: 'Provider is reachable (verified via /v1/models)',
        details: result.details
      };
    }

    return {
      success: false,
      message: 'Could not verify provider health',
      details: result.details
    };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Try a specific health endpoint
 */
async function tryHealthEndpoint(
  baseUrl: string,
  apiKey: string,
  path: string
): Promise<HealthCheckResult> {
  try {
    // Ensure baseUrl ends with / for proper path joining
    const normalizedBase = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
    // Remove leading / from path to avoid URL replacement
    const normalizedPath = path.startsWith('/') ? path.substring(1) : path;
    const url = new URL(normalizedPath, normalizedBase);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;

    return await new Promise((resolve) => {
      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000 // 10 second timeout
      };

      const req = client.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const response = JSON.parse(data);
              resolve({
                success: true,
                message: `Health check passed (${path})`,
                details: response
              });
            } catch {
              // Non-JSON response but 200 OK
              resolve({
                success: true,
                message: `Health check passed (${path})`,
                details: { raw: data }
              });
            }
          } else if (res.statusCode === 401) {
            resolve({
              success: false,
              message: 'Invalid API key (401 Unauthorized)',
              details: { statusCode: res.statusCode, body: data }
            });
          } else if (res.statusCode === 403) {
            resolve({
              success: false,
              message: 'Access forbidden - check API key permissions (403)',
              details: { statusCode: res.statusCode, body: data }
            });
          } else if (res.statusCode === 404) {
            resolve({
              success: false,
              message: `Endpoint not found (${path})`,
              details: { statusCode: res.statusCode }
            });
          } else {
            resolve({
              success: false,
              message: `HTTP ${res.statusCode}: ${data}`,
              details: { statusCode: res.statusCode, body: data }
            });
          }
        });
      });

      req.on('error', (error) => {
        if (error.message.includes('ENOTFOUND')) {
          resolve({
            success: false,
            message: 'Host not found - check base URL',
            details: error
          });
        } else if (error.message.includes('ECONNREFUSED')) {
          resolve({
            success: false,
            message: 'Connection refused - service may be down',
            details: error
          });
        } else if (error.message.includes('ETIMEDOUT')) {
          resolve({
            success: false,
            message: 'Connection timeout - check network/firewall',
            details: error
          });
        } else {
          resolve({
            success: false,
            message: `Connection error: ${error.message}`,
            details: error
          });
        }
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({
          success: false,
          message: 'Request timeout (10s)',
          details: { timeout: true }
        });
      });

      req.end();
    });
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Quick validation - just checks if URL is reachable
 */
export async function quickValidation(
  baseUrl: string,
  apiKey: string
): Promise<boolean> {
  const result = await checkProviderHealth(baseUrl, apiKey);
  return result.success;
}
