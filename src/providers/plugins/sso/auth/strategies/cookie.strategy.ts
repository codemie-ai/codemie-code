/**
 * Cookie strategy: the SSO cookie slot of the credential store (`deriveUrlStorageKey`).
 */

import type { SSOAuthResult, SSOCredentials } from '@/providers/core/types.js';
import { fetchCodeMieUserInfo, originOf } from '@/providers/core/codemie-auth-helpers.js';
import { ConfigurationError } from '@/utils/errors.js';
import { CredentialStore } from '@/utils/security.js';
import { decodeJwtExpiresAt } from '../jwt-claims.js';
import { hasUsableCookies } from '../selection.js';
import type { SSOAuthStrategy } from '../types.js';

/**
 * Derive credential expiresAt from codemie_access_token JWT exp claim.
 * Returns undefined when the cookie is absent or the JWT has no decodable exp:
 * cookie-only sessions (e.g. _oauth2_proxy) have no locally known expiry.
 */
export function deriveExpiresAt(cookies: Record<string, string>): number | undefined {
  return decodeJwtExpiresAt(cookies.codemie_access_token);
}

/** Login-time cookie check: short, no retries (the user is waiting on the browser callback). */
const LOGIN_CHECK_TIMEOUT_MS = 5000;

export const cookieStrategy: SSOAuthStrategy<'cookie'> = {
  type: 'cookie',

  load(url: string): Promise<SSOCredentials | null> {
    return CredentialStore.getInstance().retrieveSSOCredentials(url);
  },

  loadGlobal(): Promise<SSOCredentials | null> {
    return CredentialStore.getInstance().retrieveSSOCredentials();
  },

  fromCallback(result: SSOAuthResult, storedAt: number): SSOCredentials | null {
    if (!result.apiUrl || !hasUsableCookies(result.cookies)) {
      return null;
    }
    const expiresAt = deriveExpiresAt(result.cookies);
    return {
      cookies: result.cookies,
      apiUrl: result.apiUrl,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      authType: 'cookie',
      storedAt,
    };
  },

  /**
   * A reverse proxy can deliver cookies in the callback yet strip them from API requests (the
   * backend then redirects to the IdP login page), so check them once against `/v1/user`. A
   * rejection (non-2xx, a redirect, or a non-JSON page) means they do not work; a network failure
   * keeps them, as before this check existed.
   */
  async isAccepted(record: SSOCredentials): Promise<boolean> {
    try {
      await fetchCodeMieUserInfo(record.apiUrl, record.cookies, {
        timeout: LOGIN_CHECK_TIMEOUT_MS,
        maxRetries: 0,
        followRedirects: false,
        emailOnly: true,
      });
      return true;
    } catch (error) {
      return !(error instanceof ConfigurationError || error instanceof SyntaxError);
    }
  },

  async save(record: SSOCredentials, url: string): Promise<void> {
    await CredentialStore.getInstance().storeSSOCredentials(record, url);
  },

  async clear(url?: string): Promise<void> {
    const store = CredentialStore.getInstance();
    if (!url) {
      await store.clearSSOCredentials();
      return;
    }
    // Current and legacy keys
    await store.clearSSOCredentials(url);
    // The global slot, only when it holds a login for this URL's host
    const global = await store.retrieveSSOCredentials();
    if (global?.apiUrl && originOf(global.apiUrl) === originOf(url)) {
      await store.clearSSOCredentials();
    }
  },
};
