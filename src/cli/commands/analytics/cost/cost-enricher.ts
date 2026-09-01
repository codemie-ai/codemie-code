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
import type { SessionCost, SessionCostIndex, CostSummary, ModelCost, TokenUsage, CostSeriesPoint, ModelTimelinePoint } from './types.js';
import type { DispatchEventRaw } from './types.js';
import { MAX_SERIES_POINTS } from './types.js';
import { emptyUsage, addUsage, costBreakdown } from './cost-calculator.js';
import { lookupPrice } from '@/utils/pricing.js';
import { gatherUsageDeduped, gatherDedupedUsageRecords, sumUsageRecords, readCodexSubagentUsage, type UsageRecord } from './usage-readers.js';
import { extractDispatchEvents } from './dispatch-extractor.js';
import { normalizeModelName } from '@/utils/model-normalizer.js';
import { getCodemiePath } from '../../../../utils/paths.js';
import { AgentRegistry } from '../../../../agents/registry.js';
import { ClaudeSessionAdapter } from '../../../../agents/plugins/claude/claude.session.js';
import { ClaudePluginMetadata } from '../../../../agents/plugins/claude/claude.plugin.js';
import { isCodexFamilyAgent } from './codex-agent.js';
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
  if (isCodexFamilyAgent(agentName)) {
    return AgentRegistry.getAgent('codex')?.getSessionAdapter?.() ?? null;
  }
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

/**
 * Build a per-turn model-usage timeline from ordered usage records.
 * Each point captures the actual model, per-turn cost, and token count.
 * Returns [] when there are no records.
 */
export function buildModelTimeline(records: UsageRecord[]): ModelTimelinePoint[] {
  if (!records.length) return [];
  const useTs = records.every((r) => r.ts != null);
  return records.map((r, i) => {
    const model = normalizeModelName(r.model);
    const price = lookupPrice(model);
    const costUSD = price ? costBreakdown(r.usage, price).total : 0;
    const point: ModelTimelinePoint = {
      t: useTs ? (r.ts as number) : i + 1,
      model,
      costUSD: Math.round(costUSD * 1e8) / 1e8,
      tokens: r.usage.total,
    };
    if (r.requestedModel != null) point.requestedModel = r.requestedModel;
    if (r.capableModel != null) point.capableModel = r.capableModel;
    if (r.routingFamily != null) point.routingFamily = r.routingFamily;
    if (r.routingTier != null) point.routingTier = r.routingTier;
    if (r.routingTierRaw != null) point.routingTierRaw = r.routingTierRaw;
    if (r.routedModel != null) point.routedModel = r.routedModel;
    if (r.classifierModel != null) point.classifierModel = r.classifierModel;
    if (r.routerType != null) point.routerType = r.routerType;
    if (r.routerScore != null) point.routerScore = r.routerScore;
    if (r.routingConfidence != null) point.routingConfidence = r.routingConfidence;
    if (r.routingSource != null) point.routingSource = r.routingSource;
    if (r.signalScore != null) point.signalScore = r.signalScore;
    if (r.signalConfidence != null) point.signalConfidence = r.signalConfidence;
    if (r.signalSeverity != null) point.signalSeverity = r.signalSeverity;
    if (r.signalSpinning != null) point.signalSpinning = r.signalSpinning;
    if (r.signalExploring != null) point.signalExploring = r.signalExploring;
    if (r.signalProductionIntensity != null) point.signalProductionIntensity = r.signalProductionIntensity;
    if (r.judgePSolve != null) point.judgePSolve = r.judgePSolve;
    if (r.judgeCrux != null) point.judgeCrux = r.judgeCrux;
    if (r.judgePrimaryRule != null) point.judgePrimaryRule = r.judgePrimaryRule;
    if (r.judgeCapabilityBoundary != null) point.judgeCapabilityBoundary = r.judgeCapabilityBoundary;
    if (r.decisionSource != null) point.decisionSource = r.decisionSource;
    return point;
  });
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

/**
 * Attribute cost to a `skill` dispatch from the session's OWN already-priced usage records
 * whose timestamp falls inside the skill's [start, start + durationMs] window. Skills run
 * inline in the parent transcript (no separate subagent log to pull tokens from), so this is a
 * re-attribution of tokens already counted in the session total — same "ALLOCATION, don't add
 * to `seen`" semantics as the agent-dispatch path below. A dispatch with durationMs === 0 (no
 * matching tool_result found — see dispatch-extractor.ts) has no window to attribute from and is
 * left as "unknown" (absent costUSD/tokens), not zero.
 */
function enrichSkillDispatchCost(dispatch: DispatchEventRaw, sessionRecords: UsageRecord[]): void {
  if (!dispatch.durationMs) return;
  const windowEnd = dispatch.start + dispatch.durationMs;
  const matched = sessionRecords.filter((r) => r.ts != null && r.ts >= dispatch.start && r.ts <= windowEnd);
  if (!matched.length) return;

  const usageByModel = sumUsageRecords(matched);
  let totalCost = 0;
  let totalTokens = emptyUsage();
  let priced = false;
  for (const [rawModel, usage] of usageByModel) {
    const model = normalizeModelName(rawModel);
    const price = lookupPrice(model);
    if (price) {
      totalCost += costBreakdown(usage, price).total;
      priced = true;
    }
    totalTokens = addUsage(totalTokens, usage);
  }
  if (priced) dispatch.costUSD = Math.round(totalCost * 1e8) / 1e8;
  dispatch.tokens = totalTokens;
}

/**
 * Second-pass enrichment: for each agent dispatch that has a matching subagent entry
 * (linked by toolUseId from the .meta.json), extract usage from the subagent's messages,
 * price it, and attach costUSD + tokens + tools to the dispatch event in place.
 *
 * The per-dispatch cost is an ALLOCATION of already-counted session tokens (subagents are
 * included in the session total via allMessageArrays). Do NOT add to `seen` here.
 */
function enrichDispatchCosts(
  dispatches: DispatchEventRaw[],
  parsed: ParsedSession,
  agentName: string,
  sessionRecords: UsageRecord[]
): void {
  const byToolUseId = new Map<string, { messages: unknown[] }>();
  for (const sub of parsed.subagents ?? []) {
    if (sub.toolUseId && Array.isArray(sub.messages)) {
      byToolUseId.set(sub.toolUseId, sub);
    }
  }

  for (const dispatch of dispatches) {
    if (dispatch.kind === 'skill') {
      enrichSkillDispatchCost(dispatch, sessionRecords);
      continue;
    }
    if (dispatch.kind !== 'agent' || !dispatch._toolUseId) continue;
    const sub = byToolUseId.get(dispatch._toolUseId);
    if (!sub) continue;

    const subSeen = new Set<string>();
    const usageAgent = isCodexFamilyAgent(agentName) ? 'codex' : 'claude';
    const records = gatherDedupedUsageRecords(
      usageAgent,
      { sessionId: '', agentName: usageAgent, metadata: {}, messages: sub.messages } as unknown as ParsedSession,
      subSeen,
    );

    if (records.length) {
      const usageByModel = sumUsageRecords(records);
      let totalCost = 0;
      let totalTokens = emptyUsage();
      let priced = false;
      for (const [rawModel, usage] of usageByModel) {
        const model = normalizeModelName(rawModel);
        const price = lookupPrice(model);
        if (price) { totalCost += costBreakdown(usage, price).total; priced = true; }
        totalTokens = addUsage(totalTokens, usage);
      }
      if (priced) dispatch.costUSD = Math.round(totalCost * 1e8) / 1e8;
      dispatch.tokens = totalTokens;
    }

    const toolCounts: Record<string, number> = {};
    const agentKey = agentName.toLowerCase();
    if (isCodexFamilyAgent(agentKey)) {
      for (const raw of sub.messages as Array<{ type?: string; payload?: { type?: string; name?: string } }>) {
        if (raw.type === 'response_item' && raw.payload?.type === 'function_call' && raw.payload.name) {
          const name = raw.payload.name.toLowerCase();
          toolCounts[name] = (toolCounts[name] || 0) + 1;
        }
      }
    } else {
      for (const raw of sub.messages as Array<{ message?: { content?: unknown } }>) {
        const content = raw.message?.content;
        if (!Array.isArray(content)) continue;
        for (const b of content as Array<{ type?: string; name?: string }>) {
          if (b.type === 'tool_use' && b.name) {
            toolCounts[b.name] = (toolCounts[b.name] || 0) + 1;
          }
        }
      }
    }
    const tools = Object.entries(toolCounts)
      .map(([name, calls]) => ({ name, calls }))
      .sort((a, b) => b.calls - a.calls)
      .slice(0, 8);
    if (tools.length) dispatch.tools = tools;
  }
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
    let records: UsageRecord[] = [];
    try {
      // Gather ordered, deduped records ONCE per session (consumes keys in `seen`). When there
      // are records (Claude per-message path) sum them for the map + build the series from the
      // SAME records — so the series endpoint equals the session cost. The summed-gatherer
      // fallback runs only when there are no records (SDK rollup / gemini / no-reader), paths
      // that never touch `seen`, so there is no double-dedup. The same `records` are reused
      // below to attribute cost to `skill` dispatches within their time window.
      records = entry.parsed ? gatherDedupedUsageRecords(entry.agentName, entry.parsed, seen) : [];
      if (records.length) {
        usageByModel = sumUsageRecords(records);
        series = buildCostSeries(records);
        // Codex sub-agent rollouts are linked to the parent but their tokens are NOT in the
        // parent's per-turn records (parent transcript only). Fold them into the session total
        // here so sub-agent spend is counted; the per-turn series stays parent-only by design.
        if (entry.parsed && isCodexFamilyAgent(entry.agentName)) {
          for (const [model, usage] of readCodexSubagentUsage(entry.parsed)) {
            usageByModel.set(model, usageByModel.has(model) ? addUsage(usageByModel.get(model)!, usage) : usage);
          }
        }
      } else {
        usageByModel = entry.parsed ? gatherUsageDeduped(entry.agentName, entry.parsed, seen) : new Map<string, TokenUsage>();
      }
    } catch (e) {
      // One malformed log must not abort the whole report — degrade to "no usage" for this
      // session, consistent with the parse/discover paths that already catch and continue.
      logger.debug(`[cost] usage extraction failed for ${entry.sessionId}:`, e);
      usageByModel = new Map<string, TokenUsage>();
      series = [];
      records = [];
    }
    const { cost, unpriced: u } = priceUsage(entry.sessionId, entry.hadLog, usageByModel);
    if (series.length) {
      cost.costSeries = series;
    }
    if (records.length) {
      const timeline = buildModelTimeline(records);
      if (timeline.length) cost.modelTimeline = timeline;
      // Accumulate classifier (routing LLM) cost and tokens from per-turn metadata.
      let judgeCostUSD = 0;
      let judgeInputTokens = 0;
      let judgeOutputTokens = 0;
      let judgeCachedTokens = 0;
      let judgeCacheCreationTokens = 0;
      // A session is only "cost known" if every routed turn reported its classifier cost.
      // One unreported turn makes the session total an understatement, not a measurement.
      let routedTurns = 0;
      let costKnownTurns = 0;
      for (const r of records) {
        judgeCostUSD += r.judgeCostUSD ?? 0;
        judgeInputTokens += r.judgeInputTokens ?? 0;
        judgeOutputTokens += r.judgeOutputTokens ?? 0;
        judgeCachedTokens += r.judgeCachedTokens ?? 0;
        judgeCacheCreationTokens += r.judgeCacheCreationTokens ?? 0;
        if (r.routingFamily != null) {
          routedTurns++;
          if (r.routingCostKnown) costKnownTurns++;
        }
      }
      if (routedTurns > 0) {
        cost.routingCostKnown = costKnownTurns === routedTurns;
      }
      if (judgeInputTokens > 0 || judgeOutputTokens > 0 || judgeCostUSD > 0) {
        cost.judgeCostUSD = Math.round(judgeCostUSD * 1e8) / 1e8;
        cost.judgeInputTokens = judgeInputTokens;
        cost.judgeOutputTokens = judgeOutputTokens;
        if (judgeCachedTokens > 0) cost.judgeCachedTokens = judgeCachedTokens;
        if (judgeCacheCreationTokens > 0) cost.judgeCacheCreationTokens = judgeCacheCreationTokens;
        // Include routing cost in the session total.
        cost.costUSD = Math.round((cost.costUSD + judgeCostUSD) * 1e8) / 1e8;
      }
    }
    if (entry.parsed) {
      // Usage provenance from the adapter: lets the report distinguish "cost is genuinely
      // zero" from "cost is unmeasurable", and surface a provider's own billing unit.
      const meta = entry.parsed.usageMeta;
      if (meta?.premiumRequests !== undefined) {
        cost.premiumRequests = meta.premiumRequests;
      }
      if (meta?.usagePartial) {
        cost.usagePartial = true;
      }
      if (meta?.usageUnavailableReason) {
        cost.usageUnavailableReason = meta.usageUnavailableReason;
      }

      try {
        const dispatches = extractDispatchEvents(entry.parsed, entry.agentName);
        if (dispatches.length) {
          enrichDispatchCosts(dispatches, entry.parsed, entry.agentName, records);
          // Strip internal _toolUseId before storing in the public cost index
          cost.dispatches = dispatches.map(({ _toolUseId: _id, ...d }) => d);
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
