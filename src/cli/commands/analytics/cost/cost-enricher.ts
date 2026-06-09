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
import type { SessionCost, SessionCostIndex, CostSummary, ModelCost, TokenUsage } from './types.js';
import { emptyUsage, addUsage, costForUsage } from './cost-calculator.js';
import { lookupPrice } from './pricing.js';
import { gatherUsageDeduped } from './usage-readers.js';
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

  for (const [rawModel, usage] of usageByModel) {
    const model = normalizeModelName(rawModel);
    const price = lookupPrice(model);
    const costUSD = price ? costForUsage(usage, price) : 0;
    if (!price) {
      unpriced.push(model);
    }
    perModel.push({ model, tokens: usage, costUSD, unpriced: !price });
    sessionTokens = addUsage(sessionTokens, usage);
    sessionCost += costUSD;
  }

  // "priced" means the agent's usage reader actually yielded model usage. A parsed log
  // for an agent with no reader (codex/opencode → empty map) is hadLog=true but priced=false,
  // so the coverage view shows "no token reader" instead of a misleading "✓ full" at $0.
  return {
    cost: { sessionId, tokens: sessionTokens, costUSD: sessionCost, perModel, priced: perModel.length > 0, hadLog },
    unpriced,
  };
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
    try {
      usageByModel = entry.parsed
        ? gatherUsageDeduped(entry.agentName, entry.parsed, seen)
        : new Map<string, TokenUsage>();
    } catch (e) {
      // One malformed log must not abort the whole report — degrade to "no usage" for this
      // session, consistent with the parse/discover paths that already catch and continue.
      logger.debug(`[cost] usage extraction failed for ${entry.sessionId}:`, e);
      usageByModel = new Map<string, TokenUsage>();
    }
    const { cost, unpriced: u } = priceUsage(entry.sessionId, entry.hadLog, usageByModel);
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
