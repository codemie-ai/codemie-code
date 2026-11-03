/**
 * The SessionEnd a record never got, built from the record and its located transcript.
 */
import { existsSync } from 'fs';
import type { SessionEndEvent } from '@/cli/commands/hook.js';
import type { Session } from './types.js';
import { logger } from '@/utils/logger.js';
import { recordNoTranscript } from './no-transcript-correlation.js';

async function locateTranscript(record: Session): Promise<string[]> {
  try {
    const { AgentRegistry } = await import('../../registry.js');
    const adapter = AgentRegistry.getAgent(record.agentName)?.getSessionAdapter?.();
    return (await adapter?.locateTranscript?.(record)) ?? [];
  } catch (error) {
    logger.debug(`[reconcile] Transcript lookup failed for ${record.sessionId}:`, error);
    return [];
  }
}

/**
 * The SessionEnd a record never got: `interrupted`, ending at its last recorded activity,
 * `session_id` = the agent's own id, over the record's transcript (located when it names none).
 * `flush: false`, or a transcript that is gone → no transcript: the end comes from the record alone.
 * A copilot-cli record is uncorrelated only when its named transcript is not on disk and, with the
 * flush, none is located, as its own SessionEnd leaves it: the stored correlation and the end name
 * the CodeMie record. Without the flush a record whose named transcript exists keeps its correlation.
 * The caller holds the record's reconcile lock.
 */
export async function syntheticSessionEnd(record: Session, options: { flush: boolean }): Promise<SessionEndEvent> {
  const named = record.correlation?.agentSessionFile;
  const located = options.flush ? (named ? [named] : await locateTranscript(record)) : [];
  const transcripts = located.filter((path) => existsSync(path));
  const namedExists = named !== undefined && existsSync(named);
  const uncorrelated = transcripts.length === 0 && !namedExists && record.agentName === 'copilot-cli';
  if (uncorrelated) await recordNoTranscript(record.sessionId);
  const agentSessionId = uncorrelated ? record.sessionId : record.correlation?.agentSessionId;
  return {
    hook_event_name: 'SessionEnd',
    session_id: agentSessionId && agentSessionId !== 'unknown' ? agentSessionId : record.sessionId,
    transcript_path: transcripts[0] ?? '',
    ...(transcripts.length > 1 && { transcript_paths: transcripts }),
    permission_mode: 'default',
    cwd: record.workingDirectory,
    reason: 'interrupted',
    endTimeFromActivity: true,
  };
}
