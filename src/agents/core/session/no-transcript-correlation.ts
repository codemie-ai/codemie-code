/**
 * The correlation of a CodeMie record with its run's native transcript, or with none when the run has no
 * native transcript.
 */
import { logger } from '@/utils/logger.js';
import { SessionStore } from './SessionStore.js';

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
