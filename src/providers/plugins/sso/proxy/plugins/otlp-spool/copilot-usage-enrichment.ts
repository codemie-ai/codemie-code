import { realpathSync, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { isSafeSessionId } from '../../../../../../agents/core/session-id.js';
import { logger } from '../../../../../../utils/logger.js';
import { sanitizeLogArgs } from '../../../../../../utils/security.js';
import { getDefaultCopilotSessionStateRoot } from '../../../../../../agents/plugins/copilot-cli/copilot-cli.paths.js';
import type { CopilotEvent } from '../../../../../../agents/plugins/copilot-cli/copilot-cli-event-types.js';
import { buildDeferredUsageEvents, type DeferredUsageOptions } from '../../../../../../agents/plugins/copilot-cli-otlp/copilot-cli-otlp.usage.js';
import { readTranscriptFromAsync } from '../../../../../../agents/plugins/copilot-cli-otlp/copilot-cli-otlp.transcript.js';
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

/** Under the user's home, or (for an explicit COPILOT_HOME elsewhere) a directory the current user owns. */
function isTrustedRoot(root: string): boolean {
  if (isInside(realpathSync(homedir()), root)) return true;
  return typeof process.getuid === 'function' && statSync(root).uid === process.getuid();
}

/**
 * Session-state root: the hook's recorded override when it passes validation, else the default.
 * Valid means a `session-state` directory under the user's home (or owned by the user, POSIX) whose `<id>/events.jsonl`
 * resolves inside it and is a regular file.
 */
function resolveStateRoot(sessionId: string): string {
  const fallback = getDefaultCopilotSessionStateRoot();
  const recorded = readSessionState(sessionId).sessionStateRoot;
  if (!recorded) return fallback;
  try {
    const root = realpathSync(recorded);
    if (root.split(/[\\/]/).pop() !== 'session-state' || !isTrustedRoot(root)) {
      logger.warn('[copilot-usage] recorded session-state root rejected (must be a session-state directory under the home directory or owned by the current user); using the default root', recorded);
      return fallback;
    }
    const file = realpathSync(join(root, sessionId, 'events.jsonl'));
    return isInside(root, file) && statSync(file).isFile() ? root : fallback;
  } catch {
    return fallback;
  }
}

interface TranscriptSnapshot {
  events: CopilotEvent[];
  truncated: boolean;
  /** Size and mtime of the file when read; an unchanged signature means the parse can be reused. */
  signature: string;
}

/** Re-parses the transcript only when its size or mtime changed since `previous`; the read itself is async. */
async function readEvents(sessionId: string, previous?: TranscriptSnapshot): Promise<TranscriptSnapshot> {
  const path = join(resolveStateRoot(sessionId), sessionId, 'events.jsonl');
  let signature = '';
  try {
    const info = await stat(path);
    signature = `${info.size}:${info.mtimeMs}`;
  } catch {
    // Not written yet: the read below reports it as empty.
  }
  if (previous && signature !== '' && previous.signature === signature) return previous;
  const read = await readTranscriptFromAsync(path);
  return { events: read?.events ?? [], truncated: read?.truncated ?? false, signature };
}

/** True if the hooks spool already holds the final summary for this shutdown (survives a daemon restart). */
async function alreadyEnriched(sessionId: string, endedAt: string): Promise<boolean> {
  const records = await listHookRecords(sessionId);
  return records.some((r) => r['type'] === SUMMARY_TYPE && r['is_final'] === true && r['ended_at'] === endedAt);
}

/** Builds the deferred events from the transcript and appends them to the hooks spool (nothing is written when there are none). */
async function flushDeferredUsage(
  sessionId: string,
  template: Record<string, unknown>,
  events: CopilotEvent[],
  options: DeferredUsageOptions
): Promise<void> {
  const start = events.find((e) => e.type === 'session.start')?.data as { copilotVersion?: string } | undefined;
  const wire = buildDeferredUsageEvents(template, events, start?.copilotVersion ?? '', options);
  if (wire.length === 0) return;
  await appendSpool(sessionId, 'hooks', wire
    .map((hookEvent) => JSON.stringify({ agentName: COPILOT_CLI_OTLP_AGENT, hookEvent: JSON.stringify(hookEvent) }))
    .join('\n') + '\n');
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
    let snapshot: TranscriptSnapshot | undefined;
    for (;;) {
      snapshot = await readEvents(sessionId, snapshot);
      const { events, truncated } = snapshot;
      const shutdown = events.filter((e) => e.type === 'session.shutdown').pop();
      const shutdownMs = shutdown?.timestamp ? Date.parse(shutdown.timestamp) : NaN;
      // A resumed session can hold an older shutdown: only one after this sessionEnd counts.
      if (shutdown && Number.isFinite(shutdownMs) && (!Number.isFinite(notBeforeMs) || shutdownMs >= notBeforeMs)) {
        const endedAt = shutdown.timestamp as string;
        if (await alreadyEnriched(sessionId, endedAt)) {
          return 'duplicate';
        }
        await flushDeferredUsage(sessionId, template, events, { truncated });
        deleteSessionStateFiles(sessionId);
        return 'enriched';
      }
      if (now() >= deadline) {
        // `session.shutdown` never showed up in the bound: rather than silently dropping whatever
        // usage the transcript already holds (including hook-side held-back Tier B messages, which
        // have no other path to the spool once sessionEnd has fired), flush the usage rows now.
        // They carry the same stable `event_id`s a later, successful enrichment would produce, so
        // that one dedups against this fallback. No final summary is written: without a shutdown it
        // would have no `ended_at`, and so a different `event_id` than the real one.
        // The session state is left in place — a later resume's `sessionEnd` can still retry.
        await flushDeferredUsage(sessionId, template, events, { truncated, withoutSummary: true });
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
