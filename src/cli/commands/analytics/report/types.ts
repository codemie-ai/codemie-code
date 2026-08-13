/**
 * The embedded report payload — the single data object baked into the HTML
 * report. The client app reads only this and computes every view from it.
 */

import type { TokenUsage, ModelCost, AgentCoverage, CostSeriesPoint, DispatchEvent } from '../cost/types.js';
import type { ToolStats, NamedInvocationStats } from '../types.js';

/** One flat record per session — the client aggregates everything from these. */
export interface ReportSessionRecord {
  sessionId: string;
  agentName: string;
  provider: string;
  project: string;
  branch: string;
  title: string; // first user prompt, cleaned of command/system XML; '' when none captured
  startTime: number; // unix ms
  durationMs: number;
  turns: number;
  fileOps: number;
  linesAdded: number;
  linesRemoved: number;
  linesModified: number;
  netLines: number;
  filesChanged: number; // distinct paths written or edited (excludes reads)
  filesWritten: number; // distinct paths written
  filesEdited: number; // distinct paths edited
  toolCallsTotal: number;
  toolCallsSuccess: number;
  toolCallsFailure: number;
  models: string[];
  languages: string[];
  tools: ToolStats[];
  skillInvocations: NamedInvocationStats[];
  agentInvocations: NamedInvocationStats[];
  commandInvocations: NamedInvocationStats[];
  /** Tooling/framework classified from the invocation names above — see session-source-detector.ts. */
  sessionSource: string;
  tokens: TokenUsage;
  costUSD: number;
  cacheReadCostUSD: number; // USD attributable to cache reads (subset of costUSD)
  perModelCost: ModelCost[];
  hadLog: boolean; // a native agent log was located for this session (priced<hadLog ⇒ parse/reader gap)
  costSeries?: CostSeriesPoint[]; // per-turn cumulative cost/token growth; absent when no per-turn data
  dispatches?: DispatchEvent[]; // timed top-level agent/skill/command invocations; absent when none

  // === Usage provenance (optional; absent for agents that always record full usage) ===
  /**
   * The provider's own billing unit, when it differs from tokens. Currently only GitHub
   * Copilot CLI ("premium requests") — `costUSD` there is a token-derived estimate for
   * cross-agent comparison, not GitHub's invoice.
   */
  premiumRequests?: number;
  /** True when usage was reconstructed from partial data and understates actual use. */
  usagePartial?: boolean;
  /** Why this session shows no tokens or cost; absent when priced. */
  usageUnavailableReason?: string;
}

export interface ReportMeta {
  generatedAt: string; // ISO
  rangeLabel: string; // e.g. "last 30d" or "all"
  agents: string[]; // distinct agents present
  projectFilter: string; // applied --project or "all"
  totals: {
    sessions: number;
    durationMs: number;
    turns: number;
    files: number;
    netLines: number;
    toolCallsTotal: number;
    toolSuccessRate: number;
    totalCostUSD: number;
    cacheReadCostUSD: number;
    pricedSessions: number;
  };
  unpricedModels: string[];
  coverage: AgentCoverage[]; // per-agent priced/total — "which tools are included"
  userEmail?: string;   // identity of the report owner; absent when not authenticated
  periodStart?: string; // ISO — start of the reported range; always present when the report contains any sessions
  periodEnd?: string;   // ISO — end of the reported range; always present when the report contains any sessions
}

export interface ReportPayload {
  meta: ReportMeta;
  sessions: ReportSessionRecord[];
}
