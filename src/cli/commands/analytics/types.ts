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
 * Token breakdown for aggregated metrics
 * Matches MetricDelta.tokens but adds computed fields
 */
export interface TokenBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  total: number;
  cacheHitRate: number;
}

/**
 * Model usage statistics
 */
export interface ModelStats {
  model: string;
  calls: number;
  percentage: number;
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
 * Language/Format statistics
 */
export interface LanguageStats {
  language: string;
  filesCreated: number;
  filesModified: number;
  linesAdded: number;
  linesRemoved: number;
  tokens: number;
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
  startTime: number;
  endTime: number;
  duration: number;

  // Token metrics (aggregated from MetricDelta.tokens)
  tokens: TokenBreakdown;

  // Counts
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
  totalTokens: TokenBreakdown;
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
  totalTokens: TokenBreakdown;
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
  totalTokens: TokenBreakdown;
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
}
