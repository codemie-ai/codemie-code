/**
 * Analytics types and interfaces for CodeMie CLI
 * Provides unified analytics across all agents with minimal overhead
 */

/**
 * Analytics configuration
 */
export interface AnalyticsConfig {
  /** Enable/disable analytics collection */
  enabled: boolean;
  /** Storage target: local file, remote endpoint, or both */
  target: 'local' | 'remote' | 'both';
  /** Local storage path for JSONL files */
  localPath: string;
  /** Remote endpoint URL (optional) */
  remoteEndpoint?: string;
  /** Buffer flush interval in milliseconds */
  flushInterval: number;
  /** Maximum events to buffer before auto-flush */
  maxBufferSize: number;
}

/**
 * Default analytics configuration
 */
export const DEFAULT_ANALYTICS_CONFIG: AnalyticsConfig = {
  enabled: false,
  target: 'local',
  localPath: '~/.codemie/analytics',
  flushInterval: 5000, // 5 seconds
  maxBufferSize: 100,
};

/**
 * Event types tracked across all agents
 */
export type EventType =
  // Session lifecycle
  | 'session_start'
  | 'session_end'
  | 'session_error'
  // User interactions
  | 'api_request'
  | 'api_response'
  | 'api_error'
  // Proxy errors
  | 'proxy_error'
  // Configuration
  | 'config_change'
  | 'profile_switch'
  // Performance
  | 'latency_measurement';

/**
 * Core analytics event structure
 * OpenTelemetry-inspired format for consistency
 */
export interface AnalyticsEvent {
  // Core identifiers
  timestamp: string; // ISO 8601
  eventType: EventType;
  sessionId: string; // UUID per session
  installationId: string; // Persistent user ID

  // Agent context
  agent: string; // 'codemie-code' | 'claude' | 'codex' | 'gemini' | 'deepagents'
  agentVersion: string;
  cliVersion: string;

  // Configuration context
  profile: string;
  provider: string;
  model: string;

  // Event-specific data
  attributes: Record<string, unknown>;
  metrics?: Record<string, number>;
}

/**
 * Session configuration
 */
export interface SessionConfig {
  agent: string;
  agentVersion: string;
  cliVersion: string;
  profile: string;
  provider: string;
  model: string;
  workingDir: string;
  interactive: boolean;
}

/**
 * Session metadata
 */
export interface SessionMetadata {
  id: string;
  startTime: number;
  agent: string;
  agentVersion: string;
  cliVersion: string;
  profile: string;
  provider: string;
  model: string;
  workingDir: string;
  interactive: boolean;
}

/**
 * Collector configuration
 */
export interface CollectorConfig {
  maxBufferSize: number;
  flushInterval: number;
}

/**
 * Analytics writer interface
 */
export interface IAnalyticsWriter {
  write(events: AnalyticsEvent[]): Promise<void>;
}

/**
 * Remote analytics interface
 */
export interface IRemoteAnalytics {
  send(events: AnalyticsEvent[]): Promise<void>;
}

/**
 * Comprehensive session metrics
 */
export interface SessionMetrics {
  // API metrics
  apiRequestCount: number;
  totalLatencyMs: number;
  averageLatencyMs: number;

  // Session duration
  durationSeconds: number;
}
