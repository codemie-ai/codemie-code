/**
 * Metrics Collection Types
 *
 * Core type definitions for the metrics collection system.
 * Supports file-based metrics gathering from agent session files.
 */

/**
 * File snapshot information
 */
export interface FileInfo {
  path: string;
  size: number;
  createdAt: number; // Unix timestamp (ms)
  modifiedAt: number; // Unix timestamp (ms)
}

/**
 * Snapshot of directory state at a point in time
 */
export interface FileSnapshot {
  timestamp: number; // Unix timestamp (ms)
  files: FileInfo[];
}

/**
 * Correlation status
 */
export type CorrelationStatus = 'pending' | 'matched' | 'failed';

/**
 * Session status
 */
export type SessionStatus = 'active' | 'completed' | 'recovered' | 'failed';

/**
 * Watermark type (per-agent strategy)
 */
export type WatermarkType = 'hash' | 'line' | 'object';

/**
 * Watermark data
 */
export interface Watermark {
  type: WatermarkType;
  value: string; // Hash string, line number, or object IDs
  updatedAt: number; // Unix timestamp (ms)
  expiresAt: number; // Unix timestamp (ms) - startTime + 24h
}

/**
 * Correlation result
 */
export interface CorrelationResult {
  status: CorrelationStatus;
  agentSessionFile?: string; // Path to matched file
  agentSessionId?: string; // Extracted session ID
  detectedAt?: number; // Unix timestamp (ms)
  retryCount: number;
}

/**
 * Monitoring state
 */
export interface MonitoringState {
  isActive: boolean;
  lastCheckTime?: number; // Unix timestamp (ms)
  changeCount: number;
}

/**
 * Sync status for metrics records
 */
export type SyncStatus = 'pending' | 'syncing' | 'synced' | 'failed';

/**
 * Session metadata (stored in ~/.codemie/metrics/sessions/{sessionId}.json)
 * Contains both session info and sync state
 */
export interface MetricsSession {
  sessionId: string; // CodeMie session ID (UUID)
  agentName: string; // 'claude', 'gemini', 'codex'
  provider: string; // 'ai-run-sso', etc.
  project?: string; // SSO project name (optional, only for ai-run-sso provider)
  startTime: number; // Unix timestamp (ms)
  endTime?: number; // Unix timestamp (ms)
  workingDirectory: string; // CWD where agent was launched

  correlation: CorrelationResult;
  monitoring: MonitoringState;
  watermark?: Watermark;
  status: SessionStatus;

  // Embedded sync state (replaces separate sync_state.json file)
  syncState?: SyncState;
}

/**
 * Tool execution status
 */
export type ToolStatus = 'pending' | 'success' | 'error';

/**
 * File operation type
 */
export type FileOperationType = 'read' | 'write' | 'edit' | 'delete' | 'glob' | 'grep';

/**
 * File operation details
 */
export interface FileOperation {
  type: FileOperationType;
  path?: string;
  pattern?: string; // For glob/grep operations
  language?: string; // Detected language (e.g., 'typescript', 'python')
  format?: string; // File format (e.g., 'ts', 'py', 'md')
  linesAdded?: number;
  linesRemoved?: number;
  linesModified?: number;
  durationMs?: number; // Tool execution time (from tool_result)
}

/**
 * Detailed tool call metric
 */
export interface ToolCallMetric {
  id: string; // Unique tool call ID from session
  name: string; // Tool name (e.g., 'Read', 'Write', 'Edit', 'Bash')
  timestamp: number; // Unix timestamp (ms)
  status: ToolStatus;
  input?: Record<string, unknown>; // Tool input parameters
  error?: string; // Error message if status is 'error'
  fileOperation?: FileOperation; // File operation details (if applicable)
}

/**
 * Aggregated tool usage summary
 */
export interface ToolUsageSummary {
  name: string;
  count: number;
  successCount?: number;
  errorCount?: number;
  fileOperations?: {
    read?: number;
    write?: number;
    edit?: number;
    delete?: number;
    glob?: number;
    grep?: number;
  };
}

/**
 * Metric snapshot (extracted from agent session file)
 * This represents the current state of all metrics for a session
 */
export interface MetricSnapshot {
  sessionId: string; // Agent session ID
  timestamp: number; // When metrics were collected

  // Universal metrics
  tokens?: {
    input: number;
    output: number;
    cacheCreation?: number; // Cache creation tokens (for prompt caching)
    cacheRead?: number; // Cache read tokens (for prompt caching)
  };

  // Detailed tool tracking
  toolCalls?: ToolCallMetric[]; // Individual tool calls with detailed tracking

  // Aggregated tool usage summary (for backward compatibility)
  toolUsageSummary?: ToolUsageSummary[];

  // Session metadata
  turnCount?: number;
  duration?: number;
  model?: string;

  // Agent-specific metadata
  metadata?: Record<string, unknown>;
}

/**
 * Delta record (JSONL line in session_metrics.jsonl)
 * Each line represents incremental metrics for one turn
 */
export interface MetricDelta {
  // Identity
  recordId: string;              // UUID from message.uuid (for backtracking to agent session)
  sessionId: string;             // CodeMie session ID
  agentSessionId: string;        // Agent-specific session ID
  timestamp: number | string;    // Unix ms or ISO string
  gitBranch?: string;            // Git branch at time of this turn (can change mid-session)

  // Incremental metrics for this turn
  tokens: {
    input: number;
    output: number;
    cacheCreation?: number;
    cacheRead?: number;
  };

  // Tools used in this turn (counts)
  tools: {
    [toolName: string]: number;  // e.g., {"Read": 1, "Edit": 1}
  };

  // Tool execution status (success/failure breakdown)
  toolStatus?: {
    [toolName: string]: {
      success: number;
      failure: number;
    };
  };

  // File operations in this turn
  fileOperations?: {
    type: 'read' | 'write' | 'edit' | 'delete' | 'glob' | 'grep';
    path?: string;
    pattern?: string;
    language?: string;
    format?: string;
    linesAdded?: number;
    linesRemoved?: number;
    linesModified?: number;
    durationMs?: number;         // Tool execution time (from tool_result)
  }[];

  // Model tracking (raw names, unnormalized)
  models?: string[];             // All models used in this turn

  // API error details (if any tool failed)
  apiErrorMessage?: string;

  // User interaction metrics
  userPrompts?: {
    count: number;        // Number of user prompts in this turn
    text?: string;        // Actual prompt text (optional)
  }[];

  // Sync tracking
  syncStatus: SyncStatus;
  syncedAt?: number;
  syncAttempts: number;
  syncError?: string;
}

/**
 * User prompt record (from history file)
 */
export interface UserPrompt {
  display: string;       // The actual prompt text
  timestamp: number;     // Unix timestamp (ms)
  project: string;       // Working directory
  sessionId: string;     // Agent session ID
  pastedContents?: Record<string, unknown>; // Optional pasted content
}

/**
 * Sync state (sync_state.json)
 */
export interface SyncState {
  sessionId: string;
  agentSessionId: string;

  // Session lifecycle
  sessionStartTime: number;      // When session started
  sessionEndTime?: number;       // When session ended
  status: 'active' | 'completed' | 'failed';

  // Last processed line from agent file
  lastProcessedLine: number;
  lastProcessedTimestamp: number;

  // Local processing tracking (deduplication)
  processedRecordIds: string[];  // All record IDs written to local metrics JSONL
  attachedUserPromptTexts?: string[];  // User prompt texts already attached to deltas (prevents duplication)

  // Remote sync tracking
  lastSyncedRecordId?: string;   // Last synced record ID (for resume)
  lastSyncAt?: number;            // Last sync timestamp

  // Statistics
  totalDeltas: number;           // Total deltas created
  totalSynced: number;           // Total synced to API
  totalFailed: number;           // Total failed syncs
}

/**
 * Agent-specific metrics support interface
 */
export interface AgentMetricsSupport {
  /**
   * Get data paths for this agent
   */
  getDataPaths(): {
    sessionsDir: string; // Where session files are stored
    settingsDir?: string; // Optional settings directory
  };

  /**
   * Check if file path matches agent's session file pattern
   */
  matchesSessionPattern(path: string): boolean;

  /**
   * Extract session ID from file path
   */
  extractSessionId(path: string): string;

  /**
   * Parse session file and extract metrics (full snapshot)
   */
  parseSessionFile(path: string): Promise<MetricSnapshot>;

  /**
   * Parse incremental metrics from session file
   * Returns only new deltas since fromLine
   */
  parseIncrementalMetrics(
    path: string,
    processedRecordIds: Set<string>,
    attachedUserPromptTexts?: Set<string>
  ): Promise<{
    deltas: MetricDelta[];
    lastLine: number;
    newlyAttachedPrompts?: string[];
  }>;

  /**
   * Get user prompts for a specific session
   * Each agent implements this to parse their specific history format
   *
   * @param sessionId - Agent session ID
   * @param fromTimestamp - Start timestamp (Unix ms) - optional
   * @param toTimestamp - End timestamp (Unix ms) - optional
   * @returns Array of user prompts
   */
  getUserPrompts(
    sessionId: string,
    fromTimestamp?: number,
    toTimestamp?: number
  ): Promise<UserPrompt[]>;

  /**
   * Get watermark strategy for this agent
   */
  getWatermarkStrategy(): WatermarkType;

  /**
   * Get initialization delay (ms) for this agent
   */
  getInitDelay(): number;
}

/**
 * File change event
 */
export interface FileChangeEvent {
  path: string;
  timestamp: number;
  size: number;
  hash: string; // SHA256 hash of file content
}

/**
 * Metrics configuration
 */
export interface MetricsConfig {
  // Provider filter
  enabled: (provider: string) => boolean;

  // Agent-specific init delays
  initDelay: Record<string, number>;

  // Retry configuration
  retry: {
    attempts: number;
    delays: number[]; // Exponential backoff delays
  };

  // Monitoring configuration
  monitoring: {
    pollInterval: number; // Polling fallback interval (ms)
    debounceDelay: number; // Debounce delay before collection (ms)
  };

  // Watermark configuration
  watermark: {
    ttl: number; // Time-to-live (ms) - 24h
  };

  // Post-processing configuration
  /**
   * Global list of tool names whose errors should be excluded from metrics
   * Agents can override this via their metricsConfig.excludeErrorsFromTools
   * Example: ['Bash', 'Execute', 'Shell']
   */
  excludeErrorsFromTools?: string[];
}
