/**
 * Azure OpenAI Model Proxy
 *
 * Fetches available deployments from Azure OpenAI via the OpenAI-compatible endpoint.
 */

import type { CodeMieConfigOptions } from '../../../env/types.js';
import type { ModelInfo, ProviderModelFetcher } from '../../core/types.js';
import { ProviderRegistry } from '../../core/registry.js';
import { ConfigurationError } from '../../../utils/errors.js';

export interface AzureOpenAIDeploymentInfo {
  id: string;
  name: string;
  description?: string;
  model?: string;
}

/**
 * Extension of ProviderModelFetcher that also supports fetching raw deployment info.
 * Implemented by AzureOpenAIModelProxy and accessible via ProviderRegistry.getModelProxy('azure-openai').
 */
export interface AzureDeploymentFetcher {
  fetchDeploymentInfos(config: CodeMieConfigOptions): Promise<AzureOpenAIDeploymentInfo[]>;
}

export class AzureOpenAIModelProxy implements ProviderModelFetcher {
  constructor(
    private baseUrl: string,
    private apiKey?: string,
    private apiVersion: string = '2024-06-01'
  ) {}

  supports(provider: string): boolean {
    return provider === 'azure-openai';
  }

  private buildDeploymentsUrl(endpoint: string, apiVersion: string): string {
    return new URL(`/openai/deployments?api-version=${encodeURIComponent(apiVersion)}`, endpoint).toString();
  }

  async fetchDeploymentInfos(config: CodeMieConfigOptions): Promise<AzureOpenAIDeploymentInfo[]> {
    // baseUrl is always set by buildConfig; no legacy azureOpenAIBaseUrl fallback needed.
    const endpoint = config.baseUrl || this.baseUrl;
    const apiKey = config.apiKey || this.apiKey;
    const apiVersion = config.azureApiVersion || this.apiVersion;

    if (!endpoint) {
      return [];
    }

    const response = await fetch(this.buildDeploymentsUrl(endpoint, apiVersion), {
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { 'api-key': apiKey } : {})
      }
    });

    if (!response.ok) {
      throw new ConfigurationError(`Failed to fetch Azure OpenAI deployments: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as { data?: Array<Record<string, unknown>> };
    const deployments = data.data ?? [];

    return deployments
      .map((deployment): AzureOpenAIDeploymentInfo | null => {
        const id = String(deployment.id || deployment.name || deployment.model || '').trim();
        if (!id) {
          return null;
        }

        const name = String(deployment.name || deployment.id || id).trim();
        const description = typeof deployment.model === 'string' ? `Model: ${deployment.model}` : undefined;

        return {
          id,
          name,
          description,
          model: typeof deployment.model === 'string' ? deployment.model : undefined
        };
      })
      .filter((deployment): deployment is AzureOpenAIDeploymentInfo => deployment !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async fetchModels(config: CodeMieConfigOptions): Promise<ModelInfo[]> {
    const deployments = await this.fetchDeploymentInfos(config);
    return deployments.map((deployment) => ({
      id: deployment.id,
      name: deployment.name,
      description: deployment.description,
      metadata: {
        deploymentName: deployment.name,
        model: deployment.model
      }
    }));
  }
}

ProviderRegistry.registerModelProxy('azure-openai', new AzureOpenAIModelProxy(''));
