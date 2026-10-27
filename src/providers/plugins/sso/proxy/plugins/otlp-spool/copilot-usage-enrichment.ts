import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../../../../../../utils/logger.js';
import { sanitizeLogArgs } from '../../../../../../utils/security.js';
import { getCopilotSessionStateRoot } from '../../../../../../agents/plugins/copilot-cli/copilot-cli.paths.js';
import { extractCopilotUsage } from '../../../../../../agents/plugins/copilot-cli/copilot-cli.usage.js';
import type { CopilotEvent } from '../../../../../../agents/plugins/copilot-cli/copilot-cli-event-types.js';
import { buildDeferredUsageEvents } from '../../../../../../agents/plugins/copilot-cli-otlp/copilot-cli-otlp.usage.js';
import { appendSpool } from './spool-io.js';
import { listHookRecords } from './copilot-usage-spool.js';

/**
 * Deferred usage for native Copilot CLI sessions, owned by the persistent proxy daemon.
 *
 * Copilot writes `session.shutdown` (the only record with token usage) only AFTER the
 * `sessionEnd` hook process has exited, so the hook cannot read it. The daemon outlives the
 * Copilot CLI, so when a session's `agent.session.end` is accepted it schedules one short,
 * bounded read of the session's `events.jsonl` and appends the resulting usage events to the
 * same hooks spool, where the normal tick forwards them.
 */

export const COPILOT_CLI_OTLP_AGENT = 'copilot-cli-otlp';
export const SESSION_END_TYPE = 'agent.session.end';
export const POLL_INTERVAL_MS = 150;
export const MAX_WAIT_MS = 10_000;

const USAGE_TYPE = 'agent.usage.request';

/** Sessions already scheduled by this daemon process: duplicate session-end batches add nothing. */
const scheduled = new Set<string>();

export function resetScheduledForTests(): void {
  scheduled.clear();
}

async function readEvents(sessionId: string): Promise<CopilotEvent[]> {
  const path = join(getCopilotSessionStateRoot(), sessionId, 'events.jsonl');
  let text: string;
  try {
    text = await readFile(path, 'utf-8');
  } catch {
    return [];
  }
  const events: CopilotEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as CopilotEvent);
    } catch {
      // A line still being written: the next poll sees it whole.
    }
  }
  return events;
}

/** True if the hooks spool already holds usage for this session (survives a daemon restart). */
async function alreadyEnriched(sessionId: string): Promise<boolean> {
  const records = await listHookRecords(sessionId);
  return records.some((r) => r['type'] === USAGE_TYPE);
}

/**
 * One enrichment attempt: polls until `session.shutdown` (written after `notBeforeMs`) appears or
 * the bound passes, then appends the usage events. Never throws.
 */
export async function enrichSessionUsage(
  template: Record<string, unknown>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => number = Date.now
): Promise<'enriched' | 'timeout' | 'no-usage' | 'duplicate'> {
  const sessionId = String(template['session_id'] ?? '');
  const notBeforeMs = Date.parse(String(template['timestamp'] ?? ''));
  const deadline = now() + MAX_WAIT_MS;

  try {
    if (await alreadyEnriched(sessionId)) {
      return 'duplicate';
    }
    for (;;) {
      const events = await readEvents(sessionId);
      const shutdown = events.filter((e) => e.type === 'session.shutdown').pop();
      const shutdownMs = shutdown?.timestamp ? Date.parse(shutdown.timestamp) : NaN;
      // A resumed session can hold an older shutdown: only one after this sessionEnd counts.
      if (shutdown && Number.isFinite(shutdownMs) && (!Number.isFinite(notBeforeMs) || shutdownMs >= notBeforeMs)) {
        const usage = extractCopilotUsage(events);
        if (usage.messages.length === 0) {
          return 'no-usage';
        }
        const start = events.find((e) => e.type === 'session.start')?.data as { startTime?: string } | undefined;
        const endedAt = new Date(shutdownMs).toISOString();
        const wire = buildDeferredUsageEvents(template, usage.messages, start?.startTime ?? endedAt, endedAt);
        await appendSpool(sessionId, 'hooks', wire
          .map((hookEvent) => JSON.stringify({ agentName: COPILOT_CLI_OTLP_AGENT, hookEvent: JSON.stringify(hookEvent) }))
          .join('\n') + '\n');
        return 'enriched';
      }
      if (now() >= deadline) {
        return 'timeout';
      }
      await sleep(POLL_INTERVAL_MS);
    }
  } catch (err) {
    logger.debug('[otlp-ingest] copilot usage enrichment error', ...sanitizeLogArgs({ sessionId, err: err instanceof Error ? err.message : String(err) }));
    return 'timeout';
  }
}

/** Fire-and-forget scheduling for the events of one accepted hook batch. */
export function scheduleCopilotUsageEnrichment(agentName: string, events: Record<string, unknown>[]): void {
  if (agentName !== COPILOT_CLI_OTLP_AGENT) return;
  for (const event of events) {
    if (event['type'] !== SESSION_END_TYPE) continue;
    const sessionId = String(event['session_id'] ?? '');
    if (!sessionId || scheduled.has(sessionId)) continue;
    scheduled.add(sessionId);
    void enrichSessionUsage(event).then((outcome) => {
      logger.debug('[otlp-ingest] copilot usage enrichment', ...sanitizeLogArgs({ sessionId, outcome }));
    });
  }
}
