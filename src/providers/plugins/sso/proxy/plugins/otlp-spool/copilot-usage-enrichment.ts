import { realpathSync, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { isSafeSessionId } from '@/agents/core/session-id.js';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import { getDefaultCopilotSessionStateRoot } from '@/agents/plugins/copilot-cli/copilot-cli.paths.js';
import type { CopilotEvent } from '@/agents/plugins/copilot-cli/copilot-cli-event-types.js';
import { buildDeferredUsageEvents, stableEventId, TEMPLATE_FIELDS, type DeferredUsageOptions } from '@/agents/plugins/copilot-cli-otlp/copilot-cli-otlp.usage.js';
import { readTranscriptFromAsync } from '@/agents/plugins/copilot-cli-otlp/copilot-cli-otlp.transcript.js';
import { deleteSessionStateFiles, readSessionState } from '@/agents/plugins/copilot-cli-otlp/copilot-cli-otlp.state.js';
import { appendSpool } from './spool-io.js';
import { listHookRecords, readHookRecordsLocked } from './copilot-usage-spool.js';
import type { OtlpHookLifecycle } from '../otlp.plugin.js';

export const copilotHookLifecycle: OtlpHookLifecycle = {
  beforeSessionTicks: recoverMissingSessionEnds,
  skipAppend: lateSessionEndSkip,
  afterBatchAccepted: scheduleCopilotUsageEnrichment,
};

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
  inspected.clear();
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
      const shutdownIndex = Number.isFinite(notBeforeMs)
        ? events.findIndex((event) => event.type === 'session.shutdown' && Date.parse(event.timestamp ?? '') >= notBeforeMs)
        : events.reduce((last, event, index) =>
          event.type === 'session.shutdown' && Number.isFinite(Date.parse(event.timestamp ?? '')) ? index : last, -1);
      const shutdown = events[shutdownIndex];
      if (shutdown?.timestamp) {
        const endedAt = shutdown.timestamp as string;
        if (await alreadyEnriched(sessionId, endedAt)) {
          return 'duplicate';
        }
        await flushDeferredUsage(sessionId, template, events.slice(0, shutdownIndex + 1), { truncated });
        const records = await listHookRecords(sessionId);
        const resumed = records.some((record) => record['type'] === START_TYPE && timeOf(record) > Date.parse(endedAt))
          || events.slice(shutdownIndex + 1).some((event) => event.type === 'session.start' || event.type === 'session.resume');
        if (!resumed) {
          deleteSessionStateFiles(sessionId);
        }
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


/** A transcript this quiet has stopped growing: a hook still racing the shutdown has had its chance. */
export const RECOVERY_SETTLE_MS = 15_000;

const START_TYPE = 'agent.session.start';

/** Transcript signature last inspected per session, so an idle session is parsed once, not every tick. */
const inspected = new Map<string, string>();

const timeOf = (record: Record<string, unknown>): number => Date.parse(String(record['timestamp'] ?? ''));
/** The id a recovered end carries: deterministic per shutdown, and how the hook path recognises it. */
const recoveredEndId = (sessionId: string, shutdownAt: string): string => stableEventId(SESSION_END_TYPE, sessionId, shutdownAt);

/** The latest `agent.session.start` at or before `ms`: the run a timestamp belongs to (NaN when none). */
function runStartAt(records: Record<string, unknown>[], ms: number): number {
  const starts = records.filter((s) => s['type'] === START_TYPE && timeOf(s) <= ms).map(timeOf);
  return starts.length ? Math.max(...starts) : NaN;
}

function transcriptStarts(events: CopilotEvent[]): Record<string, unknown>[] {
  return events
    .filter((event) => event.type === 'session.start' || event.type === 'session.resume')
    .map((event) => ({ type: START_TYPE, timestamp: event.timestamp }));
}

/**
 * A recovered end of the same run as the hook end: the same latest start precedes both, whichever of the two is
 * later (a hook end's timestamp can fall back to the wall clock and land after the shutdown). A start between them
 * is a resume, i.e. a different run, so the hook end is kept.
 */
function recoveredEndCovers(sessionId: string, records: Record<string, unknown>[], hookEndMs: number): boolean {
  const run = runStartAt(records, hookEndMs);
  return Number.isFinite(run) && records.some((r) =>
    r['type'] === SESSION_END_TYPE &&
    r['event_id'] === recoveredEndId(sessionId, String(r['timestamp'])) &&
    runStartAt(records, timeOf(r)) === run);
}

/**
 * Under the spool lock: is the run that started at `startMs` already ended, or has a newer run taken over its shutdown?
 * A newer start at or before the shutdown makes it that run's evidence, so no end is written for the old one now (the
 * next tick re-reads the latest start). A newer start after the shutdown leaves the old run's end recoverable: only an
 * end inside this run's window counts.
 */
function runEndedOrSuperseded(records: Record<string, unknown>[], startMs: number, endedMs: number): boolean {
  const later = records.filter((r) => r['type'] === START_TYPE && timeOf(r) > startMs).map(timeOf);
  if (later.some((s) => s <= endedMs)) return true;
  const next = Math.min(Infinity, ...later);
  return records.some((r) => r['type'] === SESSION_END_TYPE && timeOf(r) >= startMs && timeOf(r) < next);
}

/**
 * For the hook-ingest append: a batch made only of `agent.session.end` events that a recovered end already
 * covers is skipped (decided under the session lock, so it cannot race the recovery's own append).
 * `undefined` = nothing to check, append as usual.
 */
export function lateSessionEndSkip(
  agentName: string,
  sessionId: string,
  events: Record<string, unknown>[]
): (() => Promise<boolean>) | undefined {
  if (agentName !== COPILOT_CLI_OTLP_AGENT || events.length === 0) return undefined;
  if (!events.every((e) => typeof e === 'object' && e !== null && e['type'] === SESSION_END_TYPE)) return undefined;
  return async () => {
    const records = await readHookRecordsLocked(sessionId);
    if (!records.some((record) => record['type'] === SESSION_END_TYPE &&
      record['event_id'] === recoveredEndId(sessionId, String(record['timestamp'])))) return false;
    const windows = Number.isFinite(runStartAt(records, Infinity))
      ? records
      : [...records, ...transcriptStarts((await readEvents(sessionId)).events)];
    return events.every((e) => recoveredEndCovers(sessionId, windows, timeOf(e)));
  };
}

type HookRecord = Record<string, unknown>;
type Shutdown = { timestamp: string; index: number };

function findRunShutdowns(records: HookRecord[], events: CopilotEvent[]) {
  // A drained spool can be swept while Copilot is idle. Its next hook recreates it without a start.
  const hasHookStart = Number.isFinite(runStartAt(records, Infinity));
  const windows = hasHookStart ? records : transcriptStarts(events);
  const lastStart = runStartAt(windows, Infinity);
  const spooledRuns = hasHookStart ? undefined : new Set(records.map((record) => runStartAt(windows, timeOf(record))));
  const shutdowns = new Map<number, Shutdown>();
  for (const [index, event] of events.entries()) {
    if (event.type !== 'session.shutdown' || !event.timestamp) continue;
    const start = runStartAt(windows, Date.parse(event.timestamp));
    if (Number.isFinite(start) && (!spooledRuns || spooledRuns.has(start))) {
      shutdowns.set(start, { timestamp: event.timestamp, index });
    }
  }
  return { windows, lastStart, hasHookStart, shutdowns };
}

interface RecoveryContext {
  sessionId: string;
  records: HookRecord[];
  newestFirst: HookRecord[];
  template: HookRecord;
  events: CopilotEvent[];
  truncated: boolean;
  windows: HookRecord[];
  lastStart: number;
  hasHookStart: boolean;
}

async function recoverRun(
  { sessionId, records, newestFirst, template, events, truncated, windows, lastStart, hasHookStart }: RecoveryContext,
  startMs: number,
  shutdown: Shutdown
): Promise<void> {
  const existing = records.find((r) => r['type'] === SESSION_END_TYPE && runStartAt(windows, timeOf(r)) === startMs);
  if (existing && records.some((r) => r['type'] === SUMMARY_TYPE && r['is_final'] === true && r['ended_at'] === shutdown.timestamp)) return;

  const endedMs = Date.parse(shutdown.timestamp);
  const runTemplate = newestFirst.find((r) => timeOf(r) >= startMs && timeOf(r) <= endedMs) ?? template;
  const end = existing ?? {
    ...Object.fromEntries(TEMPLATE_FIELDS.filter((k) => runTemplate[k] !== undefined).map((k) => [k, runTemplate[k]])),
    session_id: sessionId,
    type: SESSION_END_TYPE,
    timestamp: shutdown.timestamp,
    event_id: recoveredEndId(sessionId, shutdown.timestamp),
  };
  if (!existing) {
    const line = JSON.stringify({
      agentName: COPILOT_CLI_OTLP_AGENT,
      hookEvent: JSON.stringify(end),
      ...(startMs < lastStart ? { historicalEnd: true } : {}),
    }) + '\n';
    const written = await appendSpool(sessionId, 'hooks', line, undefined, {
      skipIf: async () => {
        const current = await readHookRecordsLocked(sessionId);
        return runEndedOrSuperseded(hasHookStart ? current : [...current, ...windows], startMs, endedMs);
      },
    });
    if (!written) {
      inspected.delete(sessionId); // A newer start or an end won the race. Re-read the run windows next tick.
      return;
    }
  }

  if (hasHookStart && startMs === lastStart) {
    scheduleCopilotUsageEnrichment(COPILOT_CLI_OTLP_AGENT, [end]);
  } else {
    // Keep the transcript root for late-end matching when a recreated spool has no start.
    scheduleEnrichment(sessionId, end, async () => {
      if (await alreadyEnriched(sessionId, shutdown.timestamp)) return 'duplicate';
      await flushDeferredUsage(sessionId, end, events.slice(0, shutdown.index + 1), { truncated });
      return 'enriched';
    });
  }
}

/**
 * Recover each settled shutdown in the spool's run windows. A resumed transcript is cumulative:
 * a historical shutdown uses only its prefix and must leave the active run's state intact.
 */
export async function recoverMissingSessionEnds(
  sessionIds: readonly string[],
  now: () => number = Date.now
): Promise<void> {
  for (const sessionId of sessionIds) {
    try {
      if (!isSafeSessionId(sessionId)) continue;
      const path = join(resolveStateRoot(sessionId), sessionId, 'events.jsonl');
      const info = await stat(path).catch(() => undefined);
      if (!info || now() - info.mtimeMs < RECOVERY_SETTLE_MS) continue;
      const signature = `${info.size}:${info.mtimeMs}`;
      if (inspected.get(sessionId) === signature) continue;

      const records = await listHookRecords(sessionId);
      const template = records.at(-1);
      if (!template || !String(template['platform'] ?? '').startsWith('copilot')) continue;
      const newestFirst = [...records].reverse();

      const { events, truncated } = await readEvents(sessionId);
      const { windows, lastStart, hasHookStart, shutdowns } = findRunShutdowns(records, events);
      const context = { sessionId, records, newestFirst, template, events, truncated, windows, lastStart, hasHookStart };
      inspected.set(sessionId, signature);
      for (const [startMs, shutdown] of shutdowns) {
        await recoverRun(context, startMs, shutdown);
      }
    } catch (err) {
      inspected.delete(sessionId);
      logger.debug('[otlp-ingest] copilot session end recovery error', ...sanitizeLogArgs({ sessionId, err: err instanceof Error ? err.message : String(err) }));
    }
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
    scheduleEnrichment(sessionId, event, () => enrichSessionUsage(event));
  }
}

function scheduleEnrichment(
  sessionId: string,
  event: Record<string, unknown>,
  enrich: () => ReturnType<typeof enrichSessionUsage>
): void {
  const key = `${sessionId}|${String(event['timestamp'] ?? '')}`;
  if (scheduled.has(key)) return;
  scheduled.add(key);
  const retry = () => {
    scheduled.delete(key);
    inspected.delete(sessionId);
  };
  void enrich()
    .then((outcome) => {
      if (outcome !== 'enriched' && outcome !== 'duplicate') retry();
      logger.debug('[otlp-ingest] copilot usage enrichment', ...sanitizeLogArgs({ sessionId, outcome }));
    })
    .catch(retry);
}
