/**
 * VS Code Copilot Chat scanner — the `chatSessions/*.jsonl` append-log store.
 *
 * This is the only source of real token data and exact agent (chat mode) attribution for the
 * VS Code extension: its native hooks, consumed by `copilot-chat-otlp`, report no usage.
 *
 * The store is an append-log, not a document:
 *   {"kind":0,"v":{...full session...}}        initial snapshot
 *   {"kind":1,"k":<prop>,"v":<val>}            property update
 *   {"kind":2,"k":"requests","v":[...]}        appended request batch
 *
 * SCHEMA DRIFT: `k` is a plain property name on older builds and a JSON PATH ARRAY on current
 * ones (`{"kind":1,"k":["requests",2,"promptTokens"],"v":83004}`). Both must be handled —
 * supporting only the string form leaves the periodic `kind:0` snapshots intact while every
 * recent turn silently vanishes.
 *
 * DEFENSIVE PARSING: this store is written by an editor that can crash mid-write, so every
 * field is untrusted. Valid JSON is not necessarily an object, `result` is not necessarily a
 * dict, and token fields are not necessarily numbers. One malformed file must never take down
 * the scan.
 */

import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { logger } from '@/utils/logger.js';
import { vsCodeChatLocations, type VsCodeLocation } from './copilot-local-paths.js';
import {
  emptyHealth,
  toCount,
  toInt,
  type CopilotScanHealth,
  type CopilotScanResult,
  type CopilotUsageRow,
} from './types.js';

/** Request fields the report reads. The rest of the journal is streamed response text. */
const REQUEST_FIELDS = new Set([
  'timestamp',
  'requestId',
  'modelId',
  'promptTokens',
  'completionTokens',
  'copilotCredits',
  'result',
  'message',
  'modeInfo',
  'elapsedMs',
  'agent',
  'responseTimestamp',
  'modelConfiguration',
]);

/** Guard against a corrupt journal declaring an absurd request index. */
const MAX_TURNS = 100_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `value` as an object, or an empty one — a malformed `result` must not throw on property access. */
function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** One replayed chat session: its requests plus the metadata rows need. */
interface ReplayedSession {
  sessionId?: string;
  creationDate?: number;
  requests: Array<Record<string, unknown>>;
}

/**
 * Replay one append-log into its final request list.
 *
 * Returns undefined when the file yields nothing usable, so the caller can count it as
 * skipped rather than emit an empty session.
 */
async function replaySession(file: string, health: CopilotScanHealth): Promise<ReplayedSession | undefined> {
  const session: ReplayedSession = { requests: [] };
  let sawSnapshot = false;

  const stream = createReadStream(file, { encoding: 'utf-8' });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      if (!line.trim()) {
        continue;
      }
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        // A half-written tail line is normal for a log the editor is still appending to.
        continue;
      }
      if (!isRecord(entry)) {
        continue;
      }
      const { kind, k, v } = entry as { kind?: unknown; k?: unknown; v?: unknown };

      if (kind === 0) {
        const snapshot = asRecord(v);
        sawSnapshot = true;
        if (typeof snapshot.sessionId === 'string') {
          session.sessionId = snapshot.sessionId;
        }
        if (typeof snapshot.creationDate === 'number') {
          session.creationDate = snapshot.creationDate;
        }
        session.requests = Array.isArray(snapshot.requests)
          ? snapshot.requests.filter(isRecord).map((r) => ({ ...r }))
          : [];
        continue;
      }

      // Pre-2026 string form: the whole `requests` array is replaced or appended to.
      if (k === 'requests') {
        if (kind === 2 && Array.isArray(v)) {
          session.requests.push(...v.filter(isRecord).map((r) => ({ ...r })));
        } else if (kind === 1 && Array.isArray(v)) {
          session.requests = v.filter(isRecord).map((r) => ({ ...r }));
        }
        continue;
      }

      // Everything else addresses a JSON path. Only `requests` paths matter.
      if (!Array.isArray(k) || k.length === 0 || k[0] !== 'requests') {
        continue;
      }
      if (k.length === 1) {
        if (kind === 2 && Array.isArray(v)) {
          session.requests.push(...v.filter(isRecord).map((r) => ({ ...r })));
        }
        continue;
      }
      const index = toInt(k[1]);
      if (index < 0 || index >= MAX_TURNS) {
        continue;
      }
      if (k.length === 2) {
        // Whole-request replacement; a sparse index grows the list with holes to fill.
        if (isRecord(v)) {
          while (session.requests.length <= index) {
            session.requests.push({});
          }
          session.requests[index] = { ...v };
        }
        continue;
      }
      // Single-field update: `k[2]` can be a list or dict in a corrupt journal, so it is
      // type-checked before being used as a property name.
      if (k.length === 3 && kind === 1 && typeof k[2] === 'string' && REQUEST_FIELDS.has(k[2])) {
        while (session.requests.length <= index) {
          session.requests.push({});
        }
        session.requests[index][k[2]] = v;
      }
    }
  } catch (error) {
    health.errors += 1;
    logger.debug('[copilot-local] vscode session read failed:', error);
    return undefined;
  } finally {
    reader.close();
    stream.destroy();
  }

  return sawSnapshot || session.requests.length > 0 ? session : undefined;
}

/** Chat mode (built-in or custom) behind a request, for agent attribution. */
function resolveChatMode(request: Record<string, unknown>): { mode: string; custom: boolean } {
  const modeInfo = asRecord(request.modeInfo);
  const instructions = asRecord(modeInfo.modeInstructions);
  const kind = typeof modeInfo.kind === 'string' ? modeInfo.kind : '';

  // A custom mode's own name wins: modeId/modeName are absent on most built-in records, so
  // they cannot lead, and `agent.id` is the same value on every record and is unusable.
  if (typeof instructions.name === 'string' && instructions.name) {
    return { mode: instructions.name, custom: true };
  }
  for (const key of ['modeId', 'modeName'] as const) {
    const value = modeInfo[key];
    if (typeof value === 'string' && value) {
      return { mode: value, custom: false };
    }
  }
  const telemetry = modeInfo.telemetryModeId;
  if (typeof telemetry === 'string' && telemetry && telemetry !== 'custom') {
    return { mode: telemetry, custom: false };
  }
  if (kind) {
    return { mode: kind, custom: modeInfo.isBuiltin === false };
  }
  return { mode: 'unknown', custom: false };
}

/** The model that actually ran, and how confident the id is. */
function resolveModel(
  request: Record<string, unknown>,
  metadata: Record<string, unknown>
): { model: string; confidence: CopilotUsageRow['modelConfidence'] } {
  const raw = request.modelId;
  let model = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : '';
  if (!model) {
    model = 'unknown';
  }
  const alias = model.split('/').pop() ?? model;
  const resolved = metadata.resolvedModel;
  if (typeof resolved === 'string' && resolved) {
    // `copilot/auto` is a router alias, not a billable model, and prices at zero;
    // `metadata.resolvedModel` names what actually ran.
    if (alias === 'auto' || alias === 'unknown' || alias === '') {
      model = resolved;
    }
    return { model, confidence: 'exact' };
  }
  return { model, confidence: alias === 'auto' ? 'inferred' : 'exact' };
}

/** One replayed request → one billed row, or undefined when it carries nothing usable. */
function requestRow(
  request: Record<string, unknown>,
  session: ReplayedSession,
  location: VsCodeLocation,
  sessionId: string,
  workspaceId: string,
  index: number
): CopilotUsageRow | undefined {
  const tsMs = toInt(request.timestamp) || toInt(session.creationDate);
  if (tsMs <= 0) {
    return undefined;
  }
  const result = asRecord(request.result);
  const metadata = asRecord(result.metadata);
  const timings = asRecord(result.timings);

  const inputTokens = toCount(request.promptTokens ?? metadata.promptTokens);
  const outputTokens = toCount(request.completionTokens ?? metadata.outputTokens);

  const { model, confidence } = resolveModel(request, metadata);
  const { mode, custom } = resolveChatMode(request);

  // A turn that failed still cost tokens; counting it as a success hides every
  // network and rate-limit failure from the report.
  const errorDetails = result.errorDetails;
  const status: CopilotUsageRow['status'] = isRecord(errorDetails) && Object.keys(errorDetails).length > 0
    ? (errorDetails.responseIsFiltered ? 'cancelled' : 'error')
    : 'success';

  // Each tool-call round is a separate API call. Reporting 1 makes VS Code look an order of
  // magnitude cheaper per turn than it is.
  const rounds = metadata.toolCallRounds;
  const apiCalls = Array.isArray(rounds) && rounds.length > 0 ? rounds.length : 1;

  const credits = request.copilotCredits;
  const requestId = typeof request.requestId === 'string' && request.requestId
    ? request.requestId
    : `${sessionId}:${index}`;

  return {
    sessionId,
    requestId: `vscode:${requestId}`,
    tsMs,
    agentName: 'copilot-vscode',
    surface: location.label === 'insiders' ? 'VS Code Insiders' : 'VS Code',
    source: 'copilot-vscode-sessions',
    model,
    modelConfidence: confidence,
    category: 'chat/agent',
    status,
    isUserTurn: true,
    // VS Code reports no cache split, so every prompt token bills as fresh input.
    usage: {
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    },
    durationMs: toCount(request.elapsedMs) || toCount(timings.totalElapsed),
    apiCalls,
    workspaceId,
    ideProfile: location.label,
    agentMode: mode,
    isCustomAgent: custom,
    ...(typeof credits === 'number' && Number.isFinite(credits) && credits > 0
      ? { reportedCredits: credits }
      : {}),
  };
}

export interface VsCodeScanOptions {
  maxAgeDays?: number;
  /** Override the scanned editions; defaults to stable + Insiders. */
  editions?: readonly string[];
  env?: NodeJS.ProcessEnv;
  /** Explicit VS Code user-data roots, bypassing platform resolution (test seam). */
  userDataDirs?: readonly string[];
}

/**
 * Scan every VS Code chat-session store on this machine.
 *
 * Never throws: an absent VS Code, an unreadable location or a corrupt file is counted and
 * skipped.
 */
export async function scanVsCodeSessions(opts: VsCodeScanOptions = {}): Promise<CopilotScanResult> {
  const health = emptyHealth('copilot-vscode-sessions');
  const rows: CopilotUsageRow[] = [];
  const coveredSessionIds = new Set<string>();
  const locations = vsCodeChatLocations(opts.editions, opts.env, opts.userDataDirs);
  if (locations.length === 0) {
    health.reasons.push('absent');
    health.notes.push('no VS Code chat session directory found');
    return { rows, health, coveredSessionIds };
  }
  const floorMs = opts.maxAgeDays === undefined ? 0 : Date.now() - opts.maxAgeDays * 86_400_000;
  // The same session is reachable from both the shared `User` root and a `User/profiles/*`
  // root (the profile layout is unverified, so both are scanned); dedupe by request id.
  const seenRequestIds = new Set<string>();

  for (const location of locations) {
    let entries;
    try {
      entries = await readdir(location.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
        continue;
      }
      const file = join(location.path, entry.name);
      try {
        const info = await stat(file);
        if (info.mtimeMs < floorMs) {
          continue;
        }
      } catch {
        continue;
      }
      health.filesSeen += 1;

      const session = await replaySession(file, health);
      if (!session) {
        health.rowsSkipped += 1;
        continue;
      }
      const sessionId = session.sessionId ?? basename(entry.name, '.jsonl');
      // `workspaceStorage/<hash>/chatSessions` → the hash; otherwise the location kind.
      const workspaceId =
        location.kind === 'workspaceStorage'
          ? basename(join(location.path, '..'))
          : location.kind;

      let kept = 0;
      session.requests.forEach((request, index) => {
        const row = requestRow(request, session, location, sessionId, workspaceId, index);
        if (!row) {
          health.rowsSkipped += 1;
          return;
        }
        if (row.tsMs < floorMs || seenRequestIds.has(row.requestId)) {
          health.rowsSkipped += 1;
          return;
        }
        seenRequestIds.add(row.requestId);
        rows.push(row);
        health.rowsRead += 1;
        kept += 1;
      });
      if (kept > 0) {
        coveredSessionIds.add(sessionId);
      }
    }
  }

  return { rows, health, coveredSessionIds };
}
