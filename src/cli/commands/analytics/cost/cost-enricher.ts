/**
 * Report-time cost enrichment.
 *
 * For each analytics session, locate its native agent log (via the persisted
 * `correlation.agentSessionFile` in ~/.codemie/sessions/{id}.json), re-parse it
 * with the agent's existing SessionAdapter, extract token usage, and apply the
 * pricing table. Dependencies are injected so the join/pricing logic is unit
 * testable without fs or the registry.
 */

import { readFile } from 'node:fs/promises';
import type { RawSessionData } from '../data-loader.js';
import type { ParsedSession, SessionAdapter } from '../../../../agents/core/session/BaseSessionAdapter.js';
import type { SessionCost, SessionCostIndex, CostSummary, ModelCost, TokenUsage, CostSeriesPoint } from './types.js';
import { MAX_SERIES_POINTS } from './types.js';
import { emptyUsage, addUsage, costBreakdown } from './cost-calculator.js';
import { lookupPrice } from './pricing.js';
import { gatherUsageDeduped, gatherDedupedUsageRecords, sumUsageRecords, type UsageRecord } from './usage-readers.js';
import { extractDispatchEvents } from './dispatch-extractor.js';
import { normalizeModelName } from '../model-normalizer.js';
import { getCodemiePath } from '../../../../utils/paths.js';
import { AgentRegistry } from '../../../../agents/registry.js';
import { ClaudeSessionAdapter } from '../../../../agents/plugins/claude/claude.session.js';
import { ClaudePluginMetadata } from '../../../../agents/plugins/claude/claude.plugin.js';
import { logger } from '../../../../utils/logger.js';

export interface EnricherDeps {
  resolveAgentName(raw: RawSessionData): string;
  /** Native agent log path for a session, or null if not resolvable. */
  loadAgentSessionFile(raw: RawSessionData): Promise<string | null>;
  parseNative(agentName: string, filePath: string, sessionId: string): Promise<ParsedSession | null>;
}

/**
 * Resolve the SessionAdapter for an agent. Most agents expose one via their registry plugin
 * (a typed optional on `AgentAdapter.getSessionAdapter`). `claude-desktop` (Claude Desktop
 * local-agent mode — the native Anthropic subscription app) has no registry plugin, but its
 * native logs are Claude-format JSONL, so we reuse the Claude adapter directly. That direct
 * instantiation is the one intentional, documented CLI→plugin reach; every other agent
 * resolves through the registry.
 */
function resolveSessionAdapter(agentName: string): SessionAdapter | null {
  const fromRegistry = AgentRegistry.getAgent(agentName)?.getSessionAdapter?.();
  if (fromRegistry) {
    return fromRegistry;
  }
  if (agentName.toLowerCase() === 'claude-desktop') {
    return new ClaudeSessionAdapter(ClaudePluginMetadata);
  }
  return null;
}

export const realDeps: EnricherDeps = {
  resolveAgentName: (raw) => raw.startEvent?.agentName ?? '',
  async loadAgentSessionFile(raw) {
    // Native-discovered sessions carry their log path directly (no CodeMie correlation file).
    if (raw.agentSessionFile) {
      return raw.agentSessionFile;
    }
    try {
      const metaPath = getCodemiePath('sessions', `${raw.sessionId}.json`);
      const meta = JSON.parse(await readFile(metaPath, 'utf-8')) as {
        correlation?: { agentSessionFile?: string };
      };
      return meta.correlation?.agentSessionFile ?? null;
    } catch {
      return null;
    }
  },
  async parseNative(agentName, filePath, sessionId) {
    const adapter = resolveSessionAdapter(agentName);
    if (!adapter) {
      return null;
    }
    try {
      return await adapter.parseSessionFile(filePath, sessionId);
    } catch (e) {
      logger.debug(`[cost] native parse failed for ${sessionId}:`, e);
      return null;
    }
  },
};

/** Parsed native log for one session, plus ordering/attribution metadata. */
interface ParsedEntry {
  sessionId: string;
  agentName: string;
  hadLog: boolean;
  parsed: ParsedSession | null;
  startTime: number;
}

/** Phase 1: resolve + parse a session's native log. Safe to run in parallel. */
async function parseOne(raw: RawSessionData, deps: EnricherDeps): Promise<ParsedEntry> {
  const agentName = deps.resolveAgentName(raw);
  const filePath = await deps.loadAgentSessionFile(raw);
  const hadLog = filePath != null;
  const parsed = filePath ? await deps.parseNative(agentName, filePath, raw.sessionId) : null;
  return { sessionId: raw.sessionId, agentName, hadLog, parsed, startTime: raw.startEvent?.data?.startTime ?? 0 };
}

/** Phase 3: price an already-gathered (deduped) per-model usage map for one session. */
function priceUsage(
  sessionId: string,
  hadLog: boolean,
  usageByModel: Map<string, TokenUsage>
): { cost: SessionCost; unpriced: string[] } {
  const perModel: ModelCost[] = [];
  const unpriced: string[] = [];
  let sessionTokens = emptyUsage();
  let sessionCost = 0;
  let cacheReadCostUSD = 0;

  for (const [rawModel, usage] of usageByModel) {
    const model = normalizeModelName(rawModel);
    const price = lookupPrice(model);
    const breakdown = price ? costBreakdown(usage, price) : null;
    const costUSD = breakdown ? breakdown.total : 0;
    if (!price) {
      unpriced.push(model);
    }
    perModel.push({ model, tokens: usage, costUSD, unpriced: !price });
    sessionTokens = addUsage(sessionTokens, usage);
    sessionCost += costUSD;
    cacheReadCostUSD += breakdown ? breakdown.cacheRead : 0;
  }

  // "priced" means the agent's usage reader actually yielded model usage. A parsed log
  // for an agent with no reader (codex/opencode → empty map) is hadLog=true but priced=false,
  // so the coverage view shows "no token reader" instead of a misleading "✓ full" at $0.
  return {
    cost: { sessionId, tokens: sessionTokens, costUSD: sessionCost, cacheReadCostUSD, perModel, priced: perModel.length > 0, hadLog },
    unpriced,
  };
}

/** Evenly downsample a cumulative series to ≤ MAX_SERIES_POINTS, always keeping the first and last point. */
function downsample(points: CostSeriesPoint[]): CostSeriesPoint[] {
  if (points.length <= MAX_SERIES_POINTS) {
    return points;
  }
  const out: CostSeriesPoint[] = [];
  const step = (points.length - 1) / (MAX_SERIES_POINTS - 1);
  for (let i = 0; i < MAX_SERIES_POINTS; i++) {
    out.push(points[Math.round(i * step)]);
  }
  out[out.length - 1] = points[points.length - 1]; // guarantee the true endpoint (cumulative total)
  return out;
}

/**
 * Build a per-turn cumulative cost/token series from ordered usage records. Prices each record
 * with the same table/normalizer as the session total, so the final cumulative cost equals the
 * session's costUSD. x-axis (`t`) is the message epoch ms when every record is timed, else the
 * 1-based turn ordinal. Returns [] for fewer than 2 records.
 */
export function buildCostSeries(records: UsageRecord[]): CostSeriesPoint[] {
  if (records.length < 2) {
    return [];
  }
  const useTs = records.every((r) => r.ts != null);
  const points: CostSeriesPoint[] = [];
  let cumCost = 0;
  let cumTokens = 0;
  records.forEach((r, i) => {
    const price = lookupPrice(normalizeModelName(r.model));
    cumCost += price ? costBreakdown(r.usage, price).total : 0;
    cumTokens += r.usage.total;
    // Round cumulative cost to 8 decimals to shrink the embedded series (well within the
    // endpoint test's 6-decimal tolerance); tokens are exact integer sums.
    points.push({ t: useTs ? (r.ts as number) : i + 1, cost: Math.round(cumCost * 1e8) / 1e8, tokens: cumTokens });
  });
  return downsample(points);
}

/** Run async tasks with bounded concurrency (cap open file descriptors). */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function enrichCosts(
  sessions: RawSessionData[],
  deps: EnricherDeps = realDeps
): Promise<{ index: SessionCostIndex; summary: CostSummary }> {
  // Phase 1: parse every native log concurrently.
  const parsedEntries = await mapWithConcurrency(sessions, 16, (raw) => parseOne(raw, deps));

  // Phase 2+3: gather usage in startTime order so the EARLIEST session owns a shared API
  // response, deduping by (message.id, requestId) across sessions — Claude replays prior
  // turns into resumed/forked logs, so the same response appears in many files. Then price.
  const ordered = [...parsedEntries].sort((a, b) => a.startTime - b.startTime);
  const seen = new Set<string>();

  const index: SessionCostIndex = new Map();
  const unpriced = new Set<string>();
  let totalCostUSD = 0;
  let pricedSessions = 0;

  for (const entry of ordered) {
    let usageByModel: Map<string, TokenUsage>;
    let series: CostSeriesPoint[] = [];
    try {
      // Gather ordered, deduped records ONCE per session (consumes keys in `seen`). When there
      // are records (Claude per-message path) sum them for the map + build the series from the
      // SAME records — so the series endpoint equals the session cost. The summed-gatherer
      // fallback runs only when there are no records (SDK rollup / gemini / no-reader), paths
      // that never touch `seen`, so there is no double-dedup.
      const records = entry.parsed ? gatherDedupedUsageRecords(entry.agentName, entry.parsed, seen) : [];
      if (records.length) {
        usageByModel = sumUsageRecords(records);
        series = buildCostSeries(records);
      } else {
        usageByModel = entry.parsed ? gatherUsageDeduped(entry.agentName, entry.parsed, seen) : new Map<string, TokenUsage>();
      }
    } catch (e) {
      // One malformed log must not abort the whole report — degrade to "no usage" for this
      // session, consistent with the parse/discover paths that already catch and continue.
      logger.debug(`[cost] usage extraction failed for ${entry.sessionId}:`, e);
      usageByModel = new Map<string, TokenUsage>();
      series = [];
    }
    const { cost, unpriced: u } = priceUsage(entry.sessionId, entry.hadLog, usageByModel);
    if (series.length) {
      cost.costSeries = series;
    }
    if (entry.parsed) {
      try {
        const dispatches = extractDispatchEvents(entry.parsed);
        if (dispatches.length) {
          cost.dispatches = dispatches;
        }
      } catch (e) {
        logger.debug(`[cost] dispatch extraction failed for ${entry.sessionId}:`, e);
      }
    }
    index.set(cost.sessionId, cost);
    u.forEach((m) => unpriced.add(m));
    if (cost.priced) {
      totalCostUSD += cost.costUSD;
      pricedSessions += 1;
    }
  }

  return {
    index,
    summary: { totalCostUSD, pricedSessions, totalSessions: sessions.length, unpricedModels: [...unpriced] },
  };
}
