/**
 * CodeMie model catalog for an agent launch environment.
 *
 * The one place agents read the catalog from: it picks the auth (JWT, else stored
 * SSO credentials) and the project from the same `env`, so every agent lists only
 * the models the profile's project allows without each call site remembering to.
 */

import type { LlmModel } from './sso.http-client.js';
import { fetchCodeMieLlmModels } from './sso.http-client.js';
import {
  getPlatformUrlFromEnv,
  getStoredPlatformCredentialsFromEnv,
} from '../../core/codemie-auth-helpers.js';
import { ConfigurationError } from '../../../utils/errors.js';
import { logger } from '../../../utils/logger.js';

export interface EnvCatalogOptions {
  /** Prefix for debug logs, e.g. `[kimi-models]`. */
  logPrefix: string;
  /** API URL for JWT auth; defaults to `env.CODEMIE_BASE_URL`. */
  jwtBaseUrl?: string;
  /**
   * When a platform URL is configured but no stored SSO credentials match it:
   * `true` (default) throws a ConfigurationError telling the user to log in,
   * `false` treats it as "no auth" and returns undefined.
   */
  requireCredentials?: boolean;
}

/** The project whose models the launch may use: the profile's, exported as CODEMIE_PROJECT. */
export function projectFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  return env.CODEMIE_PROJECT?.trim() || undefined;
}

/**
 * Fetch the catalog for `env`, narrowed to its project.
 *
 * Returns undefined when the environment carries no usable CodeMie auth, so each
 * caller keeps its own fallback (empty list, static configs, or an error).
 */
export async function fetchCodeMieCatalogForEnv(
  env: NodeJS.ProcessEnv,
  options: EnvCatalogOptions
): Promise<LlmModel[] | undefined> {
  const { logPrefix, requireCredentials = true } = options;
  const project = projectFromEnv(env);
  const jwtToken = env.CODEMIE_JWT_TOKEN;
  const jwtBaseUrl = options.jwtBaseUrl ?? env.CODEMIE_BASE_URL;

  if (jwtToken && jwtBaseUrl) {
    logger.debug(`${logPrefix} Fetching CodeMie model list via JWT auth`, { project });
    return fetchCodeMieLlmModels(jwtBaseUrl, jwtToken, project);
  }

  const found = await getStoredPlatformCredentialsFromEnv(env);
  if (found) {
    logger.debug(`${logPrefix} Fetching CodeMie model list via SSO auth`, { project });
    return fetchCodeMieLlmModels(found.credentials.apiUrl, found.credentials.cookies, project);
  }

  const platformUrl = getPlatformUrlFromEnv(env);
  if (platformUrl && requireCredentials) {
    throw new ConfigurationError(
      `SSO credentials not found for ${platformUrl}. Run: codemie setup or codemie profile login --url ${platformUrl}`
    );
  }
  return undefined;
}
