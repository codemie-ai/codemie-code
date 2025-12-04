/**
 * Metric Transformer - Backend-Aligned Pattern
 *
 * Transforms CodemieSession raw events into backend-aligned metric payloads
 * generating only session-level aggregation metrics:
 * - codemie_coding_agent_usage_total (session aggregation)
 */

import { sep } from 'node:path';
import type {
  CodemieSession,
  CodemieMessage,
  CodemieToolCall,
  CodemieFileModification
} from '../aggregation/types.js';
import type {
  MetricPayload,
  SessionMetricAttributes
} from './types.js';


/**
 * Helper: Normalize project path to relative format (cross-platform)
 * "/Users/John_Doe/repos/codemie-ai/codemie-code" -> "codemie-ai/codemie-code"
 * "C:\Users\John_Doe\repos\codemie-ai\codemie-code" -> "codemie-ai/codemie-code"
 */
function normalizeProjectPath(fullPath: string): string {
  // Split by platform-specific separator
  const parts = fullPath.split(sep);
  // Get last 2 parts (organization/project) and join with forward slash
  return parts.slice(-2).join('/');
}

/**
 * Helper: Estimate API requests from messages
 * Heuristic: Usually 1-2 API calls per assistant message
 */
function estimateAPIRequests(session: CodemieSession): number {
  return Math.ceil(session.assistantMessageCount * 1.5);
}


/**
 * Helper: Calculate total execution time from tool calls
 */
function calculateTotalExecutionTime(toolCalls: CodemieToolCall[]): number {
  return toolCalls.reduce((sum, tc) => sum + (tc.durationMs || 0), 0);
}

/**
 * Create session aggregation metric
 * Only called when session ends (explicit endTime or timeout)
 */
export function createSessionMetric(
  session: CodemieSession,
  rawData: {
    messages: CodemieMessage[];
    toolCalls: CodemieToolCall[];
    fileModifications: CodemieFileModification[];
  },
  options: {
    exitReason: string;
  }
): MetricPayload {
  const sessionAttributes: SessionMetricAttributes = {
    // Base context (no tool_type for session metric)
    agent: session.agent,
    agent_version: session.agentVersion,
    llm_model: session.model,
    project: normalizeProjectPath(session.projectPath),
    session_id: session.sessionId,

    // Context (only include if available)
    ...(session.projectHash && { projectHash: session.projectHash }),
    ...(session.gitBranch && { gitBranch: session.gitBranch }),
    ...(session.gitCommit && { gitCommit: session.gitCommit }),

    // Interaction tracking
    total_user_prompts: session.userPromptCount,
    total_ai_requests: estimateAPIRequests(session),
    total_ai_responses: session.assistantMessageCount,
    total_tool_calls: session.toolCallCount,
    successful_tool_calls: session.successfulToolCalls,
    failed_tool_calls: session.failedToolCalls,

    // Token totals
    total_input_tokens: session.tokens.input,
    total_output_tokens: session.tokens.output,
    total_cache_read_input_tokens: session.tokens.cacheRead,

    // Code totals
    files_created: session.fileStats?.filesCreated || 0,
    files_modified: session.fileStats?.filesModified || 0,
    files_deleted: session.fileStats?.filesDeleted || 0,
    total_lines_added: session.fileStats?.totalLinesAdded || 0,
    total_lines_removed: session.fileStats?.totalLinesRemoved || 0,

    // Performance
    session_duration_ms: session.durationMs || 0,
    ...(rawData.toolCalls.some(tc => tc.durationMs) && {
      total_execution_time: calculateTotalExecutionTime(rawData.toolCalls)
    }),

    // Status
    exit_reason: options.exitReason,
    had_errors: session.hadErrors,

    count: 1,
  };

  return {
    metric_name: 'codemie_coding_agent_usage_total',
    attributes: sessionAttributes as unknown as Record<string, string | number | boolean>,
    time: (session.endTime || new Date()).toISOString(),
  };
}
