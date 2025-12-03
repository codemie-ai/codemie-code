/**
 * Remote Metrics Submission - Type Definitions
 *
 * Backend-aligned metric payload structures for submitting to /v1/metrics endpoint
 */

// ============================================================================
// Metric Payload Types (Backend-Aligned)
// ============================================================================

/**
 * Metric names following backend convention
 */
export type MetricName =
  | 'codemie_tools_usage_total'           // Tool execution success with ALL details
  | 'codemie_tools_usage_tokens'          // Token consumption
  | 'codemie_tools_usage_errors_total'    // Tool execution failures
  | 'codemie_coding_agent_usage';         // Session aggregation

/**
 * Base metric payload structure (what gets sent to /v1/metrics)
 */
export interface MetricPayload {
  metric_name: MetricName;
  attributes: Record<string, string | number | boolean>;
  time: string;  // ISO 8601
}

/**
 * Core attributes shared across all CLI tool metrics
 */
export interface BaseMetricAttributes {
  // Tool identification
  tool_name: string;
  tool_type: 'cli';

  // Agent context
  agent: string;
  agent_version: string;

  // LLM model
  llm_model: string;

  // User identification
  user_id: string;
  user_name: string;

  // Project context
  project: string;

  // Session context
  session_id: string;

  // Always present
  count: number;
}

/**
 * Tool execution success metric attributes (with ALL details)
 */
export interface ToolSuccessAttributes extends BaseMetricAttributes {
  // Performance (always present)
  duration_ms: number;

  // File modification (optional - only if file was modified)
  file_extension?: string;
  operation?: 'create' | 'update' | 'delete';
  lines_added?: number;
  lines_removed?: number;
  was_new_file?: boolean;
}

/**
 * Token consumption metric attributes
 */
export interface TokenMetricAttributes extends Omit<BaseMetricAttributes, 'count'> {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  count: number;  // = output_tokens
}

/**
 * Tool execution failure metric attributes
 */
export interface ToolErrorAttributes extends BaseMetricAttributes {
  error: string;
  status: 'failure';
  duration_ms: number;
}

/**
 * Session aggregation metric attributes (no tool_name, different structure)
 */
export interface SessionMetricAttributes {
  // Base context (no tool_type for session metric)
  user_id: string;
  user_name: string;
  agent: string;
  agent_version: string;
  llm_model: string;
  project: string;
  session_id: string;

  // Interaction tracking
  total_user_prompts: number;
  total_ai_requests: number;
  total_ai_responses: number;
  total_tool_calls: number;
  successful_tool_calls: number;
  failed_tool_calls: number;

  // Token totals
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_input_tokens: number;
  total_money_spent: number;
  total_cached_tokens_money_spent: number;

  // Code totals
  files_created: number;
  files_modified: number;
  files_deleted: number;
  total_lines_added: number;
  total_lines_removed: number;

  // Performance
  session_duration_ms: number;
  total_execution_time: number;

  // Status
  exit_reason: string;
  had_errors: boolean;
  status: 'completed' | 'timeout' | 'resumed';
  is_final?: boolean;  // true if explicitly ended, false if timeout

  count: number;  // Always 1
}

// ============================================================================
// Cursor State (Event-Level Tracking)
// ============================================================================

/**
 * Root cursor state file structure
 */
export interface CursorState {
  version: number;
  lastRun: string;
  agents: Record<string, AgentCursorState>;
  stats: {
    totalSessionsSubmitted: number;
    totalMetricsSubmitted: number;
    consecutiveFailures: number;
  };
}

/**
 * Per-agent cursor state
 */
export interface AgentCursorState {
  lastScan: string;
  sessions: Record<string, SessionSubmissionState>;
}

/**
 * Per-session submission tracking (event-level)
 */
export interface SessionSubmissionState {
  submitted: boolean;
  timestamp: string;

  // Track individual events sent (prevents duplicates)
  sentEventIds: {
    messages: string[];      // Message IDs already sent
    toolCalls: string[];     // Tool call IDs already sent
  };

  // Track session metric lifecycle
  sessionMetrics: {
    timeoutSent: boolean;       // Sent due to 24h inactivity
    resumedSent: boolean;       // Sent due to resume after timeout
    completedSent: boolean;     // Sent due to explicit endTime
  };

  lastActivityTime: string;     // Last detected activity
  metricsSubmitted: number;     // Total metrics sent
  lastUpdate: string;           // Last time we processed

  // Optional metadata
  projectHash?: string;
  failureCount?: number;
  lastAttempt?: string;
}

// ============================================================================
// Lock Management
// ============================================================================

/**
 * Lock file information
 */
export interface LockInfo {
  pid: number;
  timestamp: string;
  hostname: string;
  agent: string;
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Remote submission configuration
 */
export interface RemoteSubmissionConfig {
  enabled: boolean;
  target: 'local' | 'remote' | 'both';  // Where to write metrics
  baseUrl?: string;         // AI-Run SSO base URL (optional for local-only)
  cookies?: string;         // SSO cookies (optional for local-only)
  interval: number;         // Submission interval (ms)
  batchSize: number;        // Metrics per batch
}

// ============================================================================
// Session Status
// ============================================================================

/**
 * Session activity status
 */
export type SessionStatus =
  | 'active'           // Recently updated (< 30 min)
  | 'inactive'         // No updates for 30 min - 24 hours
  | 'ended'            // No updates for > 24 hours OR explicit endTime
  | 'final';           // Session metric sent

/**
 * Session timeouts
 */
export const SESSION_TIMEOUTS = {
  INACTIVE: 30 * 60 * 1000,      // 30 minutes - consider inactive
  ENDED: 24 * 60 * 60 * 1000,    // 24 hours - consider ended
} as const;
