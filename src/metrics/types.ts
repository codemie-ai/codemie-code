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
 * Session metadata
 */
export interface MetricsSession {
  sessionId: string; // CodeMie session ID (UUID)
  agentName: string; // 'claude', 'gemini', 'codex'
  provider: string; // 'ai-run-sso', etc.
  startTime: number; // Unix timestamp (ms)
  endTime?: number; // Unix timestamp (ms)
  workingDirectory: string; // CWD where agent was launched

  correlation: CorrelationResult;
  monitoring: MonitoringState;
  watermark?: Watermark;
  status: SessionStatus;
}

/**
 * Metric snapshot (extracted from agent session file)
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

  cost?: number; // Calculated from tokens

  // Tool usage
  toolCalls?: {
    name: string;
    count: number;
  }[];

  // Session metadata
  turnCount?: number;
  duration?: number;
  model?: string;

  // Agent-specific metadata
  metadata?: Record<string, unknown>;
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
   * Parse session file and extract metrics
   */
  parseSessionFile(path: string): Promise<MetricSnapshot>;

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
}
