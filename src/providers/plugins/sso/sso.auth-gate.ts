import {
  getAnalyticsPlatformSource,
  getPlatformUrl,
  getStoredAnalyticsCredentials,
  type PlatformUrlSource,
} from '@/providers/core/codemie-auth-helpers.js';
import { clearAnalyticsAuthStatus, getAnalyticsAuthStatus, type AnalyticsAuthStatus } from '@/utils/analytics-auth-status.js';
import {
  describeLogin,
  getLastSignInAt,
  SSO_LOGIN_WAIT_MS,
  startDetachedSsoLogin,
  waitForDetachedSsoLogin,
  type DetachedLoginOutcome,
  type LoginWaitResult,
} from '@/providers/plugins/sso/sso.detached-login.js';
import { hasUsableSsoCredential } from '@/providers/plugins/sso/sso.auth.js';
import { normalizeUrlForKey } from '@/utils/credential-crypto.js';
import { logger } from '@/utils/logger.js';

/** Shortest wait worth holding a prompt for; below it the gate blocks with re-send guidance at once. */
export const MIN_LOGIN_WAIT_MS = 30_000;

export interface AuthGateInput {
  provider?: string;
  /** Workspace CodeMie URL (CODEMIE_URL); fallback when the profile URL has no login. */
  ssoUrl?: string;
  /** Active profile URL; defaults to the one in CODEMIE_PROFILE_CONFIG of `env`. */
  baseUrl?: string;
  syncApiUrl?: string;
  apiKey?: string;
  /** Environment carrying CODEMIE_PROFILE_CONFIG; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

export type AuthGateResult =
  | { ok: true }
  | { ok: false; reason: string; loginOutcome: DetachedLoginOutcome | undefined; waitResult?: LoginWaitResult };

/**
 * The analytics-auth-status marker is a single global file, written by multiple profiles'
 * processes (MetricsApiClient, SSOSessionExpiryPlugin) with no environment/profile key of their
 * own (PR #655 review). Without this check, a redirect in one profile's proxy blocks prompts and
 * opens a sign-in in a session of a different, healthy profile, and the gate's error message
 * ("metrics endpoint rejected...") describes the wrong profile's problem. `marker.baseUrl` IS
 * recorded by every writer (see analytics-auth-status.ts), so match it against every URL this
 * gate call knows about for its OWN profile — matching ANY of them (rather than requiring one
 * specific field) avoids a false negative from the writers not all normalizing to the same one
 * of baseUrl/syncApiUrl/loginUrl. No candidate resolved at all (e.g. no SSO configured) ⇒ treat
 * the marker as still applicable rather than silently ignore a real problem.
 */
export function markerAppliesToProfile(marker: AnalyticsAuthStatus, candidateUrls: Array<string | undefined>): boolean {
  if (!marker.baseUrl) {
    // Old/malformed marker with no key of its own — treat as matching rather than silently
    // ignore a real problem it might still be reporting.
    return true;
  }
  const known = candidateUrls.filter((u): u is string => Boolean(u));
  if (known.length === 0) {
    return true;
  }
  const normalizedMarkerUrl = normalizeUrlForKey(marker.baseUrl);
  return known.some((u) => normalizeUrlForKey(u) === normalizedMarkerUrl);
}

function isOlderThan(marker: AnalyticsAuthStatus, signedInAt: number | null): boolean {
  return signedInAt !== null && Number.isFinite(marker.detectedAt) && marker.detectedAt < signedInAt;
}

/**
 * A marker detected before the latest completed sign-in describes credentials that sign-in has
 * since replaced, so it is cleared instead of blocking the prompt and opening another browser.
 * The sign-in time is read first and the marker is re-read after it, with nothing awaited between
 * that re-read and the clear; the clear is also tied to the re-read marker's detection time, so a
 * marker written in between (a genuine rejection after the sign-in) is kept and never deleted
 * unexamined. Returns the marker that still applies, or null when none does.
 */
async function dropMarkerOlderThanSignIn(
  marker: AnalyticsAuthStatus,
  source: PlatformUrlSource,
  candidateUrls: Array<string | undefined>
): Promise<AnalyticsAuthStatus | null> {
  const signedInAt = await getLastSignInAt(source);
  if (!isOlderThan(marker, signedInAt)) {
    return marker;
  }
  const current = await getAnalyticsAuthStatus();
  if (!current || !markerAppliesToProfile(current, candidateUrls)) {
    return null;
  }
  if (!isOlderThan(current, signedInAt)) {
    return current;
  }
  await clearAnalyticsAuthStatus({ ifDetectedAt: current.detectedAt });
  logger.debug('[sso-auth-gate] Cleared an auth-status marker older than the last sign-in');
  return null;
}

/**
 * Cheap, local-only CodeMie SSO auth check.
 * Deliberately excludes the live network probe that
 * `validateAuth`/`fetchCodeMieModels` performs, to avoid a network round-trip on
 * every `UserPromptSubmit`.
 *
 * When auth is broken, a browser sign-in is started in a detached process; the
 * gate does not wait for it and returns immediately with the start outcome.
 */
export async function ensureCodeMieSsoAuth(input: AuthGateInput): Promise<AuthGateResult> {
  let loginOutcome: DetachedLoginOutcome | undefined;

  try {
    const analyticsConfigured = input.provider === 'ai-run-sso' || Boolean(input.ssoUrl && input.syncApiUrl);
    if (!analyticsConfigured) {
      return { ok: true };
    }

    let hasValidAuth = Boolean(input.apiKey);
    const source = getAnalyticsPlatformSource(input.ssoUrl, input.env, {
      provider: input.provider,
      baseUrl: input.baseUrl,
    });
    // Profile URL first, workspace URL as fallback — re-auth targets the URL the
    // profile actually uses, never a different environment's workspace.
    const loginUrl = getPlatformUrl(source);

    if (!hasValidAuth && loginUrl) {
      try {
        const found = await getStoredAnalyticsCredentials(input.ssoUrl, input.env, {
          provider: input.provider,
          baseUrl: input.baseUrl,
        });
        hasValidAuth = hasUsableSsoCredential(found?.credentials.cookies, found?.credentials.authorization);
      } catch (error) {
        logger.debug('[sso-auth-gate] Failed to load SSO credentials:', error);
      }
    }

    const rawAuthStatus = await getAnalyticsAuthStatus();
    const candidateUrls = [input.baseUrl, input.syncApiUrl, loginUrl];
    let authStatus = rawAuthStatus && markerAppliesToProfile(rawAuthStatus, candidateUrls) ? rawAuthStatus : null;
    if (authStatus && hasValidAuth && !input.apiKey) {
      authStatus = await dropMarkerOlderThanSignIn(authStatus, source, candidateUrls);
    }

    if (hasValidAuth && !authStatus) {
      return { ok: true };
    }

    const reason = !hasValidAuth
      ? 'no valid CodeMie SSO credentials found'
      : `CodeMie metrics endpoint rejected the stored credentials (${authStatus?.reason || 'unknown reason'})`;

    if (!input.apiKey && loginUrl) {
      loginOutcome = await startDetachedSsoLogin(loginUrl);
    } else if (input.provider === 'ai-run-sso' || !input.apiKey) {
      // SSO credential problem with no sign-in started (no login URL, or SSO provider with a key):
      // 'failed' makes describeLogin point at `codemie profile login`, not the API-key text.
      loginOutcome = 'failed';
    }

    return { ok: false, reason, loginOutcome };
  } catch (error) {
    logger.debug('[sso-auth-gate] Auth gate check failed:', error);
    return { ok: false, reason: 'CodeMie SSO auth gate check failed unexpectedly', loginOutcome };
  }
}

/**
 * Like ensureCodeMieSsoAuth, but when the gate started (or found) a browser sign-in, waits for it
 * and re-checks once, so a hook that can hold the prompt lets it through without a resubmit.
 * Never waits for other failures (api key, cooldown, failed start, unexpected gate error).
 */
export async function ensureCodeMieSsoAuthOrWait(
  input: AuthGateInput,
  opts: { waitMs?: number; onWaitStart?: (message: string) => void } = {}
): Promise<AuthGateResult> {
  const first = await ensureCodeMieSsoAuth(input);
  const waitMs = opts.waitMs ?? SSO_LOGIN_WAIT_MS;
  // Too short a wait rarely outlasts a sign-in, so keep the manual re-send text instead of promising auto-continue.
  if (first.ok || waitMs < MIN_LOGIN_WAIT_MS || (first.loginOutcome !== 'started' && first.loginOutcome !== 'in-progress')) {
    return first;
  }

  opts.onWaitStart?.(describeLogin(first.loginOutcome, { resume: 'auto' }));
  const waitResult = await waitForDetachedSsoLogin({ timeoutMs: waitMs });
  if (waitResult.status !== 'succeeded') {
    return { ...first, waitResult };
  }
  // The lock may have been released by another profile's login, so success still needs a re-check.
  const recheck = await ensureCodeMieSsoAuth(input);
  return recheck.ok ? recheck : { ...recheck, waitResult };
}
