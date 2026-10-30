import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { isSafeSessionId } from '../../../../../../agents/core/session-id.js';
import { logger } from '../../../../../../utils/logger.js';
import { sanitizeLogArgs } from '../../../../../../utils/security.js';
import { getCopilotSessionStateRoot } from '../../../../../../agents/plugins/copilot-cli/copilot-cli.paths.js';
import type { CopilotEvent } from '../../../../../../agents/plugins/copilot-cli/copilot-cli-event-types.js';
import { buildDeferredUsageEvents } from '../../../../../../agents/plugins/copilot-cli-otlp/copilot-cli-otlp.usage.js';
import { readTranscriptFrom } from '../../../../../../agents/plugins/copilot-cli-otlp/copilot-cli-otlp.transcript.js';
import { deleteSessionStateFiles, readSessionState } from '../../../../../../agents/plugins/copilot-cli-otlp/copilot-cli-otlp.state.js';
import { appendSpool } from './spool-io.js';
import { listHookRecords } from './copilot-usage-spool.js';

/**
 * Deferred usage for Copilot CLI sessions (native and managed), owned by the persistent proxy daemon.
 *
 * Copilot writes `session.shutdown` (the only record with the final per-model totals) only AFTER the
 * `sessionEnd` hook process has exited, so the hook cannot read it. The daemon outlives the
 * Copilot CLI, so when a session's `agent.session.end` is accepted it schedules one short,
 * bounded read of the session's `events.jsonl` and appends the resulting events to the
 * same hooks spool, where the normal tick forwards them.
 *
 * The pass is stateless and idempotent: it rebuilds every usage row and the final summary from the
 * whole transcript. Rows carry the same stable `event_id` the `agentStop` hooks used, and the
 * backend dedups on `(type, session_id, event_id)`.
 */

export const COPILOT_CLI_OTLP_AGENT = 'copilot-cli-otlp';
export const SESSION_END_TYPE = 'agent.session.end';
export const POLL_INTERVAL_MS = 150;
export const MAX_WAIT_MS = 10_000;

const SUMMARY_TYPE = 'agent.session.summary';

/** In-flight or completed enrichments keyed by session + sessionEnd timestamp (a resumed session ends again). */
const scheduled = new Set<string>();

export function resetScheduledForTests(): void {
  scheduled.clear();
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Session-state root: the hook's recorded override when it passes validation, else the default.
 * Valid means a `session-state` directory under the user's home whose `<id>/events.jsonl`
 * resolves inside it and is a regular file.
 */
function resolveStateRoot(sessionId: string): string {
  const recorded = readSessionState(sessionId).sessionStateRoot;
  if (!recorded) return getCopilotSessionStateRoot();
  try {
    const root = realpathSync(recorded);
    if (root.split(/[\\/]/).pop() !== 'session-state' || !isInside(realpathSync(homedir()), root)) {
      return getCopilotSessionStateRoot();
    }
    const file = realpathSync(join(root, sessionId, 'events.jsonl'));
    return isInside(root, file) && statSync(file).isFile() ? root : getCopilotSessionStateRoot();
  } catch {
    return getCopilotSessionStateRoot();
  }
}

function readEvents(sessionId: string): { events: CopilotEvent[]; truncated: boolean } {
  const read = readTranscriptFrom(join(resolveStateRoot(sessionId), sessionId, 'events.jsonl'));
  return { events: read?.events ?? [], truncated: read?.truncated ?? false };
}

/** True if the hooks spool already holds the final summary for this shutdown (survives a daemon restart). */
async function alreadyEnriched(sessionId: string, endedAt: string): Promise<boolean> {
  const records = await listHookRecords(sessionId);
  return records.some((r) => r['type'] === SUMMARY_TYPE && r['is_final'] === true && r['ended_at'] === endedAt);
}

/**
 * One enrichment attempt: polls until `session.shutdown` (written after `notBeforeMs`) appears or
 * the bound passes, then appends every usage row and the final summary. Never throws.
 */
export async function enrichSessionUsage(
  template: Record<string, unknown>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => number = Date.now
): Promise<'enriched' | 'timeout' | 'duplicate' | 'error'> {
  const sessionId = String(template['session_id'] ?? '');
  const notBeforeMs = Date.parse(String(template['timestamp'] ?? ''));
  const deadline = now() + MAX_WAIT_MS;

  if (!isSafeSessionId(sessionId)) {
    logger.warn('[otlp-ingest] copilot usage enrichment skipped: unsafe session id');
    return 'error';
  }

  try {
    for (;;) {
      const { events, truncated } = readEvents(sessionId);
      const shutdown = events.filter((e) => e.type === 'session.shutdown').pop();
      const shutdownMs = shutdown?.timestamp ? Date.parse(shutdown.timestamp) : NaN;
      // A resumed session can hold an older shutdown: only one after this sessionEnd counts.
      if (shutdown && Number.isFinite(shutdownMs) && (!Number.isFinite(notBeforeMs) || shutdownMs >= notBeforeMs)) {
        const endedAt = shutdown.timestamp as string;
        if (await alreadyEnriched(sessionId, endedAt)) {
          return 'duplicate';
        }
        const start = events.find((e) => e.type === 'session.start')?.data as { copilotVersion?: string } | undefined;
        const wire = buildDeferredUsageEvents(template, events, start?.copilotVersion ?? '', truncated);
        await appendSpool(sessionId, 'hooks', wire
          .map((hookEvent) => JSON.stringify({ agentName: COPILOT_CLI_OTLP_AGENT, hookEvent: JSON.stringify(hookEvent) }))
          .join('\n') + '\n');
        deleteSessionStateFiles(sessionId);
        return 'enriched';
      }
      if (now() >= deadline) {
        return 'timeout';
      }
      await sleep(POLL_INTERVAL_MS);
    }
  } catch (err) {
    logger.warn('[otlp-ingest] copilot usage enrichment error', ...sanitizeLogArgs({ sessionId, err: err instanceof Error ? err.message : String(err) }));
    return 'error';
  }
}


/** Fire-and-forget scheduling for the events of one accepted hook batch. */
export function scheduleCopilotUsageEnrichment(agentName: string, events: Record<string, unknown>[]): void {
  if (agentName !== COPILOT_CLI_OTLP_AGENT) return;
  for (const event of events) {
    if (typeof event !== 'object' || event === null) continue;
    if (event['type'] !== SESSION_END_TYPE) continue;
    const sessionId = String(event['session_id'] ?? '');
    if (!isSafeSessionId(sessionId)) continue;
    const key = `${sessionId}|${String(event['timestamp'] ?? '')}`;
    if (scheduled.has(key)) continue;
    scheduled.add(key);
    void enrichSessionUsage(event)
      .then((outcome) => {
        // Only a finished enrichment is final; anything else may be retried by a later sessionEnd batch.
        if (outcome !== 'enriched' && outcome !== 'duplicate') scheduled.delete(key);
        logger.debug('[otlp-ingest] copilot usage enrichment', ...sanitizeLogArgs({ sessionId, outcome }));
      })
      .catch(() => scheduled.delete(key));
  }
}
