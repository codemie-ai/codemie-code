import { readFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicReplace, evidenceDir, verdictFileName } from '@/agents/core/evidence/record-store.js';
import type { ClassResult } from '@/agents/core/evidence/classify.js';
import type { Capability } from './policy-cache.js';
import { logger } from '@/utils/logger.js';

/*
 * Per-session sticky verdict (I5): `<key>.verdict.json`, same key as the evidence record. Retention is
 * handled by record-store's sweepRecords, which removes the verdict together with its record and
 * never while the key is pending.
 */

export interface Verdict {
  schema: 1;
  class: ClassResult['class'];
  policy_version?: string;
  created: number;
}

const path = (key: string) => join(evidenceDir(), verdictFileName(key));
const determinate = (r: ClassResult) => r.status === 'determinate';

export type VerdictState = { state: 'none' } | { state: 'ok'; verdict: Verdict } | { state: 'unreadable' };

/** Missing (ENOENT) is distinct from corrupt / unreadable: the latter may hide a sticky Personal. */
export async function readVerdictState(key: string): Promise<VerdictState> {
  let raw: string;
  try {
    raw = await readFile(path(key), 'utf-8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'none' } : { state: 'unreadable' };
  }
  try {
    const v = JSON.parse(raw) as Verdict;
    if (v?.schema !== 1 || !['codemie', 'corporate', 'personal', 'unknown'].includes(v.class)) return { state: 'unreadable' };
    return { state: 'ok', verdict: v };
  } catch {
    return { state: 'unreadable' };
  }
}

export async function readVerdict(key: string): Promise<Verdict | null> {
  const s = await readVerdictState(key);
  return s.state === 'ok' ? s.verdict : null;
}

async function write(key: string, r: ClassResult): Promise<void> {
  await mkdir(evidenceDir(), { recursive: true, mode: 0o700 });
  const v: Verdict = { schema: 1, class: r.class, ...(r.policy_version ? { policy_version: r.policy_version } : {}), created: Date.now() };
  await atomicReplace(path(key), JSON.stringify(v));
}

/** Persist sticky Personal on the FIRST determinate personal result only; never overwritten by later results. */
export async function recordVerdict(key: string, r: ClassResult): Promise<Verdict | null> {
  try {
    const existing = await readVerdict(key);
    if (existing) return existing;
    if (r.class !== 'personal' || !determinate(r)) return null;
    await write(key, r);
    return readVerdict(key);
  } catch (err) {
    logger.debug(`[verdict-store] record failed: ${(err as NodeJS.ErrnoException).code ?? 'error'}`);
    return null;
  }
}

/**
 * Spec item 5: "a fresh usable policy may replace it". Only a determinate result computed from a fresh
 * usable policy (caller attests via `freshPolicy`, and the result must carry its policy_version) replaces
 * a stored verdict. Returns true if replaced.
 */
export async function replaceVerdict(key: string, r: ClassResult, freshPolicy: boolean): Promise<boolean> {
  if (!freshPolicy || !determinate(r) || !r.policy_version) return false;
  try {
    if (!(await readVerdict(key))) return false;
    await write(key, r);
    return true;
  } catch {
    return false;
  }
}

/** No usable policy: what may be sent for this session (I5, AC16). */
export function forwardDecisionWithoutPolicy(
  a: { verdict: Pick<Verdict, 'class'> | null; capability: Capability },
): 'full_evidence' | 'hold_personal_not_forwardable' | 'legacy_ok' {
  if (a.verdict?.class === 'personal') {
    return a.capability === 'evidence' ? 'full_evidence' : 'hold_personal_not_forwardable';
  }
  return a.capability === 'legacy' ? 'legacy_ok' : 'full_evidence';
}
