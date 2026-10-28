import { classify, decide, type ClassResult, type Consumer, type Evidence } from '@/agents/core/evidence/classify.js';
import type { EvidenceRecord } from '@/agents/core/evidence/record-store.js';
import type { SSOCredentials, JWTCredentials } from '../../../../../core/types.js';
import { isSSOCredentials, isJWTCredentials } from '../../../../../core/types.js';
import { buildAuthHeaders } from '../../../../../core/codemie-auth-helpers.js';
import { getPolicyState, refreshPolicy, type NamespaceId, type PolicyState } from './policy-cache.js';
import { forwardDecisionWithoutPolicy, readVerdict, recordVerdict, replaceVerdict } from './verdict-store.js';

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
  | { action: 'hold'; reason: 'classification_unresolved' | 'personal_not_forwardable' }
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
  const verdict = await readVerdict(key);
  if (state.policy) {
    if (!verdict) await recordVerdict(key, result);
    else if (verdict.class !== result.class || verdict.policy_version !== result.policy_version) {
      await replaceVerdict(key, result, true);
    }
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
