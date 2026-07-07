/**
 * JWT token resolution utilities
 */

import type { CodeMieConfigOptions } from '@/env/types.js';

export const JWT_TOKEN_DEFAULT_ENV_VAR = 'CODEMIE_JWT_TOKEN';

/**
 * Returns the env-var name to read the JWT token from.
 * Falls back to CODEMIE_JWT_TOKEN when not customised in the profile.
 */
export function resolveJwtTokenEnvVar(config: CodeMieConfigOptions): string {
  return config.jwtConfig?.tokenEnvVar ?? JWT_TOKEN_DEFAULT_ENV_VAR;
}

/**
 * Resolves the JWT token for the given profile.
 * Priority: env var named by profile → inline token stored in profile.
 */
export function resolveJwtToken(config: CodeMieConfigOptions): string | undefined {
  const envToken = process.env[resolveJwtTokenEnvVar(config)];
  const trimmed = envToken?.trim();
  return (trimmed && trimmed.length > 0 ? trimmed : undefined) ?? config.jwtConfig?.token;
}
