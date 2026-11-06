import { rawProjectHeader } from '@/utils/header-value.js';
import { logger } from '@/utils/logger.js';
import { buildAttributionHeaders } from '../header-injection.plugin.js';
import type { ClassResult } from '@/agents/core/evidence/classify.js';
import { readRecord, recordKey, type EvidenceRecord } from '@/agents/core/evidence/record-store.js';
import type { SSOCredentials, JWTCredentials } from '../../../../../core/types.js';
import { getPolicyState, type NamespaceId, type PolicyState } from './policy-cache.js';
import { isStopped, writeStop } from '@/agents/core/evidence/stop-marker.js';
import { consentHolds } from '@/agents/core/evidence/consent-store.js';
import { hasScopeEvidence } from '@/agents/core/evidence/session-scope.js';
import { stopIntentPending } from './stop-intent.js';
import { readClaudeAnalyticsPreferences } from '@/agents/plugins/claude-code-otlp/claude-code-otlp.preferences.js';
import { classifySession, sessionPolicyState, type AnalyticsEndpoint } from './classification.js';
import { publicationMode, type PublicationMode } from './publication-mode.js';

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
  /** The session selected contract mode: contract and frozen funding go on every request. */
  newContract: boolean;
  wireMode?: PublicationMode;
  /** Explicit work consent: the frozen entry still holds right now. Never true from spooled or inbound headers. */
  consent: boolean;
}

/**
 * Whether this session may make a NEW network send right now (checked at tick and before every attempt).
 * A stopped session sends nothing, backlog included. For the new contract the frozen collection generation must
 * equal the current one and a frozen consent entry must still hold; a mismatch persists a stop (never a downgrade
 * that would send under another scope). Unreadable evidence is no send, never open.
 */
export async function sendGuard(key: string, record: EvidenceRecord): Promise<boolean> {
  if ((await isStopped(key)) || (await stopIntentPending(key, record.session_id))) return false;
  try {
    // No frozen generation = no proof of privacy continuity, whatever the wire protocol or funding claim: suspended.
    if (!hasScopeEvidence(record)) {
      await writeStop(key, 'scope_unproven', record.session_id);
      return false;
    }
    const prefs = await readClaudeAnalyticsPreferences();
    if (prefs.kind !== 'ok') return false;
    if (prefs.value.collectionGeneration !== record.collection_generation) {
      await writeStop(key, 'generation_changed', record.session_id);
      return false;
    }
    // A consented session whose project cannot travel as a raw header must never fall back to personal storage by omission.
    if (record.consent_ref && rawProjectHeader(record.project ?? '') === undefined) {
      await writeStop(key, 'consent_project_unsupported', record.session_id);
      return false;
    }
    if (record.consent_ref && !(await consentHolds(record.consent_ref, scopeOf(record)))) {
      await writeStop(key, 'consent_revoked', record.session_id);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

const scopeOf = (r: EvidenceRecord) => ({ owner_hash: r.owner_hash, api_identity: r.api_identity, project: r.project ?? '' });

/**
 * Evidence headers (spec item 6; backend `EVIDENCE_HEADERS`), from the record's frozen values and
 * the classification. Organization only if known; Project and Project-Source only with a project;
 * Repo-Remote carries the credential-free repo key, never a raw remote. Values that are not valid
 * Latin-1 header values are omitted rather than sent mangled.
 */
export function evidenceHeaders(sessionId: string, ctx: EvidenceContext): Record<string, string> {
  const { record, result } = ctx;
  const built = buildAttributionHeaders({
    destination: 'analytics',
    sessionId,
    routedViaCodemie: record.routed_via_codemie,
    subscriptionType: result.class,
    routingUnproven: result.basis === 'routing_unproven',
    organization: record.organization,
    policyVersion: result.policy_version,
    repoKey: record.repo_key,
    project: record.project,
    projectSource: record.project_source,
    contract: ctx.newContract && record.funding_route ? { fundingRoute: record.funding_route, consent: ctx.consent } : undefined,
  });
  for (const name of built.omitted) logger.debug(`[otlp-evidence] ${name} omitted: not_latin1_header_value`);
  return built.headers;
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
  if (!(await sendGuard(key, found.record))) return null;
  const ns: NamespaceId = { ...id, ...(profile ? { profile } : {}) };
  let state: PolicyState | undefined;
  let result = decided;
  if (!result) {
    state = await sessionPolicyState(ns, baseUrl, credentials, undefined, undefined, found.record.funding_route !== undefined);
    const cls = await classifySession(key, found.record, state);
    if (cls.action !== 'send') return null;
    result = cls.result;
  }
  const wireMode = found.record.funding_route === undefined ? 'evidence'
    : await publicationMode(key, found.record, state ?? await getPolicyState(ns, { needContract: true }), result);
  if (!wireMode) return null;
  const newContract = wireMode === 'contract';
  return { key, record: found.record, ns, baseUrl, credentials, result, newContract, wireMode, consent: newContract && !!found.record.consent_ref };
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
  if (ctx.record.funding_route !== undefined &&
    !(await publicationMode(ctx.key, ctx.record, state, cls.result))) return false;
  ctx.result = cls.result;
  return true;
}
