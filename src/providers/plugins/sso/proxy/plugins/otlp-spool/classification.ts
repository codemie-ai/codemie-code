import { apiIdentity } from '@/agents/core/evidence/api-identity.js';
import { logger } from '@/utils/logger.js';
import { forwarderIdentity } from './spool-io.js';
import { classify, decide, type ClassResult, type Consumer, type Evidence } from '@/agents/core/evidence/classify.js';
import type { EvidenceRecord } from '@/agents/core/evidence/record-store.js';
import type { SSOCredentials, JWTCredentials } from '../../../../../core/types.js';
import { isSSOCredentials, isJWTCredentials } from '../../../../../core/types.js';
import { buildAuthHeaders, ensureApiBase } from '../../../../../core/codemie-auth-helpers.js';
import { getPolicyState, refreshPolicy, type NamespaceId, type PolicyState } from './policy-cache.js';
import { forwardDecisionWithoutPolicy, readVerdictState, recordVerdict, replaceVerdict } from './verdict-store.js';

/*
 * The one classification decision point for evidence sessions (spec item 5): classify -> sticky
 * verdict (I5) -> decide(consumer). Used by the tick (normal path) and the forwarder (409 re-decide).
 */

let consumer: Consumer | undefined;

/**
 * The #711 seam. Default (undefined): everything is forwarded, indeterminate as `unknown`.
 * - `withhold`: nothing is sent, the session is held `classification_unresolved` (bounded by
 *   heldRetentionMs) and re-decided every tick after the policy refresh.
 * - `suppress`: non-destructive no-op here. Nothing is sent, no bytes, cursor or hold change and no
 *   loss is recorded; the opt-out outcome itself (and its own loss reason) is #711's to define.
 */
export function setClassificationConsumer(c: Consumer | undefined): void {
  consumer = c;
}

export type SessionClassification =
  | { action: 'send'; result: ClassResult }
  | { action: 'hold'; reason: 'classification_unresolved' | 'personal_not_forwardable' | 'verdict_unavailable' }
  | { action: 'suppress' };

export function authHeadersFor(credentials: SSOCredentials | JWTCredentials): Record<string, string> | null {
  if (isSSOCredentials(credentials)) return buildAuthHeaders(credentials.cookies);
  if (isJWTCredentials(credentials)) return buildAuthHeaders(credentials.token);
  return null;
}

/** Usable policy from the cache; fetched (bounded by the cache's timeout/backoff) when none is usable. */
export async function sessionPolicyState(
  ns: NamespaceId,
  baseUrl: string,
  credentials: SSOCredentials | JWTCredentials,
  force?: true
): Promise<PolicyState> {
  const state = force ? undefined : await getPolicyState(ns);
  if (state && (state.policy || !state.refreshDue || !baseUrl)) return state;
  return refreshPolicy(ns, { baseUrl, headers: authHeadersFor(credentials), force });
}

export const evidenceOf = (r: EvidenceRecord): Evidence => ({
  routed_via_codemie: r.routed_via_codemie,
  routing_proof: r.routing_proof,
  organization: r.organization,
});

/**
 * Classify a stamped session and apply the sticky verdict: with a usable policy the first
 * determinate Personal is recorded and a changed result replaces a stored verdict (Task 8 rule);
 * without one a sticky Personal is sent as full evidence (class personal, its policy version) only
 * when the backend is evidence-capable, else held `personal_not_forwardable`, never stripped.
 */
export async function classifySession(
  key: string,
  record: EvidenceRecord,
  state: Pick<PolicyState, 'policy' | 'capability'>
): Promise<SessionClassification> {
  let result = classify(evidenceOf(record), state.policy);
  const vs = await readVerdictState(key);
  const verdict = vs.state === 'ok' ? vs.verdict : null;
  // Durable privacy state that cannot be read or written fails closed (hold), never an evidence-free send.
  const unavailable: SessionClassification = { action: 'hold', reason: 'verdict_unavailable' };
  if (state.policy) {
    if (!verdict) {
      const personal = result.class === 'personal' && result.status === 'determinate';
      // An unreadable file is overwritten (repaired) only by a determinate Personal; anything else proceeds on the fresh policy.
      if (!(await recordVerdict(key, result)) && personal) return unavailable;
    } else if (verdict.class !== result.class || verdict.policy_version !== result.policy_version) {
      const eligible = result.status === 'determinate' && !!result.policy_version;
      if (!(await replaceVerdict(key, result, true)) && eligible) return unavailable;
    }
  } else if (vs.state === 'unreadable') {
    return unavailable;
  } else if (verdict?.class === 'personal') {
    if (forwardDecisionWithoutPolicy({ verdict, capability: state.capability }) !== 'full_evidence') {
      return { action: 'hold', reason: 'personal_not_forwardable' };
    }
    result = {
      class: 'personal', status: 'determinate', basis: 'org_no_match',
      ...(verdict.policy_version ? { policy_version: verdict.policy_version } : {}),
    };
  }
  const decision = decide(result, consumer);
  if (decision === 'withhold') return { action: 'hold', reason: 'classification_unresolved' };
  if (decision === 'suppress') return { action: 'suppress' };
  return { action: 'send', result };
}

export interface AnalyticsEndpoint {
  /** The one analytics base URL every policy fetch and ingest POST of this pass uses. */
  baseUrl: string;
  profile?: string;
  /** The credential identity (null = none can be built: legacy world, no evidence key). */
  identity: { api_identity: string; owner_hash: string } | null;
}

/**
 * Resolve the intended ANALYTICS endpoint once (the CodeMie API URL the daemon recorded, else its
 * target; never the model gateway on its own) and require its canonical identity (scheme, host, port
 * and base path) to equal the credentials' api_identity that keys the record, stamp, verdict and policy
 * cache. `null` = mismatch or stale daemon/credentials: the caller sends and fetches nothing.
 */
export async function resolveAnalyticsEndpoint(credentials: SSOCredentials | JWTCredentials): Promise<AnalyticsEndpoint | null> {
  const { readState } = await import('../../../../../../cli/commands/proxy/daemon-manager.js');
  const state = await readState();
  // Sync producers: syncApiUrl = the profile's resolved CodeMie API URL (ssoConfig.apiUrl, config.js
  // VITE_API_URL aware); syncCodeMieUrl = the raw org host, which SSO login turns into the API base with
  // ensureApiBase. With neither (legacy daemon) the target is the API. The model gateway is never a candidate
  // next to a sync URL.
  const candidates = state?.syncApiUrl || state?.syncCodeMieUrl
    ? [state.syncApiUrl, state.syncCodeMieUrl && ensureApiBase(state.syncCodeMieUrl)]
    : [state?.targetUrl ?? state?.url];
  const urls = candidates.filter((u): u is string => !!u);
  const identity = forwarderIdentity(credentials);
  const wireOf = (u: string): string | undefined => {
    try {
      return apiIdentity(u);
    } catch {
      return undefined;
    }
  };
  if (!identity) return { baseUrl: (urls[0] && wireOf(urls[0])) || urls[0] || '', profile: state?.profile, identity };
  // Origin AND base path must equal the credentials' api_identity.
  if (!urls.some((u) => wireOf(u) === identity.api_identity)) {
    logger.debug('[otlp-classification] analytics endpoint does not match the credential identity; nothing sent or fetched');
    return null;
  }
  // The validated canonical identity IS the destination base (no trailing/repeated slash, query or
  // userinfo), so the policy fetch and every `${baseUrl}/v1/...` send go where validation looked.
  return { baseUrl: identity.api_identity, profile: state?.profile, identity };
}
