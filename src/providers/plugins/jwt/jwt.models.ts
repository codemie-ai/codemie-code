/**
 * JWT Model Proxy
 *
 * Fetches available models from the CodeMie API using a JWT Bearer token.
 */

import type { CodeMieConfigOptions } from '@/env/types.js';
import type { ModelInfo, ProviderModelFetcher } from '@/providers/core/types.js';
import { ProviderName } from '@/providers/core/types.js';
import { resolveJwtToken, resolveJwtTokenEnvVar } from '@/providers/plugins/jwt/jwt.utils.js';
import { fetchCodeMieModels } from '@/providers/plugins/sso/sso.http-client.js';
import { ProviderRegistry } from '@/providers/core/registry.js';

export class JWTModelProxy implements ProviderModelFetcher {
  supports(provider: string): boolean {
    return provider === ProviderName.BEARER_AUTH;
  }

  async fetchModels(config: CodeMieConfigOptions): Promise<ModelInfo[]> {
    const token = resolveJwtToken(config);

    if (!token) {
      throw new Error(
        `JWT token not found. Set ${resolveJwtTokenEnvVar(config)} or pass --jwt-token <token>.`
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

ProviderRegistry.registerModelProxy(ProviderName.BEARER_AUTH, new JWTModelProxy());
