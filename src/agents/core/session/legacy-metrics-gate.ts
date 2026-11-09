import { logger } from '@/utils/logger.js';
import { ProviderName } from '@/providers/core/types.js';
import { isSafeSessionId } from '@/agents/core/session-id.js';
import type { Session } from './types.js';

/*
 * EPMCDME-17054: the legacy `POST /v1/metrics` path of an `anthropic-subscription` session publishes only while
 * the work consent frozen at SessionStart still holds for the folder and the new pipeline has not held or
 * discarded the session. Every legacy sender asks `legacyMetricsVerdict` at send time. Fail closed throughout.
 *
 * A final skip (LEGACY_GATE_SKIPS) is persisted as `endMetricSkipped` and the session's deltas count as delivered.
 * A transient verdict sends nothing and persists nothing, so delivery retries once the hold clears:
 * - `destination-pending`: a recoverable hold (a notice-only marker, a non-empty spool `holds` entry);
 * - `verdict-unavailable`: the verdict could not be established (an error, an unreadable marker, or a native
 *   session id unsafe as a path segment, which is never used to build a spool or marker path).
 */

export type LegacyMetricsSkip = 'no-work-consent' | 'consent-revoked' | 'destination-held';
export const LEGACY_GATE_SKIPS: readonly LegacyMetricsSkip[] = ['no-work-consent', 'consent-revoked', 'destination-held'];

export type LegacyMetricsPending = 'destination-pending' | 'verdict-unavailable';

export type LegacyMetricsVerdict =
  | { publish: true }
  | { publish: false; reason: LegacyMetricsSkip }
  | { publish: false; reason: LegacyMetricsPending; transient: true };

/** Whether an `endMetricSkipped` value is a gate skip (the session counts as delivered). */
export function isLegacyGateSkip(reason: string | undefined): boolean {
  return reason !== undefined && (LEGACY_GATE_SKIPS as readonly string[]).includes(reason);
}

export function isLegacyGatedProvider(provider: string | undefined): boolean {
  return provider === ProviderName.ANTHROPIC_SUBSCRIPTION;
}

/** SessionStart: undefined unless gated provider + identity + resolveConsent(...) all succeed. Never throws. */
export async function freezeLegacyMetricsConsent(
  provider: string | undefined,
  project: string | undefined,
  cwd: string
): Promise<Session['legacyMetricsConsent']> {
  if (!isLegacyGatedProvider(provider) || !project?.trim()) return undefined;
  try {
    const { currentEvidenceIdentity } = await import('@/agents/core/evidence/hook-identity.js');
    const identity = await currentEvidenceIdentity();
    if (!identity) return undefined;
    const { resolveConsent } = await import('@/agents/core/evidence/consent-store.js');
    const ref = await resolveConsent({ ...identity, project }, cwd);
    return ref ? { ref, apiIdentity: identity.api_identity, ownerHash: identity.owner_hash } : undefined;
  } catch (error) {
    logger.debug('[legacy-metrics-gate] Consent could not be resolved at start: no-work-consent', error instanceof Error ? error.name : 'unknown');
    return undefined;
  }
}

type GateInput = Pick<Session, 'provider' | 'project' | 'workingDirectory' | 'legacyMetricsConsent'> & {
  correlation?: { agentSessionId?: string };
};

type DestinationState = 'clear' | 'held' | LegacyMetricsPending;

/** Whether the new pipeline stopped or discarded the session for good (`held`) or holds it for now (pending). */
async function destinationState(consent: NonNullable<Session['legacyMetricsConsent']>, nativeId: string | undefined): Promise<DestinationState> {
  if (!nativeId || nativeId === 'unknown') return 'clear';
  if (!isSafeSessionId(nativeId)) return 'verdict-unavailable';
  const { recordKey } = await import('@/agents/core/evidence/record-store.js');
  const { markerState } = await import('@/agents/core/evidence/stop-marker.js');
  const marker = await markerState(recordKey(consent.apiIdentity, consent.ownerHash, nativeId));
  if (marker === 'stop') return 'held';
  if (marker === 'unknown') return 'verdict-unavailable';
  const { readStatus } = await import('@/providers/plugins/sso/proxy/plugins/otlp-spool/session-status.js');
  const status = await readStatus(nativeId);
  if (status?.lastDiscard !== undefined || status?.stopIntent !== undefined) return 'held';
  if (marker === 'notice' || Object.keys(status?.holds ?? {}).length > 0) return 'destination-pending';
  return 'clear';
}

/** Send time. Never throws; any doubt => withhold, transiently unless the outcome is final. */
export async function legacyMetricsVerdict(session: GateInput): Promise<LegacyMetricsVerdict> {
  if (!isLegacyGatedProvider(session.provider)) return { publish: true };
  const consent = session.legacyMetricsConsent;
  if (!consent) return { publish: false, reason: 'no-work-consent' };
  try {
    const { consentHolds } = await import('@/agents/core/evidence/consent-store.js');
    const scope = { owner_hash: consent.ownerHash, api_identity: consent.apiIdentity, project: session.project ?? '' };
    if (!(await consentHolds(consent.ref, scope, session.workingDirectory))) return { publish: false, reason: 'consent-revoked' };
    const state = await destinationState(consent, session.correlation?.agentSessionId);
    if (state === 'clear') return { publish: true };
    if (state === 'held') return { publish: false, reason: 'destination-held' };
    return { publish: false, reason: state, transient: true };
  } catch (error) {
    logger.debug('[legacy-metrics-gate] Verdict could not be established: verdict-unavailable', error instanceof Error ? error.name : 'unknown');
    return { publish: false, reason: 'verdict-unavailable', transient: true };
  }
}
