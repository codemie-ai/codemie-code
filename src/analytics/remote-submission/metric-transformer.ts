/**
 * Metric Transformer - Backend-Aligned Pattern
 *
 * Transforms CodemieSession raw events into backend-aligned metric payloads
 * following the approved 3+1 metric pattern:
 * - codemie_tools_usage_total (success with ALL details)
 * - codemie_tools_usage_tokens (optional, when available)
 * - codemie_tools_usage_errors_total (failures with details)
 * - codemie_coding_agent_usage (session aggregation)
 */

import type {
  CodemieSession,
  CodemieMessage,
  CodemieToolCall,
  CodemieFileModification
} from '../aggregation/types.js';
import type {
  MetricPayload,
  BaseMetricAttributes,
  ToolSuccessAttributes,
  TokenMetricAttributes,
  ToolErrorAttributes,
  SessionMetricAttributes
} from './types.js';

/**
 * Helper: Truncate strings to 500 chars (Elasticsearch limit)
 */
function truncate(str: string | undefined, maxLength = 500): string {
  if (!str) return '';
  return str.length > maxLength ? str.substring(0, maxLength) : str;
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
 * Transform CodemieSession raw events to backend-aligned metrics
 *
 * CRITICAL: CodemieSession contains AGGREGATED data. We extract individual
 * tool call events from raw JSONL files for granular metrics.
 *
 * This function implements the APPROVED backend pattern with 3+1 metrics:
 * - codemie_tools_usage_total (success with ALL details)
 * - codemie_tools_usage_tokens (optional, if tokens available)
 * - codemie_tools_usage_errors_total (failures with details)
 * - codemie_coding_agent_usage (session aggregation)
 */
export function transformSessionToMetrics(
  session: CodemieSession,
  rawData: {
    messages: CodemieMessage[];
    toolCalls: CodemieToolCall[];
    fileModifications: CodemieFileModification[];
  },
  config: {
    userId: string;
    userName: string;
  }
): MetricPayload[] {
  const metrics: MetricPayload[] = [];

  // Base attributes (following backend pattern)
  const baseAttributes: Omit<BaseMetricAttributes, 'tool_name' | 'count'> = {
    tool_type: 'cli',
    agent: session.agent,
    agent_version: session.agentVersion,
    llm_model: truncate(session.model),
    user_id: config.userId,
    user_name: config.userName,
    project: truncate(session.projectPath, 500),
    session_id: session.sessionId,
  };

  // ========================================================================
  // 1. TOOL EXECUTION SUCCESS (with ALL details) - Backend Pattern
  // ========================================================================
  for (const toolCall of rawData.toolCalls) {
    if (toolCall.status === 'success') {
      // Find associated file modifications for this tool call
      const fileChanges = rawData.fileModifications.filter(
        fm => fm.toolCallId === toolCall.toolCallId
      );

      // Calculate aggregated file stats for this tool call
      const linesAdded = fileChanges.reduce((sum, fm) => sum + fm.linesAdded, 0);
      const linesRemoved = fileChanges.reduce((sum, fm) => sum + fm.linesRemoved, 0);

      // Get first file's metadata (if multiple files, use primary file)
      const primaryFile = fileChanges[0];

      const successAttributes: ToolSuccessAttributes = {
        ...baseAttributes,
        tool_name: toolCall.toolName,
        duration_ms: toolCall.durationMs || 0,
        count: 1,
      };

      // Add file modification details (optional - only if file was modified)
      if (primaryFile) {
        successAttributes.file_extension = primaryFile.fileExtension;
        successAttributes.operation = primaryFile.operation;
        successAttributes.lines_added = linesAdded;
        successAttributes.lines_removed = linesRemoved;
        successAttributes.was_new_file = primaryFile.wasNewFile;
      }

      metrics.push({
        metric_name: 'codemie_tools_usage_total',
        attributes: successAttributes as unknown as Record<string, string | number | boolean>,
        time: toolCall.timestamp.toISOString(),
      });

      // 2. Token consumption (optional - only if available)
      // Note: Tool-level tokens are in the message that contains the tool call
      const message = rawData.messages.find(m => m.messageId === toolCall.messageId);
      if (message?.tokens?.output && message.tokens.output > 0) {
        const tokenAttributes: TokenMetricAttributes = {
          ...baseAttributes,
          tool_name: toolCall.toolName,
          input_tokens: message.tokens.input ?? 0,
          output_tokens: message.tokens.output,
          cache_read_input_tokens: message.tokens.cacheRead ?? 0,
          count: message.tokens.output,
        };

        metrics.push({
          metric_name: 'codemie_tools_usage_tokens',
          attributes: tokenAttributes as unknown as Record<string, string | number | boolean>,
          time: toolCall.timestamp.toISOString(),
        });
      }
    } else {
      // ========================================================================
      // 3. TOOL EXECUTION FAILURE - Backend Pattern
      // ========================================================================
      const errorAttributes: ToolErrorAttributes = {
        ...baseAttributes,
        tool_name: toolCall.toolName,
        error: truncate(toolCall.error || 'Unknown error', 200),
        status: 'failure',
        duration_ms: toolCall.durationMs || 0,
        count: 1,
      };

      metrics.push({
        metric_name: 'codemie_tools_usage_errors_total',
        attributes: errorAttributes as unknown as Record<string, string | number | boolean>,
        time: toolCall.timestamp.toISOString(),
      });
    }
  }

  return metrics;
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
  config: {
    userId: string;
    userName: string;
  },
  options: {
    status: 'completed' | 'timeout' | 'resumed';
    exitReason: string;
    isFinal: boolean;
  }
): MetricPayload {
  const sessionAttributes: SessionMetricAttributes = {
    // Base context (no tool_type for session metric)
    user_id: config.userId,
    user_name: config.userName,
    agent: session.agent,
    agent_version: session.agentVersion,
    llm_model: truncate(session.model),
    project: truncate(session.projectPath, 500),
    session_id: session.sessionId,

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
    total_money_spent: 0, // Cost calculation removed - handled by backend
    total_cached_tokens_money_spent: 0, // Cost calculation removed - handled by backend

    // Code totals
    files_created: session.fileStats?.filesCreated || 0,
    files_modified: session.fileStats?.filesModified || 0,
    files_deleted: session.fileStats?.filesDeleted || 0,
    total_lines_added: session.fileStats?.totalLinesAdded || 0,
    total_lines_removed: session.fileStats?.totalLinesRemoved || 0,

    // Performance
    session_duration_ms: session.durationMs || 0,
    total_execution_time: calculateTotalExecutionTime(rawData.toolCalls),

    // Status
    exit_reason: truncate(options.exitReason),
    had_errors: session.hadErrors,
    status: options.status,
    is_final: options.isFinal,

    count: 1,
  };

  return {
    metric_name: 'codemie_coding_agent_usage',
    attributes: sessionAttributes as unknown as Record<string, string | number | boolean>,
    time: (session.endTime || new Date()).toISOString(),
  };
}
