import { CodeMieSSO } from '@/providers/plugins/sso/sso.auth.js';
import { getAnalyticsAuthStatus } from '@/utils/analytics-auth-status.js';
import { logger } from '@/utils/logger.js';

export interface AuthGateInput {
  provider?: string;
  ssoUrl?: string;
  syncApiUrl?: string;
  apiKey?: string;
}

export interface AuthGateResult {
  ok: boolean;
  reason?: string;
}

/**
 * Cheap, local-only CodeMie SSO auth check.
 * Deliberately excludes the live network probe that
 * `validateAuth`/`fetchCodeMieModels` performs, to avoid a network round-trip on
 * every `UserPromptSubmit`.
 */
export async function ensureCodeMieSsoAuth(input: AuthGateInput): Promise<AuthGateResult> {
  try {
    const analyticsConfigured = input.provider === 'ai-run-sso' || Boolean(input.ssoUrl && input.syncApiUrl);
    if (!analyticsConfigured) {
      return { ok: true };
    }

    let hasValidAuth = Boolean(input.apiKey);

    if (!hasValidAuth && input.ssoUrl) {
      try {
        const credentials = await new CodeMieSSO().getStoredCredentials(input.ssoUrl);
        hasValidAuth = Boolean(credentials?.cookies);
      } catch (error) {
        logger.debug('[sso-auth-gate] Failed to load SSO credentials:', error);
      }
    }

    const authStatus = await getAnalyticsAuthStatus();

    if (hasValidAuth && !authStatus) {
      return { ok: true };
    }

    const reason = !hasValidAuth
      ? 'no valid CodeMie SSO credentials found'
      : `CodeMie metrics endpoint rejected the stored credentials (${authStatus?.reason || 'unknown reason'})`;

    if (!input.apiKey && input.ssoUrl) {
      try {
        await new CodeMieSSO().authenticate({ codeMieUrl: input.ssoUrl, timeout: 120_000, quiet: true });
      } catch (error) {
        logger.error(`[sso-auth-gate] Failed to re-authenticate: ${(error as Error).message}`);
      }
    }

    return { ok: false, reason };
  } catch (error) {
    logger.debug('[sso-auth-gate] Auth gate check failed:', error);
    return { ok: false, reason: 'CodeMie SSO auth gate check failed unexpectedly' };
  }
}
