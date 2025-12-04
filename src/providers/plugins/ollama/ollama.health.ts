/**
 * Ollama Health Check Implementation
 *
 * Validates Ollama runtime availability and functionality.
 * Uses BaseHealthCheck for common patterns, delegates to OllamaModelProxy for model operations.
 */

import type { ModelInfo } from '../../core/types.js';
import { BaseHealthCheck } from '../../core/base/BaseHealthCheck.js';
import { ProviderRegistry } from '../../core/registry.js';
import { OllamaTemplate } from './ollama.template.js';
import { OllamaModelProxy } from './ollama.models.js';

/**
 * Ollama version API response
 */
interface OllamaVersionResponse {
  version: string;
}

/**
 * Health check implementation for Ollama
 * Extends BaseHealthCheck for common patterns, delegates to OllamaModelProxy for model operations
 */
export class OllamaHealthCheck extends BaseHealthCheck {
  private modelProxy: OllamaModelProxy;

  constructor(baseUrl: string = OllamaTemplate.defaultBaseUrl) {
    super({
      provider: 'ollama',
      baseUrl,
      timeout: 5000
    });
    this.modelProxy = new OllamaModelProxy(baseUrl);
  }

  /**
   * Ping Ollama to check if it's running
   * Uses healthCheckEndpoint from template
   */
  protected async ping(): Promise<void> {
    await this.client.get(`${this.config.baseUrl}${OllamaTemplate.healthCheckEndpoint}`);
  }

  /**
   * Get Ollama version
   */
  protected async getVersion(): Promise<string | undefined> {
    try {
      const response = await this.client.get<OllamaVersionResponse>(
        `${this.config.baseUrl}/api/version`
      );
      return response.data.version;
    } catch {
      return 'unknown';
    }
  }

  /**
   * List available models
   * Delegates to OllamaModelProxy to avoid code duplication
   */
  async listModels(): Promise<ModelInfo[]> {
    return this.modelProxy.listModels();
  }

  /**
   * Custom unreachable message with installation instructions
   */
  protected getUnreachableResult() {
    return {
      provider: 'ollama',
      status: 'unreachable' as const,
      message: 'Ollama is not running',
      remediation: `Start Ollama:
  - macOS/Linux: ollama serve
  - Windows: Start Ollama from Start Menu
  - Docker: docker start ollama

Or install Ollama:
  - macOS: https://ollama.com/download/mac
  - Linux: curl -fsSL https://ollama.com/install.sh | sh
  - Windows: https://ollama.com/download`
    };
  }

  /**
   * Custom healthy message
   */
  protected getHealthyMessage(models: ModelInfo[]): string {
    return models.length > 0
      ? `Ollama is running with ${models.length} model(s) installed`
      : 'Ollama is running but no models installed';
  }

  /**
   * Custom no-models remediation
   */
  protected getNoModelsRemediation(): string {
    return 'Install a model: codemie models install ollama/llama3.2';
  }
}

// Auto-register health check
ProviderRegistry.registerHealthCheck('ollama', new OllamaHealthCheck());
