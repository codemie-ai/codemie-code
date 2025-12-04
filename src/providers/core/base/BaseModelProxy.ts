/**
 * Base Model Proxy Implementation
 *
 * Unified implementation for both ModelInstallerProxy and ProviderModelFetcher
 */

import type { CodeMieConfigOptions } from '../../../env/types.js';
import type {
  ModelInstallerProxy,
  ProviderModelFetcher,
  ModelInfo,
  InstallProgress
} from '../types.js';
import { HTTPClient } from './http-client.js';

/**
 * Base model proxy implementation
 */
export abstract class BaseModelProxy implements ModelInstallerProxy, ProviderModelFetcher {
  protected client: HTTPClient;
  protected baseUrl: string;

  constructor(baseUrl: string, timeout = 10000) {
    this.baseUrl = baseUrl;
    this.client = new HTTPClient({ timeout });
  }

  /**
   * Check if this proxy supports the given provider
   */
  abstract supports(provider: string): boolean;

  /**
   * List installed models
   */
  abstract listModels(): Promise<ModelInfo[]>;

  /**
   * Fetch models for setup wizard
   */
  abstract fetchModels(config: CodeMieConfigOptions): Promise<ModelInfo[]>;

  /**
   * Check if installation is supported
   */
  supportsInstallation(): boolean {
    return false;
  }

  /**
   * Install model with progress tracking
   */
  async installModel(_modelName: string, _onProgress?: (status: InstallProgress) => void): Promise<void> {
    throw new Error('Model installation not supported by this provider');
  }

  /**
   * Remove model
   */
  async removeModel(_modelName: string): Promise<void> {
    throw new Error('Model removal not supported by this provider');
  }

  /**
   * Get detailed model information
   */
  async getModelInfo(modelName: string): Promise<ModelInfo | null> {
    const models = await this.listModels();
    return models.find(m => m.id === modelName) || null;
  }
}
