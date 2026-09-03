/**
 * Analytics types and interfaces
 * Reuses core types from src/agents/core/metrics/types.ts
 */

import type {
  MetricDelta,
  SyncStatus,
  FileOperation,
  ToolStatus
} from '../../../agents/core/metrics/types.js';

// Re-export core types used by analytics
export type { MetricDelta, SyncStatus, FileOperation, ToolStatus };

/**
 * Model usage statistics
 */
export interface ModelStats {
  model: string;
  calls: number;
  percentage: number;
  tokens?: import('./cost/types.js').TokenUsage;
  costUSD?: number;
}

/**
 * Tool usage statistics
 * Extends the concept from ToolUsageSummary but optimized for analytics
 */
export interface ToolStats {
  toolName: string;
  totalCalls: number;
  successCount: number;
  failureCount: number;
  successRate: number;
}

/**
 * Named invocation statistics — skill names, agent subtypes, or slash commands.
 * successCount equals totalCalls because MetricDelta does not track per-name failures.
 */
export interface NamedInvocationStats {
  name: string;
  totalCalls: number;
  successCount: number;
  failureCount: number;
}

/**
 * Language/Format statistics
 */
export interface LanguageStats {
  language: string;
  filesCreated: number;
  filesModified: number;
  linesAdded: number;
  linesRemoved: number;
  percentage: number;
}

/**
 * File operation summary
 * Aggregates FileOperation records per file path
 */
export interface FileOperationSummary {
  filePath: string;
  operationCount: number;
  linesAdded: number;
  linesRemoved: number;
  linesModified: number;
  netLinesChanged: number;
}

/**
 * Session-level analytics
 * Built from aggregating MetricDelta records
 */
export interface SessionAnalytics {
  sessionId: string;
  agentName: string;
  provider: string;
  workingDirectory: string;
  /** Human-readable session title — the first user prompt, with command/system XML stripped. Empty when no prompt was captured. */
  title: string;
  /** The branch the session did the most work on (modal of its deltas' gitBranch). */
  primaryBranch: string;
  startTime: number;
  endTime: number;
  /** Wall-clock span: endTime − startTime (or endEvent.data.duration). Counts idle/overnight
   *  gaps — a session resumed across days reports a "duration" far larger than any time
   *  actually spent working. See {@link activeDurationMs} for CodeMie's tracked active time. */
  duration: number;
  /** CodeMie's own tracked active time, ms — present only when the source session JSON
   *  carried `activeDurationMs`. Session-level only: deliberately not rolled up into branch/
   *  project/root aggregates, which have their own known double-counting issue for a session
   *  touching multiple branches (aggregateBranchFromDeltas) that this field must not inherit. */
  activeDurationMs?: number;

  // Counts
  totalTurns: number;
  totalFileOperations: number;
  totalLinesAdded: number;
  totalLinesRemoved: number;
  totalLinesModified: number;
  netLinesChanged: number;

  // Change-metric breakdown (distinct paths by op type; read/glob/grep excluded)
  filesChanged: number;  // distinct paths with a write OR edit op
  filesWritten: number;  // distinct paths with a write op
  filesEdited: number;   // distinct paths with an edit op

  totalToolCalls: number;
  successfulToolCalls: number;
  failedToolCalls: number;
  toolSuccessRate: number;

  // Model distribution (from MetricDelta.models)
  models: ModelStats[];

  // Tool usage (from MetricDelta.tools and toolStatus)
  tools: ToolStats[];

  // File operations (from MetricDelta.fileOperations)
  files: FileOperationSummary[];

  // Language breakdown (from FileOperation.language)
  languages: LanguageStats[];

  // Format breakdown (from FileOperation.format)
  formats: LanguageStats[];

  // Named invocation breakdowns (from MetricDelta.skillInvocations / agentInvocations / commandInvocations)
  skillInvocations: NamedInvocationStats[];
  agentInvocations: NamedInvocationStats[];
  commandInvocations: NamedInvocationStats[];

  // Token usage and cost (optional; populated only for the HTML report path)
  tokens?: import('./cost/types.js').TokenUsage;
  costUSD?: number;
  agentSessionFile?: string; // native log path used for cost pricing; absent when none resolved
}

/**
 * Branch-level analytics
 */
export interface BranchAnalytics {
  branchName: string;
  sessions: SessionAnalytics[];

  // Aggregated stats
  totalSessions: number;
  totalDuration: number;
  totalTurns: number;
  totalFileOperations: number;
  totalLinesAdded: number;
  totalLinesRemoved: number;
  totalLinesModified: number;
  netLinesChanged: number;
  totalToolCalls: number;
  successfulToolCalls: number;
  failedToolCalls: number;
  toolSuccessRate: number;

  // Aggregated distributions
  models: ModelStats[];
  tools: ToolStats[];
  languages: LanguageStats[];
  formats: LanguageStats[];
}

/**
 * Project-level analytics
 */
export interface ProjectAnalytics {
  projectPath: string;
  branches: BranchAnalytics[];

  // Aggregated stats
  totalSessions: number;
  totalDuration: number;
  totalTurns: number;
  totalFileOperations: number;
  totalLinesAdded: number;
  totalLinesRemoved: number;
  totalLinesModified: number;
  netLinesChanged: number;
  totalToolCalls: number;
  successfulToolCalls: number;
  failedToolCalls: number;
  toolSuccessRate: number;

  // Aggregated distributions
  models: ModelStats[];
  tools: ToolStats[];
  languages: LanguageStats[];
  formats: LanguageStats[];
}

/**
 * Root-level analytics (all projects)
 */
export interface RootAnalytics {
  projects: ProjectAnalytics[];

  // Aggregated stats
  totalSessions: number;
  totalDuration: number;
  totalTurns: number;
  totalFileOperations: number;
  totalLinesAdded: number;
  totalLinesRemoved: number;
  totalLinesModified: number;
  netLinesChanged: number;
  totalToolCalls: number;
  successfulToolCalls: number;
  failedToolCalls: number;
  toolSuccessRate: number;

  // Aggregated distributions
  models: ModelStats[];
  tools: ToolStats[];
  languages: LanguageStats[];
  formats: LanguageStats[];
}

/**
 * Analytics filter options
 */
export interface AnalyticsFilter {
  sessionId?: string;
  projectPattern?: string;
  agentName?: string;
  fromDate?: Date;
  toDate?: Date;
  branch?: string;
}

/**
 * Analytics command options
 */
export interface AnalyticsOptions {
  session?: string;
  project?: string;
  agent?: string;
  from?: string;
  to?: string;
  last?: string;
  branch?: string;
  verbose?: boolean;
  export?: 'json' | 'csv';
  output?: string;
  report?: boolean;
  open?: boolean;
  reportOutput?: string;
  /** Report serialization selector (default 'html'). 'json' writes the cost-enriched payload; 'both' writes html + json. */
  reportFormat?: 'html' | 'json' | 'both';
  /** When false (via --no-scan-native), skip native-log discovery and use tracked sessions only. */
  scanNative?: boolean;
  /** When true (via --include-external), include non-CodeMie-owned native sessions in output (matches pre-fix behavior). */
  includeExternal?: boolean;
}

/** Options for the `analytics otel` subcommand: the shared base plus OTEL-specific flags. */
export interface OtelCommandOptions extends AnalyticsOptions {
  /** Path to the flattened OTEL events file (required). */
  file: string;
  /** Scope OTEL analytics to one user (matches native user.email or user.id). */
  user?: string;
}
