import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { acquirePidLock } from '@/utils/pid-lock.js';
import { writeJsonFileAtomic } from '@/utils/atomic-write.js';
import { atomicReplace, evidenceDir, publish, stopAckFileName, stopFileName } from './record-store.js';

export { stopFileName };

/*
 * Publication-stop marker: a tiny sidecar keyed by recordKey(), outside the evictable evidence record.
 * Once it exists the session never publishes again (hook, tick and forwarder all check isStopped);
 * reconnect never deletes it, only sweepRecords does, once no record and no queued data remain.
 * It holds a bounded reason code (never project/path text) and a notice-pending flag.
 */

export const STOP_REASONS = [
  'collection_disabled', 'folder_changed', 'consent_revoked', 'consent_missing', 'work_consent_required', 'resume_unknown',
  'generation_changed', 'scope_excluded', 'response_unverified', 'contract_unsupported',
  'hold_expired', 'hold_contract_unavailable', 'hold_state_unknown', 'hold_personal_unsupported', 'hold_project_unavailable', 'hold_destination_unsupported', 'consent_invalid', 'consent_project_unsupported', 'scope_unproven', 'requires_session', 'unspecified',
] as const;
export type StopReason = (typeof STOP_REASONS)[number];

interface MarkerFile {
  schema: 1;
  reason: StopReason;
  session_id: string;
  at: number;
  /** false = notice only (a hold that can still recover); true = publication is stopped for good. */
  stop: boolean;
}

/** Which marker version (its `at` and reason) the user was already told about; written only by takeNotice. */
interface AckFile { at: number; reason: string }

const pathOf = (key: string): string => join(evidenceDir(), stopFileName(key));
const ackPathOf = (key: string): string => join(evidenceDir(), stopAckFileName(key));
const bounded = (r: string): StopReason => ((STOP_REASONS as readonly string[]).includes(r) ? (r as StopReason) : 'unspecified');

async function create(key: string, reason: StopReason, sessionId: string, stop: boolean): Promise<void> {
  const marker: MarkerFile = { schema: 1, reason: bounded(reason), session_id: sessionId.slice(0, 200), at: Date.now(), stop };
  await mkdir(evidenceDir(), { recursive: true, mode: 0o700 });
  // Temp file + hard link: the marker is never observable half-written, so a concurrent stop always sees a whole one.
  if ((await publish(pathOf(key), JSON.stringify(marker), { strict: true })) === 'won' || !stop) return;
  await upgradeToStop(key, marker);
}

/** Short wait: hooks run inside a tight budget; the ack file is tiny so contention is brief. */
const LOCK_BUDGET_MS = 3_000;
const lockOf = (key: string): string => `${pathOf(key)}.lock`;
/** Serializes notice -> stop upgrades only; separate from the acknowledgement lock so a stalled acknowledgement never blocks a stop. */
const upgradeLockOf = (key: string): string => `${pathOf(key)}.upgrade.lock`;

/**
 * Notice -> stop upgrade. The marker file is written only here (and create-once above); takeNotice records the
 * acknowledgement in a separate file, so no stale or stalled acknowledgement can ever write the marker back to
 * stop=false, lock or no lock. The upgraded marker has a new `at`, so its reason notice is pending again.
 */
async function upgradeToStop(key: string, marker: MarkerFile): Promise<void> {
  // Decide and replace under the lock, on a fresh read: two overlapping upgrades (or a stale read) can never overwrite an
  // accepted stop, so the first stop's reason stays. Only a notice-only (or unreadable, e.g. emptied by an older build) marker is replaced.
  const lock = await acquirePidLock(upgradeLockOf(key), { mode: 'wait', budgetMs: LOCK_BUDGET_MS, pidOnlyLiveness: true }).catch(() => null);
  if (!lock) throw new Error('stop marker busy'); // a stop that cannot be recorded is reported, never dropped
  try {
    let existing: Partial<MarkerFile> | undefined;
    try { existing = JSON.parse(await readFile(pathOf(key), 'utf-8')) as Partial<MarkerFile>; } catch { /* unreadable */ }
    // Its bounded Windows rename retry handles readers briefly holding the old marker open.
    if (!existing || existing.stop === false) await writeJsonFileAtomic(pathOf(key), marker);
  } finally {
    await lock.release();
  }
}

/** Create-once: a later stop never changes the first reason or re-arms an already shown notice. Throws when it cannot be written. */
export function writeStop(key: string, reason: StopReason, sessionId: string): Promise<void> {
  return create(key, reason, sessionId, true);
}

/** A first-hold notice that does not stop publication (the hold may recover). Create-once; never downgrades a stop. */
export function writeNotice(key: string, reason: StopReason, sessionId: string): Promise<void> {
  return create(key, reason, sessionId, false);
}

/** Fail closed: any marker file, however unreadable, and any read error other than "absent" means stopped. */
export async function isStopped(key: string): Promise<boolean> {
  try {
    const m = JSON.parse(await readFile(pathOf(key), 'utf-8')) as Partial<MarkerFile>;
    return m.stop !== false;
  } catch (err) {
    if (err instanceof SyntaxError) return true; // corrupt marker
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

export type MarkerState = 'absent' | 'notice' | 'stop' | 'unknown';

/**
 * Which marker exists: none, a notice (recoverable), a stop (final), or `unknown` when the file could not be read
 * for now (an I/O error). A corrupt marker is a stop, as `isStopped` reads it.
 */
export async function markerState(key: string): Promise<MarkerState> {
  try {
    const m = JSON.parse(await readFile(pathOf(key), 'utf-8')) as Partial<MarkerFile>;
    return m.stop === false ? 'notice' : 'stop';
  } catch (err) {
    if (err instanceof SyntaxError) return 'stop'; // corrupt marker
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unknown';
  }
}

/** The pending notice reason, once: marks it shown before returning. Undefined when none, already shown or unreadable. */
export async function takeNotice(key: string): Promise<StopReason | undefined> {
  // Only the ack file is written (never the marker), under the lock so two hooks do not both show it.
  // Lock unavailable = notice stays pending for a later hook.
  const lock = await acquirePidLock(lockOf(key), { mode: 'wait', budgetMs: LOCK_BUDGET_MS, pidOnlyLiveness: true }).catch(() => null);
  if (!lock) return undefined;
  try {
    const m = JSON.parse(await readFile(pathOf(key), 'utf-8')) as Partial<MarkerFile>;
    if (m.schema !== 1 || typeof m.reason !== 'string' || typeof m.at !== 'number') return undefined;
    let ack: Partial<AckFile> = {};
    try { ack = JSON.parse(await readFile(ackPathOf(key), 'utf-8')) as Partial<AckFile>; } catch { /* none yet */ }
    if (ack.at === m.at && ack.reason === m.reason) return undefined;
    await atomicReplace(ackPathOf(key), JSON.stringify({ at: m.at, reason: m.reason } satisfies AckFile));
    return bounded(m.reason);
  } catch {
    return undefined;
  } finally {
    await lock.release();
  }
}
