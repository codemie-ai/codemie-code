/**
 * Base class for provider-specific health checks
 */

import { CodeMieConfigOptions } from '../../../../utils/config-loader.js';
import { ProviderHealthCheck, HealthCheckResult, HealthCheckDetail } from '../types.js';

export abstract class BaseProviderCheck implements ProviderHealthCheck {
  abstract readonly supportedProviders: string[];

  supports(provider: string): boolean {
    return this.supportedProviders.includes(provider);
  }

  abstract check(config: CodeMieConfigOptions): Promise<HealthCheckResult>;

  protected createResult(name: string, success: boolean, details: HealthCheckDetail[]): HealthCheckResult {
    return { name, success, details };
  }
}
