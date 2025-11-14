import { CodeMieModel } from '../types/sso.js';
import { CredentialStore } from './credential-store.js';

export async function fetchCodeMieModels(
  apiUrl: string,
  cookies: Record<string, string>
): Promise<string[]> {
  const cookieString = Object.entries(cookies)
    .map(([key, value]) => `${key}=${value}`)
    .join(';');

  try {
    const response = await fetch(`${apiUrl}/v1/llm_models`, {
      method: 'GET',
      headers: {
        'cookie': cookieString,
        'Content-Type': 'application/json'
      },
      // @ts-expect-error - timeout is supported in node-fetch
      timeout: 10000
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error('SSO session expired - please run setup again');
      }
      throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
    }

    // Parse the response
    const models: CodeMieModel[] = (await response.json()) as CodeMieModel[];

    if (!Array.isArray(models)) {
      return [];
    }

    // Filter and map models based on the actual API response structure
    const filteredModels = models
      .filter(model => {
        if (!model) return false;
        // Check for different possible model ID fields
        const hasId = model.id && model.id.trim() !== '';
        const hasBaseName = model.base_name && model.base_name.trim() !== '';
        const hasDeploymentName = model.deployment_name && model.deployment_name.trim() !== '';

        return hasId || hasBaseName || hasDeploymentName;
      })
      .map(model => {
        // Use the most appropriate identifier field
        return model.id || model.base_name || model.deployment_name || model.label || 'unknown';
      })
      .filter(id => id !== 'unknown')
      .sort();

    return filteredModels;

  } catch (error) {
    console.error('Error fetching CodeMie models:', error);
    throw error;
  }
}

export async function fetchCodeMieModelsFromConfig(): Promise<string[]> {
  const store = CredentialStore.getInstance();
  const credentials = await store.retrieveSSOCredentials();

  if (!credentials) {
    throw new Error('No SSO credentials found - please run setup');
  }

  return fetchCodeMieModels(credentials.apiUrl, credentials.cookies);
}

export async function validateCodeMieConnectivity(codeMieUrl: string): Promise<void> {
  // Following the codemie-ide-plugin pattern, we don't perform connectivity validation
  // Instead, we trust that the SSO flow will handle any connectivity issues
  // This function is kept for compatibility but essentially becomes a no-op
  return Promise.resolve();
}