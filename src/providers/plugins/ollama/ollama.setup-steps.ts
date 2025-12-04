/**
 * Ollama Provider Setup Steps
 *
 * Implements setup flow for Ollama (local model provider).
 * Unique features:
 * - Health check (verify Ollama is running)
 * - Model installation support (extra step)
 */

import type {
  ProviderSetupSteps,
  ProviderCredentials
} from '../../core/types.js';
import type { CodeMieConfigOptions } from '../../../env/types.js';
import { ProviderRegistry } from '../../core/registry.js';
import { OllamaTemplate } from './ollama.template.js';

/**
 * Ollama setup steps implementation
 *
 * Handles Ollama-specific setup flow with health checks and model discovery
 */
export const OllamaSetupSteps: ProviderSetupSteps = {
  name: 'ollama',

  /**
   * Get credentials for Ollama
   * Ollama runs locally so no API key needed, just verify it's running
   */
  async getCredentials(): Promise<ProviderCredentials> {
    const inquirer = (await import('inquirer')).default;
    const ora = (await import('ora')).default;
    const chalk = (await import('chalk')).default;
    const { OllamaHealthCheck } = await import('./ollama.health.js');

    // Ask for Ollama base URL first (allow pressing Enter for default)
    const { baseUrl } = await inquirer.prompt([
      {
        type: 'input',
        name: 'baseUrl',
        message: 'Ollama base URL:',
        default: OllamaTemplate.defaultBaseUrl,
        validate: (input: string) => input.trim() !== '' || 'Base URL is required'
      }
    ]);

    // Check if Ollama is running at the specified URL
    const healthSpinner = ora('Checking if Ollama is running...').start();
    const healthCheck = new OllamaHealthCheck(baseUrl);

    try {
      const result = await healthCheck.check({
        provider: 'ollama',
        baseUrl,
        apiKey: '',
        model: 'temp',
        timeout: 300
      });

      if (result.status === 'unreachable') {
        healthSpinner.fail(chalk.red('Ollama is not running'));
        console.log(chalk.yellow('\n' + result.remediation + '\n'));

        const { continueAnyway } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'continueAnyway',
            message: 'Continue with setup anyway?',
            default: false
          }
        ]);

        if (!continueAnyway) {
          throw new Error('Setup cancelled - please start Ollama first');
        }
      } else if (result.status === 'unhealthy') {
        // Ollama is running but no models installed - that's OK for setup
        healthSpinner.succeed(chalk.green('Ollama is running (no models installed yet)'));
        console.log(chalk.dim('  You can install models after setup completes\n'));
      } else {
        // Healthy - Ollama running with models
        healthSpinner.succeed(chalk.green(result.message));
      }
    } catch (error) {
      healthSpinner.fail(chalk.red('Failed to check Ollama health'));
      throw error;
    }

    return {
      baseUrl,
      apiKey: '' // Ollama doesn't use API keys
    };
  },

  /**
   * Fetch available models from Ollama
   */
  async fetchModels(credentials: ProviderCredentials): Promise<string[]> {
    const { OllamaModelProxy } = await import('./ollama.models.js');

    const modelProxy = new OllamaModelProxy(credentials.baseUrl);

    try {
      const models = await modelProxy.fetchModels({
        provider: 'ollama',
        baseUrl: credentials.baseUrl,
        apiKey: '',
        model: 'temp',
        timeout: 300
      });

      return models.map(m => m.id);
    } catch {
      // If fetch fails, return recommended models
      return OllamaTemplate.recommendedModels;
    }
  },

  /**
   * Install model if not already installed
   */
  async installModel(credentials: ProviderCredentials, selectedModel: string, _availableModels: string[]): Promise<void> {
    const ora = (await import('ora')).default;
    const chalk = (await import('chalk')).default;
    const { OllamaModelProxy } = await import('./ollama.models.js');

    const modelProxy = new OllamaModelProxy(credentials.baseUrl);

    // Check if model is actually installed by querying Ollama directly
    let isInstalled = false;
    try {
      const installedModels = await modelProxy.listModels();
      isInstalled = installedModels.some(m => m.id === selectedModel);
    } catch {
      // If we can't check, assume not installed
      isInstalled = false;
    }

    if (isInstalled) {
      console.log(chalk.dim(`  Model "${selectedModel}" is already installed\n`));
      return;
    }

    // Model needs to be installed
    console.log(chalk.cyan(`\n📦 Installing model: ${selectedModel}`));
    console.log(chalk.dim('  This may take several minutes depending on model size...\n'));

    const installSpinner = ora(`Pulling ${selectedModel}...`).start();

    try {
      await modelProxy.installModel(selectedModel, (progress) => {
        if (progress.status === 'downloading') {
          installSpinner.text = progress.message || `Pulling ${selectedModel}...`;
        } else if (progress.status === 'complete') {
          installSpinner.succeed(chalk.green(progress.message || `Successfully installed ${selectedModel}`));
        } else if (progress.status === 'error') {
          installSpinner.fail(chalk.red(progress.message || `Failed to install ${selectedModel}`));
        }
      });

      console.log(chalk.green(`✓ Model "${selectedModel}" is ready to use\n`));
    } catch (error) {
      installSpinner.fail(chalk.red('Model installation failed'));
      throw new Error(`Failed to install model: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  },

  /**
   * Build configuration for Ollama
   */
  buildConfig(credentials: ProviderCredentials, model: string): Partial<CodeMieConfigOptions> {
    return {
      provider: 'ollama',
      baseUrl: credentials.baseUrl,
      apiKey: '', // Ollama doesn't use API keys
      model,
      timeout: 300,
      debug: false
    };
  }
};

// Auto-register setup steps
ProviderRegistry.registerSetupSteps('ollama', OllamaSetupSteps);
