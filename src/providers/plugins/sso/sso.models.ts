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
import { SSOTemplate } from './sso.template.js';
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
        throw new Error('No SSO credentials found. Run: codemie auth login');
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
   */
  async fetchModels(config: CodeMieConfigOptions): Promise<ModelInfo[]> {
    try {
      // Try to get credentials
      const credentials = await this.sso.getStoredCredentials();

      if (!credentials) {
        // If no credentials yet, return empty array (setup wizard will handle auth)
        logger.debug('No SSO credentials found, returning empty model list');
        return [];
      }

      // Use API URL from credentials or config
      const apiUrl = credentials.apiUrl || config.codeMieUrl;
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
   * Fetch LiteLLM integrations
   */
  async fetchIntegrations(codeMieUrl: string): Promise<CodeMieIntegration[]> {
    const credentials = await this.sso.getStoredCredentials();
    if (!credentials) {
      logger.debug('No SSO credentials found for fetching integrations');
      throw new Error('No SSO credentials found. Please authenticate first.');
    }

    const apiUrl = credentials.apiUrl || codeMieUrl;

    logger.debug(`Fetching integrations from: ${apiUrl}${CODEMIE_ENDPOINTS.USER_SETTINGS}`);

    try {
      // Use the working utility function that handles redirects and SSL
      return await fetchCodeMieIntegrations(
          apiUrl,
          credentials.cookies,
          CODEMIE_ENDPOINTS.USER_SETTINGS
      );
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

      // Transform model IDs to ModelInfo format
      // Mark recommended models as popular for highlighting (⭐)
      const models = modelIds.map(id => {
        const isRecommended = SSOTemplate.recommendedModels.includes(id);

        return {
          id,
          name: id, // Use label from API
          popular: isRecommended // Adds ⭐ to recommended models
        };
      });

      return models;
    } catch (error) {
      throw new Error(`Failed to fetch models from SSO API: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}

// Auto-register model proxy
ProviderRegistry.registerModelProxy('ai-run-sso', new SSOModelProxy());
