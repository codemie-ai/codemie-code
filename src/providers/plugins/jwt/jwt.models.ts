/**
 * JWT Model Proxy
 *
 * Fetches available models from the CodeMie API using a JWT Bearer token.
 */

import type { CodeMieConfigOptions } from '../../../env/types.js';
import type { ModelInfo, ProviderModelFetcher } from '../../core/types.js';
import { fetchCodeMieModels } from '../sso/sso.http-client.js';
import { ProviderRegistry } from '../../core/registry.js';

export class JWTModelProxy implements ProviderModelFetcher {
  supports(provider: string): boolean {
    return provider === 'bearer-auth';
  }

  async fetchModels(config: CodeMieConfigOptions): Promise<ModelInfo[]> {
    const tokenEnvVar = config.jwtConfig?.tokenEnvVar ?? 'CODEMIE_JWT_TOKEN';
    const token = process.env[tokenEnvVar] ?? config.jwtConfig?.token;

    if (!token) {
      throw new Error(
        `JWT token not found. Set ${tokenEnvVar} or pass --jwt-token <token>.`
      );
    }

    const apiUrl = config.baseUrl;
    if (!apiUrl) {
      throw new Error('No baseUrl configured for bearer-auth provider.');
    }

    const modelIds = await fetchCodeMieModels(apiUrl, token);
    return modelIds.map((id) => ({ id, name: id }));
  }
}

ProviderRegistry.registerModelProxy('bearer-auth', new JWTModelProxy());
