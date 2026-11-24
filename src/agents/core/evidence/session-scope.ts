import { consentHolds } from './consent-store.js';
import type { EvidenceRecord } from './record-store.js';
import type { StopReason } from './stop-marker.js';

/** Hook-time facts a recorded new-contract session is re-checked against (live in a hook, captured in an owner-pending entry). */
export interface ScopeFacts {
  /** The hook's own folder; needed to prove a consent still covers it. */
  cwd?: string;
  /** The project the folder resolves to now, ignoring the session pin. */
  projectAtCwd: string;
  generation: number;
}

/** Same canonical form as the consent store and the backend (trim, case-insensitive). */
const canon = (p: string): string => p.trim().toLowerCase();

/** A frozen collection generation is the evidence that the session's scope was recorded; the funding claim is a separate wire fact. */
export const hasScopeEvidence = (record: EvidenceRecord): boolean => record.collection_generation !== undefined;

/**
 * Why a recorded session must stop for content seen under `facts`, or undefined when it still holds.
 * One rule for the live transition gate, the post-stamp check, the owner-pending replay, the tick and the forwarder.
 * A record without a frozen generation cannot prove privacy continuity (collection toggle, folder, consent): it suspends;
 * nothing is invented for it and it is never upgraded.
 */
export async function scopeViolation(record: EvidenceRecord, facts: ScopeFacts): Promise<StopReason | undefined> {
  if (!hasScopeEvidence(record)) return 'scope_unproven';
  if (facts.generation !== record.collection_generation) return 'generation_changed';
  if (canon(facts.projectAtCwd) !== canon(record.project ?? '')) return 'folder_changed';
  if (record.consent_ref) {
    const scope = { owner_hash: record.owner_hash, api_identity: record.api_identity, project: record.project ?? '' };
    if (!facts.cwd) return 'folder_changed'; // coverage of the folder cannot be shown
    if (!(await consentHolds(record.consent_ref, scope, facts.cwd))) {
      return (await consentHolds(record.consent_ref, scope)) ? 'folder_changed' : 'consent_revoked';
    }
  }
  return undefined;
}
