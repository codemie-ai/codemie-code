/**
 * The correlation of a CodeMie record with its run's native transcript, or with none when the run has no
 * native transcript.
 */
import { accessSync, constants, readdirSync } from 'fs';
import { join } from 'path';
import { logger } from '@/utils/logger.js';
import { SessionStore } from './SessionStore.js';
import type { Session } from './types.js';

/**
 * `read()`, undefined when what it reads does not exist. Only `ENOENT` / `ENOTDIR` say so: any other
 * error (`EACCES`, `EIO`) leaves the answer unknown and is thrown.
 */
export function unlessAbsent<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  }
}

/**
 * Whether the transcript exists, for a caller about to read it: true means it exists and read permission
 * is granted, not that a read will succeed; false that it is absent. One that is there without read
 * permission, or that cannot be checked, throws: checked before the read, the failure reaches the lookup
 * rather than surfacing later.
 */
export function transcriptExists(path: string): boolean {
  return (
    unlessAbsent(() => {
      accessSync(path, constants.R_OK);
      return true;
    }) === true
  );
}

/**
 * Throws unless `<agentHome>/session-state` of a record with a stored `agentHome` can be listed; a record
 * without one is not checked. The launch creates the home but not `session-state`, and an unmounted
 * volume's mount point is an empty directory, so a missing root says nothing of the transcript. The cost:
 * a run that died before Copilot wrote anything spends its attempts and closes with its correlation untouched.
 */
export function assertSessionStateListable(record: Pick<Session, 'agentHome'>): void {
  if (record.agentHome) readdirSync(join(record.agentHome, 'session-state'));
}

/**
 * A run with no native transcript is not correlated: nothing of it is read, and the correlation names
 * the CodeMie record instead of a native session that does not exist.
 */
export async function recordNoTranscript(sessionId: string): Promise<void> {
  const store = new SessionStore();
  const record = await store.loadSession(sessionId);
  if (!record) return;
  const { agentSessionFile: _none, ...correlation } = record.correlation;
  record.correlation = { ...correlation, agentSessionId: record.sessionId, status: 'failed' };
  await store.saveSession(record);
}

/**
 * Point the CodeMie session record at the transcript this run produced.
 *
 * @returns true when the record now names `transcriptPath`; false when there is no record yet,
 *   the record keeps another transcript, or the save failed
 */
export async function recordTranscriptCorrelation(sessionId: string, transcriptPath: string): Promise<boolean> {
  try {
    const store = new SessionStore();
    const session = await store.loadSession(sessionId);
    if (!session) {
      logger.debug(`[session] No session record for ${sessionId}; skipping transcript correlation`);
      return false;
    }
    const existing = session.correlation?.agentSessionFile;
    if (existing && existing !== transcriptPath) {
      logger.warn(`[session] Session ${sessionId} is already correlated to another transcript; keeping it`);
      return false;
    }
    session.correlation = {
      ...session.correlation,
      status: 'matched',
      agentSessionFile: transcriptPath,
    };
    await store.saveSession(session);
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.debug(`[session] Failed to record transcript correlation (non-blocking): ${msg}`);
    return false;
  }
}
