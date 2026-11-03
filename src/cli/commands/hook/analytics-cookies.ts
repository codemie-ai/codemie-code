import { logger } from '@/utils/logger.js';
import type { CredentialsSupersededCheck } from '@/providers/plugins/sso/session/cookie-auth.js';
import type { HookProcessingConfig } from '../hook.js';
import { getConfigValue } from './config-value.js';

/**
 * Cookies for CodeMie analytics, read once from the credential store, plus the check that tells a
 * rejection from a newer sign-in apart. Cookies handed in through the config are used as they are,
 * with no check.
 */
export async function loadAnalyticsCookies(
  logTag: string,
  ssoUrl: string | undefined,
  config?: HookProcessingConfig
): Promise<{ cookies: string; credentialsSuperseded?: CredentialsSupersededCheck }> {
  if (config?.cookies) {
    return { cookies: config.cookies };
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
