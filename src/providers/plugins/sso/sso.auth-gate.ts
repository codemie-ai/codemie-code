import { CodeMieSSO } from '@/providers/plugins/sso/sso.auth.js';
import {
  getAnalyticsPlatformSource,
  getPlatformUrl,
  getStoredAnalyticsCredentials,
} from '@/providers/core/codemie-auth-helpers.js';
import { getAnalyticsAuthStatus } from '@/utils/analytics-auth-status.js';
import { logger } from '@/utils/logger.js';

export interface AuthGateInput {
  provider?: string;
  /** Workspace CodeMie URL (CODEMIE_URL); fallback when the profile URL has no login. */
  ssoUrl?: string;
  /** Active profile URL; defaults to the one in CODEMIE_PROFILE_CONFIG of `env`. */
  baseUrl?: string;
  syncApiUrl?: string;
  apiKey?: string;
  /** Environment carrying CODEMIE_PROFILE_CONFIG; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
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
    const source = getAnalyticsPlatformSource(input.ssoUrl, input.env, {
      provider: input.provider,
      baseUrl: input.baseUrl,
    });
    // Profile URL first, workspace URL as fallback — re-auth targets the URL the
    // profile actually uses, never a different environment's workspace.
    const loginUrl = getPlatformUrl(source);

    if (!hasValidAuth && loginUrl) {
      try {
        const found = await getStoredAnalyticsCredentials(input.ssoUrl, input.env, {
          provider: input.provider,
          baseUrl: input.baseUrl,
        });
        hasValidAuth = Boolean(found?.credentials.cookies);
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

    if (!input.apiKey && loginUrl) {
      try {
        await new CodeMieSSO().authenticate({ codeMieUrl: loginUrl, timeout: 120_000, quiet: true });
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
