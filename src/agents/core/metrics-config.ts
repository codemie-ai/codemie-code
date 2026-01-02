/**
 * Metrics Collection Configuration
 *
 * Centralized configuration for the metrics collection system.
 */

import type { MetricsConfig } from './types.js';
import { join } from 'path';
import { getCodemieHome } from '../../utils/codemie-home.js';

/**
 * Default metrics configuration
 */
export const METRICS_CONFIG: MetricsConfig = {
  /**
   * Metrics only enabled for ai-run-sso provider
   * Can be disabled at runtime via CODEMIE_METRICS_DISABLED env var
   */
  enabled: (provider: string) => {
    // Check if metrics are disabled at runtime
    if (process.env.CODEMIE_METRICS_DISABLED === '1') {
      return false;
    }
    return provider === 'ai-run-sso';
  },

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
   * Exponential backoff: 500ms → 1s → 2s → 4s → 8s → 16s → 32s → 32s
   * Total wait time: ~1.6 minutes
   */
  retry: {
    attempts: 8,
    delays: [500, 1000, 2000, 4000, 8000, 16000, 32000, 32000] // Exponential backoff capped at 32s
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
  },

  /**
   * Post-processing configuration
   * Global default: exclude errors from shell tools (contains sensitive command output)
   * Individual agents can override this via their metricsConfig.excludeErrorsFromTools
   */
  excludeErrorsFromTools: ['Bash', 'Execute', 'Shell']
};

/**
 * Storage paths
 */
export const METRICS_PATHS = {
  root: '.codemie/metrics',
  sessions: 'sessions'
};

/**
 * Get full path for metrics storage
 */
export function getMetricsPath(subpath?: string): string {
  const base = join(getCodemieHome(), 'metrics');
  return subpath ? join(base, subpath) : base;
}

/**
 * Get session metadata file path
 * Format: ~/.codemie/metrics/sessions/{sessionId}.json
 */
export function getSessionPath(sessionId: string): string {
  return getMetricsPath(`${METRICS_PATHS.sessions}/${sessionId}.json`);
}

/**
 * Get session metrics JSONL file path
 * Format: ~/.codemie/metrics/sessions/{sessionId}_metrics.jsonl
 */
export function getSessionMetricsPath(sessionId: string): string {
  return getMetricsPath(`${METRICS_PATHS.sessions}/${sessionId}_metrics.jsonl`);
}

/**
 * Get sync state file path (embedded in session metadata)
 * This is a legacy function - sync state is now stored in session.json
 * @deprecated Use session.json for sync state
 */
export function getSyncStatePath(sessionId: string): string {
  return getMetricsPath(`${METRICS_PATHS.sessions}/${sessionId}.json`);
}
