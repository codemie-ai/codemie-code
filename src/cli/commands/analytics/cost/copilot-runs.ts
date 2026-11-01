/**
 * Report-time windows of Copilot runs: Copilot keeps one native session for every run that resumed
 * it, so each run's tokens are read from its own slice of that shared log.
 */

import type { EnricherDeps, ParsedEntry } from './cost-enricher.js';

/** Whether a session is a Copilot run, parsed over its own window of the shared native session. */
export const isCopilotRun = (agentName: string): boolean => agentName.toLowerCase() === 'copilot-cli';

/** The reason a Copilot run with no start time on its record stays unpriced. */
export const NO_RUN_START_REASON =
  'No start time on the CodeMie record of this Copilot run — its window of the shared session is unknown';

/** The copilot runs still to parse and each run's upper window bound, keyed by session id. */
export interface CopilotRunWindows {
  runs: ParsedEntry[];
  bounds: Map<string, number | undefined>;
}

/**
 * Phase 1b: the copilot runs whose native log is read over their own window — a run's start → the next
 * record's start over the same log — so a resumed run's tokens are priced into that run, never into the
 * session it resumed. The next record is a loaded sibling, else one on disk the report filtered out, so
 * the window does not depend on the report's filter.
 */
export async function copilotRunWindows(ordered: ParsedEntry[], nextSiblingStart: Map<string, number>, deps: EnricherDeps): Promise<CopilotRunWindows> {
  const runs = ordered.filter((entry) => entry.filePath && !entry.parsed && isCopilotRun(entry.agentName));
  const started = runs.filter((entry) => entry.startTime).map((entry) => entry.sessionId);
  const diskBounds = started.length > 0 ? await deps.nextRecordStarts?.(started) : undefined;
  const bounds = new Map(runs.map((entry) => [entry.sessionId, earliest(nextSiblingStart.get(entry.sessionId), diskBounds?.get(entry.sessionId))]));
  return { runs, bounds };
}

/** The earlier of two optional bounds; either absent → the other. */
function earliest(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined ? b : b === undefined ? a : Math.min(a, b);
}

/** One copilot run parsed over its window; a run with no start time has no window and stays unparsed. */
export async function parseCopilotRun(entry: ParsedEntry, bounds: Map<string, number | undefined>, deps: EnricherDeps): Promise<void> {
  if (!entry.startTime) {
    entry.unavailableReason = NO_RUN_START_REASON;
    return;
  }
  const run = { startTime: entry.startTime, upperBound: bounds.get(entry.sessionId) };
  entry.parsed = await deps.parseNative(entry.agentName, entry.filePath as string, entry.sessionId, run);
}
