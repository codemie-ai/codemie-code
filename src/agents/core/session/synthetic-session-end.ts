/**
 * The SessionEnd a record never got, built from the record and its located transcript.
 */
import { existsSync } from 'fs';
import type { SessionEndEvent } from '@/cli/commands/hook.js';
import type { Session } from './types.js';
import { logger } from '@/utils/logger.js';
import { recordNoTranscript, recordTranscriptCorrelation } from './no-transcript-correlation.js';

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
 * `flush` decides only what the event carries: without it the event names no transcript and nothing of the
 * transcript is sent. A copilot-cli record is located with or without the flush, since a resumed run names its transcript
 * only at its own SessionEnd; a transcript located without the flush is stored on the record, as the
 * SessionEnd of an event naming it would. Other agents without the flush locate nothing. A copilot-cli
 * record is uncorrelated when its named transcript is gone, or it names none and none is located, as its
 * own SessionEnd leaves it: the stored correlation and the end name the CodeMie record.
 * The caller holds the record's reconcile lock.
 */
export async function syntheticSessionEnd(record: Session, options: { flush: boolean }): Promise<SessionEndEvent> {
  const named = record.correlation?.agentSessionFile;
  const isCopilot = record.agentName === 'copilot-cli';
  const found = named ? [named] : options.flush || isCopilot ? await locateTranscript(record) : [];
  const onDisk = found.filter((path) => existsSync(path));
  const uncorrelated = onDisk.length === 0 && isCopilot;
  if (uncorrelated) await recordNoTranscript(record.sessionId);
  if (!options.flush && !named && onDisk.length > 0 && !(await recordTranscriptCorrelation(record.sessionId, onDisk[0]))) {
    logger.warn(`[reconcile] ${record.sessionId}: located transcript not stored on the record`);
  }
  const transcripts = options.flush ? onDisk : [];
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
