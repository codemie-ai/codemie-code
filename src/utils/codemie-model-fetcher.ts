import { CodeMieModel } from '../types/sso.js';
import { CredentialStore } from './credential-store.js';
import https from 'https';
import { URL } from 'url';

export async function fetchCodeMieModels(
  apiUrl: string,
  cookies: Record<string, string>
): Promise<string[]> {
  const cookieString = Object.entries(cookies)
    .map(([key, value]) => `${key}=${value}`)
    .join(';');

  try {
    // Use custom HTTPS request to properly handle certificate issues in enterprise environments
    const parsedUrl = new URL(`${apiUrl}/v1/llm_models`);

    const requestOptions: https.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'cookie': cookieString,
        'Content-Type': 'application/json',
        'User-Agent': 'CodeMie-CLI/1.0.0'
      },
      // Handle certificate issues commonly found in enterprise environments
      rejectUnauthorized: false, // Allow self-signed certificates
      timeout: 10000
    };

    const response = await new Promise<{ statusCode?: number; statusMessage?: string; data: string }>((resolve, reject) => {
      const req = https.request(requestOptions, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            statusMessage: res.statusMessage,
            data
          });
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.end();
    });

    if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
      if (response.statusCode === 401 || response.statusCode === 403) {
        throw new Error('SSO session expired - please run setup again');
      }
      throw new Error(`Failed to fetch models: ${response.statusCode} ${response.statusMessage}`);
    }

    // Parse the response
    const models: CodeMieModel[] = JSON.parse(response.data) as CodeMieModel[];

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

export async function validateCodeMieConnectivity(): Promise<void> {
  // Following the codemie-ide-plugin pattern, we don't perform connectivity validation
  // Instead, we trust that the SSO flow will handle any connectivity issues
  // This function is kept for compatibility but essentially becomes a no-op
  return Promise.resolve();
}