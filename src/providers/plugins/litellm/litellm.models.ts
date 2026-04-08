/**
 * LiteLLM Model Proxy
 *
 * Fetches available models from LiteLLM proxy server via /v1/models endpoint.
 */

import type { CodeMieConfigOptions } from '../../../env/types.js';
import type { ModelInfo } from '../../core/types.js';
import { BaseModelProxy } from '../../core/base/BaseModelProxy.js';

/**
 * LiteLLM model proxy implementation
 *
 * Fetches models from LiteLLM's OpenAI-compatible /v1/models endpoint
 */
export class LiteLLMModelProxy extends BaseModelProxy {
  constructor(baseUrl: string, apiKey?: string) {
    super(baseUrl, 10000);
    this.apiKey = apiKey;
  }

  private apiKey?: string;

  supports(provider: string): boolean {
    return provider === 'litellm';
  }

  /**
   * List models from LiteLLM proxy
   */
  async listModels(): Promise<ModelInfo[]> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };

    // Add API key if provided
    if (this.apiKey && this.apiKey !== 'not-required') {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const response = await this.client.get<{ data: Array<{ id: string }> }>(
      `${this.baseUrl}/v1/models`,
      headers
    );

    // Transform OpenAI format to ModelInfo
    const models: ModelInfo[] = response.data.data.map(model => ({
      id: model.id,
      name: model.id,
      popular: false
    }));

    return models;
  }

  /**
   * Fetch models using runtime config values (baseUrl and apiKey).
   * Falls back to constructor values when config fields are absent.
   */
  async fetchModels(config: CodeMieConfigOptions): Promise<ModelInfo[]> {
    const effectiveBaseUrl = config.baseUrl || this.baseUrl;
    const effectiveApiKey = config.apiKey !== undefined ? config.apiKey : this.apiKey;
    const proxy = new LiteLLMModelProxy(effectiveBaseUrl, effectiveApiKey);
    return proxy.listModels();
  }
}
