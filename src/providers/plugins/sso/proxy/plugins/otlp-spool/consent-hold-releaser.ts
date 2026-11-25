import { attachConsentRef, readRecord } from '@/agents/core/evidence/record-store.js';
import { lookupConsent } from '@/agents/core/evidence/consent-store.js';
import type { HoldReleaser, HoldReleaseVerdict } from './hold-release.js';

/*
 * `work_consent_required`: the record froze no consent at the first stamp, and the tick re-decides the hold every
 * pass. Attaching the consent that covers the session now (looked up for its stored folder, as the stamp would have)
 * is the whole release; the tick and forwarder then send it under every guard of a consented session.
 */

const kept = (detail: 'no_consent' | 'not_eligible'): HoldReleaseVerdict => ({ outcome: 'kept', detail });

export const consentHoldReleaser: HoldReleaser = {
  reason: 'work_consent_required',
  async release({ key, identity }) {
    const found = await readRecord(key);
    if (!found) return kept('not_eligible'); // no record under this account: another login's session, or swept
    if (found.kind !== 'existing') return { outcome: 'unavailable' };
    const { record } = found;
    if (record.funding_route === undefined || !record.project) return kept('not_eligible');
    if (record.consent_ref) return { outcome: 'released' }; // attached by an earlier run; the next pass sends it
    // No stored folder (recorded by an older build): only the all-folders consent can cover it.
    const consent = await lookupConsent({ ...identity, project: record.project }, record.session_folder);
    if (consent.kind === 'unknown') return { outcome: 'unavailable' };
    if (consent.kind === 'none') return kept('no_consent');
    const attached = await attachConsentRef(key, consent.ref);
    if (attached === 'attached' || attached === 'already_consented') return { outcome: 'released' };
    return attached === 'not_eligible' ? kept('not_eligible') : { outcome: 'unavailable' };
  },
};
