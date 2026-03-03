/**
 * Metrics Sync Types
 *
 * Type definitions for metrics sync API integration
 */

/**
 * Base identity fields shared by all metric types
 */
export interface MetricIdentity {
  agent: string;
  agent_version: string;
  repository: string;
  session_id: string;
  branch: string;
  project?: string;
  count: number;  // Always 1 (Prometheus compatibility)
}

/**
 * Attributes for codemie_cli_session_total
 * Lifecycle events: started, completed, failed, interrupted
 */
export interface SessionLifecycleAttributes extends MetricIdentity {
  llm_model: string;
  status: 'started' | 'completed' | 'failed' | 'interrupted';
  reason?: string;
  session_duration_ms: number;
  had_errors: boolean;
  errors?: Record<string, string[]>;

  // MCP fields (optional, only at session start)
  mcp_total_servers?: number;
  mcp_local_servers?: number;
  mcp_project_servers?: number;
  mcp_user_servers?: number;
  mcp_server_names?: string[];
  mcp_local_server_names?: string[];
  mcp_project_server_names?: string[];
  mcp_user_server_names?: string[];

  // Extensions fields (optional, only at session start)
  agents_project?: number;
  agents_global?: number;
  commands_project?: number;
  commands_global?: number;
  skills_project?: number;
  skills_global?: number;
  hooks_project?: number;
  hooks_global?: number;
  rules_project?: number;
  rules_global?: number;
  agent_names?: string[];
  agents_project_names?: string[];
  agents_global_names?: string[];
  command_names?: string[];
  commands_project_names?: string[];
  commands_global_names?: string[];
  skill_names?: string[];
  skills_project_names?: string[];
  skills_global_names?: string[];
  hook_names?: string[];
  hooks_project_names?: string[];
  hooks_global_names?: string[];
  rule_names?: string[];
  rules_project_names?: string[];
  rules_global_names?: string[];
}

/**
 * Attributes for codemie_cli_tool_usage_total
 * Periodic sync of tool/file metrics (replaces codemie_cli_usage_total)
 * NOTE: No token fields.
 */
export interface ToolUsageAttributes extends MetricIdentity {
  llm_model: string;
  total_user_prompts: number;
  session_duration_ms: number;
  had_errors: boolean;
  errors?: Record<string, string[]>;

  // Tool metrics
  tool_names: string[];
  tool_counts: Record<string, number>;
  total_tool_calls: number;
  successful_tool_calls: number;
  failed_tool_calls: number;

  // File metrics
  files_created: number;
  files_modified: number;
  files_deleted: number;
  total_lines_added: number;
  total_lines_removed: number;
}

/**
 * Union type for backward compatibility during migration
 * @deprecated Use SessionLifecycleAttributes or ToolUsageAttributes directly
 */
export type SessionAttributes = SessionLifecycleAttributes | ToolUsageAttributes;

export interface SessionMetric {
  /**
   * Metric name
   * - 'codemie_cli_session_total': Session lifecycle events (start/end)
   * - 'codemie_cli_tool_usage_total': Aggregated tool usage metrics
   */
  name: string;

  /** Metric attributes */
  attributes: SessionLifecycleAttributes | ToolUsageAttributes;
}

/**
 * API response for successful metrics submission
 * Matches FastAPI MetricsResponse pydantic model
 */
export interface MetricsSyncResponse {
  success: boolean;      // Whether the metric was sent successfully
  message: string;       // Result message
}

/**
 * API error response from FastAPI ExtendedHTTPException
 */
export interface MetricsApiError {
  code: number;          // HTTP status code
  message: string;       // Error message
  details?: string;      // Detailed error information
  help?: string;         // Help text for resolving the error
}

/**
 * Metrics API client configuration
 */
export interface MetricsApiConfig {
  baseUrl: string;       // API base URL
  cookies?: string;      // SSO cookies (session token)
  apiKey?: string;       // API key for localhost development (user-id header)
  timeout?: number;      // Request timeout (ms)
  retryAttempts?: number; // Max retry attempts
  retryDelays?: number[]; // Backoff delays [1s, 2s, 5s]
  version?: string;      // CLI version (from CODEMIE_CLI_VERSION env var)
  clientType?: string;   // Client type (codemie-claude, gemini-cli, etc.)
}
