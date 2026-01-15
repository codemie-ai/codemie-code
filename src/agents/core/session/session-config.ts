/**
 * Session Infrastructure Configuration
 *
 * Unified configuration for session management, metrics, and conversations.
 * All session data stored under ~/.codemie/sessions/
 */

import type { MetricsConfig } from '../types.js';
import { join } from 'path';
import { getCodemieHome } from '../../../utils/paths.js';

/**
 * Metrics collection configuration
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
   * Retry configuration for correlation
   * Exponential backoff: 500ms → 1s → 2s → 4s → 8s → 16s → 32s → 32s
   * Total wait time: ~1.6 minutes
   */
  retry: {
    attempts: 8,
    delays: [500, 1000, 2000, 4000, 8000, 16000, 32000, 32000] // Exponential backoff capped at 32s
  },

  /**
   * Post-processing configuration
   * Global default: exclude errors from shell tools (contains sensitive command output)
   * Individual agents can override this via their metricsConfig.excludeErrorsFromTools
   */
  excludeErrorsFromTools: ['Bash', 'Execute', 'Shell']
};

/**
 * Get session metadata file path
 * Format: ~/.codemie/sessions/{sessionId}.json
 */
export function getSessionPath(sessionId: string): string {
  return join(getCodemieHome(), 'sessions', `${sessionId}.json`);
}

/**
 * Get session metrics JSONL file path
 * Format: ~/.codemie/sessions/{sessionId}_metrics.jsonl
 */
export function getSessionMetricsPath(sessionId: string): string {
  return join(getCodemieHome(), 'sessions', `${sessionId}_metrics.jsonl`);
}

/**
 * Get session conversation payloads JSONL file path
 * Format: ~/.codemie/sessions/{sessionId}_conversation.jsonl
 */
export function getSessionConversationPath(sessionId: string): string {
  return join(getCodemieHome(), 'sessions', `${sessionId}_conversation.jsonl`);
}
