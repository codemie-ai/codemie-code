/**
 * Pure credential selection: which stored record wins, and what a record turns into. Keytar-free
 * on purpose: the esbuild-bundled statusline imports this module. Only `node:crypto` and type
 * imports belong here.
 */

import { createHash } from 'node:crypto';
import type { JWTCredentials, SSOCredentials } from '@/providers/core/types.js';
import type { SSOAuth, SSOAuthSource, SSOAuthType } from './types.js';

function hasInvalidHeaderChars(value: string): boolean {
  // RFC 7230 field-vchar / obs-text; control characters other than HTAB are rejected.
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if ((code <= 0x1f && code !== 0x09) || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * Joins cookies into a Cookie header value. Entries with an empty name or
 * control characters in the name or value are skipped; yields an empty string
 * when no usable cookie remains.
 */
export function buildCookieHeader(cookies: Record<string, string>): string {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(cookies)) {
    const name = String(key).trim();
    const val = String(value);
    if (!name || hasInvalidHeaderChars(name) || hasInvalidHeaderChars(val)) {
      continue;
    }
    pairs.push(`${name}=${val}`);
  }
  return pairs.join('; ');
}

/**
 * Whether stored cookies build a non-empty Cookie header. False, not a throw, for a record whose
 * `cookies` field is missing or not an object (an old or corrupt record).
 */
export function hasUsableCookies(cookies: unknown): cookies is Record<string, string> {
  return typeof cookies === 'object' && cookies !== null && buildCookieHeader(cookies as Record<string, string>) !== '';
}

/**
 * Names of the entries buildCookieHeader leaves out (an empty name shows as `<empty>`).
 * Names only: the values are credentials.
 */
export function droppedCookieKeys(cookies: Record<string, string>): string[] {
  return Object.entries(cookies)
    .filter(([key, value]) => buildCookieHeader({ [key]: value }) === '')
    .map(([key]) => String(key).trim() || '<empty>');
}

/** A stored record tagged with the type of the slot it was read from. */
export type RecordCandidate =
  | { type: 'cookie'; record: SSOCredentials }
  | { type: 'jwt'; record: JWTCredentials };

/** Whether the record carries material a request can be sent with. */
export function isRecordUsable(c: RecordCandidate): boolean {
  if (c.type === 'cookie') {
    return hasUsableCookies(c.record.cookies) && buildCookieHeader(c.record.cookies) !== '';
  }
  return typeof c.record.token === 'string' && c.record.token !== '';
}

/**
 * Expiry that may be enforced locally.
 *
 * Cookie: the stored expiresAt counts only when a codemie_access_token cookie is present.
 * Cookie-only logins (including legacy ones with a synthetic 24h expiresAt) never expire locally.
 *
 * JWT: expiresAt is derived from the token's own `exp` claim at store time, so it is used directly.
 */
export function recordExpiresAt(c: RecordCandidate): number | undefined {
  if (c.type === 'jwt') {
    return c.record.expiresAt;
  }
  return c.record.cookies?.codemie_access_token ? c.record.expiresAt : undefined;
}

const TYPE_ORDER: readonly SSOAuthType[] = ['cookie', 'jwt'];

/**
 * Picks the record a request should use, or null when none is usable and unexpired.
 *
 * 1. An unmarked (pre-2026-11) record coexisting with a marked record of the other type wins, so
 *    a login made by an older build is not shadowed by a stale marked record of the other type.
 * 2. Otherwise, with any marked record, the one stored last.
 * 3. Otherwise, cookie before JWT.
 */
export function selectRecord(candidates: RecordCandidate[], now: number = Date.now()): RecordCandidate | null {
  const live = candidates
    .filter((c) => {
      if (!isRecordUsable(c)) return false;
      const expiresAt = recordExpiresAt(c);
      return !(expiresAt && now > expiresAt);
    })
    .sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type));

  const isMarked = (c: RecordCandidate): boolean => c.record.authType !== undefined;

  const unmarkedWithMarkedOther = live.find((c) => !isMarked(c) && live.some((o) => isMarked(o) && o.type !== c.type));
  if (unmarkedWithMarkedOther) {
    return unmarkedWithMarkedOther;
  }

  const marked = live.filter(isMarked);
  if (marked.length > 0) {
    return marked.reduce((best, c) => ((c.record.storedAt ?? 0) > (best.record.storedAt ?? 0) ? c : best));
  }

  return live[0] ?? null;
}

/**
 * Stable, non-secret hash of the login. The cookie form is the fingerprint owner and pending files
 * on disk are already keyed by, so it must not change.
 */
export function recordFingerprint(c: RecordCandidate): string {
  if (c.type === 'cookie') {
    const cookies = Object.entries(c.record.cookies).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return createHash('sha256').update(JSON.stringify([c.record.apiUrl, cookies])).digest('hex');
  }
  return createHash('sha256').update(JSON.stringify([c.record.apiUrl, 'jwt', c.record.token])).digest('hex');
}

/** Turns a stored record into the credential a request is sent with. */
export function toSSOAuth(c: RecordCandidate, url: string, source: SSOAuthSource = 'store'): SSOAuth {
  const expiresAt = recordExpiresAt(c);
  const fingerprint = recordFingerprint(c);

  if (c.type === 'cookie') {
    const header = buildCookieHeader(c.record.cookies);
    return {
      type: 'cookie',
      apiUrl: c.record.apiUrl,
      url,
      expiresAt,
      headers: { cookie: header },
      authValue: header,
      fingerprint,
      identityToken: c.record.cookies.codemie_access_token,
      email: c.record.email,
      source,
      cookies: c.record.cookies,
    };
  }

  return {
    type: 'jwt',
    apiUrl: c.record.apiUrl,
    url,
    expiresAt,
    headers: { authorization: `Bearer ${c.record.token}` },
    authValue: c.record.token,
    fingerprint,
    identityToken: c.record.token,
    source,
    token: c.record.token,
  };
}
