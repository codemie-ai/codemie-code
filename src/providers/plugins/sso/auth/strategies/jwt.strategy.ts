/**
 * JWT strategy: the `jwt-` slot of the credential store, written when a reverse proxy in front
 * of the backend strips cookies entirely and the callback carries a bearer token instead.
 */

import type { JWTCredentials, SSOAuthResult } from '@/providers/core/types.js';
import { originOf } from '@/providers/core/codemie-auth-helpers.js';
import { CredentialStore } from '@/utils/security.js';
import type { SSOAuthStrategy } from '../types.js';
import { decodeJwtExpiresAt } from '../jwt-claims.js';

export const jwtStrategy: SSOAuthStrategy<'jwt'> = {
  type: 'jwt',

  load(url: string): Promise<JWTCredentials | null> {
    return CredentialStore.getInstance().retrieveJWTCredentials(url, { includeExpired: true });
  },

  loadGlobal(): Promise<JWTCredentials | null> {
    return CredentialStore.getInstance().retrieveJWTCredentials(undefined, { includeExpired: true });
  },

  fromCallback(result: SSOAuthResult, storedAt: number): JWTCredentials | null {
    if (!result.jwt || !result.apiUrl) {
      return null;
    }
    const expiresAt = decodeJwtExpiresAt(result.jwt);
    return {
      token: result.jwt,
      apiUrl: result.apiUrl,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      authType: 'jwt',
      storedAt,
    };
  },

  async save(record: JWTCredentials, url: string): Promise<void> {
    await CredentialStore.getInstance().storeJWTCredentials(record, url);
  },

  async clear(url?: string): Promise<void> {
    const store = CredentialStore.getInstance();
    if (!url) {
      await store.clearJWTCredentials();
      return;
    }
    // Current and legacy keys
    await store.clearJWTCredentials(url);
    // The global slot, only when it holds a login for this URL's host
    const global = await store.retrieveJWTCredentials(undefined, { includeExpired: true });
    if (global?.apiUrl && originOf(global.apiUrl) === originOf(url)) {
      await store.clearJWTCredentials();
    }
  },
};
