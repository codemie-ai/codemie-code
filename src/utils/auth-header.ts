/**
 * Auth Header Utility
 *
 * Provides consistent authorization header construction for HTTP requests.
 * Supports custom header names and value formats to accommodate various API authentication schemes.
 */

/**
 * Configuration for building authorization headers
 */
export interface AuthHeaderConfig {
  /** The API key or authentication token */
  apiKey: string;
  /** Custom header name (default: 'Authorization') */
  headerName?: string;
  /** Value format using {key} placeholder (default: 'Bearer {key}') */
  valueFormat?: string;
}

/**
 * Result of building an authorization header
 */
export interface AuthHeader {
  /** The header name (e.g., 'Authorization', 'api-key', 'X-API-Key') */
  name: string;
  /** The fully constructed header value */
  value: string;
}

/**
 * Build an authorization header from configuration
 *
 * @example
 * // Default behavior (Authorization: Bearer sk-xxx)
 * buildAuthHeader({ apiKey: 'sk-xxx' })
 * // { name: 'Authorization', value: 'Bearer sk-xxx' }
 *
 * @example
 * // Custom header with raw key (api-key: sk-xxx)
 * buildAuthHeader({ apiKey: 'sk-xxx', headerName: 'api-key', valueFormat: '{key}' })
 * // { name: 'api-key', value: 'sk-xxx' }
 *
 * @example
 * // Custom scheme (X-API-Key: Token sk-xxx)
 * buildAuthHeader({ apiKey: 'sk-xxx', headerName: 'X-API-Key', valueFormat: 'Token {key}' })
 * // { name: 'X-API-Key', value: 'Token sk-xxx' }
 */
export function buildAuthHeader(config: AuthHeaderConfig): AuthHeader {
  const name = config.headerName || 'Authorization';
  const format = config.valueFormat || 'Bearer {key}';

  // Replace {key} placeholder with actual API key, or use format as literal if no placeholder
  const value = format.includes('{key}')
    ? format.replace('{key}', config.apiKey)
    : format;

  return { name, value };
}
