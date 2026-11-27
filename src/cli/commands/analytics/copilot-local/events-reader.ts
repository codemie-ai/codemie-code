/**
 * Copilot `events.jsonl` scanner — the fallback for sessions `session-store.db` does not cover.
 *
 * Needed for two cases:
 *   1. Copilot Desktop, which writes nothing to the store, so these events are its ONLY
 *      per-call usage source.
 *   2. A runtime without `node:sqlite`, or a broken/absent store.
 *
 * Callers pass `excludeSessionIds` so a session is never counted from both sources.
 *
 * PRIVACY: these files interleave prompt and response text with usage events. Every line is
 * prefiltered by substring BEFORE `JSON.parse`, and only numeric fields plus the model id are
 * kept — no message content is read into a row.
 *
 * ASSUMPTION (carried over from the Python original, still unconfirmed): the field paths
 * `data.usage.*` on `session.usage_record` and `data.modelMetrics.<model>` on
 * `session.shutdown`. A missing or oddly-shaped field is counted as skipped, never raised.
 */

import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { logger } from '@/utils/logger.js';
import { FULL_SESSION_UUID } from '@/agents/plugins/copilot-cli/copilot-cli.constants.js';
import { sessionStateRoot } from './copilot-local-paths.js';
import { categoryOf, readClientName, resolveSurface } from './copilot-surfaces.js';
import {
  emptyHealth,
  toCount,
  type CopilotScanHealth,
  type CopilotScanResult,
  type CopilotUsageRow,
} from './types.js';

/**
 * Event types worth parsing. A line without one of these never reaches `JSON.parse`.
 *
 * `session.start` is included for its `data.context` block — the only place a transcript names
 * the working directory, repository and branch. Without it, events-sourced rows carried no
 * branch at all and `--branch` could never match one (verified against 127 real transcripts).
 *
 * `session.usage_checkpoint` is deliberately NOT read: its running totals would double-count
 * the per-call `session.usage_record` rows, which on real data cover every call.
 */
const EVENT_MARKERS = ['session.usage_record', 'session.shutdown', 'session.start'] as const;

/** Longest line parsed; a longer one is a pathological transcript, not a usage record. */
const MAX_LINE_LENGTH = 1024 * 1024;

/** Token field spellings Copilot has used, newest first. */
const TOKEN_FIELDS = {
  inputTokens: ['inputTokens', 'input_tokens'],
  outputTokens: ['outputTokens', 'output_tokens'],
  cacheReadTokens: ['cacheReadTokens', 'cache_read_tokens'],
  cacheWriteTokens: ['cacheWriteTokens', 'cache_write_tokens'],
  reasoningTokens: ['reasoningTokens', 'reasoning_tokens'],
} as const satisfies Record<string, readonly string[]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** First present spelling of a numeric field, clamped to a non-negative integer. */
function pickCount(source: Record<string, unknown>, spellings: readonly string[]): number {
  for (const name of spellings) {
    if (source[name] !== undefined) {
      return toCount(source[name]);
    }
  }
  return 0;
}

/** Epoch ms from an event timestamp in any of the forms Copilot writes. */
function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e11 ? value : value * 1000;
  }
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value.trim());
    return Number.isFinite(ms) ? ms : undefined;
  }
  return undefined;
}

function tokensFrom(usage: Record<string, unknown>): CopilotUsageRow['usage'] {
  return {
    inputTokens: pickCount(usage, TOKEN_FIELDS.inputTokens),
    outputTokens: pickCount(usage, TOKEN_FIELDS.outputTokens),
    cacheReadTokens: pickCount(usage, TOKEN_FIELDS.cacheReadTokens),
    cacheWriteTokens: pickCount(usage, TOKEN_FIELDS.cacheWriteTokens),
    reasoningTokens: pickCount(usage, TOKEN_FIELDS.reasoningTokens),
  };
}

/** Copilot's own premium-request billing for one call, when the event reports it. */
function nanoAiuFrom(usage: Record<string, unknown>): number | undefined {
  const copilotUsage = usage.copilotUsage;
  if (!isRecord(copilotUsage)) {
    return undefined;
  }
  const nano = copilotUsage.totalNanoAiu ?? copilotUsage.total_nano_aiu;
  return typeof nano === 'number' && Number.isFinite(nano) ? Math.max(0, nano) : undefined;
}

interface SessionContext {
  sessionId: string;
  agentName: CopilotUsageRow['agentName'];
  surface: string;
}

/** Where the work happened, from a `session.start` event's `data.context`. */
interface SessionPlace {
  workingDirectory?: string;
  repository?: string;
  branch?: string;
}

/** `data.context` of a `session.start`, keeping only the location fields. */
function placeFrom(event: Record<string, unknown>): SessionPlace {
  const data = event.data;
  const context = isRecord(data) ? data.context : undefined;
  if (!isRecord(context)) {
    return {};
  }
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value ? value : undefined;
  return {
    ...(text(context.cwd) ? { workingDirectory: text(context.cwd) } : {}),
    ...(text(context.repository) ? { repository: text(context.repository) } : {}),
    ...(text(context.branch) ? { branch: text(context.branch) } : {}),
  };
}

/** One `session.usage_record` → one billed row, the same granularity as a store row. */
function usageRecordRow(
  event: Record<string, unknown>,
  context: SessionContext,
  index: number
): CopilotUsageRow | undefined {
  const data = event.data;
  const usage = isRecord(data) ? data.usage : undefined;
  if (!isRecord(usage)) {
    return undefined;
  }
  const tsMs = parseTimestamp(event.timestamp);
  if (tsMs === undefined) {
    return undefined;
  }
  const model = usage.model;
  const initiator = usage.initiator;
  const eventId = typeof event.id === 'string' && event.id ? event.id : `${context.sessionId}:${index}`;
  const nanoAiu = nanoAiuFrom(usage);
  // Copilot charges premium requests, not tokens; `cost` is what this call was charged.
  const premiumCost = usage.cost;

  return {
    sessionId: context.sessionId,
    requestId: `events:${eventId}`,
    tsMs,
    agentName: context.agentName,
    surface: context.surface,
    source: 'copilot-cli-events',
    model: typeof model === 'string' && model ? model : 'unknown',
    modelConfidence: 'exact',
    category: categoryOf(initiator),
    status: 'success',
    isUserTurn: initiator === 'user',
    usage: tokensFrom(usage),
    durationMs: toCount(usage.duration),
    apiCalls: 1,
    ...(nanoAiu !== undefined ? { billedNanoAiu: nanoAiu } : {}),
    ...(typeof premiumCost === 'number' && Number.isFinite(premiumCost)
      ? { premiumRequestCost: premiumCost }
      : {}),
  };
}

/**
 * `session.shutdown` per-model totals → one aggregate row per model.
 *
 * Used only for a session whose `usage_record` events are absent: the shutdown rollup is the
 * ceiling, so emitting both would double-count the same tokens.
 */
function shutdownRows(
  event: Record<string, unknown>,
  context: SessionContext,
  fallbackTsMs: number
): CopilotUsageRow[] {
  const data = event.data;
  const metrics = isRecord(data) ? data.modelMetrics : undefined;
  if (!isRecord(metrics)) {
    return [];
  }
  const tsMs = parseTimestamp(event.timestamp) ?? fallbackTsMs;
  const rows: CopilotUsageRow[] = [];
  for (const [model, bucket] of Object.entries(metrics)) {
    if (!isRecord(bucket)) {
      continue;
    }
    const usage = tokensFrom(bucket);
    if (usage.inputTokens + usage.outputTokens === 0) {
      continue;
    }
    rows.push({
      sessionId: context.sessionId,
      requestId: `events:${context.sessionId}:shutdown:${model}`,
      tsMs,
      agentName: context.agentName,
      surface: context.surface,
      source: 'copilot-cli-events',
      model: model || 'unknown',
      modelConfidence: 'exact',
      category: 'chat/agent',
      status: 'success',
      // A rollup covers a whole session, so it is not one user turn.
      isUserTurn: false,
      usage,
      durationMs: 0,
      apiCalls: 1,
      ...(nanoAiuFrom(bucket) !== undefined ? { billedNanoAiu: nanoAiuFrom(bucket) as number } : {}),
    });
  }
  return rows;
}

/** Parse one session's `events.jsonl`, appending its rows. */
async function scanSessionFile(
  file: string,
  context: SessionContext,
  health: CopilotScanHealth,
  floorMs: number,
  out: CopilotUsageRow[]
): Promise<boolean> {
  const perCall: CopilotUsageRow[] = [];
  const rollup: CopilotUsageRow[] = [];
  let index = 0;
  let lastTsMs = 0;
  let place: SessionPlace = {};

  const stream = createReadStream(file, { encoding: 'utf-8' });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      if (line.length === 0 || line.length > MAX_LINE_LENGTH) {
        continue;
      }
      // Substring prefilter: no prompt-bearing line is ever handed to JSON.parse.
      if (!EVENT_MARKERS.some((marker) => line.includes(marker))) {
        continue;
      }
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        health.rowsSkipped += 1;
        continue;
      }
      if (!isRecord(event)) {
        health.rowsSkipped += 1;
        continue;
      }
      lastTsMs = parseTimestamp(event.timestamp) ?? lastTsMs;

      if (event.type === 'session.start') {
        // A resumed session starts more than once; the newest context block wins.
        place = { ...place, ...placeFrom(event) };
        continue;
      }
      if (event.type === 'session.usage_record') {
        const row = usageRecordRow(event, context, index++);
        if (row) {
          perCall.push(row);
        } else {
          health.rowsSkipped += 1;
        }
      } else if (event.type === 'session.shutdown') {
        rollup.push(...shutdownRows(event, context, lastTsMs));
      }
    }
  } catch (error) {
    health.errors += 1;
    logger.debug('[copilot-local] events read failed:', error);
    return false;
  } finally {
    reader.close();
    stream.destroy();
  }

  // Per-call records win; the rollup is only the ceiling for a session that has none.
  const chosen = perCall.length > 0 ? perCall : rollup;
  // `session.start` can appear after the first usage record in a resumed transcript, so the
  // location is applied once the whole file has been read rather than per row as it is built.
  for (const row of chosen) {
    Object.assign(row, place);
  }
  const kept = chosen.filter((row) => row.tsMs >= floorMs);
  health.rowsSkipped += chosen.length - kept.length;
  health.rowsRead += kept.length;
  out.push(...kept);
  return kept.length > 0;
}

export interface EventsScanOptions {
  /** Copilot home holding `session-state/<id>/events.jsonl`. */
  home: string;
  maxAgeDays?: number;
  wslDistro?: string;
  /** Sessions already read from the store; skipped here so nothing is counted twice. */
  excludeSessionIds?: ReadonlySet<string>;
  /** Sessions the desktop app owns, from its own `data.db`. */
  desktopSessionIds?: ReadonlySet<string>;
}

/**
 * Scan one Copilot home's per-session `events.jsonl` files.
 *
 * Never throws: an unreadable session is counted and skipped.
 */
export async function scanSessionEvents(opts: EventsScanOptions): Promise<CopilotScanResult> {
  const health = emptyHealth('copilot-cli-events');
  const rows: CopilotUsageRow[] = [];
  const coveredSessionIds = new Set<string>();
  const root = sessionStateRoot(opts.home);
  const floorMs = opts.maxAgeDays === undefined ? 0 : Date.now() - opts.maxAgeDays * 86_400_000;

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    health.reasons.push('absent');
    health.notes.push('session-state directory absent');
    return { rows, health, coveredSessionIds };
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !FULL_SESSION_UUID.test(entry.name)) {
      continue;
    }
    const sessionId = entry.name;
    if (opts.excludeSessionIds?.has(sessionId)) {
      continue;
    }
    const file = join(root, sessionId, 'events.jsonl');
    try {
      // mtime is a cheap pre-filter: a session not written since the cutoff cannot hold rows
      // inside the window, and skipping it avoids reading a large transcript for nothing.
      const info = await stat(file);
      if (info.mtimeMs < floorMs) {
        continue;
      }
    } catch {
      continue;
    }
    health.filesSeen += 1;

    const clientName = await readClientName(opts.home, sessionId, opts.wslDistro);
    const { agentName, surface } = resolveSurface(clientName, opts.wslDistro, opts.desktopSessionIds?.has(sessionId));
    const produced = await scanSessionFile(
      file,
      { sessionId, agentName, surface },
      health,
      floorMs,
      rows
    );
    if (produced) {
      coveredSessionIds.add(sessionId);
    }
  }

  return { rows, health, coveredSessionIds };
}
