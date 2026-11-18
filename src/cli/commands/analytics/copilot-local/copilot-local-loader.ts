/**
 * Turn Copilot local scanner rows into the analytics pipeline's inputs.
 *
 * The scanners emit flat, already-tokenized rows, so this loader is the Copilot counterpart of
 * `otel-loader.ts`: group rows by session, price each row, and return `RawSessionData[]` plus
 * an authoritative `SessionCostIndex` + `CostSummary`. Returning cost here is what lets
 * `CopilotLocalSource` bypass `cost-enricher` entirely (see `sources/types.ts`).
 *
 * Scan order matters. `session-store.db` is read first and reports which sessions it covered;
 * the `events.jsonl` pass then skips those, so a session that exists in both is never counted
 * twice.
 */

import { normalizeModelName } from '@/utils/model-normalizer.js';
import { logger } from '@/utils/logger.js';
import { priceOtelEvent } from '../otel-pricing.js';
import { copilotUsageToTokens } from '../cost/usage-readers.js';
import { emptyUsage, addUsage } from '../cost/cost-calculator.js';
import type { MetricDelta } from '@/agents/core/metrics/types.js';
import type {
  SessionStartEvent,
  SessionEndEvent,
  RawSessionData,
} from '../data-loader.js';
import type {
  CostSummary,
  ModelCost,
  SessionCost,
  SessionCostIndex,
  TokenUsage,
} from '../cost/types.js';
import { localCopilotHome } from './copilot-local-paths.js';
import { scanSessionStore } from './store-reader.js';
import { scanSessionEvents } from './events-reader.js';
import { scanVsCodeSessions } from './vscode-sessions-reader.js';
import { scanWslHomes } from './wsl-reader.js';
import type { CopilotScanHealth, CopilotUsageRow } from './types.js';

export interface CopilotLocalLoadOptions {
  /** Scan window in days; undefined scans everything on disk. */
  maxAgeDays?: number;
  /** Skip the WSL pass even on Windows. */
  skipWsl?: boolean;
  /** Skip the VS Code extension pass. */
  skipVsCode?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Explicit Copilot home, bypassing `~/.copilot` / `COPILOT_HOME` resolution (test seam). */
  copilotHome?: string;
  /** Explicit VS Code user-data roots, bypassing platform resolution (test seam). */
  vsCodeUserDataDirs?: readonly string[];
}

export interface CopilotLocalResult {
  rawSessions: RawSessionData[];
  costIndex: SessionCostIndex;
  summary: CostSummary;
  /** One entry per scanner that ran, for the report's coverage banner. */
  health: CopilotScanHealth[];
}

/** Every scanner's rows, deduped by request id, oldest first. */
async function collectRows(
  opts: CopilotLocalLoadOptions
): Promise<{ rows: CopilotUsageRow[]; health: CopilotScanHealth[] }> {
  const health: CopilotScanHealth[] = [];
  const rows: CopilotUsageRow[] = [];
  const home = opts.copilotHome ? { path: opts.copilotHome } : localCopilotHome(opts.env);

  if (home) {
    const store = await scanSessionStore({ home: home.path, maxAgeDays: opts.maxAgeDays });
    health.push(store.health);
    rows.push(...store.rows);

    // Only the sessions the store did not cover — all Desktop sessions, plus every session
    // when `node:sqlite` was unavailable.
    const events = await scanSessionEvents({
      home: home.path,
      maxAgeDays: opts.maxAgeDays,
      excludeSessionIds: store.coveredSessionIds,
    });
    health.push(events.health);
    rows.push(...events.rows);
  }

  if (!opts.skipVsCode) {
    const vscode = await scanVsCodeSessions({
      maxAgeDays: opts.maxAgeDays,
      env: opts.env,
      userDataDirs: opts.vsCodeUserDataDirs,
    });
    health.push(vscode.health);
    rows.push(...vscode.rows);
  }

  if (!opts.skipWsl) {
    const wsl = await scanWslHomes({ maxAgeDays: opts.maxAgeDays });
    health.push(wsl.health);
    rows.push(...wsl.rows);
  }

  // A session reachable through two roots yields the same request id twice.
  const seen = new Set<string>();
  const deduped = rows.filter((row) => {
    if (seen.has(row.requestId)) {
      return false;
    }
    seen.add(row.requestId);
    return true;
  });
  deduped.sort((a, b) => a.tsMs - b.tsMs);
  return { rows: deduped, health };
}

/** Per-model accumulator for one session. */
interface ModelAccumulator {
  tokens: TokenUsage;
  costUSD: number;
  unpriced: boolean;
  estimated: boolean;
}

/**
 * Price one session's rows into a {@link SessionCost}.
 *
 * Every row is priced from the pricing table: Copilot reports no per-call dollar figure, only
 * `total_nano_aiu` (premium requests), which is a different billing unit and cannot be turned
 * into USD without the account's contract. So cost here is always a token estimate, labelled
 * as such — `costSource: 'native-estimate'` — and the premium-request totals are carried
 * alongside it rather than converted.
 */
function priceSession(
  sessionId: string,
  rows: CopilotUsageRow[],
  unpricedModels: Set<string>,
  estimatedModels: Set<string>
): SessionCost {
  const perModel = new Map<string, ModelAccumulator>();
  let tokens = emptyUsage();
  let costUSD = 0;
  let cacheReadCostUSD = 0;
  let tablePriced = false;

  for (const row of rows) {
    // Copilot's `inputTokens` includes cache reads; this is the one place that convention is
    // converted, shared with the native-transcript reader so both paths agree.
    const usage = copilotUsageToTokens(row.usage);
    const model = normalizeModelName(row.model);
    // `priceOtelEvent` with no reported cost == "price this usage from the table", which is
    // exactly what is needed here; reusing it keeps one pricing resolution path.
    const priced = priceOtelEvent(false, undefined, row.model, usage);

    tokens = addUsage(tokens, usage);
    costUSD += priced.cost;
    if (priced.tablePriced) {
      tablePriced = true;
    }
    if (priced.unpriced) {
      unpricedModels.add(model);
    }
    if (priced.estimated) {
      estimatedModels.add(model);
    }

    let accumulator = perModel.get(model);
    if (!accumulator) {
      accumulator = { tokens: emptyUsage(), costUSD: 0, unpriced: false, estimated: false };
      perModel.set(model, accumulator);
    }
    accumulator.tokens = addUsage(accumulator.tokens, usage);
    accumulator.costUSD += priced.cost;
    accumulator.unpriced ||= priced.unpriced;
    accumulator.estimated ||= priced.estimated;
  }

  // Cumulative cost/token growth, one point per row.
  let runningCost = 0;
  let runningTokens = 0;
  const costSeries = rows.map((row, index) => {
    const usage = copilotUsageToTokens(row.usage);
    runningCost += priceOtelEvent(false, undefined, row.model, usage).cost;
    runningTokens += usage.total;
    return { t: row.tsMs > 0 ? row.tsMs : index + 1, cost: runningCost, tokens: runningTokens };
  });

  const timestamps = rows.map((row) => row.tsMs).filter((ms) => ms > 0);

  return {
    sessionId,
    tokens,
    costUSD,
    cacheReadCostUSD,
    costSeries,
    perModel: [...perModel.entries()]
      .map(([model, accumulator]): ModelCost => ({
        model,
        tokens: accumulator.tokens,
        costUSD: accumulator.costUSD,
        unpriced: accumulator.unpriced,
        ...(accumulator.estimated && { estimated: true }),
      }))
      .sort((a, b) => b.costUSD - a.costUSD),
    priced: tablePriced,
    // The local artifact IS the log; there is never a separate transcript to locate.
    hadLog: true,
    costSource: 'native-estimate',
    costBasis: 'standard-api-tokens',
    ...(timestamps.length > 0
      ? { observedStart: Math.min(...timestamps), observedEnd: Math.max(...timestamps) }
      : {}),
  };
}

/**
 * One delta per row, so turn counts stay honest.
 *
 * `isTurn` is false for a row that is not the user's own turn (a tool-loop call, a sub-agent
 * call, context compaction, or a session-level rollup), which the aggregator excludes from
 * turn counts while still crediting its models.
 */
function buildDeltas(sessionId: string, rows: CopilotUsageRow[]): MetricDelta[] {
  const deltas: MetricDelta[] = rows.map((row, index) => ({
    recordId: row.requestId || `${sessionId}-copilot-${index}`,
    sessionId,
    agentSessionId: sessionId,
    timestamp: row.tsMs,
    isTurn: row.isUserTurn,
    models: [row.model],
    ...(row.branch ? { gitBranch: row.branch } : {}),
    syncStatus: 'synced',
    syncAttempts: 0,
  }));
  if (deltas.length === 0) {
    return deltas;
  }

  // Chat-mode attribution, where the source reports it (VS Code only).
  const agentInvocations: Record<string, number> = {};
  for (const row of rows) {
    if (row.agentMode) {
      agentInvocations[row.agentMode] = (agentInvocations[row.agentMode] ?? 0) + 1;
    }
  }
  if (Object.keys(agentInvocations).length > 0) {
    deltas[0].agentInvocations = agentInvocations;
  }
  return deltas;
}

/** One {@link RawSessionData} for a session's rows. */
function buildRawSession(sessionId: string, rows: CopilotUsageRow[]): RawSessionData {
  const timestamps = rows.map((row) => row.tsMs).filter((ms) => ms > 0);
  const startTime = timestamps.length > 0 ? Math.min(...timestamps) : 0;
  const endTime = timestamps.length > 0 ? Math.max(...timestamps) : 0;
  const first = rows[0];
  // Surface is the most useful "where did this run" label a local scan has; the working
  // directory is only present for store rows that joined `sessions.cwd`.
  const workingDirectory = rows.find((row) => row.workingDirectory)?.workingDirectory ?? first.surface;

  const startEvent: SessionStartEvent = {
    recordId: sessionId,
    type: 'session_start',
    timestamp: startTime,
    codeMieSessionId: sessionId,
    agentName: first.agentName,
    syncStatus: 'synced',
    data: { provider: 'copilot-local', workingDirectory, startTime },
  };
  const endEvent: SessionEndEvent = {
    recordId: `${sessionId}-end`,
    type: 'session_end',
    timestamp: endTime,
    codeMieSessionId: sessionId,
    agentName: first.agentName,
    syncStatus: 'synced',
    data: {
      endTime,
      duration: Math.max(0, endTime - startTime),
      totalTurns: rows.filter((row) => row.isUserTurn).length,
    },
  };
  return { sessionId, startEvent, endEvent, deltas: buildDeltas(sessionId, rows) };
}

/**
 * Scan the machine's Copilot artifacts and map them into the analytics pipeline.
 *
 * Never throws for a missing source: a machine with no Copilot at all returns an empty result
 * with health entries explaining why.
 */
export async function loadCopilotLocalSessions(
  opts: CopilotLocalLoadOptions = {}
): Promise<CopilotLocalResult> {
  const { rows, health } = await collectRows(opts);
  logger.debug(`[copilot-local] ${rows.length} usage row(s) from ${health.length} scanner(s)`);

  // Rows from the same session id are merged regardless of which scanner found them: the
  // store and the events fallback describe one session, and a session resumed later is still
  // that session.
  const bySession = new Map<string, CopilotUsageRow[]>();
  for (const row of rows) {
    const existing = bySession.get(row.sessionId);
    if (existing) {
      existing.push(row);
    } else {
      bySession.set(row.sessionId, [row]);
    }
  }

  const costIndex: SessionCostIndex = new Map();
  const rawSessions: RawSessionData[] = [];
  const unpricedModels = new Set<string>();
  const estimatedModels = new Set<string>();

  for (const [sessionId, sessionRows] of bySession) {
    costIndex.set(sessionId, priceSession(sessionId, sessionRows, unpricedModels, estimatedModels));
    rawSessions.push(buildRawSession(sessionId, sessionRows));
  }

  const summary: CostSummary = {
    totalCostUSD: [...costIndex.values()].reduce((sum, cost) => sum + cost.costUSD, 0),
    pricedSessions: [...costIndex.values()].filter((cost) => cost.priced).length,
    totalSessions: costIndex.size,
    unpricedModels: [...unpricedModels],
    estimatedModels: [...estimatedModels],
    // A Copilot subscription proxies cloud models only; none run locally.
    localModels: [],
  };

  return { rawSessions, costIndex, summary, health };
}

/** Total premium-request billing (`nano AIU`) across a scan, when any source reported it. */
export function totalBilledNanoAiu(rows: readonly CopilotUsageRow[]): number | undefined {
  const reported = rows.filter((row) => row.billedNanoAiu !== undefined);
  return reported.length > 0 ? reported.reduce((sum, row) => sum + (row.billedNanoAiu ?? 0), 0) : undefined;
}
