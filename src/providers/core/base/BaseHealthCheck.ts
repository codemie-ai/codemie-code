/**
 * Base Health Check Implementation
 *
 * Provides common patterns for health checks:
 * - HTTP client with timeout
 * - Ping/version detection
 * - Model listing
 * - Error handling
 */

import type { CodeMieConfigOptions } from '../../../env/types.js';
import type {
  ProviderHealthCheck,
  HealthCheckResult,
  HealthCheckConfig,
  HealthCheckDetail,
  ModelInfo
} from '../types.js';
import { HTTPClient } from './http-client.js';

/**
 * Base health check implementation
 */
export abstract class BaseHealthCheck implements ProviderHealthCheck {
  protected client: HTTPClient;
  protected config: HealthCheckConfig;

  constructor(config: HealthCheckConfig) {
    this.config = {
      timeout: 5000,
      ...config
    };
    this.client = new HTTPClient({
      timeout: this.config.timeout,
      headers: this.config.headers
    });
  }

  /**
   * Check if this health check supports the given provider
   */
  supports(provider: string): boolean {
    return provider === this.config.provider;
  }

  /**
   * Main health check flow
   * 1. Ping server
   * 2. Get version
   * 3. List models (if applicable)
   * 4. Validate configured model (if specified)
   */
  async check(config: CodeMieConfigOptions): Promise<HealthCheckResult> {
    try {
      // 1. Ping server
      await this.ping();

      // 2. Get version
      const version = await this.getVersion();

      // 3. List models (if applicable)
      const models = await this.listModels().catch(() => []);

      // 4. Build details with model validation
      const details: HealthCheckDetail[] = [];

      // Validate configured model if specified
      if (config.model && models.length > 0) {
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

      // Build result
      const result: HealthCheckResult = {
        provider: this.config.provider,
        status: 'healthy',
        message: this.getHealthyMessage(models),
        version,
        models,
        details
      };

      // Check if models are available
      if (models.length === 0) {
        result.status = 'unhealthy';
        result.message = 'No models available';
        result.remediation = this.getNoModelsRemediation();
      }

      return result;
    } catch (error) {
      return this.getUnreachableResult(error);
    }
  }

  /**
   * Ping server to check if it's reachable
   */
  protected abstract ping(): Promise<void>;

  /**
   * Get provider version
   */
  protected abstract getVersion(): Promise<string | undefined>;

  /**
   * List available models (optional - override if needed)
   */
  protected async listModels(): Promise<ModelInfo[]> {
    return [];
  }

  /**
   * Get result for unreachable server
   */
  protected getUnreachableResult(error?: unknown): HealthCheckResult {
    return {
      provider: this.config.provider,
      status: 'unreachable',
      message: `Provider is not reachable: ${error instanceof Error ? error.message : String(error)}`,
      remediation: 'Check if the provider is running and accessible'
    };
  }

  /**
   * Get healthy message
   */
  protected getHealthyMessage(models: ModelInfo[]): string {
    return models.length > 0
      ? `Provider is healthy with ${models.length} model(s) available`
      : 'Provider is healthy';
  }

  /**
   * Get remediation for no models
   */
  protected getNoModelsRemediation(): string {
    return 'Install models via provider CLI or CodeMie models command';
  }
}
