import { join, resolve, sep } from 'node:path';
import { getCopilotHome, getCopilotSessionStateRoot } from '@/agents/plugins/copilot-cli/copilot-cli.paths.js';
import { logger } from '@/utils/logger.js';
import { readTranscriptFrom } from './copilot-cli-otlp.transcript.js';
import { readSessionState, updateSessionState, type UsageCursor } from './copilot-cli-otlp.state.js';
import {
  addCounters,
  buildSessionSummaryEvent,
  EMPTY_COUNTERS,
  mergeDetails,
  summarizeSlice,
  type SummaryDetails,
} from './copilot-cli-otlp.usage.js';

export interface StopPass {
  /** Usage rows and the incremental summary, ready for the base class's `buildEvent`. */
  events: Record<string, unknown>[];
  /** Persists the cursor; call only once the spool accepted `events`. */
  commit: () => Promise<void>;
}

const EMPTY_DETAILS: SummaryDetails = { tools: {}, filesWritten: [], filesEdited: [], linesAdded: null, linesRemoved: null };

/** `transcriptPath` is honoured only under the Copilot home; otherwise the session-state path is used. */
export function resolveTranscriptPath(sessionId: string, transcriptPath?: string): string {
  if (transcriptPath) {
    const home = resolve(getCopilotHome());
    const candidate = resolve(transcriptPath);
    if (candidate.startsWith(home + sep)) return candidate;
  }
  return join(getCopilotSessionStateRoot(), sessionId, 'events.jsonl');
}

/**
 * The `agentStop` pass (Claude's `Stop`): usage rows for records after the cursor plus an
 * incremental summary. A fresh state (first stop of this process, also after a resume) reads the
 * whole transcript once. Returns null when there is nothing readable; the next stop or the
 * daemon's final pass catches up.
 */
export function buildStopPass(sessionId: string, transcriptPath?: string): StopPass | null {
  const cursor = readSessionState(sessionId).usageCursor;
  const read = readTranscriptFrom(resolveTranscriptPath(sessionId, transcriptPath), cursor?.offset ?? 0);
  if (!read) return null;
  if (read.events.length === 0 && !cursor) return null;

  const slice = summarizeSlice(sessionId, read.events, cursor ? 'incremental' : 'full');
  const counters = addCounters(cursor?.counters ?? EMPTY_COUNTERS, slice.counters);
  const details = mergeDetails(cursor?.details ?? EMPTY_DETAILS, slice.details);

  const startEvent = read.events.find((e) => e.type === 'session.start');
  const startData = startEvent?.data as { startTime?: string } | undefined;
  const startedAt = cursor?.startedAt || startData?.startTime || read.events[0]?.timestamp || '';
  const lastEventTs = read.events[read.events.length - 1]?.timestamp ?? cursor?.lastEventTs ?? '';

  const summary = buildSessionSummaryEvent({
    sessionId,
    phase: 'incremental',
    counters,
    details,
    startedAt,
    endedAt: lastEventTs,
    usagePartial: slice.partial || read.truncated,
  });
  if (read.truncated) logger.debug('[copilot-cli-otlp] transcript above 8 MB, reading tail only');

  const next: UsageCursor = { offset: read.nextOffset, lastEventTs, startedAt, counters, details };
  return {
    events: [...slice.rows, summary],
    commit: async () => {
      await updateSessionState(sessionId, { usageCursor: next });
    },
  };
}
