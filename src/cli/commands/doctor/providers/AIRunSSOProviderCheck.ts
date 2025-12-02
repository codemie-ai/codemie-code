/**
 * AI-Run SSO provider health check
 */

import ora from 'ora';
import { CodeMieConfigOptions } from '../../../../utils/config-loader.js';
import { CodeMieSSO } from '../../../../utils/sso-auth.js';
import {
  validateCodeMieConnectivity,
  fetchCodeMieModelsFromConfig,
  fetchCodeMieIntegrationsFromConfig
} from '../../../../utils/codemie-model-fetcher.js';
import { BaseProviderCheck } from './BaseProviderCheck.js';
import { HealthCheckResult, HealthCheckDetail } from '../types.js';
import { logger } from '../../../../utils/logger.js';
import { sanitizeCookies } from '../../../../utils/sanitize.js';

export class AIRunSSOProviderCheck extends BaseProviderCheck {
  readonly supportedProviders = ['ai-run-sso'];

  async check(config: CodeMieConfigOptions): Promise<HealthCheckResult> {
    const details: HealthCheckDetail[] = [];
    let success = true;
    const verbose = logger.isDebugMode();

    // Check CodeMie URL
    if (config.codeMieUrl) {
      details.push({
        status: 'ok',
        message: `CodeMie URL: ${config.codeMieUrl}`
      });

      // Check connectivity
      const connectivitySpinner = ora('Checking CodeMie server connectivity...').start();
      try {
        await validateCodeMieConnectivity();
        connectivitySpinner.stop();
        details.push({
          status: 'ok',
          message: 'CodeMie server accessible'
        });
      } catch (error) {
        connectivitySpinner.stop();
        details.push({
          status: 'error',
          message: `Server connectivity failed: ${error instanceof Error ? error.message : String(error)}`
        });
        success = false;
      }
    } else {
      details.push({
        status: 'error',
        message: 'CodeMie URL not configured',
        hint: 'Run: codemie setup'
      });
      success = false;
    }

    // Check SSO credentials
    try {
      const sso = new CodeMieSSO();
      const credentials = await sso.getStoredCredentials();

      if (credentials) {
        details.push({
          status: 'ok',
          message: 'SSO credentials stored'
        });

        // Verbose: Show detailed credential info
        if (verbose) {
          details.push({
            status: 'info',
            message: `API URL: ${credentials.apiUrl}`
          });
          details.push({
            status: 'info',
            message: `Cookies: ${sanitizeCookies(credentials.cookies)}`
          });
        }

        // Check expiration
        if (credentials.expiresAt) {
          const expiresIn = Math.max(0, credentials.expiresAt - Date.now());
          if (expiresIn > 0) {
            const hours = Math.floor(expiresIn / (1000 * 60 * 60));
            const minutes = Math.floor((expiresIn % (1000 * 60 * 60)) / (1000 * 60));

            if (verbose) {
              details.push({
                status: 'ok',
                message: `Session expires in: ${hours}h ${minutes}m`
              });
            } else {
              details.push({
                status: 'ok',
                message: `Session expires in: ${hours} hours`
              });
            }
          } else {
            details.push({
              status: 'error',
              message: 'SSO session expired',
              hint: 'Run: codemie auth refresh'
            });
            success = false;
          }
        }

        // Test API access
        const apiSpinner = verbose
          ? ora('Testing /v1/llm_models endpoint with redirect following...').start()
          : ora('Testing API access...').start();

        try {
          const startTime = Date.now();
          const models = await fetchCodeMieModelsFromConfig();
          const duration = Date.now() - startTime;

          apiSpinner.stop();

          if (verbose) {
            details.push({
              status: 'ok',
              message: `API accessible (${duration}ms, ${models.length} models)`
            });
            if (models.length > 0) {
              const sampleModels = models.slice(0, 5).join(', ') + (models.length > 5 ? '...' : '');
              details.push({
                status: 'info',
                message: `Sample models: ${sampleModels}`
              });
            }
          } else {
            details.push({
              status: 'ok',
              message: `API access working (${models.length} models available)`
            });
          }
        } catch (error) {
          apiSpinner.stop();
          details.push({
            status: 'error',
            message: `API access error: ${error instanceof Error ? error.message : String(error)}`
          });

          if (verbose && error instanceof Error && error.stack) {
            details.push({
              status: 'info',
              message: `Error details: ${error.stack.split('\n')[0]}`
            });
          }

          if (error instanceof Error && error.message.includes('expired')) {
            details.push({
              status: 'info',
              message: 'Session expired',
              hint: 'Run: codemie auth refresh'
            });
          }
          success = false;
        }

        // Verbose: Network diagnostics
        if (verbose && credentials.apiUrl) {
          try {
            const url = new URL(credentials.apiUrl);
            details.push({
              status: 'info',
              message: `Protocol: ${url.protocol}`
            });
            details.push({
              status: 'info',
              message: `Hostname: ${url.hostname}`
            });
            details.push({
              status: 'info',
              message: `Port: ${url.port || (url.protocol === 'https:' ? '443' : '80')}`
            });
          } catch {
            details.push({
              status: 'error',
              message: 'Invalid API URL format'
            });
          }
        }

        // Check CodeMie integrations (optional)
        if (config.codeMieIntegration) {
          const displayValue = config.codeMieIntegration.alias || config.codeMieIntegration.id || 'unknown';
          details.push({
            status: 'info',
            message: `Integration: ${displayValue}`
          });

          const integrationSpinner = ora('Validating CodeMie integration...').start();
          try {
            const integrations = await fetchCodeMieIntegrationsFromConfig();
            const litellmIntegrations = integrations.filter(i => i.credential_type === 'LiteLLM');

            if (litellmIntegrations.length === 0) {
              integrationSpinner.fail('No LiteLLM integrations found');
              details.push({
                status: 'error',
                message: 'No LiteLLM integrations available',
                hint: 'Contact support to set up LiteLLM integration'
              });
            } else {
              // Use ID for validation if available, otherwise fall back to alias
              const validationKey = config.codeMieIntegration.id ? 'id' : 'alias';
              const validationValue = config.codeMieIntegration.id || config.codeMieIntegration.alias;
              const hasSelectedIntegration = litellmIntegrations.some(i => i[validationKey] === validationValue);

              if (hasSelectedIntegration) {
                const selectedIntegration = litellmIntegrations.find(i => i[validationKey] === validationValue);
                const displayName = selectedIntegration?.project_name
                  ? `${selectedIntegration.alias} (${selectedIntegration.project_name})`
                  : selectedIntegration?.alias || validationValue;

                integrationSpinner.succeed(`Integration validated: ${displayName}`);
              } else {
                integrationSpinner.fail('Selected integration not found');
                details.push({
                  status: 'error',
                  message: 'Configured integration not found'
                });

                // Show available integrations
                details.push({
                  status: 'info',
                  message: 'Available LiteLLM integrations:'
                });
                litellmIntegrations.forEach(integration => {
                  const displayName = integration.project_name
                    ? `${integration.alias} (${integration.project_name})`
                    : integration.alias;
                  details.push({
                    status: 'info',
                    message: `  • ${displayName}`
                  });
                });
                details.push({
                  status: 'info',
                  message: '',
                  hint: 'Run: codemie setup to reconfigure'
                });
              }
            }
          } catch (error) {
            integrationSpinner.fail('Integration validation failed');
            details.push({
              status: 'error',
              message: `Integration error: ${error instanceof Error ? error.message : String(error)}`
            });
          }
        } else {
          details.push({
            status: 'info',
            message: 'No integration configured (optional)'
          });
        }

      } else {
        details.push({
          status: 'error',
          message: 'SSO credentials not found',
          hint: 'Run: codemie auth login'
        });
        success = false;
      }
    } catch (error) {
      details.push({
        status: 'error',
        message: `Error checking SSO credentials: ${error instanceof Error ? error.message : String(error)}`
      });
      success = false;
    }

    return this.createResult('SSO Configuration', success, details);
  }
}
