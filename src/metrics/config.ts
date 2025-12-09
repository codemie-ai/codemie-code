/**
 * Metrics Collection Configuration
 *
 * Centralized configuration for the metrics collection system.
 */

import type { MetricsConfig } from './types.js';

/**
 * Default metrics configuration
 */
export const METRICS_CONFIG: MetricsConfig = {
  /**
   * Metrics only enabled for ai-run-sso provider
   */
  enabled: (provider: string) => provider === 'ai-run-sso',

  /**
   * Agent-specific initialization delays (ms)
   * Time to wait after agent spawn before taking post-snapshot
   */
  initDelay: {
    claude: 500
    // Future: gemini, codex, etc.
  },

  /**
   * Retry configuration for correlation
   */
  retry: {
    attempts: 5,
    delays: [500, 1000, 2000, 4000, 8000] // Exponential backoff
  },

  /**
   * File monitoring configuration
   */
  monitoring: {
    pollInterval: 5000, // 5s fallback polling
    debounceDelay: 5000 // 5s debounce before collection
  },

  /**
   * Watermark configuration
   */
  watermark: {
    ttl: 24 * 60 * 60 * 1000 // 24 hours
  }
};

/**
 * Storage paths
 */
export const METRICS_PATHS = {
  root: '.codemie/metrics',
  sessions: 'sessions',
  watermarks: 'watermarks',
  data: 'data'
};

/**
 * Get full path for metrics storage
 */
export function getMetricsPath(subpath?: string): string {
  const homedir = process.env.HOME || process.env.USERPROFILE || '~';
  const base = `${homedir}/${METRICS_PATHS.root}`;
  return subpath ? `${base}/${subpath}` : base;
}

/**
 * Get session file path
 */
export function getSessionPath(sessionId: string): string {
  return getMetricsPath(`${METRICS_PATHS.sessions}/${sessionId}.json`);
}

/**
 * Get watermark file path
 */
export function getWatermarkPath(fileHash: string): string {
  return getMetricsPath(`${METRICS_PATHS.watermarks}/${fileHash}.json`);
}

/**
 * Get metrics data path
 */
export function getMetricsDataPath(agentName: string, sessionId: string): string {
  return getMetricsPath(`${METRICS_PATHS.data}/${agentName}/${sessionId}.json`);
}
