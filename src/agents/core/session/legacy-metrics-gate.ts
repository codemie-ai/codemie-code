import { logger } from '@/utils/logger.js';
import { ProviderName } from '@/providers/core/types.js';
import { isSafeSessionId } from '@/agents/core/session-id.js';
import type { Session } from './types.js';

/*
 * EPMCDME-17054: the legacy `POST /v1/metrics` path of an `anthropic-subscription` session publishes only while
 * the work consent frozen at SessionStart still holds for the folder and the new pipeline has not held or
 * discarded the session. Every legacy sender asks `legacyMetricsVerdict` at send time. Fail closed throughout:
 * nothing is published unless every check passes.
 *
 * A final skip (LEGACY_GATE_SKIPS) is persisted as `legacyMetricsWithheld` by whichever sender meets it first (the
 * end metric also as `endMetricSkipped`); the session's deltas then count as delivered. A transient verdict sends
 * nothing and persists nothing, so delivery retries once it clears:
 * - `destination-pending`: a live hold of the new pipeline (a spool `holds` entry, or a stream whose delivery the
 *   backend holds, e.g. `project_unavailable`; acknowledgement clears it);
 * - `verdict-unavailable`: the verdict could not be established for now (an unreadable consent store, marker or
 *   spool status, or any other error).
 * A condition that can never clear is final: a missing or unsafe native session id (`session-unverifiable`; an
 * unsafe one is never used to build a spool or marker path).
 */

export type LegacyMetricsSkip = 'no-work-consent' | 'consent-revoked' | 'destination-held' | 'session-unverifiable';
export const LEGACY_GATE_SKIPS: readonly LegacyMetricsSkip[] = ['no-work-consent', 'consent-revoked', 'destination-held', 'session-unverifiable'];

export type LegacyMetricsPending = 'destination-pending' | 'verdict-unavailable';

export type LegacyMetricsVerdict =
  | { publish: true }
  | { publish: false; reason: LegacyMetricsSkip }
  | { publish: false; reason: LegacyMetricsPending; transient: true };

/** Whether an `endMetricSkipped` value is a gate skip (the session counts as delivered). */
export function isLegacyGateSkip(reason: string | undefined): boolean {
  return reason !== undefined && (LEGACY_GATE_SKIPS as readonly string[]).includes(reason);
}

/** Whether a final gate verdict withholds this record's metric deltas for good (they count as delivered). */
export function legacyMetricsWithheld(record: Pick<Session, 'endMetricSkipped' | 'legacyMetricsWithheld'>): boolean {
  return isLegacyGateSkip(record.legacyMetricsWithheld) || isLegacyGateSkip(record.endMetricSkipped);
}

export function isLegacyGatedProvider(provider: string | undefined): boolean {
  return provider === ProviderName.ANTHROPIC_SUBSCRIPTION;
}

type FrozenConsent = Pick<Session, 'legacyMetricsConsent' | 'legacyMetricsConsentUnresolved'>;

/**
 * SessionStart: the consent entry for a gated provider with a project, signed in. When the store cannot be read,
 * `legacyMetricsConsentUnresolved` keeps the identity of this moment, so it is not mistaken for "no entry" and the
 * send-time lookup runs under the start's owner and backend. No identity (signed out) is no consent, as the new
 * pipeline treats it. Never throws.
 */
export async function freezeLegacyMetricsConsent(
  provider: string | undefined,
  project: string | undefined,
  cwd: string
): Promise<FrozenConsent> {
  if (!isLegacyGatedProvider(provider) || !project?.trim()) return {};
  try {
    const { currentEvidenceIdentity } = await import('@/agents/core/evidence/hook-identity.js');
    const identity = await currentEvidenceIdentity();
    if (!identity) return {};
    const { lookupConsent } = await import('@/agents/core/evidence/consent-store.js');
    const found = await lookupConsent({ ...identity, project }, cwd);
    if (found.kind === 'unknown') {
      return { legacyMetricsConsentUnresolved: { apiIdentity: identity.api_identity, ownerHash: identity.owner_hash } };
    }
    if (found.kind === 'none') return {};
    return { legacyMetricsConsent: { ref: found.ref, apiIdentity: identity.api_identity, ownerHash: identity.owner_hash } };
  } catch (error) {
    // Both lookups never throw: only a failed module load lands here, with no identity to look up under later
    logger.debug('[legacy-metrics-gate] Consent could not be resolved at start: no-work-consent', error instanceof Error ? error.name : 'unknown');
    return {};
  }
}

type GateInput = Pick<Session, 'provider' | 'project' | 'workingDirectory' | 'legacyMetricsConsent'> &
  Partial<Pick<Session, 'legacyMetricsConsentUnresolved' | 'legacyMetricsWithheld' | 'startTime'>> & {
    correlation?: { agentSessionId?: string };
  };

type DestinationState = 'clear' | 'held' | 'unverifiable' | LegacyMetricsPending;

/** Whether the new pipeline stopped or discarded the session for good (`held`) or holds it for now (pending). */
async function destinationState(consent: NonNullable<Session['legacyMetricsConsent']>, nativeId: string | undefined): Promise<DestinationState> {
  if (!nativeId || nativeId === 'unknown' || !isSafeSessionId(nativeId)) return 'unverifiable';
  const { recordKey } = await import('@/agents/core/evidence/record-store.js');
  const { markerState } = await import('@/agents/core/evidence/stop-marker.js');
  // A notice marker is create-once and outlives the hold it announced: the live hold is read from the spool status
  const marker = await markerState(recordKey(consent.apiIdentity, consent.ownerHash, nativeId));
  if (marker === 'stop') return 'held';
  if (marker === 'unknown') return 'verdict-unavailable';
  const { endsSessionDiscard, readStatusState } = await import('@/providers/plugins/sso/proxy/plugins/otlp-spool/session-status.js');
  const read = await readStatusState(nativeId);
  if (read.kind === 'unreadable') return 'verdict-unavailable';
  if (read.kind === 'absent') return 'clear';
  const { status } = read;
  // `lastDiscard` too: a status written before `endingDiscard` existed
  const ended = status.endingDiscard ?? (status.lastDiscard && endsSessionDiscard(status.lastDiscard) ? status.lastDiscard : undefined);
  if (status.stopIntent !== undefined || ended) return 'held';
  const backendHold = Object.values(status.delivery ?? {}).some((failure) => failure?.reason === 'destination_hold');
  if (backendHold || Object.keys(status.holds ?? {}).length > 0) return 'destination-pending';
  return 'clear';
}

/**
 * The consent to check: the frozen one, else (start could not read the store) the entry looked up now under the
 * start's identity. An entry connected after the session started does not count: consent is never granted
 * retroactively. An entry from an older build carries no connect time and counts as connected before the start.
 */
async function consentToCheck(session: GateInput): Promise<NonNullable<Session['legacyMetricsConsent']> | LegacyMetricsVerdict> {
  if (session.legacyMetricsConsent) return session.legacyMetricsConsent;
  const identity = session.legacyMetricsConsentUnresolved;
  if (!identity || !session.project?.trim()) return { publish: false, reason: 'no-work-consent' };
  const { lookupConsent } = await import('@/agents/core/evidence/consent-store.js');
  const found = await lookupConsent(
    { owner_hash: identity.ownerHash, api_identity: identity.apiIdentity, project: session.project },
    session.workingDirectory
  );
  if (found.kind === 'unknown') return { publish: false, reason: 'verdict-unavailable', transient: true };
  if (found.kind === 'none') return { publish: false, reason: 'no-work-consent' };
  if (found.connectedAt !== undefined && (session.startTime === undefined || found.connectedAt > session.startTime)) {
    return { publish: false, reason: 'no-work-consent' };
  }
  return { ref: found.ref, apiIdentity: identity.apiIdentity, ownerHash: identity.ownerHash };
}

/** Send time. Never throws; any doubt => withhold, transiently unless the outcome is final. */
export async function legacyMetricsVerdict(session: GateInput): Promise<LegacyMetricsVerdict> {
  if (!isLegacyGatedProvider(session.provider)) return { publish: true };
  if (isLegacyGateSkip(session.legacyMetricsWithheld)) {
    return { publish: false, reason: session.legacyMetricsWithheld as LegacyMetricsSkip };
  }
  try {
    const consent = await consentToCheck(session);
    if ('publish' in consent) return consent;
    const { consentStatus } = await import('@/agents/core/evidence/consent-store.js');
    const scope = { owner_hash: consent.ownerHash, api_identity: consent.apiIdentity, project: session.project ?? '' };
    const held = await consentStatus(consent.ref, scope, session.workingDirectory);
    if (held === 'revoked') return { publish: false, reason: 'consent-revoked' };
    if (held === 'unknown') return { publish: false, reason: 'verdict-unavailable', transient: true };
    const state = await destinationState(consent, session.correlation?.agentSessionId);
    if (state === 'clear') return { publish: true };
    if (state === 'held') return { publish: false, reason: 'destination-held' };
    if (state === 'unverifiable') return { publish: false, reason: 'session-unverifiable' };
    return { publish: false, reason: state, transient: true };
  } catch (error) {
    logger.debug('[legacy-metrics-gate] Verdict could not be established: verdict-unavailable', error instanceof Error ? error.name : 'unknown');
    return { publish: false, reason: 'verdict-unavailable', transient: true };
  }
}

/** Persist a final verdict on the record (best effort), so every sender and the delivered checks honour it. */
export async function persistLegacyMetricsWithheld(sessionId: string, reason: LegacyMetricsSkip): Promise<void> {
  try {
    const { SessionStore } = await import('./SessionStore.js');
    const store = new SessionStore();
    const latest = await store.loadSession(sessionId);
    if (latest && latest.legacyMetricsWithheld === undefined) await store.saveSession({ ...latest, legacyMetricsWithheld: reason });
  } catch (error) {
    logger.debug('[legacy-metrics-gate] Final verdict could not be persisted', error instanceof Error ? error.name : 'unknown');
  }
}
