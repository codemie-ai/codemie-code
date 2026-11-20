/**
 * The single place that decides which stored credential a request is sent with: loads every
 * type's record for a URL, drops expired ones, and lets `selectRecord` pick.
 */

import type { JWTCredentials, SSOAuthResult, SSOCredentials } from '@/providers/core/types.js';
import {
  getAnalyticsPlatformSource,
  getPlatformUrlCandidates,
  getProfileOrigin,
  originOf,
  platformSourceFromEnv,
  type PlatformUrlSource,
} from '@/providers/core/codemie-auth-helpers.js';
import { logger } from '@/utils/logger.js';
import { decodeJwtExpiresAt } from './jwt-claims.js';
import { recordExpiresAt, selectRecord, toSSOAuth, type RecordCandidate } from './selection.js';
import { STRATEGIES } from './strategies/index.js';
import type { JwtSSOAuth, SSOAuth, SSOAuthStrategy } from './types.js';

/** Pairs a strategy's record with its type. The strategy list is typed by the union, so this is the one cast. */
function toCandidate(strategy: SSOAuthStrategy, record: SSOCredentials | JWTCredentials): RecordCandidate {
  return { type: strategy.type, record } as RecordCandidate;
}

/**
 * Stored login for one URL. Expired records are cleared (their own type's slot only); the
 * global slot is used when the URL has no record of its own and it was issued for the same host.
 */
export async function resolveSSOAuthForUrl(
  url: string,
  opts: { allowGlobalFallback?: boolean } = {},
): Promise<SSOAuth | null> {
  const { allowGlobalFallback = true } = opts;
  const now = Date.now();
  const candidates: RecordCandidate[] = [];

  for (const strategy of STRATEGIES) {
    let record = await strategy.load(url);
    if (!record && allowGlobalFallback) {
      const global = await strategy.loadGlobal();
      if (global?.apiUrl && originOf(global.apiUrl) === originOf(url)) {
        record = global;
      }
    }
    if (!record) continue;

    const candidate = toCandidate(strategy, record);
    const expiresAt = recordExpiresAt(candidate);
    if (expiresAt && now > expiresAt) {
      await strategy.clear(url);
    }
    candidates.push(candidate);
  }

  const selected = selectRecord(candidates, now);
  return selected ? toSSOAuth(selected, url) : null;
}

/**
 * Try each platform URL candidate in order. The workspace codeMieUrl is a single value shared
 * by all profiles, so it can point at a different environment than the active profile. A login
 * found under a fallback candidate is therefore accepted only if it was issued for the profile's
 * own API host (apiUrl); otherwise a dev login would be used for a prod profile. Loopback
 * baseUrls are exempt: inside an agent session baseUrl may be the local proxy URL.
 */
export async function resolveSSOAuth(src: PlatformUrlSource): Promise<SSOAuth | null> {
  const candidates = getPlatformUrlCandidates(src);
  if (candidates.length === 0) return null;

  const profileOrigin = getProfileOrigin(src);

  for (const url of candidates) {
    const auth = await resolveSSOAuthForUrl(url);
    if (!auth) continue;

    if (
      profileOrigin &&
      originOf(url) !== profileOrigin &&
      (!auth.apiUrl || originOf(auth.apiUrl) !== profileOrigin)
    ) {
      logger.debug('[auth] Ignoring stored credentials issued for a different host than the profile URL', {
        profileOrigin,
        credentialsUrl: url,
      });
      continue;
    }
    return auth;
  }
  return null;
}

/** `resolveSSOAuth` for the profile carried in the environment (`CODEMIE_PROFILE_CONFIG`, `CODEMIE_URL`). */
export function resolveSSOAuthFromEnv(env: NodeJS.ProcessEnv): Promise<SSOAuth | null> {
  return resolveSSOAuth(platformSourceFromEnv(env));
}

/** Stored login for analytics, session sync and hook auth checks; profile-first like model traffic. */
export function resolveAnalyticsSSOAuth(
  ssoUrl: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  overrides: { provider?: string; baseUrl?: string } = {},
): Promise<SSOAuth | null> {
  return resolveSSOAuth(getAnalyticsPlatformSource(ssoUrl, env, overrides));
}

/**
 * Stores the login a callback delivered: the first type whose record the payload can produce
 * (cookies win over a token), with every other type's slot for the URL cleared so the old login
 * cannot shadow the new one. Null when the payload has nothing usable.
 */
export async function storeSSOAuth(result: SSOAuthResult, codeMieUrl: string): Promise<SSOAuth | null> {
  const storedAt = Date.now();
  const offers = STRATEGIES.flatMap((strategy) => {
    const record = strategy.fromCallback(result, storedAt);
    return record ? [{ strategy, record }] : [];
  });

  const chosen = await firstAcceptedOffer(offers);
  if (!chosen) return null;

  await chosen.strategy.save(chosen.record, codeMieUrl);
  for (const other of STRATEGIES) {
    if (other !== chosen.strategy) {
      await other.clear(codeMieUrl);
    }
  }
  return toSSOAuth(toCandidate(chosen.strategy, chosen.record), codeMieUrl);
}

interface CallbackOffer {
  strategy: SSOAuthStrategy;
  record: SSOCredentials | JWTCredentials;
}

/**
 * The first offer in strategy order that the server accepts. Only an offer with a later
 * alternative is checked: a callback carrying a single credential type is stored as it is.
 */
async function firstAcceptedOffer(offers: CallbackOffer[]): Promise<CallbackOffer | null> {
  for (const [index, offer] of offers.entries()) {
    const hasAlternative = index < offers.length - 1;
    if (!hasAlternative || !offer.strategy.isAccepted || await offer.strategy.isAccepted(offer.record)) {
      return offer;
    }
    logger.info(`[sso-auth] ${offer.strategy.type} credentials from the login callback were rejected by the server; using ${offers[index + 1].strategy.type}`);
  }
  return null;
}

/** Clears every type's login for the URL (current and legacy keys, matching global slot); no URL clears the global slots. */
export async function clearSSOAuth(url?: string): Promise<void> {
  for (const strategy of STRATEGIES) {
    await strategy.clear(url);
  }
}

/**
 * A token supplied by the caller (`--jwt-token`, env, bearer-auth profile). Never re-read from the
 * store. Its expiry is the token's own `exp` claim, so a lapsed explicit token is rejected locally.
 */
export function explicitJwtAuth(token: string, apiUrl: string): JwtSSOAuth {
  const expiresAt = decodeJwtExpiresAt(token);
  return toSSOAuth(
    { type: 'jwt', record: { token, apiUrl, ...(expiresAt !== undefined && { expiresAt }) } },
    apiUrl,
    'explicit',
  ) as JwtSSOAuth;
}
