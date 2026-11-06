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

/**
 * Why a recorded session must stop for content seen under `facts`, or undefined when it still holds.
 * One rule for the live transition gate and the owner-pending replay. A record from before the new contract is legacy: unchanged.
 */
export async function scopeViolation(record: EvidenceRecord, facts: ScopeFacts): Promise<StopReason | undefined> {
  if (record.funding_route === undefined) return undefined;
  if (facts.generation !== (record.collection_generation ?? 0)) return 'generation_changed';
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
