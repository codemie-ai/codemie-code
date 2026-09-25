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
import { fetchCodeMieLlmModels, fetchCodeMieIntegrations, CODEMIE_ENDPOINTS } from './sso.http-client.js';
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
   * Update the base URL for credential lookup
   * Required because SSO credentials are stored per-URL
   */
  setBaseUrl(url: string): void {
    this.baseUrl = url;
  }

  /**
   * List models from SSO API
   *
   * Note: This is mainly for consistency with the interface.
   * For SSO, listModels and fetchModels are essentially the same.
   * Uses baseUrl from instance to lookup credentials.
   */
  async listModels(): Promise<ModelInfo[]> {
    try {
      const credentials = await this.sso.getStoredCredentials(this.baseUrl);
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
   */
  async fetchModels(config: CodeMieConfigOptions): Promise<ModelInfo[]> {
    try {
      // Try to get credentials with URL parameter
      const lookupUrl = config.codeMieUrl || config.baseUrl;
      const credentials = await this.sso.getStoredCredentials(lookupUrl);

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
   * Fetch LiteLLM integrations filtered by project (optional)
   *
   * @param codeMieUrl - CodeMie organization URL
   * @param projectName - Optional project name for filtering
   * @returns Array of integrations (filtered if projectName provided)
   */
  async fetchIntegrations(codeMieUrl: string, projectName?: string): Promise<CodeMieIntegration[]> {
    const credentials = await this.sso.getStoredCredentials(codeMieUrl);
    if (!credentials) {
      logger.debug(`No SSO credentials found for URL: ${codeMieUrl}`);
      throw new Error('No SSO credentials found. Please authenticate first.');
    }

    const apiUrl = credentials.apiUrl || codeMieUrl;

    logger.debug(`Fetching integrations from: ${apiUrl}${CODEMIE_ENDPOINTS.USER_SETTINGS}`);
    if (projectName) {
      logger.debug(`Filtering by project: ${projectName}`);
    }

    try {
      // Fetch user-level integrations from the SSO settings endpoint
      const allIntegrations = await fetchCodeMieIntegrations(
          apiUrl,
          credentials.cookies
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
   *
   * Uses fetchCodeMieLlmModels (the full descriptor, not the ID-only fetchCodeMieModels) so
   * router entries surface their `is_router`/`litellm_router.is_router` flag as
   * `metadata.isRouter` — the same signal claude.models.ts's `isRouterCatalogEntry` uses to gate
   * the statusline's routing widget. Without this, `codemie models list` silently dropped every
   * router alias a user could actually route through (Switchyard virtual routers and LiteLLM
   * auto-router declarations alike), since fetchCodeMieModels never carried that flag through.
   */
  private async fetchModelsFromAPI(apiUrl: string, cookies: Record<string, string>): Promise<ModelInfo[]> {
    try {
      const llmModels = await fetchCodeMieLlmModels(apiUrl, cookies);

      const models: ModelInfo[] = [];
      for (const model of llmModels) {
        const id = model.deployment_name || model.base_name || model.label;
        if (!id) continue;
        const isRouter = model.is_router === true || model.litellm_router?.is_router === true;
        const isRecommended = SSOTemplate.recommendedModels.includes(id);

        models.push({
          id,
          name: model.label || id,
          popular: isRecommended, // Adds ⭐ to recommended models
          ...(isRouter && { metadata: { isRouter: true } }),
        });
      }
      models.sort((a, b) => a.id.localeCompare(b.id));

      return models;
    } catch (error) {
      throw new Error(`Failed to fetch models from SSO API: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}

// Auto-register model proxy
ProviderRegistry.registerModelProxy('ai-run-sso', new SSOModelProxy());
