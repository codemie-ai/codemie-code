/**
 * FCC Authentication
 *
 * Handles authentication for FCC provider.
 * Uses LiteLLM API keys.
 */

import type { ProviderCredentials, ValidationResult } from '../../core/types.js';

/**
 * FCC Credentials structure
 */
export interface FCCCredentials extends ProviderCredentials {
  fccLiteLLMKey: string;
  fccServerUrl: string;
  authToken: string;
}

/**
 * Validate FCC credentials
 *
 * Checks that all required credentials are present:
 * - FCC LiteLLM API key
 * - FCC server URL
 * - Anthropic auth token
 */
export async function validateFCCCredentials(
  credentials: Partial<FCCCredentials>
): Promise<ValidationResult> {
  const errors: string[] = [];

  // Required: LiteLLM API key
  if (!credentials.fccLiteLLMKey) {
    errors.push('FCC LiteLLM API key is required.');
  }

  // Required: Server URL
  if (!credentials.fccServerUrl) {
    errors.push('FCC server URL is required.');
  }

  // Required: Auth token
  if (!credentials.authToken) {
    errors.push('Auth token is required.');
  }

  // Validate server URL format
  if (credentials.fccServerUrl) {
    try {
      new URL(credentials.fccServerUrl);
    } catch {
      errors.push('FCC server URL must be a valid HTTP/HTTPS URL');
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Get FCC credentials from environment variables
 */
export function getFCCCredentialsFromEnv(): Partial<FCCCredentials> {
  return {
    fccLiteLLMKey: process.env.FCC_LITELLM_KEY,
    fccServerUrl: process.env.CODEMIE_FCC_SERVER_URL || process.env.FCC_SERVER_URL,
    authToken: process.env.ANTHROPIC_AUTH_TOKEN
  };
}