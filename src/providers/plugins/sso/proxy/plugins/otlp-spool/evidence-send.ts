import { rawProjectHeader } from '@/utils/header-value.js';
import { logger } from '@/utils/logger.js';
import { ORG_ENCODED_HEADER, encodeOrganization, needsOrganizationEncoding } from '@/agents/core/evidence/org-encoding.js';
import type { ClassResult } from '@/agents/core/evidence/classify.js';
import { readRecord, recordKey, type EvidenceRecord } from '@/agents/core/evidence/record-store.js';
import type { SSOCredentials, JWTCredentials } from '../../../../../core/types.js';
import type { NamespaceId } from './policy-cache.js';
import { classifySession, sessionPolicyState, type AnalyticsEndpoint } from './classification.js';

/** Project the session is bound to; the backend gates analytics on it. */
export const PROJECT_HEADER = 'X-CodeMie-Project';

/** An evidence-mode session: the frozen record at the forwarder's key and its current classification. */
export interface EvidenceContext {
  key: string;
  record: EvidenceRecord;
  ns: NamespaceId;
  baseUrl: string;
  credentials: SSOCredentials | JWTCredentials;
  result: ClassResult;
}

/**
 * Evidence headers (spec item 6; backend `EVIDENCE_HEADERS`), from the record's frozen values and
 * the classification. Organization only if known; Project and Project-Source only with a project;
 * Repo-Remote carries the credential-free repo key, never a raw remote. Values that are not valid
 * Latin-1 header values are omitted rather than sent mangled.
 */
export function evidenceHeaders(sessionId: string, ctx: EvidenceContext): Record<string, string> {
  const { record, result } = ctx;
  const headers: Record<string, string> = {
    'X-CodeMie-Session-Id': sessionId,
    'X-CodeMie-Routed-Via-CodeMie': String(record.routed_via_codemie),
    // Indeterminate is sent as `unknown`; the local basis (e.g. routing_unproven) is never sent.
    'X-CodeMie-Subscription-Type': result.class,
  };
  const put = (name: string, value: string | undefined): void => {
    const v = value ? rawProjectHeader(value) : undefined;
    if (v) headers[name] = v;
    // Reason code only, never the value. Organization is the one whose omission changes what the backend derives.
    else if (value) logger.debug(`[otlp-evidence] ${name} omitted: not_latin1_header_value`);
  };
  // Backend D7 derives Personal from routed=false + a non-matching organization and ignores the advisory
  // class. An unproven route must therefore not carry the organization: without it the backend derives
  // the same Unknown this client claims. (Corporate-by-match is the only other unproven outcome and is
  // never sent through this basis.)
  // Organization the plain header cannot carry goes only in the versioned encoded header (classifySession
  // already confirmed the backend advertises it). A CodeMie-routed class needs no organization at all.
  const org = record.organization;
  if (result.basis !== 'routing_unproven' && org) {
    if (!needsOrganizationEncoding(org)) put('X-CodeMie-Organization', org);
    else if (!record.routed_via_codemie) {
      const encoded = encodeOrganization(org);
      if (encoded) headers[ORG_ENCODED_HEADER] = encoded;
    }
  }
  put('X-CodeMie-Policy-Version', result.policy_version);
  put('X-CodeMie-Repo-Remote', record.repo_key);
  const project = record.project ? rawProjectHeader(record.project) : undefined;
  if (project) {
    headers[PROJECT_HEADER] = project;
    if (record.project_source !== 'none') headers['X-CodeMie-Project-Source'] = record.project_source;
  }
  return headers;
}

/**
 * Build the evidence context; `null` = nothing may be sent (fail closed, I2). The tick normally
 * passes the classification it decided (consumer seam, sticky verdict, holds); a direct caller
 * without one gets the same decision here, and anything but `send` sends nothing.
 */
export async function evidenceContext(
  sessionId: string,
  baseUrl: string,
  credentials: SSOCredentials | JWTCredentials,
  endpoint: AnalyticsEndpoint,
  decided: ClassResult | undefined
): Promise<EvidenceContext | null> {
  const id = endpoint.identity;
  if (!id) return null;
  const profile = endpoint.profile;
  const key = recordKey(id.api_identity, id.owner_hash, sessionId);
  const found = await readRecord(key);
  if (found?.kind !== 'existing' && found?.kind !== 'created') return null;
  const ns: NamespaceId = { ...id, ...(profile ? { profile } : {}) };
  let result = decided;
  if (!result) {
    const cls = await classifySession(key, found.record, await sessionPolicyState(ns, baseUrl, credentials));
    if (cls.action !== 'send') return null;
    result = cls.result;
  }
  return { key, record: found.record, ns, baseUrl, credentials, result };
}

/**
 * 409 stale_policy: force a refresh and re-decide through the same seam. True only when a fresher
 * policy than the one that was sent is now usable and the decision is still `send`; otherwise the
 * caller keeps the spool.
 */
export async function reclassify(ctx: EvidenceContext): Promise<boolean> {
  const state = await sessionPolicyState(ctx.ns, ctx.baseUrl, ctx.credentials, true);
  if (!state.policy || state.policy.version === ctx.result.policy_version) return false;
  const cls = await classifySession(ctx.key, ctx.record, state);
  if (cls.action !== 'send') return false;
  ctx.result = cls.result;
  return true;
}
