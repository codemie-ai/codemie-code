/**
 * The decision shared by the sync clients on a credential rejection: whether the analytics
 * invalid-auth marker may be written for the credentials that were sent.
 */

import { logger } from '@/utils/logger.js';
import { markAnalyticsAuthInvalid } from '@/utils/analytics-auth-status.js';
import type { CredentialsSupersededCheck } from './cookie-auth.js';

/**
 * How long a "superseded" answer is reused. At most the credential refresher's re-read window, so a
 * caller never works from an answer older than one store re-read.
 */
export const SUPERSEDED_CHECK_TTL_MS = 5000;

export interface RejectedCredentials {
  /** Why the server rejected the credentials; stored in the marker */
  reason: string;
  /** API base URL that rejected them */
  baseUrl: string;
  /** Cookie header the rejected request carried */
  cookies?: string;
  /** API key the rejected request carried (localhost development) */
  apiKey?: string;
  /** Whether a newer sign-in replaced `cookies`; absent means "never superseded" */
  credentialsSuperseded?: CredentialsSupersededCheck;
}

interface SupersededAnswer {
  answer: Promise<boolean>;
  /** Infinity while the check is still running; the TTL counts from when it answered. */
  expiresAt: number;
}

/**
 * Answers per check callback and sent cookie header. Keyed by the callback so clients that share one
 * (a client per sync pass, rebuilt over the same context) share its answers too, and the entries are
 * released with the callback.
 */
const supersededAnswers = new WeakMap<CredentialsSupersededCheck, Map<string, SupersededAnswer>>();

async function askSuperseded(check: CredentialsSupersededCheck, sent: string): Promise<boolean> {
  try {
    return await check(sent);
  } catch (error) {
    logger.debug('[analytics-auth-marker] Superseded-credentials check failed', error);
    return false;
  }
}

/**
 * Whether a newer sign-in replaced the cookies that were sent; never throws. The check reads the
 * credential store, and a sync pass can fail many requests, so failures running together share one
 * in-flight check. Only a true answer is kept for the TTL: it cannot turn false again, while a false
 * one goes stale the moment a sign-in finishes, so it is dropped as soon as it settles.
 */
async function wasSuperseded(check: CredentialsSupersededCheck, sent: string): Promise<boolean> {
  let byHeader = supersededAnswers.get(check);
  if (!byHeader) {
    byHeader = new Map();
    supersededAnswers.set(check, byHeader);
  }
  const now = Date.now();
  for (const [header, entry] of byHeader) {
    if (entry.expiresAt <= now) byHeader.delete(header);
  }

  const known = byHeader.get(sent);
  if (known) return known.answer;

  const created: SupersededAnswer = { answer: askSuperseded(check, sent), expiresAt: Infinity };
  const entries = byHeader;
  entries.set(sent, created);
  void created.answer.then((superseded) => {
    if (superseded) {
      created.expiresAt = Date.now() + SUPERSEDED_CHECK_TTL_MS;
    } else if (entries.get(sent) === created) {
      entries.delete(sent);
    }
  });
  return created.answer;
}

/**
 * Writes the analytics invalid-auth marker for a credential rejection, unless the rejection says
 * nothing about the stored credentials: the request carried none (an unreadable store looks the
 * same as an empty one), or a newer sign-in already replaced the cookies it carried.
 * Resolves true when the marker was written.
 */
export async function markAuthInvalidUnlessSuperseded(rejected: RejectedCredentials): Promise<boolean> {
  const { reason, baseUrl, cookies, apiKey, credentialsSuperseded } = rejected;

  if (!apiKey) {
    if (!cookies) {
      logger.debug('[analytics-auth-marker] The rejected request carried no credentials; not marking analytics auth invalid');
      return false;
    }
    if (credentialsSuperseded && await wasSuperseded(credentialsSuperseded, cookies)) {
      logger.debug('[analytics-auth-marker] Credentials were replaced by a newer sign-in; not marking analytics auth invalid');
      return false;
    }
  }

  await markAnalyticsAuthInvalid(reason, baseUrl);
  logger.debug('[analytics-auth-marker] Marked analytics auth invalid');
  return true;
}
