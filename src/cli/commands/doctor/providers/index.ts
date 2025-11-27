/**
 * Provider health checks registry
 */

import { CodeMieConfigOptions } from '../../../../utils/config-loader.js';
import { ProviderHealthCheck, HealthCheckResult } from '../types.js';
import { AIRunSSOProviderCheck } from './AIRunSSOProviderCheck.js';
import { StandardProviderCheck } from './StandardProviderCheck.js';

export { BaseProviderCheck } from './BaseProviderCheck.js';
export { AIRunSSOProviderCheck } from './AIRunSSOProviderCheck.js';
export { StandardProviderCheck } from './StandardProviderCheck.js';

/**
 * Registry of all provider-specific health checks
 */
class ProviderCheckRegistry {
  private checks: ProviderHealthCheck[] = [
    new AIRunSSOProviderCheck(),
    new StandardProviderCheck()
  ];

  /**
   * Get applicable checks for a given provider
   */
  getChecksForProvider(provider: string): ProviderHealthCheck[] {
    return this.checks.filter(check => check.supports(provider));
  }

  /**
   * Run all applicable provider checks
   * @param config Configuration to check
   * @param onProgress Optional callback called before each check starts
   */
  async runChecks(
    config: CodeMieConfigOptions,
    onProgress?: (checkName: string) => void
  ): Promise<HealthCheckResult[]> {
    if (!config.provider) {
      return [];
    }

    const applicableChecks = this.getChecksForProvider(config.provider);
    const results: HealthCheckResult[] = [];

    for (const check of applicableChecks) {
      try {
        // Notify progress if callback provided
        if (onProgress) {
          onProgress('Provider');
        }

        const result = await check.check(config);
        results.push(result);
      } catch (error) {
        // If a check throws an error, capture it
        results.push({
          name: 'Provider Check Error',
          success: false,
          details: [{
            status: 'error',
            message: `Check failed: ${error instanceof Error ? error.message : String(error)}`
          }]
        });
      }
    }

    return results;
  }

  /**
   * Register a custom provider check
   */
  register(check: ProviderHealthCheck): void {
    this.checks.push(check);
  }
}

// Export singleton instance
export const providerCheckRegistry = new ProviderCheckRegistry();
