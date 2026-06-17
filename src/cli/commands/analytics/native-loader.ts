/**
 * Native session discovery for analytics.
 *
 * The metrics loader only sees sessions CodeMie tracked into ~/.codemie/sessions/.
 * Plain `claude` usage (the Anthropic subscription, not `codemie-claude`) is never
 * tracked, so it is invisible to the report. This module discovers those native agent
 * logs directly (via SessionAdapter.discoverSessions) and synthesizes the same
 * {@link RawSessionData} shape the loader produces, so the whole downstream pipeline
 * (aggregator → formatter/report → cost) sees them too.
 *
 * Native logs already correlated to a tracked CodeMie session are skipped (deduped by
 * real path) so they are not double-counted.
 */

import { realpathSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RawSessionData } from './data-loader.js';
import type { AnalyticsFilter } from './types.js';
import type { MetricDelta } from '../../../agents/core/metrics/types.js';
import type { ParsedSession } from '../../../agents/core/session/BaseSessionAdapter.js';
import type { SessionDescriptor } from '../../../agents/core/session/discovery-types.js';
import { AgentRegistry } from '../../../agents/registry.js';
import { getCodemiePath } from '../../../utils/paths.js';
import { logger } from '../../../utils/logger.js';

/** Agents whose native logs we discover + synthesize. (claude is the gap users hit.) */
const NATIVE_AGENTS = ['claude'] as const;

/** A discovered native session paired with its agent. */
export interface DiscoveredNative {
  agentName: string;
  descriptor: SessionDescriptor;
}

/** Injected boundary so synthesis/dedup logic is unit-testable without fs or the registry. */
export interface NativeLoaderDeps {
  /** Real paths of native logs already tracked by CodeMie (skip these to avoid double counting). */
  trackedLogPaths(): Set<string>;
  /** Discover native sessions for discovery-capable agents within the age window. */
  discover(maxAgeDays: number): Promise<DiscoveredNative[]>;
  /** Parse a native log into a unified session. */
  parse(agentName: string, filePath: string, sessionId: string): Promise<ParsedSession | null>;
  /** Resolve a path to its real (symlink-free) form for dedup comparison. */
  realPath(p: string): string;
}

function safeRealPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Build the set of native log paths already tracked by CodeMie (from session correlations). */
function readTrackedLogPaths(): Set<string> {
  const out = new Set<string>();
  let dir: string;
  try {
    dir = getCodemiePath('sessions');
  } catch {
    return out;
  }
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json') && !f.includes('_metrics'));
  } catch {
    return out;
  }
  for (const f of files) {
    try {
      const meta = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as {
        correlation?: { agentSessionFile?: string };
      };
      const asf = meta.correlation?.agentSessionFile;
      if (asf) {
        out.add(safeRealPath(asf));
      }
    } catch {
      // skip unreadable / malformed metadata
    }
  }
  return out;
}

export const realNativeDeps: NativeLoaderDeps = {
  trackedLogPaths: readTrackedLogPaths,
  async discover(maxAgeDays) {
    const found: DiscoveredNative[] = [];
    for (const agentName of NATIVE_AGENTS) {
      const adapter = AgentRegistry.getAgent(agentName)?.getSessionAdapter?.();
      if (!adapter?.discoverSessions) {
        continue;
      }
      try {
        const descriptors = await adapter.discoverSessions({ maxAgeDays });
        for (const descriptor of descriptors) {
          found.push({ agentName, descriptor });
        }
      } catch (e) {
        logger.debug(`[native] discovery failed for ${agentName}:`, e);
      }
    }
    return found;
  },
  async parse(agentName, filePath, sessionId) {
    const adapter = AgentRegistry.getAgent(agentName)?.getSessionAdapter?.();
    if (!adapter) {
      return null;
    }
    try {
      return await adapter.parseSessionFile(filePath, sessionId);
    } catch (e) {
      logger.debug(`[native] parse failed for ${sessionId}:`, e);
      return null;
    }
  },
  realPath: safeRealPath,
};

interface RawMessage {
  type?: string;
  timestamp?: string | number;
  cwd?: string;
  gitBranch?: string;
  message?: { role?: string; model?: string; content?: unknown };
}

/**
 * The first genuine user prompt text in a native transcript — the session's opening message.
 * Skips messages whose content is a tool_result (role 'user' but not a real prompt) and returns
 * the first string/text-block content found, so the aggregator can derive a session title.
 */
function firstUserText(messages: RawMessage[]): string | undefined {
  for (const m of messages) {
    const role = m.message?.role ?? m.type;
    if (role !== 'user') {
      continue;
    }
    const content = m.message?.content;
    if (typeof content === 'string') {
      if (content.trim()) {
        return content;
      }
      continue;
    }
    if (Array.isArray(content)) {
      const block = content.find(
        (b): b is { type: string; text: string } =>
          !!b && typeof b === 'object' && (b as { type?: string }).type === 'text' && typeof (b as { text?: unknown }).text === 'string'
      );
      if (block && block.text.trim()) {
        return block.text;
      }
    }
  }
  return undefined;
}

function toMs(ts: string | number | undefined): number | null {
  if (ts == null) {
    return null;
  }
  if (typeof ts === 'number') {
    return ts;
  }
  const n = Date.parse(ts);
  return Number.isNaN(n) ? null : n;
}

function isAssistant(m: RawMessage): boolean {
  return m.type === 'assistant' || m.message?.role === 'assistant';
}

/** Most frequent value in a list (ties → first seen), or undefined if empty. */
function modal(values: string[]): string | undefined {
  const counts = new Map<string, number>();
  let best: string | undefined;
  let bestN = 0;
  for (const v of values) {
    const n = (counts.get(v) ?? 0) + 1;
    counts.set(v, n);
    if (n > bestN) {
      bestN = n;
      best = v;
    }
  }
  return best;
}

/**
 * Synthesize a {@link RawSessionData} from a parsed native session. Turns map to assistant
 * messages (the aggregator derives totalTurns from deltas.length), and all per-session metrics
 * (tools / file ops / models) are carried on a single delta — the aggregator sums across deltas,
 * so one metrics-bearing delta plus empty placeholders is equivalent to per-turn deltas.
 */
export function synthesizeRawSession(
  agentName: string,
  descriptor: SessionDescriptor,
  parsed: ParsedSession
): RawSessionData {
  const messages = (parsed.messages ?? []) as RawMessage[];
  const timestamps = messages.map((m) => toMs(m.timestamp)).filter((n): n is number => n != null);
  const startTime = timestamps.length ? Math.min(...timestamps) : descriptor.createdAt;
  const endTime = timestamps.length ? Math.max(...timestamps) : descriptor.updatedAt ?? descriptor.createdAt;

  const cwd = messages.find((m) => m.cwd)?.cwd ?? descriptor.projectPath ?? 'Unknown';
  const branch = modal(messages.map((m) => m.gitBranch).filter((b): b is string => !!b));
  const assistantMsgs = messages.filter(isAssistant);
  const turns = Math.max(assistantMsgs.length, 1);
  const models = assistantMsgs.map((m) => m.message?.model).filter((m): m is string => !!m);
  const openingPrompt = firstUserText(messages);

  const metricsDelta: MetricDelta = {
    recordId: `${descriptor.sessionId}-native`,
    sessionId: descriptor.sessionId,
    agentSessionId: descriptor.sessionId,
    timestamp: startTime,
    gitBranch: branch,
    tools: parsed.metrics?.tools ?? {},
    toolStatus: parsed.metrics?.toolStatus,
    fileOperations: parsed.metrics?.fileOperations as MetricDelta['fileOperations'],
    models,
    // Named invocations are extracted at parse time (claude.session.ts extractMetrics); carry
    // them through so native (untracked) sessions populate the skill/agent/command charts.
    ...(parsed.metrics?.skillInvocations && { skillInvocations: parsed.metrics.skillInvocations }),
    ...(parsed.metrics?.agentInvocations && { agentInvocations: parsed.metrics.agentInvocations }),
    ...(parsed.metrics?.commandInvocations && { commandInvocations: parsed.metrics.commandInvocations }),
    // Opening prompt → drives the session title in the report (aggregator strips command/system XML).
    ...(openingPrompt && { userPrompts: [{ count: 1, text: openingPrompt }] }),
    syncStatus: 'synced',
    syncAttempts: 0,
  };

  // Pad to `turns` deltas so the aggregator's totalTurns (= deltas.length) is correct.
  const deltas: MetricDelta[] = [metricsDelta];
  for (let i = 1; i < turns; i++) {
    deltas.push({
      recordId: `${descriptor.sessionId}-native-${i}`,
      sessionId: descriptor.sessionId,
      agentSessionId: descriptor.sessionId,
      timestamp: startTime,
      gitBranch: branch,
      tools: {},
      syncStatus: 'synced',
      syncAttempts: 0,
    });
  }

  return {
    sessionId: descriptor.sessionId,
    agentSessionFile: descriptor.filePath, // lets the cost enricher price native (untracked) sessions
    startEvent: {
      recordId: descriptor.sessionId,
      type: 'session_start',
      timestamp: startTime,
      codeMieSessionId: descriptor.sessionId,
      agentName,
      syncStatus: 'synced',
      data: { provider: 'native', workingDirectory: cwd, startTime },
    },
    endEvent: {
      recordId: `${descriptor.sessionId}-end`,
      type: 'session_end',
      timestamp: endTime,
      codeMieSessionId: descriptor.sessionId,
      agentName,
      syncStatus: 'synced',
      data: { endTime, duration: Math.max(0, endTime - startTime), totalTurns: turns },
    },
    deltas,
  };
}

/** Number of days from a filter's fromDate to now (for the discovery window), or a wide default. */
function windowDays(filter?: AnalyticsFilter): number {
  if (filter?.fromDate) {
    const days = Math.ceil((Date.now() - filter.fromDate.getTime()) / 86_400_000);
    return Math.max(days + 1, 1);
  }
  return 3650; // no lower bound requested → effectively "all"
}

/**
 * Discover native (untracked) sessions and return them as RawSessionData, ready to merge
 * with the tracked sessions from {@link MetricsDataLoader}. Sessions whose native log is
 * already tracked by CodeMie are skipped (deduped by real path).
 */
export async function loadNativeSessions(
  filter?: AnalyticsFilter,
  deps: NativeLoaderDeps = realNativeDeps
): Promise<RawSessionData[]> {
  const tracked = deps.trackedLogPaths();
  const discovered = await deps.discover(windowDays(filter));

  const out: RawSessionData[] = [];
  for (const { agentName, descriptor } of discovered) {
    if (tracked.has(deps.realPath(descriptor.filePath))) {
      continue; // already tracked by CodeMie — avoid double counting
    }
    const parsed = await deps.parse(agentName, descriptor.filePath, descriptor.sessionId);
    if (!parsed) {
      continue;
    }
    out.push(synthesizeRawSession(agentName, descriptor, parsed));
  }
  return out;
}
