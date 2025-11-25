import { Command } from 'commander';
import { readFileSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import { AgentAdapter } from './types.js';
import { ConfigLoader, CodeMieConfigOptions } from '../../utils/config-loader.js';
import { logger } from '../../utils/logger.js';
import { getDirname } from '../../utils/dirname.js';
import { ClaudePluginMetadata } from '../plugins/claude.plugin.js';
import { CodexPluginMetadata } from '../plugins/codex.plugin.js';
import { CodeMieCodePluginMetadata } from '../plugins/codemie-code.plugin.js';
import { GeminiPluginMetadata } from '../plugins/gemini.plugin.js';

/**
 * Universal CLI builder for any agent
 * Builds commander programs from agent metadata
 */
export class AgentCLI {
  private program: Command;
  private version: string = '1.0.0';

  constructor(private adapter: AgentAdapter) {
    this.program = new Command();
    this.loadVersion();
    this.setupProgram();
  }

  /**
   * Load version from package.json
   */
  private loadVersion(): void {
    try {
      const packageJsonPath = join(getDirname(import.meta.url), '../../../package.json');
      const packageJsonContent = readFileSync(packageJsonPath, 'utf-8');
      const packageJson = JSON.parse(packageJsonContent);
      this.version = packageJson.version;
    } catch {
      // Use default version
    }
  }

  /**
   * Setup commander program
   */
  private setupProgram(): void {
    this.program
      .name(`codemie-${this.adapter.name}`)
      .description(`CodeMie ${this.adapter.displayName} - ${this.adapter.description}`)
      .version(this.version)
      .option('--profile <name>', 'Use specific provider profile')
      .option('-m, --model <model>', 'Override model')
      .option('--api-key <key>', 'Override API key')
      .option('--base-url <url>', 'Override base URL')
      .option('--timeout <seconds>', 'Override timeout (in seconds)', parseInt)
      .allowUnknownOption()
      .passThroughOptions()
      .argument('[args...]', `Arguments to pass to ${this.adapter.displayName}`)
      .action(async (args, options) => {
        await this.handleRun(args, options);
      });

    // Add health check command
    this.program
      .command('health')
      .description(`Check ${this.adapter.displayName} health and installation`)
      .action(async () => {
        await this.handleHealthCheck();
      });
  }

  /**
   * Handle main run action
   */
  private async handleRun(args: string[], options: Record<string, unknown>): Promise<void> {
    try {
      // Check if agent is installed
      if (!(await this.adapter.isInstalled())) {
        logger.error(`${this.adapter.displayName} is not installed. Install it first with: codemie install ${this.adapter.name}`);
        process.exit(1);
      }

      // Load configuration with CLI overrides
      const config = await ConfigLoader.load(process.cwd(), {
        name: options.profile as string | undefined,  // Profile selection
        model: options.model as string | undefined,
        apiKey: options.apiKey as string | undefined,
        baseUrl: options.baseUrl as string | undefined,
        timeout: options.timeout as number | undefined
      });

      // Validate essential configuration
      if (!config.baseUrl || !config.apiKey || !config.model) {
        logger.error('Configuration incomplete. Run: codemie setup');
        process.exit(1);
      }

      // Validate provider and model compatibility
      if (!this.validateCompatibility(config)) {
        process.exit(1);
      }

      // Export provider-specific environment variables
      const providerEnv = ConfigLoader.exportProviderEnvVars(config);

      // Collect all arguments to pass to the agent
      const agentArgs = this.collectPassThroughArgs(args, options);

      // Run the agent
      logger.info(`Starting ${this.adapter.displayName} with model ${config.model}...`);
      await this.adapter.run(agentArgs, providerEnv);
    } catch (error) {
      logger.error(`Failed to run ${this.adapter.displayName}:`, error);
      process.exit(1);
    }
  }

  /**
   * Handle health check command
   */
  private async handleHealthCheck(): Promise<void> {
    try {
      if (await this.adapter.isInstalled()) {
        const version = await this.adapter.getVersion();
        logger.success(`${this.adapter.displayName} is installed and ready`);
        if (version) {
          console.log(`Version: ${version}`);
        }
      } else {
        logger.error(`${this.adapter.displayName} is not installed`);
        console.log(`Install with: codemie install ${this.adapter.name}`);
        process.exit(1);
      }
    } catch (error) {
      logger.error('Health check failed:', error);
      process.exit(1);
    }
  }


  /**
   * Collect pass-through arguments from Commander options
   */
  private collectPassThroughArgs(args: string[], options: Record<string, unknown>): string[] {
    const agentArgs = [...args];
    const knownOptions = ['profile', 'model', 'provider', 'apiKey', 'baseUrl', 'timeout'];

    for (const [key, value] of Object.entries(options)) {
      if (knownOptions.includes(key)) continue;

      if (key.length === 1) {
        agentArgs.push(`-${key}`);
      } else {
        agentArgs.push(`--${key}`);
      }

      if (value !== true && value !== undefined) {
        agentArgs.push(String(value));
      }
    }

    return agentArgs;
  }

  /**
   * Get agent metadata (single source of truth)
   */
  private getAgentMetadata() {
    const metadataMap: Record<string, typeof ClaudePluginMetadata> = {
      'claude': ClaudePluginMetadata,
      'codex': CodexPluginMetadata,
      'codemie-code': CodeMieCodePluginMetadata,
      'gemini': GeminiPluginMetadata
    };
    return metadataMap[this.adapter.name];
  }

  /**
   * Validate provider and model compatibility
   */
  private validateCompatibility(config: CodeMieConfigOptions): boolean {
    const metadata = this.getAgentMetadata();
    if (!metadata) {
      logger.error(`Unknown agent '${this.adapter.name}'`);
      return false;
    }

    const provider = config.provider || 'unknown';
    const model = config.model || 'unknown';

    // Check provider compatibility
    if (!metadata.supportedProviders.includes(provider)) {
      logger.error(`Provider '${provider}' is not supported by ${this.adapter.displayName}`);
      console.log(chalk.dim(`\nSupported providers: ${metadata.supportedProviders.join(', ')}`));
      console.log(chalk.dim('\nOptions:'));
      console.log(chalk.dim('  1. Run setup to choose a different provider: codemie setup'));

      if (this.adapter.name === 'claude') {
        console.log(chalk.dim('  2. Or configure environment variables directly:'));
        console.log(chalk.dim('     export ANTHROPIC_BASE_URL="https://litellm....."'));
        console.log(chalk.dim('     export ANTHROPIC_AUTH_TOKEN="sk...."'));
        console.log(chalk.dim('     export ANTHROPIC_MODEL="claude-4-5-sonnet"'));
      }
      return false;
    }

    // Check model compatibility
    const blockedPatterns = metadata.blockedModelPatterns || [];
    const isBlocked = blockedPatterns.some(pattern => pattern.test(model));

    if (isBlocked) {
      logger.error(`Model '${model}' is not compatible with ${this.adapter.displayName}`);
      console.log(chalk.dim('\nOptions:'));

      // Provide agent-specific model suggestions
      let suggestedModel = 'gpt-4.1';
      let modelDescription = 'OpenAI-compatible models';

      if (this.adapter.name === 'gemini') {
        suggestedModel = 'gemini-2.5-flash';
        modelDescription = 'Gemini models';
      } else if (this.adapter.name === 'claude') {
        suggestedModel = 'claude-4-5-sonnet';
        modelDescription = 'Claude or GPT models';
      } else if (this.adapter.name === 'codex') {
        suggestedModel = 'gpt-4.1';
        modelDescription = 'OpenAI-compatible models';
      }

      console.log(chalk.dim(`  1. ${this.adapter.name} requires ${modelDescription} (e.g., ${suggestedModel})`));
      console.log(chalk.dim(`  2. Switch model: codemie config set model ${suggestedModel}`));
      console.log(chalk.dim(`  3. Override for this session: codemie-${this.adapter.name} --model ${suggestedModel}`));
      return false;
    }

    return true;
  }

  /**
   * Run the CLI
   */
  async run(argv: string[]): Promise<void> {
    await this.program.parseAsync(argv);
  }
}
