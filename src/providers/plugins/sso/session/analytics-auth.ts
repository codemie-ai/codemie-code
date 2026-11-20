/**
 * Resolves the credentials for analytics/session sync from the credential store with one read:
 * cookie auth, bearer (JWT) auth, or none. Callers branch on `kind` (or `hasAnalyticsAuth`)
 * instead of probing empty strings.
 */

import { toAnalyticsAuthMaterial } from '../auth/material.js';
import type { SSOAuth } from '../auth/types.js';
import {
  readWithDeadline,
  sentCredentialsSuperseded,
  type CookieAuth,
  type CredentialsSupersededCheck,
} from './cookie-auth.js';

/**
 * The JWT read from the credential store, e.g. when a reverse proxy in front of the backend
 * stripped cookies entirely. `credentialsSuperseded` tells a rejection from a newer sign-in apart.
 */
export interface BearerAuth {
  jwtToken: string;
  credentialsSuperseded?: CredentialsSupersededCheck;
  readTimedOut?: boolean;
}

function unreachableMaterial(value: never): never {
  throw new Error(`Unhandled analytics auth kind: ${JSON.stringify(value)}`);
}

export type AnalyticsAuth =
  | ({ kind: 'cookies' } & CookieAuth)
  | ({ kind: 'bearer' } & BearerAuth)
  | { kind: 'none'; readTimedOut?: boolean };

export type CredentialedAnalyticsAuth = Exclude<AnalyticsAuth, { kind: 'none' }>;

export const NO_ANALYTICS_AUTH: AnalyticsAuth = { kind: 'none' };

export function hasAnalyticsAuth(auth: AnalyticsAuth): auth is CredentialedAnalyticsAuth {
  return auth.kind !== 'none';
}

/** Cookies handed in through a config are used as they are, with no supersede check. */
export function fixedCookieAuth(cookies: string): AnalyticsAuth {
  return cookies ? { kind: 'cookies', cookies } : NO_ANALYTICS_AUTH;
}

/** The credential fields processing contexts and metrics senders take; `cookies` is '' unless cookie auth. */
export function analyticsAuthFields(auth: AnalyticsAuth): {
  cookies: string;
  jwtToken?: string;
  credentialsSuperseded?: CredentialsSupersededCheck;
} {
  switch (auth.kind) {
    case 'cookies':
      return {
        cookies: auth.cookies,
        ...(auth.credentialsSuperseded && { credentialsSuperseded: auth.credentialsSuperseded }),
      };
    case 'bearer':
      return {
        cookies: '',
        jwtToken: auth.jwtToken,
        ...(auth.credentialsSuperseded && { credentialsSuperseded: auth.credentialsSuperseded }),
      };
    case 'none':
      return { cookies: '' };
  }
}

/**
 * Reads the stored credentials once and classifies them. A read that throws, finds nothing,
 * finds credentials with an empty auth value or exceeds the deadline yields `none`; `readTimedOut`
 * tells a slow store from an empty one. Long-lived callers that can afford to wait pass a longer
 * `deadlineMs`.
 */
export async function resolveAnalyticsAuth(
  read: () => Promise<SSOAuth | null>,
  opts: { deadlineMs?: number } = {}
): Promise<AnalyticsAuth> {
  let timedOut = false;
  const guardedRead = readWithDeadline(read, opts.deadlineMs, () => {
    timedOut = true;
  });
  const first = await guardedRead();
  const readTimedOut = timedOut;

  // A record whose auth value is empty (no usable cookies, empty token) is no credential
  if (first && first.authValue !== '') {
    const source = { refreshNow: guardedRead };
    const material = toAnalyticsAuthMaterial(first);
    const credentialsSuperseded = (sent: string): Promise<boolean> => sentCredentialsSuperseded(sent, source);
    switch (material.kind) {
      case 'cookies':
        return { kind: 'cookies', cookies: material.cookies, readTimedOut, credentialsSuperseded };
      case 'bearer':
        return { kind: 'bearer', jwtToken: material.jwtToken, readTimedOut, credentialsSuperseded };
      default:
        return unreachableMaterial(material);
    }
  }

  return { kind: 'none', readTimedOut };
}

type AnalyticsEnv = NodeJS.ProcessEnv;
type AnalyticsOverrides = { provider?: string; baseUrl?: string };

/** resolveAnalyticsAuth over the analytics credentials stored for the given SSO URL. */
export async function readAnalyticsAuth(
  ssoUrl: string | undefined,
  env: AnalyticsEnv = process.env,
  overrides: AnalyticsOverrides = {}
): Promise<AnalyticsAuth> {
  return resolveAnalyticsAuth(async () => {
    const { resolveAnalyticsSSOAuth } = await import('@/providers/plugins/sso/auth/index.js');
    return resolveAnalyticsSSOAuth(ssoUrl, env, overrides);
  });
}
