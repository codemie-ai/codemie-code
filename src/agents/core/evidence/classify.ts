/** Pure classification (backend contract "Classification and routing", D7). */

export type SentBasis = 'routed' | 'org_match' | 'org_no_match' | 'org_list_empty' | 'no_org' | 'policy_unavailable';
/** Local diagnostic basis only; never part of the sent enum. */
export type LocalBasis = 'routing_unproven';

export interface Evidence {
  routed_via_codemie: boolean;
  routing_proof?: 'proven' | 'unproven';
  organization?: string;
  subscription_type?: string;
}

/** A usable policy only; expiry/null handling lives in the cache layer. */
export interface Policy {
  organizations: string[];
  version: string;
}

export interface ClassResult {
  class: 'codemie' | 'corporate' | 'personal' | 'unknown';
  status: 'determinate' | 'indeterminate';
  basis: SentBasis | LocalBasis;
  policy_version?: string;
}

export type Decision = 'forward' | 'suppress' | 'withhold';
export type Consumer = (r: ClassResult) => Decision;

const norm = (s: string): string => s.trim().toLowerCase();

export function classify(evidence: Evidence, policy: Policy | null): ClassResult {
  if (evidence.routed_via_codemie) return { class: 'codemie', status: 'determinate', basis: 'routed' };
  const org = norm(evidence.organization ?? '');
  if (!org) return { class: 'unknown', status: 'determinate', basis: 'no_org' };
  const unproven = evidence.routing_proof === 'unproven';
  if (!policy) {
    return { class: 'unknown', status: 'indeterminate', basis: unproven ? 'routing_unproven' : 'policy_unavailable' };
  }
  const policy_version = policy.version;
  if (policy.organizations.length === 0) {
    return { class: 'unknown', status: 'determinate', basis: 'org_list_empty', policy_version };
  }
  if (policy.organizations.some((o) => norm(o) === org)) {
    return { class: 'corporate', status: 'determinate', basis: 'org_match', policy_version };
  }
  // Not routed-proven: the session might really be routed, so never personal.
  if (unproven) return { class: 'unknown', status: 'indeterminate', basis: 'routing_unproven', policy_version };
  return { class: 'personal', status: 'determinate', basis: 'org_no_match', policy_version };
}

/** Default forwards everything (indeterminate is sent as `unknown`); only an injected consumer may suppress/withhold. */
export function decide(r: ClassResult, consumer?: Consumer): Decision {
  return consumer ? consumer(r) : 'forward';
}
