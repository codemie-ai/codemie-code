import { logger } from '@/utils/logger.js';
import {
  fixedCookieAuth,
  NO_ANALYTICS_AUTH,
  type AnalyticsAuth,
} from '@/providers/plugins/sso/session/analytics-auth.js';
import type { HookProcessingConfig } from '../hook.js';
import { getConfigValue } from './config-value.js';

/**
 * Analytics credentials (cookies or a JWT), read once from the credential store, plus the check
 * that tells a rejection from a newer sign-in apart. Cookies handed in through the config are used
 * as they are, with no check.
 */
export async function loadAnalyticsAuth(
  logTag: string,
  ssoUrl: string | undefined,
  config?: HookProcessingConfig
): Promise<AnalyticsAuth> {
  if (config?.cookies) {
    return fixedCookieAuth(config.cookies);
  }
  if (!ssoUrl) {
    return NO_ANALYTICS_AUTH;
  }
  try {
    const { readAnalyticsAuth } = await import('@/providers/plugins/sso/session/analytics-auth.js');
    return await readAnalyticsAuth(ssoUrl, config?.env, {
      provider: getConfigValue('CODEMIE_PROVIDER', config),
    });
  } catch (error) {
    logger.debug(`${logTag} Failed to load SSO credentials:`, error);
    return NO_ANALYTICS_AUTH;
  }
}
