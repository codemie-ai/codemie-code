/**
 * The JSON `codemie analytics view` writes. CodeMie Connect renders these numbers as they are,
 * so field names and units are a contract: change them only with a new schema version.
 *
 * Units: money in USD, times in epoch ms, durations in ms. A `…Rate` or `…Pct` is a percent
 * (0–100) rounded as the HTML report shows it; a `share…`/`…Share`/`share` is a fraction (0–1).
 */

import type { ReportSessionRecord } from '../report/types.js';

export const SUMMARY_SCHEMA = 'codemie.analytics.summary/1';
export const SESSION_SCHEMA = 'codemie.analytics.session/1';

/** Which sessions count: `from`/`to` bound `startTime` inclusively; text filters match as `filterRecords` says. */
export interface ViewFilter {
  from?: number;
  to?: number;
  agent?: string;
  project?: string;
  branch?: string;
}

export interface SummaryTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  total: number;
}

export interface SummaryTotals {
  sessions: number;
  /** Sessions whose usage was priced (they have a `costSource`). */
  pricedSessions: number;
  costUSD: number;
  cacheReadCostUSD: number;
  durationMs: number;
  turns: number;
  linesAdded: number;
  linesRemoved: number;
  netLines: number;
  filesChanged: number;
  toolCalls: number;
  /** Percent with one decimal, as `meta.totals.toolSuccessRate`. */
  toolSuccessRate: number;
  tokens: SummaryTokens;
}

/** One session in a list. */
export interface SessionRow {
  sessionId: string;
  title: string;
  agentName: string;
  project: string;
  branch: string;
  models: string[];
  startTime: number;
  durationMs: number;
  turns: number;
  linesAdded: number;
  linesRemoved: number;
  filesChanged: number;
  costUSD: number;
  hadLog: boolean;
  sessionSource: string;
  /** Calls per step kind, counted as the report's skill/agent/command charts count them. */
  steps: { agents: number; skills: number; commands: number };
}

export interface HeavySessionRow extends SessionRow {
  /** Cache-read tokens per turn. */
  contextPerTurn: number;
  /** Cache-read cost over session cost, percent with one decimal. */
  bloatPct: number;
}

export interface SeriesBucket {
  /**
   * First ms of the local calendar day, or of the week starting Monday; the first bucket starts at
   * `range.from` instead when that is later. Buckets are local days, even though a date-only
   * `--from`/`--to` is a UTC day.
   */
  from: number;
  /** Last ms of that day or week; the last bucket ends at `range.to` when that is earlier. */
  to: number;
  sessions: number;
  costUSD: number;
  /** Total tokens. */
  tokens: number;
  durationMs: number;
}

export interface NamedCallStats {
  name: string;
  calls: number;
  /** Sessions with at least one call. */
  sessions: number;
}

export interface AnalyticsSummary {
  schema: typeof SUMMARY_SCHEMA;
  range: { from: number; to: number; bucket: 'day' | 'week' };
  filter: { agent: string | null; project: string | null; branch: string | null };
  coverage: Array<{ agentName: string; sessions: number; priced: number; withLog: number }>;
  totals: SummaryTotals;
  /**
   * Totals of the same-length range just before; null without --compare, when the input does not reach
   * back that far, or when it was generated before 99% of the current range up to now (`meta.generatedAt`).
   */
  previous: SummaryTotals | null;
  /** (current − previous) / previous per field; a field is null when its previous value is 0. */
  change: { costUSD: number | null; sessions: number | null; durationMs: number | null } | null;
  series: SeriesBucket[];
  /** `successRate` is a whole percent, as the report's tool chart. */
  tools: Array<{ name: string; calls: number; success: number; failure: number; successRate: number }>;
  skills: NamedCallStats[];
  agents: NamedCallStats[];
  commands: NamedCallStats[];
  /** `tokens` is the total; `share` is this model's part of all model cost. */
  models: Array<{ model: string; costUSD: number; tokens: number; sessions: number; share: number }>;
  projects: Array<{ project: string; costUSD: number; sessions: number; netLines: number }>;
  /** Agents in the range with every filter but --agent applied, for the agent picker. */
  agentsUsed: Array<{ agentName: string; sessions: number; costUSD: number }>;
  efficiency: {
    /** Null when no file changed. */
    costPerFileUSD: number | null;
    toolSuccessRate: number;
    contextPerTurn: number;
    cacheReadCostShare: number;
    dead: { sessions: number; costUSD: number; shareOfCost: number; shareOfSessions: number; top: SessionRow[] };
    depth: { buckets: Array<{ label: string; sessions: number }>; median: number; average: number };
    heavy: HeavySessionRow[];
  };
  /** Newest first. */
  sessions: SessionRow[];
}

export interface TraceEntry {
  key: string;
  kind: 'agent' | 'skill' | 'command';
  name: string;
  /** `name`, or `name #n` when the same kind and name repeat in the session. */
  label: string;
  level: number;
  parentKey: string | null;
  childKeys: string[];
  /** Why the step could not be placed under a parent, or null. */
  issue: string | null;
}

export interface SessionDetail {
  schema: typeof SESSION_SCHEMA;
  session: ReportSessionRecord;
  trace: TraceEntry[];
}
