/**
 * Ollama Model Management
 *
 * Combines model discovery and installation for Ollama.
 * Handles both listing installed models and discovering available models.
 */

import type { CodeMieConfigOptions } from '../../../env/types.js';
import type { ModelInfo, InstallProgress } from '../../core/types.js';
import { BaseModelProxy } from '../../core/base/BaseModelProxy.js';
import { ProviderRegistry } from '../../core/registry.js';
import { OllamaTemplate } from './ollama.template.js';
import { logger } from '../../../utils/logger.js';

/**
 * Ollama API response types
 */
interface OllamaTagsResponse {
  models: Array<{
    name: string;
    size: number;
    digest: string;
    modified_at: string;
    details?: {
      format?: string;
      family?: string;
      parameter_size?: string;
      quantization_level?: string;
    };
  }>;
}

/**
 * Pattern to identify coding model names
 */
const CODING_MODEL_PATTERNS = [
  /coder/i,
  /code/i,
  /codellama/i,
  /starcoder/i,
  /wizard.*code/i,
  /magic.*code/i
];

/**
 * Check if a model name matches coding patterns
 */
function isCodingModel(modelName: string): boolean {
  return CODING_MODEL_PATTERNS.some(pattern => pattern.test(modelName));
}

/**
 * Get metadata for a coding model from OllamaTemplate
 */
function getCodingModelMetadata(modelId: string): Partial<ModelInfo> {
  // Extract base name (without tag)
  const baseName = modelId.split(':')[0];

  // Get metadata from template (single source of truth)
  const metadata = OllamaTemplate.modelMetadata?.[baseName];

  if (metadata) {
    return {
      name: metadata.name,
      description: metadata.description,
      popular: metadata.popular ?? false
    };
  }

  // If not in template but matches coding pattern, mark as coding model
  if (isCodingModel(baseName)) {
    return {
      name: modelId,
      description: 'Code-specialized model',
      popular: false
    };
  }

  return {};
}

/**
 * Unified Ollama model management
 * Extends BaseModelProxy for common patterns
 */
export class OllamaModelProxy extends BaseModelProxy {
  constructor(baseUrl: string = OllamaTemplate.defaultBaseUrl) {
    super(baseUrl, 300000); // 5 minutes for model operations
  }

  /**
   * Check if this proxy supports the given provider
   */
  supports(provider: string): boolean {
    return provider === 'ollama';
  }

  /**
   * Ollama supports model installation
   */
  supportsInstallation(): boolean {
    return true;
  }

  /**
   * List installed models
   */
  async listModels(): Promise<ModelInfo[]> {
    try {
      const response = await this.client.get<OllamaTagsResponse>(`${this.baseUrl}/api/tags`);

      return response.data.models.map((model) => ({
        id: model.name,
        name: model.name,
        size: model.size,
        metadata: {
          digest: model.digest,
          modified: model.modified_at,
          format: model.details?.format || model.details?.quantization_level || 'unknown'
        }
      }));
    } catch (error) {
      throw new Error(`Failed to list models: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Fetch available models (for setup/discovery)
   * Returns installed coding models if available, otherwise returns recommended models from template
   */
  async fetchModels(config: CodeMieConfigOptions): Promise<ModelInfo[]> {
    try {
      // Use baseUrl from config if provided, otherwise use default
      const baseUrl = config.baseUrl || OllamaTemplate.defaultBaseUrl;
      const proxy = baseUrl === this.baseUrl ? this : new OllamaModelProxy(baseUrl);

      // Try to fetch installed models from Ollama
      const installedModels = await proxy.listModels();

      // If we have installed coding models, return them with enriched metadata
      if (installedModels.length > 0) {
        const codingModels = installedModels
          .filter(m => isCodingModel(m.id))
          .map(m => {
            const metadata = getCodingModelMetadata(m.id);
            return {
              id: m.id,
              name: metadata.name || m.name || m.id,
              description: metadata.description,
              size: m.size,
              popular: metadata.popular || false
            };
          });

        // Return installed coding models if we have any
        if (codingModels.length > 0) {
          return codingModels;
        }
      }
    } catch (error) {
      logger.debug('Failed to fetch installed Ollama models:', error);
    }

    // Fall back to template's recommended models with metadata from template
    const recommendedModels = OllamaTemplate.recommendedModels.map(modelId => {
      const metadata = OllamaTemplate.modelMetadata?.[modelId];
      return {
        id: modelId,
        name: metadata?.name || modelId,
        description: metadata?.description,
        popular: metadata?.popular ?? true // All recommended models are popular by default
      };
    });

    return recommendedModels;
  }

  /**
   * Install model with progress tracking
   * Streams real-time progress from Ollama API
   */
  async installModel(modelName: string, onProgress?: (status: InstallProgress) => void): Promise<void> {
    try {
      const response = await fetch(`${this.baseUrl}/api/pull`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: modelName, stream: true }),
      });

      if (!response.ok) {
        throw new Error(`Failed to pull model: ${response.statusText}`);
      }

      if (!response.body) {
        throw new Error('Response body is empty');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const data = JSON.parse(line);

            if (onProgress) {
              // Ollama progress format: { status: "pulling manifest", ... }
              // or { status: "downloading", completed: 123, total: 456 }
              if (data.status === 'success' || data.status === 'pulling manifest') {
                onProgress({ status: 'downloading', message: data.status });
              } else if (data.completed && data.total) {
                const percent = Math.round((data.completed / data.total) * 100);
                onProgress({
                  status: 'downloading',
                  progress: percent,
                  message: `${data.status || 'Downloading'} (${percent}%)`
                });
              } else if (data.status) {
                onProgress({ status: 'downloading', message: data.status });
              }
            }
          } catch {
            logger.debug(`Failed to parse progress line for ${modelName}:`, line);
          }
        }
      }

      if (onProgress) {
        onProgress({ status: 'complete', progress: 100, message: `Successfully pulled ${modelName}` });
      }
    } catch (error) {
      if (onProgress) {
        onProgress({ status: 'error', message: `Failed to install ${modelName}` });
      }
      throw new Error(`Failed to install model ${modelName}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Remove model
   */
  async removeModel(modelName: string): Promise<void> {
    try {
      await this.client.post(`${this.baseUrl}/api/delete`, { name: modelName });
    } catch (error) {
      throw new Error(`Failed to remove model ${modelName}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get detailed model information
   */
  async getModelInfo(modelName: string): Promise<ModelInfo | null> {
    try {
      // First check if model exists in list
      const models = await this.listModels();
      const basicInfo = models.find((m) => m.id === modelName);

      if (!basicInfo) {
        return null;
      }

      // Get detailed info from template if available
      const baseName = modelName.split(':')[0];
      const templateMetadata = OllamaTemplate.modelMetadata?.[baseName];

      if (templateMetadata) {
        return {
          ...basicInfo,
          name: templateMetadata.name,
          description: templateMetadata.description,
          popular: templateMetadata.popular,
          contextWindow: templateMetadata.contextWindow
        };
      }

      return basicInfo;
    } catch {
      return null;
    }
  }
}

// Auto-register model proxy
ProviderRegistry.registerModelProxy('ollama', new OllamaModelProxy());
