/**
 * Configuration Management for CodeMie Native Agent
 *
 * Integrates with the existing CodeMie configuration system while providing
 * agent-specific configuration loading and validation.
 */

import { ConfigLoader, type CodeMieConfigOptions } from '../../utils/config-loader.js';
import type { CodeMieConfig, ProviderConfig } from './types.js';
import { ConfigurationError } from './types.js';
import { CredentialStore } from '../../utils/credential-store.js';
import { ProviderRegistry } from '../../providers/core/registry.js';
import { logger } from '../../utils/logger.js';
import { sanitizeCookies } from '../../utils/sanitize.js';

/**
 * Load and validate configuration for the CodeMie native agent
 */
export async function loadCodeMieConfig(
  workingDir?: string,
  cliOverrides?: Partial<CodeMieConfigOptions>
): Promise<CodeMieConfig> {
  const workDir = workingDir || process.cwd();

  try {
    // Use existing ConfigLoader to get base configuration
    const baseConfig = await ConfigLoader.loadAndValidate(workDir, cliOverrides);

    // Handle SSO configuration
    let resolvedBaseUrl = baseConfig.baseUrl!;
    let resolvedApiKey = baseConfig.apiKey!;

    // Check if provider uses SSO authentication
    const provider = ProviderRegistry.getProvider(baseConfig.provider || '');
    if (provider?.authType === 'sso') {
      const store = CredentialStore.getInstance();
      const credentials = await store.retrieveSSOCredentials();

      if (!credentials) {
        throw new ConfigurationError(
          'SSO credentials not found. Please run: codemie auth login',
          { provider: baseConfig.provider }
        );
      }

      // Use SSO credentials
      resolvedBaseUrl = credentials.apiUrl;
      resolvedApiKey = 'sso-authenticated'; // Placeholder - actual auth via cookies

      // Store cookies for HTTP client access
      (global as any).codemieSSOCookies = credentials.cookies;

      if (baseConfig.debug) {
        logger.debug('SSO credentials loaded from store');
        logger.debug('API URL:', resolvedBaseUrl);
        logger.debug('Cookies:', sanitizeCookies(credentials.cookies));
      }
    }

    // Convert to our agent-specific config format
    const originalProvider = baseConfig.provider!;
    const agentConfig: CodeMieConfig = {
      baseUrl: resolvedBaseUrl,
      authToken: resolvedApiKey,
      model: baseConfig.model!,
      provider: normalizeProvider(originalProvider),
      displayProvider: originalProvider, // Keep original for display
      timeout: baseConfig.timeout || 300,
      workingDirectory: workDir,
      debug: baseConfig.debug || false
    };

    // Validate agent-specific requirements
    validateAgentConfig(agentConfig);

    return agentConfig;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new ConfigurationError(
      `Failed to load configuration: ${errorMessage}`,
      { workingDir, error: errorMessage }
    );
  }
}

/**
 * Normalize provider name to match our type union
 */
function normalizeProvider(provider: string): CodeMieConfig['provider'] {
  const normalized = provider.toLowerCase();

  switch (normalized) {
    case 'openai':
    case 'gpt':
    case 'codex':
      return 'openai';

    case 'azure':
    case 'azure-openai':
      return 'azure';

    case 'bedrock':
    case 'aws-bedrock':
      return 'bedrock';

    case 'litellm':
    case 'proxy':
      return 'litellm';

    default: {
      // For SSO providers, map to litellm (compatible API)
      const providerTemplate = ProviderRegistry.getProvider(provider);
      if (providerTemplate?.authType === 'sso') {
        return 'litellm';
      }

      // Default to OpenAI for unknown providers (most compatible)
      return 'openai';
    }
  }
}

/**
 * Validate agent-specific configuration requirements
 */
function validateAgentConfig(config: CodeMieConfig): void {
  const errors: string[] = [];

  // Basic validation
  if (!config.baseUrl || config.baseUrl.trim() === '') {
    errors.push('baseUrl is required');
  }

  if (!config.authToken || config.authToken.trim() === '') {
    errors.push('authToken/apiKey is required');
  }

  if (!config.model || config.model.trim() === '') {
    errors.push('model is required');
  }

  // Provider-specific validation
  validateProviderConfig(config, errors);

  // Model compatibility validation
  validateModelCompatibility(config, errors);

  if (errors.length > 0) {
    throw new ConfigurationError(
      `Configuration validation failed: ${errors.join(', ')}`,
      { errors, config: sanitizeConfig(config) }
    );
  }
}

/**
 * Provider-specific configuration validation
 */
function validateProviderConfig(config: CodeMieConfig, _errors: string[]): void {
  switch (config.provider) {
    case 'openai':
      if (!config.baseUrl.includes('openai.com') &&
          !config.baseUrl.includes('localhost') &&
          !config.baseUrl.includes('127.0.0.1')) {
        console.warn(`Warning: Using custom endpoint ${config.baseUrl} with OpenAI provider`);
      }
      break;

    case 'azure':
      if (!config.baseUrl.includes('openai.azure.com')) {
        console.warn(`Warning: Azure provider expects *.openai.azure.com endpoint`);
      }
      break;

    case 'bedrock':
      if (config.baseUrl === 'bedrock') {
        // Special case for AWS Bedrock
        break;
      }
      if (!config.baseUrl.includes('bedrock')) {
        console.warn(`Warning: Bedrock provider expects bedrock-compatible endpoint`);
      }
      break;

    case 'litellm':
      // LiteLLM proxy can use any endpoint
      break;
  }
}

/**
 * Validate model compatibility with provider
 */
function validateModelCompatibility(config: CodeMieConfig, errors: string[]): void {
  const model = config.model.toLowerCase();

  switch (config.provider) {
    case 'openai':
      if (model.includes('claude')) {
        errors.push(`Model '${config.model}' is not compatible with OpenAI provider`);
      }
      break;

    case 'azure':
      // Azure uses deployment names, so we can't validate the model name directly
      break;

    case 'bedrock':
      if (!model.includes('claude') && !model.includes('anthropic')) {
        console.warn(`Warning: Model '${config.model}' may not be available in Bedrock`);
      }
      break;

    case 'litellm':
      // LiteLLM proxy can handle model routing
      break;
  }
}

/**
 * Get provider-specific environment variables for the agent
 */
export function getProviderEnvVars(config: CodeMieConfig): Record<string, string> {
  return ConfigLoader.exportProviderEnvVars({
    provider: config.provider,
    baseUrl: config.baseUrl,
    apiKey: config.authToken,
    model: config.model,
    timeout: config.timeout,
    debug: config.debug
  });
}

/**
 * Create provider-specific configuration
 */
export function createProviderConfig(config: CodeMieConfig): ProviderConfig[keyof ProviderConfig] {
  switch (config.provider) {
    case 'openai':
      return {
        apiKey: config.authToken,
        ...(config.baseUrl !== 'https://api.openai.com/v1' && { baseURL: config.baseUrl }),
        ...(process.env.OPENAI_ORG_ID && { organization: process.env.OPENAI_ORG_ID })
      };

    case 'azure':
      return {
        apiKey: config.authToken,
        endpoint: config.baseUrl,
        deploymentName: config.model,
        apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-02-01'
      };

    case 'bedrock':
      return {
        region: process.env.AWS_REGION || 'us-east-1',
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
      };

    case 'litellm':
      return {
        apiKey: config.authToken,
        baseURL: config.baseUrl,
        model: config.model
      };

    default:
      throw new ConfigurationError(`Unsupported provider: ${config.provider}`);
  }
}

/**
 * Sanitize configuration for logging (remove sensitive data)
 */
function sanitizeConfig(config: CodeMieConfig): Partial<CodeMieConfig> {
  return {
    baseUrl: config.baseUrl,
    model: config.model,
    provider: config.provider,
    displayProvider: config.displayProvider,
    timeout: config.timeout,
    workingDirectory: config.workingDirectory,
    debug: config.debug,
    authToken: `${config.authToken.slice(0, 8)}***`
  };
}

/**
 * Get configuration summary for display
 */
export function getConfigSummary(config: CodeMieConfig): string {
  const sanitized = sanitizeConfig(config);
  return [
    `Provider: ${sanitized.displayProvider || sanitized.provider}`,
    `Model: ${sanitized.model}`,
    `Base URL: ${sanitized.baseUrl}`,
    `Working Directory: ${sanitized.workingDirectory}`,
    `Debug: ${sanitized.debug ? 'ON' : 'OFF'}`,
    `Timeout: ${sanitized.timeout}s`
  ].join('\n');
}

/**
 * Check if configuration is valid without throwing
 */
export async function isConfigValid(workingDir?: string): Promise<boolean> {
  try {
    await loadCodeMieConfig(workingDir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get configuration status for health checks
 */
export async function getConfigStatus(workingDir?: string): Promise<{
  valid: boolean;
  hasGlobalConfig: boolean;
  hasProjectConfig: boolean;
  provider?: string;
  model?: string;
  error?: string;
}> {
  const workDir = workingDir || process.cwd();

  try {
    const config = await loadCodeMieConfig(workDir);
    const hasGlobal = await ConfigLoader.hasGlobalConfig();
    const hasProject = await ConfigLoader.hasProjectConfig(workDir);

    return {
      valid: true,
      hasGlobalConfig: hasGlobal,
      hasProjectConfig: hasProject,
      provider: config.provider,
      model: config.model
    };
  } catch (error) {
    const hasGlobal = await ConfigLoader.hasGlobalConfig();
    const hasProject = await ConfigLoader.hasProjectConfig(workDir);

    return {
      valid: false,
      hasGlobalConfig: hasGlobal,
      hasProjectConfig: hasProject,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}