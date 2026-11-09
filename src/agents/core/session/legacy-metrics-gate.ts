import { logger } from '@/utils/logger.js';
import { ProviderName } from '@/providers/core/types.js';
import type { Session } from './types.js';

/*
 * EPMCDME-17054: the legacy `POST /v1/metrics` path of an `anthropic-subscription` session publishes only while
 * the work consent frozen at SessionStart still holds for the folder and the new pipeline has not held or
 * discarded the session. Every legacy sender asks `legacyMetricsVerdict` at send time. Fail closed throughout.
 */

export type LegacyMetricsSkip = 'no-work-consent' | 'consent-revoked' | 'destination-held';
export const LEGACY_GATE_SKIPS: readonly LegacyMetricsSkip[] = ['no-work-consent', 'consent-revoked', 'destination-held'];

export type LegacyMetricsVerdict = { publish: true } | { publish: false; reason: LegacyMetricsSkip };

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

/** Whether the new pipeline holds or discarded the session (a stop/notice marker, spool holds, a discard or a stop intent). */
async function destinationHeld(consent: NonNullable<Session['legacyMetricsConsent']>, nativeId: string | undefined): Promise<boolean> {
  if (!nativeId || nativeId === 'unknown') return false;
  const { recordKey } = await import('@/agents/core/evidence/record-store.js');
  const { hasMarker } = await import('@/agents/core/evidence/stop-marker.js');
  if (await hasMarker(recordKey(consent.apiIdentity, consent.ownerHash, nativeId))) return true;
  const { readStatus } = await import('@/providers/plugins/sso/proxy/plugins/otlp-spool/session-status.js');
  const status = await readStatus(nativeId);
  if (!status) return false;
  return Object.keys(status.holds ?? {}).length > 0 || status.lastDiscard !== undefined || status.stopIntent !== undefined;
}

/** Send time. Never throws; any doubt => skip. */
export async function legacyMetricsVerdict(session: GateInput): Promise<LegacyMetricsVerdict> {
  if (!isLegacyGatedProvider(session.provider)) return { publish: true };
  const consent = session.legacyMetricsConsent;
  if (!consent) return { publish: false, reason: 'no-work-consent' };
  try {
    const { consentHolds } = await import('@/agents/core/evidence/consent-store.js');
    const scope = { owner_hash: consent.ownerHash, api_identity: consent.apiIdentity, project: session.project ?? '' };
    if (!(await consentHolds(consent.ref, scope, session.workingDirectory))) return { publish: false, reason: 'consent-revoked' };
    if (await destinationHeld(consent, session.correlation?.agentSessionId)) return { publish: false, reason: 'destination-held' };
    return { publish: true };
  } catch (error) {
    logger.debug('[legacy-metrics-gate] Verdict could not be established: destination-held', error instanceof Error ? error.name : 'unknown');
    return { publish: false, reason: 'destination-held' };
  }
}
