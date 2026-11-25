/**
 * Auth value for analytics/session sync: the Cookie header (or bare token) read once from the
 * credential store, plus a check whether a later sign-in replaced what was sent.
 */

import { logger } from '@/utils/logger.js';
import type { CookieSSOAuth, SSOAuth } from '../auth/types.js';

export const STORE_READ_DEADLINE_MS = 3000;

/**
 * Deadline for the long-lived proxy's reads: a request waits on this read, so it is bounded but
 * longer than for one-shot processes, whose slow keychain would otherwise look like an empty store.
 */
export const PROXY_STORE_READ_DEADLINE_MS = 10_000;

/**
 * Answers whether the credential a request was sent with (a Cookie header or a bare token) has
 * since been replaced by a newer sign-in. Resolves false whenever that cannot be told.
 */
export type CredentialsSupersededCheck = (sentAuthValue: string) => Promise<boolean>;

/**
 * The Cookie header read from the credential store plus the check for whether a later sign-in
 * superseded it. `readTimedOut` tells a store that answered too slowly from one that is empty:
 * both leave `cookies` empty. Cookies handed in from a config carry neither the check nor the flag.
 */
export interface CookieAuth {
  cookies: string;
  credentialsSuperseded?: CredentialsSupersededCheck;
  readTimedOut?: boolean;
}

/** Anything that can re-read the credential the store holds now (a refresher, or a guarded read). */
export interface AuthSource {
  refreshNow(): Promise<SSOAuth | null>;
}

export { buildCookieHeader, hasUsableCookies, droppedCookieKeys } from '../auth/selection.js';

/**
 * Debug-logs a failure by message only, run through the log sanitizer. The sanitizer is loaded on
 * demand: it pulls in credential-storage modules that resolve filesystem paths at import time,
 * which this module (imported by every sync path) must not do.
 */
export async function logFailure(message: string, error: unknown): Promise<void> {
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
 * a fresh read. `onTimeout` is called when the deadline, not the read, ended a call.
 */
export function readWithDeadline<T>(
  read: () => Promise<T | null>,
  deadlineMs: number = STORE_READ_DEADLINE_MS,
  onTimeout?: () => void
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
        onTimeout?.();
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
 * The auth value (Cookie header or bare token) the store now holds when it differs from the one
 * that was sent, otherwise null. Assumes the store changes only at sign-in, so a difference means
 * a newer login replaced the credentials the request used. Anything unreadable, empty or unknown
 * yields null.
 */
export async function supersedingAuthValue(
  sent: string | undefined,
  source?: AuthSource
): Promise<string | null> {
  if (!source || !sent) {
    return null;
  }
  try {
    const fresh = await source.refreshNow();
    if (!fresh) {
      return null;
    }
    return fresh.authValue !== '' && fresh.authValue !== sent ? fresh.authValue : null;
  } catch (error) {
    await logFailure('[cookie-auth] supersede check failed', error);
    return null;
  }
}

/**
 * True only when the store now holds usable credentials that differ from the value that was
 * sent. Anything unreadable or unknown is "not superseded".
 */
export async function sentCredentialsSuperseded(
  sent: string | undefined,
  source?: AuthSource
): Promise<boolean> {
  return (await supersedingAuthValue(sent, source)) !== null;
}

/**
 * The Cookie header of a cookie login, together with a check for whether a later sign-in
 * superseded the header that was sent. `readTimedOut` is passed through from the read that
 * produced `first`, so a slow store is not reported as an empty one.
 */
export async function buildCookieAuth(
  first: CookieSSOAuth,
  source: AuthSource,
  readTimedOut: boolean
): Promise<Required<CookieAuth>> {
  return {
    cookies: first.authValue,
    readTimedOut,
    credentialsSuperseded: (sentCookies: string) => sentCredentialsSuperseded(sentCookies, source),
  };
}
