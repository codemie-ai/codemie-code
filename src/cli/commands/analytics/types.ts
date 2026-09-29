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
  duration: number;

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
  /**
   * `--export [format]`: commander's optional-value option. `undefined` when the flag is
   * absent, `true` when given bare (resolves to 'html'), or the raw string value otherwise
   * (validated against 'html' | 'json' | 'both' at runtime; anything else is rejected).
   */
  export?: string | true;
  /** `-o, --output <path>`: target file or directory for the report (see resolveOutputTargets). */
  output?: string;
  /** @deprecated Alias for a bare `--export` (html report); kept for backward compatibility. Will be removed on November 1, 2026. */
  report?: boolean;
  /** @deprecated Alias for {@link export}; kept for backward compatibility. `--export` wins when both are set. Will be removed on November 1, 2026. */
  reportFormat?: string;
  /** @deprecated Alias for {@link output}; kept for backward compatibility. `-o/--output` wins when both are set. Will be removed on November 1, 2026. */
  reportOutput?: string;
  open?: boolean;
  /** When true (via --include-external), also count native sessions CodeMie did not launch. */
  includeExternal?: boolean;
}

/** Options for the `analytics otel` subcommand: the shared base plus OTEL-specific flags. */
export interface OtelCommandOptions extends AnalyticsOptions {
  /** Path to the flattened OTEL events file (required). */
  file: string;
  /** Scope OTEL analytics to one user (matches native user.email or user.id). */
  user?: string;
}
