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
 * Split a base model slug (no tag) into its family root and version, e.g.
 * "qwen3.8" -> { family: "qwen", version: [3, 8] }, "glm-5.1" -> { family:
 * "glm", version: [5, 1] }. Slugs with no trailing version number (e.g.
 * "gpt-oss", or tier variants like "nemotron-3-super") get their own
 * singleton family - only sequential releases of the same lineage collapse
 * together, not parallel size/tier variants.
 */
function familyAndVersion(slug: string): { family: string; version: number[] } {
  const match = slug.match(/^(.*?)-?(\d+(?:\.\d+)*)$/);
  if (!match) {
    return { family: slug, version: [] };
  }
  return { family: match[1], version: match[2].split('.').map(Number) };
}

// Descending comparator: negative means `a` is the newer/higher version.
function compareVersionsDesc(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = (b[i] ?? 0) - (a[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

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
   * Offers installed local models and the ollama.com cloud catalog - both
   * live data, no hardcoded list. Anything beyond that narrow set is found
   * via searchModel() below, which searches Ollama's full model library on
   * demand.
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

      return [...new Set(ids)];
    } catch {
      // If fetch fails, return empty so setup prompts the user to search or
      // enter a model manually instead of showing a static, possibly stale list.
      return [];
    }
  },

  /**
   * Mark up to 3 of the fetched models as recommended, using live signals
   * instead of a hardcoded list:
   * - Fits the current machine (cloud models always do - they run on
   *   ollama.com; local models are checked against their real installed
   *   size vs. this machine's usable RAM).
   * - Supports tools/function-calling (most coding agents require it -
   *   see the "tools" capability badge on the model's ollama.com page).
   * - Ranked by real-world popularity (download count on that same page) -
   *   but grouped by model lineage first (e.g. qwen3.5/3.6/3.8 all count
   *   toward one "qwen" score) so an older release's download lead doesn't
   *   bury its own newer version; the top 3 lineages are returned, each
   *   represented by its most recent version (qwen3.5 may be the most
   *   downloaded, but qwen3.8 - the newest - is what gets recommended).
   */
  async getRecommendedModels(models: string[], credentials: ProviderCredentials): Promise<string[]> {
    if (models.length === 0) {
      return [];
    }

    const { OllamaModelProxy } = await import('./ollama.models.js');
    const { getOllamaModelDetails } = await import('./ollama.library.js');
    const { detectSystemCapabilities } = await import('../../../utils/hardware.js');

    const modelProxy = new OllamaModelProxy(credentials.baseUrl, credentials.apiKey);

    // Real installed sizes, for the environment-fit check below.
    const sizeById = new Map<string, number>();
    try {
      for (const model of await modelProxy.listModels()) {
        if (model.size) {
          sizeById.set(model.id, model.size);
        }
      }
    } catch {
      // No local daemon reachable - every remaining id is a cloud one anyway.
    }

    let usableMemoryGb = Infinity;
    try {
      usableMemoryGb = (await detectSystemCapabilities()).usableMemoryGb;
    } catch {
      // Can't probe hardware - don't let that block recommendations.
    }

    const isCloudHost = (credentials.baseUrl || '').includes('ollama.com');
    const isCloudId = (id: string): boolean => isCloudHost || id.endsWith('-cloud') || id.endsWith(':cloud');

    const fitsEnvironment = (id: string): boolean => {
      if (isCloudId(id)) {
        return true;
      }
      const bytes = sizeById.get(id);
      if (!bytes) {
        return true; // No size data - don't penalize for missing info
      }
      return bytes / 1024 ** 3 <= usableMemoryGb;
    };

    // Bound worst case (e.g. many locally-installed models) before the
    // per-model network fetch below.
    const candidates = models.filter(fitsEnvironment).slice(0, 25);
    if (candidates.length === 0) {
      return [];
    }

    const scored = await Promise.all(
      candidates.map(async id => {
        const baseSlug = id.split(':')[0];
        try {
          const details = await getOllamaModelDetails(baseSlug);
          return { id, ...details };
        } catch {
          return { id, downloads: 0, supportsTools: false };
        }
      })
    );

    // Group by lineage so an older release's accumulated downloads don't
    // bury its own newer version; each group is scored by its most
    // downloaded member but represented by its most recent one.
    interface FamilyGroup {
      popularityScore: number;
      representativeId: string;
      representativeVersion: number[];
    }
    const families = new Map<string, FamilyGroup>();

    for (const s of scored.filter(s => s.supportsTools)) {
      const { family, version } = familyAndVersion(s.id.split(':')[0]);
      const existing = families.get(family);

      if (!existing) {
        families.set(family, { popularityScore: s.downloads, representativeId: s.id, representativeVersion: version });
        continue;
      }

      existing.popularityScore = Math.max(existing.popularityScore, s.downloads);
      if (compareVersionsDesc(version, existing.representativeVersion) < 0) {
        existing.representativeId = s.id;
        existing.representativeVersion = version;
      }
    }

    return [...families.values()]
      .sort((a, b) => b.popularityScore - a.popularityScore)
      .slice(0, 3)
      .map(g => g.representativeId);
  },

  /**
   * Interactive live search against ollama.com's model library.
   *
   * The fetchModels() list only covers installed/cloud-catalog models; this
   * lets a user find and install anything else in Ollama's public library
   * (e.g. a model that isn't already installed and isn't in the curated
   * cloud catalog) without knowing its exact id up front.
   */
  async searchModel(_credentials: ProviderCredentials): Promise<string | null> {
    const inquirer = (await import('inquirer')).default;
    const ora = (await import('ora')).default;
    const chalk = (await import('chalk')).default;
    const { searchOllamaLibrary, listOllamaModelTags } = await import('./ollama.library.js');

    const { query } = await inquirer.prompt([
      {
        type: 'input',
        name: 'query',
        message: 'Search Ollama library:'
      }
    ]);

    if (!query || !query.trim()) {
      return null;
    }

    const searchSpinner = ora(`Searching Ollama library for "${query.trim()}"...`).start();
    let results;
    try {
      results = await searchOllamaLibrary(query.trim());
      searchSpinner.succeed(chalk.green(`Found ${results.length} model(s)`));
    } catch (error) {
      searchSpinner.fail(chalk.red('Search failed'));
      console.log(chalk.dim(`  ${error instanceof Error ? error.message : 'Unknown error'}\n`));
      return null;
    }

    const { picked } = await inquirer.prompt([
      {
        type: 'list',
        name: 'picked',
        message: 'Select a model:',
        pageSize: 15,
        choices: [
          ...results.map(r => ({
            name: r.description ? `${r.name} ${chalk.dim(`- ${r.description}`)}` : r.name,
            value: r.name
          })),
          { name: chalk.dim('← Back'), value: null }
        ]
      }
    ]);

    if (!picked) {
      return null;
    }

    const tagSpinner = ora(`Fetching available sizes for ${picked}...`).start();
    let tags: string[] = [];
    try {
      tags = await listOllamaModelTags(picked);
      tagSpinner.succeed(chalk.green(`Found ${tags.length} variant(s)`));
    } catch (error) {
      tagSpinner.warn(chalk.yellow('Could not fetch size variants - using default'));
      console.log(chalk.dim(`  ${error instanceof Error ? error.message : 'Unknown error'}\n`));
      return picked;
    }

    const { tag } = await inquirer.prompt([
      {
        type: 'list',
        name: 'tag',
        message: `Choose a variant of ${picked}:`,
        pageSize: 15,
        choices: tags
      }
    ]);

    return tag;
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
