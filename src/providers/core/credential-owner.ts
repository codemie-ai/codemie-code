import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolveEmailFromCredentials } from '@/agents/core/identity-resolver.js';
import { decryptWithKey, deriveMachineEncryptionKey, encryptWithKey } from '@/utils/credential-crypto.js';
import { getCodemiePath } from '@/utils/paths.js';
import { logger } from '@/utils/logger.js';
import { fetchCodeMieUserInfo } from './codemie-auth-helpers.js';
import type { JWTCredentials, SSOCredentials } from './types.js';
import { isSSOCredentials } from './types.js';

/** Minimum gap between failed `/v1/user` lookups for the same login (bounds hook and tick traffic). */
export const OWNER_LOOKUP_COOLDOWN_MS = 30_000;
const OWNER_LOOKUP_TIMEOUT_MS = 5_000;

interface OwnerRecord {
  /** Fingerprint of the exact login (API URL + cookie values) the rest of the record belongs to. */
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

/** Identifies the exact login (API URL + cookie values). Binds pending hook data to it; reveals no cookie. */
export function credentialFingerprint(credentials: SSOCredentials): string {
  const cookies = Object.entries(credentials.cookies).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(JSON.stringify([credentials.apiUrl, cookies])).digest('hex');
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
 * Returns `credentials` carrying the signed-in user's email when it can be established from the
 * session itself: a `codemie_access_token` claim, else the backend's own `GET /v1/user` answer for
 * these exact cookies (oauth2-proxy logins store no claim). The answer is kept in a record keyed by the
 * login's fingerprint, never written into the credential store: a re-login or account switch changes
 * the fingerprint, so an old identity cannot attach to new credentials and a newer login is never
 * overwritten. Failures are remembered for `OWNER_LOOKUP_COOLDOWN_MS` and leave the credentials
 * unchanged (no owner is invented). Never throws.
 */
export async function withVerifiedOwner<T extends SSOCredentials | JWTCredentials>(credentials: T): Promise<T> {
  try {
    if (!isSSOCredentials(credentials) || !credentials.apiUrl || Object.keys(credentials.cookies).length === 0) {
      return credentials;
    }
    if (resolveEmailFromCredentials(credentials)) return credentials;

    const fp = credentialFingerprint(credentials);
    const path = recordPath(credentials.apiUrl);
    const known = await readRecord(path, fp);
    if (known?.email) return { ...credentials, email: known.email };
    if (known?.failedAt && Date.now() - known.failedAt < OWNER_LOOKUP_COOLDOWN_MS) return credentials;

    try {
      const info = await fetchCodeMieUserInfo(credentials.apiUrl, credentials.cookies, {
        timeout: OWNER_LOOKUP_TIMEOUT_MS,
        maxRetries: 1,
      });
      const email = normalizeOwnerEmail(info.email);
      if (!email) throw new Error('no email in /v1/user response');
      await writeRecord(path, { fp, email });
      return { ...credentials, email };
    } catch (error) {
      logger.debug(`[credential-owner] owner lookup failed: ${error instanceof Error ? error.name : 'error'}`);
      await writeRecord(path, { fp, failedAt: Date.now() });
      return credentials;
    }
  } catch {
    return credentials;
  }
}
