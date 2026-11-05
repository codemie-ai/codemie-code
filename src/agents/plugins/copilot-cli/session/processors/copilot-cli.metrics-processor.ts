/**
 * Metrics processor for Copilot CLI sessions.
 *
 * Extraction happens in `parseSessionFile` (one pass over `events.jsonl`). This processor
 * writes the result as `MetricDelta` rows through `MetricsWriter`, the same contract Claude's
 * metrics processor uses, so the analytics aggregator reads Copilot like any tracked agent.
 *
 * One delta per real assistant turn (a session with none writes none; the aggregator keeps
 * it when the correlated transcript carries cost). Writing is append-only and idempotent:
 * turn deltas have deterministic ids, and tool/file/skill activity is written as the
 * difference between the transcript totals and what earlier runs already wrote, so a retry
 * neither duplicates nor drops activity. A write that finds the live metrics file already renamed to
 * `completed_<id>_metrics.jsonl` is dropped, never appended to the completed file.
 */

import type {
  SessionProcessor,
  ProcessingContext,
  ProcessingResult,
} from '../../../../core/session/BaseProcessor.js';
import { latestRecordTime, type ParsedSession } from '../../../../core/session/BaseSessionAdapter.js';
import type { MetricDelta } from '../../../../core/metrics/types.js';
import { resolveRunWindow } from '../../../../core/session/run-window.js';
import type { RunWindow } from '../../../../../providers/plugins/sso/session/processors/metrics/MetricsWriter.js';
import { inRun } from '../../copilot-cli.usage.js';
import { logger } from '../../../../../utils/logger.js';

interface TurnRecord {
  type?: string;
  timestamp?: string;
  gitBranch?: string;
  message?: { model?: string };
}

export class CopilotCliMetricsProcessor implements SessionProcessor {
  readonly name = 'copilot-cli-metrics';
  readonly priority = 10;

  shouldProcess(session: ParsedSession): boolean {
    return session.metrics !== undefined;
  }

  async process(session: ParsedSession, context: ProcessingContext): Promise<ProcessingResult> {
    try {
      const { MetricsWriter } = await import(
        '../../../../../providers/plugins/sso/session/processors/metrics/MetricsWriter.js'
      );
      const writer = new MetricsWriter(session.sessionId);
      const window = session.runWindow ?? (await resolveRunWindow(session.sessionId, context));
      const existing = await writer.readAll();
      const deltas = runDeltas(session, context, window, existing);

      let deltasWritten = 0;
      if (deltas.length > 0) {
        const appended = await writer.appendDeltas(deltas, window);
        if (appended.gone) {
          logger.warn(`[${this.name}] Metrics file of session ${session.sessionId} is gone (completed); ${deltas.length} deltas not written`);
          return { success: false, message: `Metrics file of session ${session.sessionId} is gone; deltas not written` };
        }
        deltasWritten = appended.written;
      }

      logger.debug(`[${this.name}] Wrote ${deltasWritten} of ${deltas.length} deltas for ${session.sessionId}`);
      return { success: true, metadata: { recordsProcessed: deltasWritten, deltasWritten } };
    } catch (error) {
      logger.error(`[${this.name}] Processing failed:`, error);
      return { success: false, message: error instanceof Error ? error.message : 'Unknown error' };
    }
  }
}

type DeltaRow = Omit<MetricDelta, 'syncStatus' | 'syncAttempts'>;

/**
 * The deltas of this pass: one per new assistant turn inside the run's window (an untimed turn lies only in
 * the whole-session window and is stamped with the run's last transcript record), the run's activity riding
 * the first of them.
 */
function runDeltas(session: ParsedSession, context: ProcessingContext, window: RunWindow, existing: MetricDelta[]): DeltaRow[] {
  const written = new Set(existing.map((d) => d.recordId));
  const turns = (session.messages as TurnRecord[]).filter((m) => m.type === 'assistant');
  const agentSessionId = context.agentSessionId ?? session.sessionId;
  const fallbackBranch = context.gitBranch ?? (session.metadata?.gitBranch as string | undefined);
  const openingPrompt = session.metrics?.userPrompts?.[0];
  const lastRecordAt = latestRecordTime(session.recordTimes, window.upperBound);

  // Activity not yet on disk: transcript totals minus what earlier runs wrote.
  const pending = subtractWritten(session, existing);

  const runTurns = turns
    .map((turn, i) => ({ turn, recordId: `${agentSessionId}-turn-${i}` }))
    .filter(({ turn, recordId }) => !written.has(recordId) && inRun(turn, window));

  const build = (recordId: string, timestamp: string | number, branch: string | undefined, model: string | undefined, carry: boolean): DeltaRow => ({
    recordId,
    sessionId: session.sessionId,
    agentSessionId,
    timestamp,
    gitBranch: branch ?? fallbackBranch,
    tools: carry ? pending.tools : {},
    ...(carry && {
      ...(Object.keys(pending.toolStatus).length > 0 && { toolStatus: pending.toolStatus }),
      ...(pending.fileOperations.length > 0 && { fileOperations: pending.fileOperations }),
      ...(Object.keys(pending.skillInvocations).length > 0 && { skillInvocations: pending.skillInvocations }),
    }),
    ...(model && { models: [model] }),
    ...(carry && existing.length === 0 && openingPrompt && { userPrompts: [openingPrompt] }),
  });

  const deltas = runTurns.map(({ turn, recordId }, i) =>
    build(recordId, turn.timestamp ?? lastRecordAt ?? Date.now(), turn.gitBranch, turn.message?.model, i === 0)
  );

  // Activity with no turn of this run to ride on (it arrived after every turn was written) is kept
  // as a clearly-identified supplement delta, stamped inside the run window: the run's last transcript
  // record, else the window's start, so the writer never drops it as another run's.
  if (runTurns.length === 0 && hasActivity(pending)) {
    const inWindowAt = lastRecordAt !== undefined && lastRecordAt >= window.startTime ? lastRecordAt : undefined;
    const stamp = inWindowAt ?? (Number.isFinite(window.startTime) ? window.startTime : Date.now());
    deltas.push(build(`${agentSessionId}-supplement-${existing.length}`, stamp, undefined, undefined, true));
  }
  return deltas;
}

interface PendingActivity {
  tools: Record<string, number>;
  toolStatus: Record<string, { success: number; failure: number }>;
  fileOperations: NonNullable<MetricDelta['fileOperations']>;
  skillInvocations: Record<string, number>;
}

function hasActivity(p: PendingActivity): boolean {
  return (
    Object.keys(p.tools).length > 0 ||
    Object.keys(p.toolStatus).length > 0 ||
    p.fileOperations.length > 0 ||
    Object.keys(p.skillInvocations).length > 0
  );
}

function subtractCounts(total: Record<string, number> | undefined, done: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, n] of Object.entries(total ?? {})) {
    const rest = n - (done[name] ?? 0);
    if (rest > 0) out[name] = rest;
  }
  return out;
}

function subtractWritten(session: ParsedSession, existing: MetricDelta[]): PendingActivity {
  const toolsDone: Record<string, number> = {};
  const skillsDone: Record<string, number> = {};
  const statusDone: Record<string, { success: number; failure: number }> = {};
  let fileOpsDone = 0;
  for (const d of existing) {
    for (const [k, n] of Object.entries(d.tools ?? {})) toolsDone[k] = (toolsDone[k] ?? 0) + n;
    for (const [k, n] of Object.entries(d.skillInvocations ?? {})) skillsDone[k] = (skillsDone[k] ?? 0) + n;
    for (const [k, v] of Object.entries(d.toolStatus ?? {})) {
      const b = statusDone[k] ?? { success: 0, failure: 0 };
      b.success += v.success;
      b.failure += v.failure;
      statusDone[k] = b;
    }
    fileOpsDone += d.fileOperations?.length ?? 0;
  }

  const toolStatus: PendingActivity['toolStatus'] = {};
  for (const [k, v] of Object.entries(session.metrics?.toolStatus ?? {})) {
    const done = statusDone[k] ?? { success: 0, failure: 0 };
    const rest = { success: Math.max(0, v.success - done.success), failure: Math.max(0, v.failure - done.failure) };
    if (rest.success > 0 || rest.failure > 0) toolStatus[k] = rest;
  }

  return {
    tools: subtractCounts(session.metrics?.tools, toolsDone),
    toolStatus,
    fileOperations: ((session.metrics?.fileOperations ?? []) as NonNullable<MetricDelta['fileOperations']>).slice(fileOpsDone),
    skillInvocations: subtractCounts(session.metrics?.skillInvocations, skillsDone),
  };
}
