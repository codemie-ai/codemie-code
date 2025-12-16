/**
 * Metrics Sync Types
 *
 * Type definitions for metrics sync API integration
 */

/**
 * Session metric sent to CodeMie API
 * Format matches Prometheus-style metrics with attributes
 */
export interface SessionMetric {
  /** Metric name (always 'codemie_coding_agent_usage') */
  name: string;

  /** Metric attributes */
  attributes: SessionAttributes;
}

/**
 * Session attributes for metrics
 */
export interface SessionAttributes {
  // Identity
  agent: string;                         // 'claude', 'gemini', 'codex', 'codemie-code'
  agent_version: string;                 // CLI version
  llm_model: string;                     // Most-used model in session
  repository: string;                    // Repository name (parent/current format)
  session_id: string;                    // Session UUID
  branch: string;                        // Git branch for this metric
  project?: string;                      // SSO project name (optional, only for ai-run-sso provider)

  // Interaction Metrics
  total_user_prompts: number;            // User prompt count

  // Token Metrics (aggregated)
  total_input_tokens: number;            // Sum of input tokens
  total_output_tokens: number;           // Sum of output tokens
  total_cache_read_input_tokens: number; // Sum of cache read tokens
  total_cache_creation_tokens: number;   // Sum of cache creation tokens

  // Tool Metrics
  total_tool_calls: number;              // Tool invocation count
  successful_tool_calls: number;         // Successful tools
  failed_tool_calls: number;             // Failed tools

  // File Operation Metrics
  files_created: number;                 // Files created
  files_modified: number;                // Files edited
  files_deleted: number;                 // Files deleted
  total_lines_added: number;             // Lines added
  total_lines_removed: number;           // Lines removed

  // Session Metadata
  session_duration_ms: number;           // Duration in milliseconds
  had_errors: boolean;                   // Boolean error flag
  errors?: Record<string, string[]>;     // Tool name -> array of error messages (only if had_errors: true)
  count: number;                         // Always 1 (Prometheus compatibility)
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
  timeout?: number;      // Request timeout (ms)
  retryAttempts?: number; // Max retry attempts
  retryDelays?: number[]; // Backoff delays [1s, 2s, 5s]
  version?: string;      // CLI version (from CODEMIE_CLI_VERSION env var)
  clientType?: string;   // Client type (codemie-claude, codex-cli, gemini-cli, etc.)
}
