/**
 * Single-field updates a hook makes on a live CodeMie session record: the transcript a SessionEnd
 * located, the id the start metric went out under.
 */
import type { SessionStore } from '@/agents/core/session/SessionStore.js';
import type { Session } from '@/agents/core/session/types.js';

/**
 * Store the transcript a SessionEnd names on a record that has none, before the flush: a run killed
 * before its plugin's own session end never wrote the path, and pricing and the next-record bound
 * read it from the record. A record that already carries a path keeps it.
 */
export async function recordLocatedTranscript(
  store: SessionStore,
  record: Session,
  transcriptPath: string | undefined
): Promise<void> {
  if (!transcriptPath || record.correlation?.agentSessionFile) return;
  // A shared sqlite store (opencode.db) holds every run's sessions, so it is no record's own transcript
  if (transcriptPath.endsWith('.db')) return;
  record.correlation = { ...record.correlation, status: 'matched', agentSessionFile: transcriptPath };
  await store.saveSession(record);
}

/**
 * Store the `session_id` the server accepted the start metric under on the live record: reloaded
 * right before the save, only that field changed. A completed record is a previous generation
 * the start could not replace, never this run's.
 *
 * ponytail: a save by another process between this load and this save is overwritten
 */
export async function recordStartMetricSessionId(sessionId: string, startMetricSessionId: string): Promise<void> {
  const { SessionStore } = await import('../../../agents/core/session/SessionStore.js');
  const store = new SessionStore();
  const latest = await store.loadSession(sessionId);
  if (latest?.status === 'active') await store.saveSession({ ...latest, startMetricSessionId });
}
