/**
 * Standard provider health check (OpenAI, Azure, LiteLLM, Gemini, etc.)
 */

import ora from 'ora';
import { CodeMieConfigOptions } from '../../../../utils/config-loader.js';
import { checkProviderHealth } from '../../../../utils/health-checker.js';
import { fetchAvailableModels } from '../../../../utils/model-fetcher.js';
import { BaseProviderCheck } from './BaseProviderCheck.js';
import { HealthCheckResult, HealthCheckDetail } from '../types.js';

export class StandardProviderCheck extends BaseProviderCheck {
  readonly supportedProviders = ['openai', 'azure', 'litellm', 'gemini', 'codex'];

  async check(config: CodeMieConfigOptions): Promise<HealthCheckResult> {
    const details: HealthCheckDetail[] = [];
    let success = true;

    // Test connectivity
    if (config.baseUrl && config.apiKey && config.model) {
      const healthSpinner = ora('Validating credentials and endpoint...').start();

      try {
        const startTime = Date.now();
        const result = await checkProviderHealth(config.baseUrl, config.apiKey);
        const duration = Date.now() - startTime;

        if (!result.success) {
          throw new Error(result.message);
        }

        healthSpinner.succeed('Credentials validated');
        details.push({
          status: 'ok',
          message: `Response time: ${duration}ms`
        });
        details.push({
          status: 'info',
          message: `Status: ${result.message}`
        });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        healthSpinner.fail('Connection test failed');
        details.push({
          status: 'error',
          message: `Connection error: ${errorMessage}`
        });
        success = false;
      }

      // Fetch and verify models (skip for Bedrock)
      if (config.provider !== 'bedrock') {
        const modelsSpinner = ora('Fetching available models...').start();

        try {
          const availableModels = await fetchAvailableModels({
            provider: config.provider,
            baseUrl: config.baseUrl,
            apiKey: config.apiKey,
            model: config.model,
            timeout: config.timeout || 300
          });

          if (availableModels.length > 0) {
            modelsSpinner.succeed(`Found ${availableModels.length} available models`);

            // Check if configured model exists
            const configuredModel = config.model;
            const modelExists = availableModels.includes(configuredModel);

            if (modelExists) {
              details.push({
                status: 'ok',
                message: `Configured model '${configuredModel}' is available`
              });
            } else {
              details.push({
                status: 'warn',
                message: `Configured model '${configuredModel}' not found in available models`
              });
              details.push({
                status: 'info',
                message: `Available models: ${availableModels.slice(0, 5).join(', ')}${availableModels.length > 5 ? '...' : ''}`
              });
              success = false;
            }
          } else {
            modelsSpinner.warn('Could not fetch models from provider');
            details.push({
              status: 'info',
              message: `Using configured model: ${config.model}`
            });
          }
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          modelsSpinner.warn('Model verification skipped');
          details.push({
            status: 'info',
            message: `Model verification error: ${errorMessage}`
          });
        }
      }
    }

    return this.createResult('Connectivity Test', success, details);
  }
}
