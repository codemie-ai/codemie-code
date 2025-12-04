/**
 * AI Configuration health check
 */

import { ConfigLoader } from '../../../../utils/config-loader.js';
import { ProviderRegistry } from '../../../../providers/core/registry.js';
import { HealthCheck, HealthCheckResult, HealthCheckDetail, ProgressCallback } from '../types.js';

export class AIConfigCheck implements HealthCheck {
  name = 'Active Profile';

  async run(onProgress?: ProgressCallback): Promise<HealthCheckResult> {
    const details: HealthCheckDetail[] = [];
    let success = true;

    try {
      onProgress?.('Loading profile configuration');

      // Check if any profiles exist first
      const profiles = await ConfigLoader.listProfiles();
      const hasAnyProfiles = profiles.length > 0;

      // If no profiles exist, show single consolidated error
      if (!hasAnyProfiles) {
        details.push({
          status: 'error',
          message: 'No configuration found',
          hint: 'Run: codemie setup'
        });
        success = false;
        return { name: this.name, success, details };
      }

      // Get active profile name and load config
      const activeProfileName = await ConfigLoader.getActiveProfileName();
      const config = await ConfigLoader.load();

      // Check if config is empty or missing required fields
      const hasProvider = !!config.provider;
      const hasBaseUrl = !!config.baseUrl;
      const hasApiKey = !!config.apiKey;
      const hasModel = !!config.model;

      // Get provider template to check requirements
      const providerTemplate = config.provider ? ProviderRegistry.getProvider(config.provider) : null;
      const requiresAuth = providerTemplate?.requiresAuth ?? false; // Default to false

      // Track missing fields for consolidated error message
      const missingFields: string[] = [];

      // Show active profile
      if (activeProfileName) {
        details.push({
          status: 'info',
          message: `Active Profile: ${activeProfileName}`
        });
      }

      // Provider check
      onProgress?.('Checking provider configuration');
      if (hasProvider) {
        details.push({
          status: 'ok',
          message: `Provider: ${config.provider}`
        });
      } else {
        missingFields.push('Provider');
      }

      // Check if provider uses SSO authentication
      const isSSOProvider = providerTemplate?.authType === 'sso';

      // For SSO providers, show CodeMie URL instead of API endpoint
      if (isSSOProvider) {
        onProgress?.('Checking CodeMie URL');
        if (config.codeMieUrl) {
          details.push({
            status: 'ok',
            message: `CodeMie URL: ${config.codeMieUrl}`
          });
        } else {
          missingFields.push('CodeMie URL');
        }
      } else {
        onProgress?.('Checking base URL');
        // For other providers, show Base URL
        if (hasBaseUrl) {
          details.push({
            status: 'ok',
            message: `Base URL: ${config.baseUrl}`
          });
        } else {
          missingFields.push('Base URL');
        }
      }

      // Only check API Key if provider requires authentication
      // Note: SSO providers use cookie-based auth, so they won't have apiKey
      if (requiresAuth) {
        onProgress?.('Checking API key');
        if (hasApiKey && config.apiKey) {
          const masked = config.apiKey.substring(0, 8) + '***' + config.apiKey.substring(config.apiKey.length - 4);
          details.push({
            status: 'ok',
            message: `API Key: ${masked}`
          });
        } else if (!isSSOProvider) {
          // Don't require API key for SSO providers (uses cookies)
          missingFields.push('API Key');
        }
      }

      // Model check
      onProgress?.('Checking model configuration');
      if (hasModel) {
        details.push({
          status: 'ok',
          message: `Model: ${config.model}`
        });
      } else {
        missingFields.push('Model');
      }

      // If any fields are missing, show consolidated error
      if (missingFields.length > 0) {
        details.push({
          status: 'error',
          message: `Missing configuration: ${missingFields.join(', ')}`,
          hint: 'Run: codemie setup'
        });
        success = false;
      }

      // Return config for provider-specific checks
      (this as any).config = config;

    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      details.push({
        status: 'error',
        message: `Configuration error: ${errorMessage}`,
        hint: 'Run: codemie setup'
      });
      success = false;
    }

    return { name: this.name, success, details };
  }

  /**
   * Get loaded config (available after run())
   */
  getConfig(): any {
    return (this as any).config;
  }
}
