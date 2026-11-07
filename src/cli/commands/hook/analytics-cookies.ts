import { logger } from '@/utils/logger.js';
import type { CookieAuth } from '@/providers/plugins/sso/session/cookie-auth.js';
import type { HookProcessingConfig } from '../hook.js';
import { getConfigValue } from './config-value.js';

/**
 * Cookies (and SSO authorization fallback) for CodeMie analytics, read once from the credential
 * store, plus the check that tells a rejection from a newer sign-in apart. Credentials handed in
 * through the config are used as they are, with no check.
 */
export async function loadAnalyticsCookies(
  logTag: string,
  ssoUrl: string | undefined,
  config?: HookProcessingConfig
): Promise<CookieAuth> {
  if (config?.cookies || config?.authorization) {
    return { cookies: config?.cookies || '', authorization: config?.authorization };
  }
  if (!ssoUrl) {
    return { cookies: '' };
  }
  try {
    const { readAnalyticsCookieAuth } = await import('@/providers/plugins/sso/session/cookie-auth.js');
    return await readAnalyticsCookieAuth(ssoUrl, config?.env, {
      provider: getConfigValue('CODEMIE_PROVIDER', config),
    });
  } catch (error) {
    logger.debug(`${logTag} Failed to load SSO credentials:`, error);
    return { cookies: '' };
  }
}
