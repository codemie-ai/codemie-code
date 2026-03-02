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
  /**
   * Metric name
   * - 'codemie_cli_session_total': Session lifecycle events (start/end)
   * - 'codemie_cli_usage_total': Aggregated usage metrics
   */
  name: string;

  /** Metric attributes */
  attributes: SessionAttributes;
}

/**
 * Session attributes for metrics
 */
export interface SessionAttributes {
  // Identity
  agent: string;                         // 'claude', 'gemini', 'codemie-code'
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

  // MCP Configuration - Counts (optional, only at session start)
  mcp_total_servers?: number;            // Total MCP servers across all scopes
  mcp_local_servers?: number;            // MCP servers in local scope (.claude.json in project)
  mcp_project_servers?: number;          // MCP servers in project scope (.mcp.json)
  mcp_user_servers?: number;             // MCP servers in user scope (~/.claude.json)

  // MCP Configuration - Server Names (optional, only at session start)
  mcp_server_names?: string[];           // All unique server names
  mcp_local_server_names?: string[];     // Server names in local scope
  mcp_project_server_names?: string[];   // Server names in project scope
  mcp_user_server_names?: string[];      // Server names in user scope

  // Extensions - Counts per scope (optional, only at session start)
  agents_project?: number;               // Agent .md files in project .claude/agents/
  agents_global?: number;                // Agent .md files in ~/.claude/agents/
  commands_project?: number;             // Command .md files in project .claude/commands/
  commands_global?: number;              // Command .md files in ~/.claude/commands/
  skills_project?: number;               // Skill .md files in project .claude/skills/
  skills_global?: number;                // Skill .md files in ~/.claude/skills/
  hooks_project?: number;                // Hook scripts in project .claude/hooks/
  hooks_global?: number;                 // Hook scripts in ~/.claude/hooks/
  rules_project?: number;                // Rule .md files in project .claude/rules/
  rules_global?: number;                 // Rule .md files in ~/.claude/rules/

  // Extensions - Names per scope (optional, only at session start)
  agent_names?: string[];                // All unique agent names across both scopes
  agents_project_names?: string[];       // Agent names in project .claude/agents/
  agents_global_names?: string[];        // Agent names in ~/.claude/agents/
  command_names?: string[];              // All unique command names across both scopes
  commands_project_names?: string[];     // Command names in project .claude/commands/
  commands_global_names?: string[];      // Command names in ~/.claude/commands/
  skill_names?: string[];                // All unique skill names across both scopes
  skills_project_names?: string[];       // Skill names in project .claude/skills/
  skills_global_names?: string[];        // Skill names in ~/.claude/skills/
  hook_names?: string[];                 // All unique hook filenames across both scopes
  hooks_project_names?: string[];        // Hook filenames in project .claude/hooks/
  hooks_global_names?: string[];         // Hook filenames in ~/.claude/hooks/
  rule_names?: string[];                 // All unique rule names across both scopes
  rules_project_names?: string[];        // Rule names in project .claude/rules/
  rules_global_names?: string[];         // Rule names in ~/.claude/rules/

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
  apiKey?: string;       // API key for localhost development (user-id header)
  timeout?: number;      // Request timeout (ms)
  retryAttempts?: number; // Max retry attempts
  retryDelays?: number[]; // Backoff delays [1s, 2s, 5s]
  version?: string;      // CLI version (from CODEMIE_CLI_VERSION env var)
  clientType?: string;   // Client type (codemie-claude, gemini-cli, etc.)
}
