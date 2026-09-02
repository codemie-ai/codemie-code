import type { CodeMieConfigOptions } from '../../env/types.js';
import type { ModelInfo } from './types.js';
import { ProviderRegistry } from './registry.js';
import { logger } from '../../utils/logger.js';
import { sanitizeLogArgs } from '../../utils/security.js';

export interface AzureConnectionConfig {
  endpoint?: string;
  apiKey?: string;
  apiVersion?: string;
}

export function getAzureConnectionConfig(env: NodeJS.ProcessEnv): AzureConnectionConfig {
  let profile: Partial<CodeMieConfigOptions> = {};
  if (env.CODEMIE_PROFILE_CONFIG) {
    try {
      profile = JSON.parse(env.CODEMIE_PROFILE_CONFIG) as Partial<CodeMieConfigOptions>;
    } catch {
      profile = {};
    }
  }

  return {
    endpoint: env.CODEMIE_AZURE_OPENAI_BASE_URL || profile.baseUrl || env.CODEMIE_BASE_URL,
    apiKey: profile.apiKey || env.CODEMIE_API_KEY || undefined,
    apiVersion: profile.azureApiVersion || env.CODEMIE_AZURE_OPENAI_API_VERSION || env.AZURE_OPENAI_API_VERSION,
  };
}

export async function fetchAzureDeploymentModels(
  connection: AzureConnectionConfig,
  selectedModel: string,
): Promise<ModelInfo[]> {
  const selected: ModelInfo = { id: selectedModel, name: selectedModel };
  if (!connection.endpoint) return [selected];

  try {
    const fetcher = ProviderRegistry.getModelProxy('azure-openai');
    if (!fetcher) return [selected];

    const models = await fetcher.fetchModels({
      provider: 'azure-openai',
      baseUrl: connection.endpoint,
      apiKey: connection.apiKey,
      model: selectedModel,
      timeout: 300,
      azureApiVersion: connection.apiVersion,
    } as CodeMieConfigOptions);

    if (!models.some(model => model.id === selectedModel)) {
      models.unshift(selected);
    }
    return models;
  } catch (error) {
    return logAzureDeploymentFallback(selected, error);
  }
}

function logAzureDeploymentFallback(selected: ModelInfo, error: unknown): ModelInfo[] {
  logger.debug(
    '[azure-models] Failed to fetch deployments, using selected deployment only',
    ...sanitizeLogArgs({ error: error instanceof Error ? error.message : String(error) }),
  );
  return [selected];
}