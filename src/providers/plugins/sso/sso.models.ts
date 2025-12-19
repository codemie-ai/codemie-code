/**
 * SSO Model Management
 *
 * Fetches available models from CodeMie SSO API.
 * Handles both direct model listing and LiteLLM integration discovery.
 */

import type { CodeMieConfigOptions } from '../../../env/types.js';
import type { ModelInfo, CodeMieIntegration } from '../../core/types.js';
import { BaseModelProxy } from '../../core/base/BaseModelProxy.js';
import { ProviderRegistry } from '../../core/registry.js';
import { CodeMieSSO } from './sso.auth.js';
import { fetchCodeMieModels, fetchCodeMieIntegrations, CODEMIE_ENDPOINTS } from './sso.http-client.js';
import { logger } from '../../../utils/logger.js';

/**
 * SSO Model Proxy
 *
 * Fetches models from CodeMie SSO API and LiteLLM integrations
 */
export class SSOModelProxy extends BaseModelProxy {
  private sso: CodeMieSSO;

  constructor(baseUrl?: string) {
    // SSO doesn't have a fixed base URL, it's resolved from config
    super(baseUrl || '', 10000);
    this.sso = new CodeMieSSO();
  }

  /**
   * Check if this proxy supports the given provider
   */
  supports(provider: string): boolean {
    return provider === 'ai-run-sso';
  }

  /**
   * SSO does not support local model installation
   */
  supportsInstallation(): boolean {
    return false;
  }

  /**
   * List models from SSO API
   *
   * Note: This is mainly for consistency with the interface.
   * For SSO, listModels and fetchModels are essentially the same.
   */
  async listModels(): Promise<ModelInfo[]> {
    try {
      const credentials = await this.sso.getStoredCredentials();
      if (!credentials) {
        throw new Error('No SSO credentials found. Run: codemie profile login');
      }

      return await this.fetchModelsFromAPI(credentials.apiUrl, credentials.cookies);
    } catch (error) {
      logger.debug('Failed to list SSO models:', error);
      throw error;
    }
  }

  /**
   * Fetch models for setup wizard
   *
   * Returns models from CodeMie SSO API
   * @param config - Configuration with optional fresh credentials in providerConfig
   */
  async fetchModels(config: CodeMieConfigOptions): Promise<ModelInfo[]> {
    try {
      // Check if fresh credentials are provided (during setup)
      const freshCookies = config.providerConfig?.cookies as Record<string, string> | undefined;
      const freshApiUrl = config.providerConfig?.apiUrl as string | undefined;

      if (freshCookies && freshApiUrl) {
        // Use fresh credentials from setup flow
        logger.debug('Using fresh credentials from setup flow');
        return await this.fetchModelsFromAPI(freshApiUrl, freshCookies);
      }

      // Try to get stored credentials (post-setup)
      const credentials = await this.sso.getStoredCredentials();

      if (!credentials) {
        // If no credentials yet, return empty array (setup wizard will handle auth)
        logger.debug('No SSO credentials found, returning empty model list');
        return [];
      }

      const apiUrl = credentials.apiUrl || (config.providerConfig?.codeMieUrl as string | undefined);
      if (!apiUrl) {
        throw new Error('No CodeMie URL configured');
      }

      return await this.fetchModelsFromAPI(apiUrl, credentials.cookies);
    } catch (error) {
      logger.debug('Failed to fetch SSO models:', error);
      // Return empty array instead of throwing - setup wizard will handle this
      return [];
    }
  }

  /**
   * Fetch LiteLLM integrations filtered by project (optional)
   *
   * @param codeMieUrl - CodeMie organization URL
   * @param projectName - Optional project name for filtering
   * @param freshCredentials - Optional fresh credentials (used during setup before saving)
   * @returns Array of integrations (filtered if projectName provided)
   */
  async fetchIntegrations(
    codeMieUrl: string,
    projectName?: string,
    freshCredentials?: { apiUrl: string; cookies: Record<string, string> }
  ): Promise<CodeMieIntegration[]> {
    // Use fresh credentials if provided (during setup), otherwise get stored credentials
    const credentials = freshCredentials || await this.sso.getStoredCredentials();
    if (!credentials) {
      logger.debug('No SSO credentials found for fetching integrations');
      throw new Error('No SSO credentials found. Please authenticate first.');
    }

    const apiUrl = credentials.apiUrl || codeMieUrl;

    logger.debug(`Fetching integrations from: ${apiUrl}${CODEMIE_ENDPOINTS.USER_SETTINGS}`);
    if (projectName) {
      logger.debug(`Filtering by project: ${projectName}`);
    }

    try {
      // Fetch all integrations
      const allIntegrations = await fetchCodeMieIntegrations(
          apiUrl,
          credentials.cookies,
          CODEMIE_ENDPOINTS.USER_SETTINGS
      );

      // Filter by project_name if specified
      if (projectName) {
        const filtered = allIntegrations.filter(
          integration => integration.project_name === projectName
        );

        logger.debug(`Filtered ${allIntegrations.length} integrations to ${filtered.length} for project "${projectName}"`);
        return filtered;
      }

      return allIntegrations;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      // Log error details properly
      logger.debug('Failed to fetch SSO integrations:', errorMsg);
      if (errorStack && process.env.CODEMIE_DEBUG) {
        logger.debug('Stack trace:', errorStack);
      }

      // Re-throw with more context
      throw new Error(`Failed to fetch integrations: ${errorMsg}`);
    }
  }

  /**
   * Fetch models from CodeMie API
   */
  private async fetchModelsFromAPI(apiUrl: string, cookies: Record<string, string>): Promise<ModelInfo[]> {
    try {
      // Use the working utility function that handles redirects, SSL, and retry logic
      const modelIds = await fetchCodeMieModels(apiUrl, cookies);

      if (modelIds.length === 0) {
        return [];
      }

      return modelIds.map(id => ({
        id,
        name: id,
        popular: false
      }));
    } catch (error) {
      throw new Error(`Failed to fetch models from SSO API: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}

// Auto-register model proxy
ProviderRegistry.registerModelProxy('ai-run-sso', new SSOModelProxy());
