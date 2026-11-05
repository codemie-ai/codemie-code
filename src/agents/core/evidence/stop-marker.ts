import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicReplace, evidenceDir, stopFileName } from './record-store.js';

export { stopFileName };

/*
 * Publication-stop marker: a tiny sidecar keyed by recordKey(), outside the evictable evidence record.
 * Once it exists the session never publishes again (hook, tick and forwarder all check isStopped);
 * reconnect never deletes it, only sweepRecords does, once no record and no queued data remain.
 * It holds a bounded reason code (never project/path text) and a notice-pending flag.
 */

export const STOP_REASONS = [
  'collection_disabled', 'folder_changed', 'consent_revoked', 'consent_missing', 'resume_unknown',
  'generation_changed', 'scope_excluded', 'response_unverified', 'contract_unsupported',
  'hold_expired', 'hold_contract_unavailable', 'consent_invalid', 'requires_session', 'unspecified',
] as const;
export type StopReason = (typeof STOP_REASONS)[number];

interface MarkerFile {
  schema: 1;
  reason: StopReason;
  session_id: string;
  at: number;
  noticed: boolean;
  /** false = notice only (a hold that can still recover); true = publication is stopped for good. */
  stop: boolean;
}

const pathOf = (key: string): string => join(evidenceDir(), stopFileName(key));
const bounded = (r: string): StopReason => ((STOP_REASONS as readonly string[]).includes(r) ? (r as StopReason) : 'unspecified');

async function create(key: string, reason: StopReason, sessionId: string, stop: boolean): Promise<void> {
  const marker: MarkerFile = { schema: 1, reason: bounded(reason), session_id: sessionId.slice(0, 200), at: Date.now(), noticed: false, stop };
  await mkdir(evidenceDir(), { recursive: true, mode: 0o700 });
  try {
    await writeFile(pathOf(key), JSON.stringify(marker), { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    // Only a notice-only marker may be upgraded to a stop (a hold that expired); a stop is never relaxed or re-reasoned.
    if (stop) {
      let existing: Partial<MarkerFile> | undefined;
      try { existing = JSON.parse(await readFile(pathOf(key), 'utf-8')) as Partial<MarkerFile>; } catch { return; }
      if (existing.stop === false) await atomicReplace(pathOf(key), JSON.stringify(marker));
    }
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

/** The pending notice reason, once: marks it shown before returning. Undefined when none, already shown or unreadable. */
export async function takeNotice(key: string): Promise<StopReason | undefined> {
  try {
    const m = JSON.parse(await readFile(pathOf(key), 'utf-8')) as Partial<MarkerFile>;
    if (m.schema !== 1 || m.noticed !== false || typeof m.reason !== 'string') return undefined;
    await atomicReplace(pathOf(key), JSON.stringify({ ...m, noticed: true }));
    return bounded(m.reason);
  } catch {
    return undefined;
  }
}
