import { readFile } from 'node:fs/promises';
import { getCodemiePath } from '@/utils/paths.js';
import { logger } from '@/utils/logger.js';
import type { PlatformUrlSource } from '@/providers/core/codemie-auth-helpers.js';
import { normalizeUrlForKey } from '@/utils/credential-crypto.js';

export interface LoginLock {
  pid: number;
  startedAt: number;
  /** CodeMie URL this lock's own sign-in was started for; absent in locks written by older versions. */
  url?: string;
  /** Epoch millis when this lock's own sign-in succeeded, if it has (see releaseLoginLockOnSuccess). */
  succeededAt?: number;
  /**
   * `succeededAt` of the sign-in this lock replaced. Read only by `getLastSignInAt`: the cooldown
   * and in-progress decisions in `acquireLock` look at `succeededAt` alone, so a carried stamp can
   * neither trigger nor extend them.
   */
  lastSucceededAt?: number;
  /** CodeMie URL of the sign-in `lastSucceededAt` belongs to; absent when that lock had none. */
  lastSucceededUrl?: string;
  /** Epoch millis when this lock's own sign-in failed, if it has (see releaseLoginLockOnFailure). */
  failedAt?: number;
  /** The sign-in child's failure reason, stamped with failedAt. */
  error?: string;
}

export function getLockPath(): string {
  return getCodemiePath('sso-login.lock');
}

export async function readLock(lockPath: string): Promise<LoginLock | null> {
  try {
    const lock = JSON.parse(await readFile(lockPath, 'utf-8')) as Partial<LoginLock> | null;
    if (typeof lock?.pid !== 'number' || typeof lock.startedAt !== 'number') {
      return null;
    }
    return {
      pid: lock.pid,
      startedAt: lock.startedAt,
      ...(typeof lock.url === 'string' && { url: lock.url }),
      ...(typeof lock.succeededAt === 'number' && { succeededAt: lock.succeededAt }),
      ...(typeof lock.lastSucceededAt === 'number' && { lastSucceededAt: lock.lastSucceededAt }),
      ...(typeof lock.lastSucceededUrl === 'string' && { lastSucceededUrl: lock.lastSucceededUrl }),
      ...(typeof lock.failedAt === 'number' && { failedAt: lock.failedAt }),
      ...(typeof lock.error === 'string' && { error: lock.error }),
    };
  } catch {
    return null;
  }
}

export interface CompletedSignIn {
  at: number;
  /** URL the sign-in was for; undefined when the lock that recorded it predates URL tracking. */
  url?: string;
}

/** The most recent completed sign-in a lock knows about: its own, else the one it replaced. */
export function lastSignInOf(lock: LoginLock | null): CompletedSignIn | undefined {
  if (lock?.succeededAt !== undefined) {
    return { at: lock.succeededAt, ...(lock.url !== undefined && { url: lock.url }) };
  }
  if (lock?.lastSucceededAt !== undefined) {
    return { at: lock.lastSucceededAt, ...(lock.lastSucceededUrl !== undefined && { url: lock.lastSucceededUrl }) };
  }
  return undefined;
}

/** The lock fields that carry a replaced sign-in over to the next lock. */
export function carriedFields(signIn: CompletedSignIn | undefined): Pick<LoginLock, 'lastSucceededAt' | 'lastSucceededUrl'> {
  return signIn
    ? { lastSucceededAt: signIn.at, ...(signIn.url !== undefined && { lastSucceededUrl: signIn.url }) }
    : {};
}

/**
 * Time of the last completed sign-in for the CodeMie URL `source` resolves to, which survives a
 * newer in-progress or failed attempt taking over the lock; null when none is known. The lock
 * holds one sign-in, so a sign-in recorded for another URL is not returned. A sign-in without a
 * recorded URL, or a source that resolves to no URL, always matches. Never throws: callers rely on
 * an unreadable lock reading as no sign-in.
 */
export async function getLastSignInAt(source: PlatformUrlSource): Promise<number | null> {
  try {
    const signIn = lastSignInOf(await readLock(getLockPath()));
    if (!signIn) {
      return null;
    }
    if (signIn.url !== undefined && !(await resolvesToUrl(source, signIn.url))) {
      return null;
    }
    return signIn.at;
  } catch {
    return null;
  }
}

/**
 * Whether the CodeMie URL `source` resolves to is `url`. Anything that cannot be told counts as a
 * match, so a sign-in is never hidden by a failure here. The resolver is loaded on demand: its
 * module pulls in the HTTP client, which this module (used by every hook) must not load up front.
 */
async function resolvesToUrl(source: PlatformUrlSource, url: string): Promise<boolean> {
  try {
    const { getPlatformUrl } = await import('@/providers/core/codemie-auth-helpers.js');
    const wanted = getPlatformUrl(source);
    return wanted === undefined || normalizeUrlForKey(wanted) === normalizeUrlForKey(url);
  } catch (error) {
    logger.debug('[sso-detached-login] Failed to resolve the sign-in URL of a source:', error);
    return true;
  }
}
