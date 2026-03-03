/**
 * Configuration adapter between CodeMie and OpenCode formats
 */

import type { CodeMieConfig, OpenCodeConfig } from './types.js';

/**
 * Provider name mapping from CodeMie to OpenCode format
 */
const PROVIDER_MAP: Record<string, string> = {
  openai: 'openai',
  anthropic: 'anthropic',
  azure: 'azure',
  bedrock: 'amazon-bedrock',
  litellm: 'openai', // LiteLLM uses OpenAI-compatible API
  ollama: 'openai', // Ollama uses OpenAI-compatible API
};

/**
 * Transform CodeMie configuration to OpenCode configuration format
 *
 * @param config - CodeMie configuration
 * @returns OpenCode-compatible configuration
 */
export function transformConfig(config: CodeMieConfig): OpenCodeConfig {
  // Map provider name
  const provider = PROVIDER_MAP[config.provider] || config.provider;

  // Construct OpenCode config
  const openCodeConfig: OpenCodeConfig = {
    provider,
    model: config.model,
    directory: config.workingDirectory,
    debug: config.debug,
  };

  // Add API key if present
  if (config.authToken) {
    openCodeConfig.apiKey = config.authToken;
  }

  // Add base URL for custom endpoints
  if (config.baseUrl) {
    openCodeConfig.baseUrl = config.baseUrl;
  }

  return openCodeConfig;
}

/**
 * Validate that the provider is supported by OpenCode
 *
 * @param provider - Provider name from CodeMie config
 * @returns True if supported
 */
export function isProviderSupported(provider: string): boolean {
  return provider in PROVIDER_MAP;
}

/**
 * Get OpenCode provider name from CodeMie provider
 *
 * @param provider - CodeMie provider name
 * @returns OpenCode provider name
 */
export function getOpenCodeProvider(provider: string): string {
  return PROVIDER_MAP[provider] || provider;
}
