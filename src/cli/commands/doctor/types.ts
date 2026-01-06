/**
 * Health check types and interfaces
 */

import { CodeMieConfigOptions } from '../../../utils/config.js';

/**
 * Status of a health check item
 */
export type HealthStatus = 'ok' | 'warn' | 'error' | 'info';

/**
 * Individual health check detail
 */
export interface HealthCheckDetail {
  status: HealthStatus;
  message: string;
  hint?: string;
}

/**
 * Result of a health check
 */
export interface HealthCheckResult {
  name: string;
  success: boolean;
  details: HealthCheckDetail[];
}

/**
 * Progress callback for individual items
 */
export type ProgressCallback = (message: string) => void;

/**
 * Item display callback for showing items one by one
 */
export type ItemDisplayCallback = (itemName: string, result: HealthCheckDetail) => void;

/**
 * Base interface for all health checks
 */
export interface HealthCheck {
  name: string;
  run(onProgress?: ProgressCallback): Promise<HealthCheckResult>;
}

/**
 * Health check that supports item-by-item display
 */
export interface ItemWiseHealthCheck extends HealthCheck {
  runWithItemDisplay(
    onStartItem: (itemName: string) => void,
    onDisplayItem: (detail: HealthCheckDetail) => void
  ): Promise<HealthCheckResult>;
}

/**
 * Provider-specific health check
 */
export interface ProviderHealthCheck {
  /**
   * Check if this provider check supports the given provider
   */
  supports(provider: string): boolean;

  /**
   * Run provider-specific health checks
   */
  check(config: CodeMieConfigOptions): Promise<HealthCheckResult>;
}
