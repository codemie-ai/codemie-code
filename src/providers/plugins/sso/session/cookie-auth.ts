/**
 * Cookie auth for analytics/session sync: the Cookie header read once from the
 * credential store, plus a check whether a later sign-in replaced what was sent.
 */

import { logger } from '@/utils/logger.js';

export const STORE_READ_DEADLINE_MS = 3000;

/**
 * Answers whether the Cookie header a request was sent with has since been
 * replaced by a newer sign-in. Resolves false whenever that cannot be told.
 */
export type CredentialsSupersededCheck = (sentCookies: string) => Promise<boolean>;

interface CookieSet {
  cookies: Record<string, string>;
}

interface CookieSource {
  refreshNow(): Promise<CookieSet | null>;
}

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
 * Debug-logs a failure by message only, run through the log sanitizer. The sanitizer is loaded on
 * demand: it pulls in credential-storage modules that resolve filesystem paths at import time,
 * which this module (imported by every sync path) must not do.
 */
async function logFailure(message: string, error: unknown): Promise<void> {
  const err = error instanceof Error ? error.message : String(error);
  try {
    const { sanitizeLogArgs } = await import('@/utils/security.js');
    logger.debug(message, ...sanitizeLogArgs({ err }));
  } catch {
    logger.debug(message);
  }
}

/**
 * Wraps a store read so it can never hang its caller: a throw, an empty result or
 * a read slower than the deadline all yield null. A read that outlives its
 * deadline keeps running but its late result is dropped; the next call starts
 * a fresh read.
 */
export function readWithDeadline<T>(
  read: () => Promise<T | null>,
  deadlineMs: number = STORE_READ_DEADLINE_MS
): () => Promise<T | null> {
  return async (): Promise<T | null> => {
    const attempt = (async (): Promise<T | null> => {
      try {
        return (await read()) ?? null;
      } catch (error) {
        await logFailure('[cookie-auth] store read failed', error);
        return null;
      }
    })();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        logger.debug(`[cookie-auth] store read timed out after ${deadlineMs}ms`);
        resolve(null);
      }, deadlineMs);
      timer.unref();
    });

    try {
      return await Promise.race([attempt, deadline]);
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * True only when the store now holds usable credentials that differ from the
 * header that was sent. Assumes the store changes only at sign-in, so a
 * difference means a newer login replaced the credentials the request used.
 * Anything unreadable or unknown is "not superseded".
 */
export async function sentCredentialsSuperseded(
  sentCookieHeader: string | undefined,
  source?: CookieSource
): Promise<boolean> {
  if (!source || !sentCookieHeader) {
    return false;
  }
  try {
    const fresh = await source.refreshNow();
    if (!fresh) {
      return false;
    }
    const freshHeader = buildCookieHeader(fresh.cookies);
    return freshHeader !== '' && freshHeader !== sentCookieHeader;
  } catch (error) {
    await logFailure('[cookie-auth] supersede check failed', error);
    return false;
  }
}

/**
 * Reads the stored credentials once and returns the Cookie header built from
 * them (empty string when the read throws, finds nothing or exceeds the store
 * read deadline), together with a
 * check for whether a later sign-in superseded the header that was sent.
 */
export async function readCookieAuth(
  read: () => Promise<CookieSet | null>
): Promise<{ cookies: string; credentialsSuperseded: CredentialsSupersededCheck }> {
  const guardedRead = readWithDeadline(read);
  const first = await guardedRead();
  const source: CookieSource = { refreshNow: guardedRead };

  let cookies = '';
  try {
    cookies = first ? buildCookieHeader(first.cookies) : '';
  } catch (error) {
    await logFailure('[cookie-auth] stored credentials are malformed', error);
  }

  return {
    cookies,
    credentialsSuperseded: (sentCookies: string) => sentCredentialsSuperseded(sentCookies, source),
  };
}

type AnalyticsEnv = NodeJS.ProcessEnv;
type AnalyticsOverrides = { provider?: string; baseUrl?: string };

/**
 * readCookieAuth over the analytics credentials stored for the given SSO URL;
 * the cookies are an empty string when none are stored or the read fails.
 */
export async function readAnalyticsCookieAuth(
  ssoUrl: string | undefined,
  env: AnalyticsEnv = process.env,
  overrides: AnalyticsOverrides = {}
): Promise<{ cookies: string; credentialsSuperseded: CredentialsSupersededCheck }> {
  return readCookieAuth(async () => {
    const { getStoredAnalyticsCredentials } = await import('../../../core/codemie-auth-helpers.js');
    const found = await getStoredAnalyticsCredentials(ssoUrl, env, overrides);
    return found?.credentials ?? null;
  });
}
