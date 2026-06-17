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
  tokens: TokenUsage;
  costUSD: number;
  cacheReadCostUSD: number; // USD attributable to cache reads (subset of costUSD)
  perModelCost: ModelCost[];
  costSeries?: CostSeriesPoint[]; // per-turn cumulative cost/token growth; absent when no per-turn data
  dispatches?: DispatchEvent[]; // timed top-level agent/skill/command invocations; absent when none
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
}

export interface ReportPayload {
  meta: ReportMeta;
  sessions: ReportSessionRecord[];
}
