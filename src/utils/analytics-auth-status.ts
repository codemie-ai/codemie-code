/**
 * Analytics Auth Status Marker
 *
 * File-based marker used to propagate CodeMie analytics (metrics endpoint)
 * authentication failures across processes.
 *
 * Problem: when SSO cookies expire, the metrics endpoint (fronted by Keycloak)
 * answers POSTs with HTTP 200 + an HTML login page instead of 401. Sync code
 * only sees a generic non-JSON failure logged at debug level, so sessions
 * silently disappear from analytics.
 *
 * Writers:
 * - MetricsApiClient marks the status invalid when the server rejects the
 *   provided credentials (401/403 or an HTML login page response).
 * - MetricsApiClient and the SSO login flow clear the marker when auth is
 *   known to work again.
 *
 * Readers:
 * - The unified `codemie hook` UserPromptSubmit gate blocks the prompt when
 *   analytics auth is configured but known-broken, instructing the user to
 *   re-authenticate via `codemie profile login`.
 *
 * All functions are best-effort and never throw: auth-status bookkeeping must
 * never break metrics sending or hook processing.
 */

import { existsSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { getCodemiePath } from './paths.js';
import { logger } from './logger.js';

export interface AnalyticsAuthStatus {
  status: 'invalid';
  /** Human-readable failure description (e.g. HTTP status or response shape) */
  reason: string;
  /** Metrics API base URL that rejected the credentials */
  baseUrl: string;
  /** Epoch millis when the failure was first detected */
  detectedAt: number;
}

function getStatusPath(): string {
  return getCodemiePath('analytics-auth-status.json');
}

/**
 * Mark analytics authentication as invalid.
 * Preserves the original detectedAt if a marker already exists.
 */
export async function markAnalyticsAuthInvalid(reason: string, baseUrl: string): Promise<void> {
  try {
    const existing = await getAnalyticsAuthStatus();
    const status: AnalyticsAuthStatus = {
      status: 'invalid',
      reason,
      baseUrl,
      detectedAt: existing?.detectedAt ?? Date.now()
    };
    await writeFile(getStatusPath(), JSON.stringify(status, null, 2), 'utf-8');
    logger.debug('[analytics-auth] Marked analytics auth as invalid:', { reason, baseUrl });
  } catch (error) {
    logger.debug('[analytics-auth] Failed to write auth status marker:', error);
  }
}

/**
 * Clear the invalid-auth marker (after successful login or successful send).
 */
export async function clearAnalyticsAuthStatus(): Promise<void> {
  try {
    const statusPath = getStatusPath();
    if (!existsSync(statusPath)) {
      return;
    }
    await unlink(statusPath);
    logger.debug('[analytics-auth] Cleared analytics auth status marker');
  } catch (error) {
    logger.debug('[analytics-auth] Failed to clear auth status marker:', error);
  }
}

/**
 * Read the current auth status marker, or null when auth is not known-broken.
 */
export async function getAnalyticsAuthStatus(): Promise<AnalyticsAuthStatus | null> {
  try {
    const statusPath = getStatusPath();
    if (!existsSync(statusPath)) {
      return null;
    }
    const parsed = JSON.parse(await readFile(statusPath, 'utf-8')) as AnalyticsAuthStatus;
    if (parsed?.status !== 'invalid') {
      return null;
    }
    return parsed;
  } catch (error) {
    logger.debug('[analytics-auth] Failed to read auth status marker:', error);
    return null;
  }
}
