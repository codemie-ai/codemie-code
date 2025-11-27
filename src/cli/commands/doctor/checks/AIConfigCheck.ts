/**
 * AI Configuration health check
 */

import { ConfigLoader } from '../../../../utils/config-loader.js';
import { HealthCheck, HealthCheckResult, HealthCheckDetail, ProgressCallback } from '../types.js';

export class AIConfigCheck implements HealthCheck {
  name = 'AI Configuration';

  async run(onProgress?: ProgressCallback): Promise<HealthCheckResult> {
    const details: HealthCheckDetail[] = [];
    let success = true;

    try {
      onProgress?.('Loading profile configuration');
      // Get active profile name
      const activeProfileName = await ConfigLoader.getActiveProfileName();
      const config = await ConfigLoader.load();

      // Check if config is empty or missing required fields
      const hasProvider = !!config.provider;
      const hasBaseUrl = !!config.baseUrl;
      const hasApiKey = !!config.apiKey;
      const hasModel = !!config.model;
      const isSSOProvider = config.provider === 'ai-run-sso';

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
        details.push({
          status: 'error',
          message: 'Provider not configured',
          hint: 'Run: codemie setup'
        });
        success = false;
      }

      // For SSO, show CodeMie URL instead of API endpoint
      if (isSSOProvider) {
        onProgress?.('Checking CodeMie URL');
        if (config.codeMieUrl) {
          details.push({
            status: 'ok',
            message: `CodeMie URL: ${config.codeMieUrl}`
          });
        } else {
          details.push({
            status: 'error',
            message: 'CodeMie URL not configured',
            hint: 'Run: codemie setup'
          });
          success = false;
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
          details.push({
            status: 'error',
            message: 'Base URL not configured',
            hint: 'Run: codemie setup'
          });
          success = false;
        }
      }

      // Don't show API Key for SSO (uses cookie-based authentication)
      if (!isSSOProvider) {
        onProgress?.('Checking API key');
        if (hasApiKey && config.apiKey) {
          const masked = config.apiKey.substring(0, 8) + '***' + config.apiKey.substring(config.apiKey.length - 4);
          details.push({
            status: 'ok',
            message: `API Key: ${masked}`
          });
        } else {
          details.push({
            status: 'error',
            message: 'API Key not configured',
            hint: 'Run: codemie setup'
          });
          success = false;
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
        details.push({
          status: 'error',
          message: 'Model not configured',
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
