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
import { toCloudOffloadTag } from './ollama.models.js';

/**
 * Ollama setup steps implementation
 *
 * Handles Ollama-specific setup flow with health checks and model discovery
 */
export const OllamaSetupSteps: ProviderSetupSteps = {
  name: 'ollama',

  /**
   * Get credentials for Ollama
   * The local daemon needs no API key; an optional ollama.com API key
   * additionally enables listing models available on Ollama cloud.
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

    // Detect system capabilities (with GPU probe) so model selection can
    // recommend only the local models that actually fit this machine
    const { detectSystemCapabilities } = await import('../../../utils/hardware.js');
    const capabilities = await detectSystemCapabilities();
    console.log(chalk.dim(
      `  System: ~${Math.round(capabilities.totalMemoryGb)}GB RAM` +
      (capabilities.gpuMemoryGb ? `, ~${Math.round(capabilities.gpuMemoryGb)}GB GPU VRAM` : '') +
      ` (~${Math.round(capabilities.usableMemoryGb)}GB usable for local models)\n`
    ));

    // Optional ollama.com API key - lets agents run cloud models directly
    // on ollama.com (no local daemon) and unlocks Ollama's web search/fetch
    // API (https://ollama.com/settings/keys). Not needed for local usage.
    const { apiKey: cloudApiKey } = await inquirer.prompt([
      {
        type: 'password',
        name: 'apiKey',
        message: 'Ollama cloud API key (optional, for ollama.com direct access):',
        mask: '*'
      }
    ]);

    let apiKey = (cloudApiKey || '').trim();

    // Validate the key against ollama.com before saving it
    if (apiKey) {
      const keySpinner = ora('Validating Ollama cloud API key...').start();
      const { validateOllamaCloudApiKey } = await import('./ollama.models.js');

      if (await validateOllamaCloudApiKey(apiKey)) {
        keySpinner.succeed(chalk.green('Ollama cloud API key is valid'));
      } else {
        keySpinner.fail(chalk.red('Ollama cloud API key validation failed'));
        console.log(chalk.yellow('  Check your key at https://ollama.com/settings/keys\n'));

        const { keepKey } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'keepKey',
            message: 'Save this key anyway?',
            default: false
          }
        ]);

        if (!keepKey) {
          apiKey = '';
        }
      }
    }

    return {
      baseUrl,
      apiKey
    };
  },

  /**
   * Fetch available models from Ollama
   *
   * Offers installed local models, the template's curated recommendations,
   * and the ollama.com cloud catalog (capability filtering happens in the
   * selection UI via modelMetadata).
   *
   * For local setups (daemon at localhost) cloud catalog entries are mapped
   * to their local cloud-offload tag (`gpt-oss:120b` -> `gpt-oss:120b-cloud`,
   * `kimi-k2.6` -> `kimi-k2.6:cloud`) so selecting one pulls an instant
   * manifest and runs it on Ollama cloud through the signed-in daemon.
   * When the base URL points at ollama.com directly, raw catalog ids are
   * used as-is.
   */
  async fetchModels(credentials: ProviderCredentials): Promise<string[]> {
    const { OllamaModelProxy } = await import('./ollama.models.js');

    const modelProxy = new OllamaModelProxy(credentials.baseUrl, credentials.apiKey);

    try {
      const models = await modelProxy.fetchModels({
        provider: 'ollama',
        baseUrl: credentials.baseUrl,
        apiKey: credentials.apiKey || '',
        model: 'temp',
        timeout: 300
      });

      const isCloudHost = (credentials.baseUrl || '').includes('ollama.com');
      const ids = models.map(m =>
        !isCloudHost && m.metadata?.origin === 'cloud'
          ? toCloudOffloadTag(m.id)
          : m.id
      );

      return [...new Set([...ids, ...OllamaTemplate.recommendedModels])];
    } catch {
      // If fetch fails, return empty so setup prompts the user to enter a
      // model manually instead of showing a static, possibly stale list.
      return [];
    }
  },

  /**
   * Install model if not already installed
   */
  async installModel(credentials: ProviderCredentials, selectedModel: string, _availableModels: string[]): Promise<void> {
    const ora = (await import('ora')).default;
    const chalk = (await import('chalk')).default;
    const { OllamaModelProxy } = await import('./ollama.models.js');

    const modelProxy = new OllamaModelProxy(credentials.baseUrl, credentials.apiKey);

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
      const isCloudModel = selectedModel.endsWith('-cloud') || selectedModel.endsWith(':cloud');
      const hint = isCloudModel
        ? ' (cloud models require `ollama signin` or a configured Ollama cloud API key)'
        : '';
      throw new Error(`Failed to install model: ${error instanceof Error ? error.message : 'Unknown error'}${hint}`);
    }
  },

  /**
   * Build configuration for Ollama
   */
  buildConfig(credentials: ProviderCredentials, model: string): Partial<CodeMieConfigOptions> {
    // Ensure baseURL includes /v1 for OpenAI-compatible API
    // Ollama supports OpenAI-compatible endpoints at /v1/chat/completions
    let baseUrl = credentials.baseUrl || OllamaTemplate.defaultBaseUrl;
    if (!baseUrl.endsWith('/v1') && !baseUrl.includes('/v1/')) {
      baseUrl = `${baseUrl}/v1`;
    }

    return {
      provider: 'ollama',
      baseUrl,
      apiKey: credentials.apiKey || '', // Optional ollama.com cloud API key
      model,
      timeout: 300,
      debug: false
    };
  }
};

// Auto-register setup steps
ProviderRegistry.registerSetupSteps('ollama', OllamaSetupSteps);
