/**
 * The SessionEnd a record never got, built from the record and its located transcript.
 */
import { existsSync } from 'fs';
import type { SessionEndEvent } from '@/cli/commands/hook.js';
import type { Session } from './types.js';
import { logger } from '@/utils/logger.js';
import { assertSessionStateListable, recordNoTranscript, recordTranscriptCorrelation, transcriptExists } from './no-transcript-correlation.js';

async function locateTranscript(record: Session): Promise<string[]> {
  const { AgentRegistry } = await import('../../registry.js');
  const adapter = AgentRegistry.getAgent(record.agentName)?.getSessionAdapter?.();
  return (await adapter?.locateTranscript?.(record)) ?? [];
}

function endEvent(record: Session, transcripts: string[], agentSessionId: string | undefined): SessionEndEvent {
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

/** Without the flush nothing is located; a lookup that fails counts as finding nothing. */
async function otherAgentEnd(record: Session, flush: boolean): Promise<SessionEndEvent> {
  const named = record.correlation?.agentSessionFile;
  let found: string[] = named ? [named] : [];
  if (!named && flush) {
    try {
      found = await locateTranscript(record);
    } catch (error) {
      logger.debug(`[reconcile] Transcript lookup failed for ${record.sessionId}:`, error);
    }
  }
  const onDisk = found.filter((path) => existsSync(path));
  return endEvent(record, flush ? onDisk : [], record.correlation?.agentSessionId);
}

/** See {@link syntheticSessionEnd}. */
async function copilotEnd(record: Session, flush: boolean): Promise<SessionEndEvent> {
  const named = record.correlation?.agentSessionFile;
  let onDisk: string[];
  try {
    assertSessionStateListable(record);
    const found = named ? [named] : await locateTranscript(record);
    onDisk = found.filter((path) => transcriptExists(path));
  } catch (error) {
    if (flush) throw error;
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn(`[reconcile] ${record.sessionId}: transcript lookup could not conclude; correlation left as it is: ${msg}`);
    return endEvent(record, [], record.correlation?.agentSessionId);
  }
  if (onDisk.length === 0) {
    await recordNoTranscript(record.sessionId);
    return endEvent(record, [], record.sessionId);
  }
  if (!flush && !named && !(await recordTranscriptCorrelation(record.sessionId, onDisk[0]))) {
    logger.warn(`[reconcile] ${record.sessionId}: located transcript not stored on the record`);
  }
  return endEvent(record, flush ? onDisk : [], record.correlation?.agentSessionId);
}

/**
 * The SessionEnd a record never got: `interrupted`, or for a copilot-cli record the reason its run stored on it
 * on exit, ending at its last recorded activity,
 * `session_id` = the agent's own id, over the record's transcript (located when it names none).
 * `flush` decides only what the event carries: without it the event names no transcript and nothing of the
 * transcript is sent. A copilot-cli record is located with or without the flush, since a resumed run names its transcript
 * only at its own SessionEnd; a transcript located without the flush is stored on the record, as the
 * SessionEnd of an event naming it would. Other agents without the flush locate nothing, and with it a
 * failed lookup finds nothing. A copilot-cli record is uncorrelated when its named transcript is gone, or
 * it names none and none is located, as its own SessionEnd leaves it: the stored correlation and the end
 * name the CodeMie record. When its stored home's `session-state` cannot be listed, or its lookup or the
 * check of its named transcript could not conclude, the correlation stays: with the flush this throws, nothing written, for a later attempt to repeat; without
 * it the event names no transcript and goes under the record's current agent session id.
 * The caller holds the record's reconcile lock.
 */
export async function syntheticSessionEnd(record: Session, options: { flush: boolean }): Promise<SessionEndEvent> {
  if (record.agentName !== 'copilot-cli') return otherAgentEnd(record, options.flush);
  return { ...(await copilotEnd(record, options.flush)), reason: record.reason ?? 'interrupted' };
}
