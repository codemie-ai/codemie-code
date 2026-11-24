import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { evidenceDir, publicationModeFileName, publish, type EvidenceRecord } from '@/agents/core/evidence/record-store.js';
import type { ClassResult } from '@/agents/core/evidence/classify.js';
import { advertisesContract, type PolicyState } from './policy-cache.js';

export type PublicationMode = 'contract' | 'evidence' | 'legacy';

async function readMode(path: string): Promise<PublicationMode | null | undefined> {
  try {
    const mode: unknown = JSON.parse(await readFile(path, 'utf8'));
    return mode === 'contract' || mode === 'evidence' || mode === 'legacy' ? mode : null;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : null;
  }
}

/** Select once, before sending. Never upgrade a legacy binding or downgrade an existing contract binding. */
export async function publicationMode(
  key: string, record: EvidenceRecord, state: PolicyState, result: ClassResult
): Promise<PublicationMode | null> {
  if (record.funding_route === undefined) return 'evidence'; // original sessions retain their existing path
  const safeFallback = !record.consent_ref && record.routing_proof === 'proven' && result.status === 'determinate' &&
    (result.class === 'codemie' || result.class === 'corporate');
  const available = (mode: PublicationMode): boolean => mode === 'contract'
    ? advertisesContract(state)
    : safeFallback && (mode === 'legacy' ? state.capability === 'legacy' || !!state.policy : state.capability === 'evidence' && !!state.policy);
  // Records from the earlier implementation may already have published contract headers. Never reinterpret them.
  if (!record.negotiate_publication) return available('contract') ? 'contract' : null;
  const path = join(evidenceDir(), publicationModeFileName(key));
  let mode = await readMode(path);
  if (mode === undefined) {
    mode = state.policy && advertisesContract(state) ? 'contract'
      : safeFallback && state.capability === 'legacy' ? 'legacy'
        : safeFallback && state.policy && state.capability === 'evidence' ? 'evidence' : null;
    if (!mode) return null;
    try {
      await mkdir(evidenceDir(), { recursive: true, mode: 0o700 });
      await publish(path, JSON.stringify(mode), { strict: true }); // atomic create-once; no link support = no mode (fail closed)
    } catch {
      return null;
    }
    // A concurrent winner is authoritative. Partial/corrupt files fail closed, without repair or fallback.
    mode = await readMode(path);
  }
  return mode && available(mode) ? mode : null;
}
