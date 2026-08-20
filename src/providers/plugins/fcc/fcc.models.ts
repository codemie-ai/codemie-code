/**
 * FCC Model Fetcher
 *
 * Model fetching for Halyk Bank FCC provider.
 * Lists available Claude models through the corporate LiteLLM gateway.
 */

import type { ProviderModelFetcher, ModelInfo } from '../../core/types.js';
import { HTTPClient } from '../../core/base/http-client.js';

/**
 * FCC Model Fetcher
 *
 * Fetches available models from the FCC LiteLLM gateway.
 */
export class FCCModelFetcher implements ProviderModelFetcher {
  private httpClient: HTTPClient;

  constructor() {
    this.httpClient = new HTTPClient();
  }

  /**
   * Check if this fetcher supports a given provider
   */
  supports(provider: string): boolean {
    return provider === 'fcc';
  }

  /**
   * Fetch available models from FCC gateway
   *
   * Returns a list of Claude models available through the corporate gateway.
   */
  async fetchModels(config: { baseUrl?: string; authToken?: string; [key: string]: unknown }): Promise<ModelInfo[]> {
    const baseUrl = (config as any).fccServerUrl || config.baseUrl;
    const apiKey = (config as any).fccLiteLLMKey;

    // Default models for FCC provider (fallback)
    const defaultModels: ModelInfo[] = [
      {
        id: 'claude-sonnet-4-5-20250929',
        name: 'Claude Sonnet 4.5',
        description: 'Fast and capable model for everyday coding tasks',
        contextWindow: 200000,
        popular: true
      },
      {
        id: 'claude-opus-4-5-20250929',
        name: 'Claude Opus 4.5',
        description: 'Most powerful model for complex reasoning and code',
        contextWindow: 200000
      },
      {
        id: 'claude-haiku-4-5-20251001',
        name: 'Claude Haiku 4.5',
        description: 'Fastest model for quick tasks and simple queries',
        contextWindow: 200000
      }
    ];

    if (!baseUrl) {
      return defaultModels;
    }

    // Try to fetch models from FCC API
    try {
      const headers: Record<string, string> = {};
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }

      const response = await this.httpClient.get(`${baseUrl}/v1/models`, headers);

      if (response.status === 200 && response.data) {
        const apiModels = response.data as any;
        if (Array.isArray(apiModels.data)) {
          return apiModels.data.map((m: any) => ({
            id: m.id,
            name: m.name || m.id,
            description: m.description,
            contextWindow: m.context_window,
            popular: m.popular || false
          }));
        }
      }
    } catch (error) {
      // Fall back to default models on error
      // This is expected during initial setup or if API is unavailable
    }

    return defaultModels;
  }
}

// Export singleton instance for registry
export const FCCModelProxy = new FCCModelFetcher();