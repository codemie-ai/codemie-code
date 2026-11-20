import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolveEmailFromCredentials } from '@/agents/core/identity-resolver.js';
import { decryptWithKey, deriveMachineEncryptionKey, encryptWithKey } from '@/utils/credential-crypto.js';
import { getCodemiePath } from '@/utils/paths.js';
import { logger } from '@/utils/logger.js';
import { fetchCodeMieUserInfo } from './codemie-auth-helpers.js';
import type { SSOAuth } from '@/providers/plugins/sso/auth/types.js';
import { authMaterial } from '@/providers/plugins/sso/auth/material.js';

/** Minimum gap between failed `/v1/user` lookups for the same login (bounds hook and tick traffic). */
export const OWNER_LOOKUP_COOLDOWN_MS = 30_000;
const OWNER_LOOKUP_TIMEOUT_MS = 5_000;

interface OwnerRecord {
  /** Fingerprint of the exact login (API URL + cookie values, or the token) the rest of the record belongs to. */
  fp: string;
  email?: string;
  failedAt?: number;
}

/** The email the backend reports for the signed-in user; `username` is a different field and never used. */
export function normalizeOwnerEmail(value: unknown): string {
  if (typeof value !== 'string') return '';
  const email = value.trim();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(email) ? email : '';
}

/** Identifies the exact login (API URL + credential values). Binds pending hook data to it; reveals no secret. */
export function credentialFingerprint(auth: SSOAuth): string {
  return auth.fingerprint;
}

/** One record per API URL, replaced by a newer login; a record for another login is simply ignored. */
function recordPath(apiUrl: string): string {
  const key = createHash('sha256').update(apiUrl.replace(/\/+$/, '').toLowerCase()).digest('hex').slice(0, 16);
  return getCodemiePath('credentials', `owner-${key}.enc`);
}

async function readRecord(path: string, fp: string): Promise<OwnerRecord | null> {
  try {
    const record = JSON.parse(decryptWithKey(await readFile(path, 'utf8'), deriveMachineEncryptionKey())) as OwnerRecord;
    return record?.fp === fp ? record : null;
  } catch {
    return null;
  }
}

async function writeRecord(path: string, record: OwnerRecord): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, encryptWithKey(JSON.stringify(record), deriveMachineEncryptionKey()), { mode: 0o600 });
    await rename(tmp, path);
  } catch (error) {
    logger.debug(`[credential-owner] record write failed: ${error instanceof Error ? error.name : 'error'}`);
  }
}

/**
 * Returns `auth` carrying the signed-in user's email when it can be established from the
 * session itself: an identity-token claim, else the backend's own `GET /v1/user` answer for
 * this exact credential (oauth2-proxy logins store no claim). The answer is kept in a record keyed by the
 * login's fingerprint, never written into the credential store: a re-login or account switch changes
 * the fingerprint, so an old identity cannot attach to new credentials and a newer login is never
 * overwritten. Failures are remembered for `OWNER_LOOKUP_COOLDOWN_MS` and leave the auth
 * unchanged (no owner is invented). A resolved email is returned on a copy, never written into the
 * caller's object. Never throws.
 */
export async function withVerifiedOwner(auth: SSOAuth): Promise<SSOAuth> {
  try {
    // An explicit credential (--jwt-token / CODEMIE_JWT_TOKEN / a bearer-auth profile's stored
    // token) is never probed: its flow is unchanged by the SSO resolver (see design doc, non-goals).
    if (!auth.apiUrl || auth.source === 'explicit') return auth;
    if (resolveEmailFromCredentials(auth)) return auth;

    const fp = credentialFingerprint(auth);
    const path = recordPath(auth.apiUrl);
    const known = await readRecord(path, fp);
    if (known?.email) return { ...auth, email: known.email };
    if (known?.failedAt && Date.now() - known.failedAt < OWNER_LOOKUP_COOLDOWN_MS) return auth;

    try {
      const info = await fetchCodeMieUserInfo(auth.apiUrl, authMaterial(auth), {
        timeout: OWNER_LOOKUP_TIMEOUT_MS,
        followRedirects: false, // an expired session redirects to the IdP: never forward the credential there
        emailOnly: true,
      });
      const email = normalizeOwnerEmail(info.email);
      if (!email) throw new Error('no email in /v1/user response');
      await writeRecord(path, { fp, email });
      return { ...auth, email };
    } catch (error) {
      logger.debug(`[credential-owner] owner lookup failed: ${error instanceof Error ? error.name : 'error'}`);
      await writeRecord(path, { fp, failedAt: Date.now() });
      return auth;
    }
  } catch {
    return auth;
  }
}
