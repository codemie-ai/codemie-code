/**
 * The embedded report payload — the single data object baked into the HTML
 * report. The client app reads only this and computes every view from it.
 */

import type { TokenUsage, ModelCost, AgentCoverage } from '../cost/types.js';
import type { ToolStats } from '../types.js';

/** One flat record per session — the client aggregates everything from these. */
export interface ReportSessionRecord {
  sessionId: string;
  agentName: string;
  provider: string;
  project: string;
  branch: string;
  startTime: number; // unix ms
  durationMs: number;
  turns: number;
  fileOps: number;
  linesAdded: number;
  linesRemoved: number;
  linesModified: number;
  netLines: number;
  toolCallsTotal: number;
  toolCallsSuccess: number;
  toolCallsFailure: number;
  models: string[];
  languages: string[];
  tools: ToolStats[];
  tokens: TokenUsage;
  costUSD: number;
  perModelCost: ModelCost[];
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
    pricedSessions: number;
  };
  unpricedModels: string[];
  coverage: AgentCoverage[]; // per-agent priced/total — "which tools are included"
}

export interface ReportPayload {
  meta: ReportMeta;
  sessions: ReportSessionRecord[];
}
