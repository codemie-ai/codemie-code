/**
 * SSO Health Check Implementation
 *
 * Validates SSO authentication and API connectivity.
 * Checks credentials, expiration, and API access.
 */

import type { CodeMieConfigOptions } from '../../../env/types.js';
import type { HealthCheckResult, HealthCheckDetail } from '../../core/types.js';
import { BaseHealthCheck } from '../../core/base/BaseHealthCheck.js';
import { ProviderRegistry } from '../../core/registry.js';
import { SSOTemplate } from './sso.template.js';
import { CodeMieSSO } from './sso.auth.js';
import { SSOModelProxy } from './sso.models.js';

/**
 * Health check implementation for SSO provider
 */
export class SSOHealthCheck extends BaseHealthCheck {
  private sso: CodeMieSSO;
  private modelProxy: SSOModelProxy;

  constructor() {
    super({
      provider: 'ai-run-sso',
      baseUrl: '',
      timeout: 10000
    });
    this.sso = new CodeMieSSO();
    this.modelProxy = new SSOModelProxy();
  }

  /**
   * Main health check flow for SSO
   *
   * Overrides base implementation to provide SSO-specific checks
   */
  async check(config: CodeMieConfigOptions): Promise<HealthCheckResult> {
    const details: HealthCheckDetail[] = [];

    // 1. Check CodeMie URL
    if (!config.codeMieUrl) {
      details.push({
        status: 'error',
        message: 'CodeMie URL not configured',
        hint: 'Run: codemie setup'
      });
      return {
        provider: 'ai-run-sso',
        status: 'unhealthy',
        message: 'SSO Configuration incomplete',
        details
      };
    }

    details.push({
      status: 'ok',
      message: `CodeMie URL: ${config.codeMieUrl}`
    });

    // 2. Check credentials
    const credentials = await this.sso.getStoredCredentials();
    if (!credentials) {
      details.push({
        status: 'error',
        message: 'SSO credentials not found',
        hint: 'Run: codemie auth login'
      });
      return {
        provider: 'ai-run-sso',
        status: 'unhealthy',
        message: 'SSO Authentication required',
        details
      };
    }

    details.push({
      status: 'ok',
      message: 'SSO credentials stored'
    });

    // 3. Check expiration
    if (credentials.expiresAt && credentials.expiresAt < Date.now()) {
      details.push({
        status: 'error',
        message: 'SSO session expired',
        hint: 'Run: codemie auth login'
      });
      return {
        provider: 'ai-run-sso',
        status: 'unhealthy',
        message: 'SSO Session expired',
        details
      };
    }

    const expiresInHours = credentials.expiresAt
      ? Math.round((credentials.expiresAt - Date.now()) / (1000 * 60 * 60))
      : null;

    if (expiresInHours !== null) {
      details.push({
        status: expiresInHours < 1 ? 'warning' : 'ok',
        message: `Session expires in ${expiresInHours} hour(s)`,
        hint: expiresInHours < 1 ? 'Consider refreshing session: codemie auth login' : undefined
      });
    }

    // 4. Test API access and validate configured model
    try {
      const models = await this.modelProxy.listModels();

      // Validate configured model is available
      if (config.model) {
        const configuredModel = config.model;
        const modelAvailable = models.some(m => m.id === configuredModel);

        if (modelAvailable) {
          details.push({
            status: 'ok',
            message: `Model '${configuredModel}' available`
          });
        } else {
          details.push({
            status: 'warning',
            message: `Model '${configuredModel}' not found`,
            hint: `Available: ${models.slice(0, 3).map(m => m.id).join(', ')}${models.length > 3 ? '...' : ''}`
          });
        }
      }

      return {
        provider: 'ai-run-sso',
        status: 'healthy',
        message: 'Provider operational',
        details,
        models
      };
    } catch (error) {
      details.push({
        status: 'error',
        message: 'Provider unreachable',
        hint: error instanceof Error ? error.message : String(error)
      });

      return {
        provider: 'ai-run-sso',
        status: 'unreachable',
        message: 'Cannot connect to provider',
        details
      };
    }
  }

  /**
   * Ping implementation (not used for SSO, check() handles everything)
   */
  protected async ping(): Promise<void> {
    // SSO ping handled in check() method
  }

  /**
   * Get version (SSO doesn't have a version endpoint)
   */
  protected async getVersion(): Promise<string | undefined> {
    return 'sso-v1';
  }

  /**
   * Get unreachable result
   */
  protected getUnreachableResult(): HealthCheckResult {
    return {
      provider: 'ai-run-sso',
      status: 'unreachable',
      message: 'SSO provider is not configured or unreachable',
      remediation: SSOTemplate.setupInstructions
    };
  }

  /**
   * Get healthy message
   */
  protected getHealthyMessage(models: any[]): string {
    return models.length > 0
      ? `SSO is healthy with ${models.length} model(s) available`
      : 'SSO is healthy';
  }

  /**
   * Get no models remediation
   */
  protected getNoModelsRemediation(): string {
    return 'Contact your CodeMie administrator to enable models';
  }
}

// Auto-register health check
ProviderRegistry.registerHealthCheck('ai-run-sso', new SSOHealthCheck());
