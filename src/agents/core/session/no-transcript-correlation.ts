/**
 * The correlation of a run with no native transcript.
 */
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
