import { Command } from 'commander';
import { readFileSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import { AgentAdapter } from './types.js';
import { ConfigLoader, CodeMieConfigOptions } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';
import { getDirname } from '../../utils/paths.js';
import { BUILTIN_AGENT_NAME } from '../registry.js';
import { ClaudePluginMetadata } from '../plugins/claude.plugin.js';
import { CodexPluginMetadata } from '../plugins/codex.plugin.js';
import { CodeMieCodePluginMetadata } from '../plugins/codemie-code.plugin.js';
import { GeminiPluginMetadata } from '../plugins/gemini.plugin.js';
import { DeepAgentsPluginMetadata } from '../plugins/deepagents.plugin.js';

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

    // Set agent name in logger for consistent log formatting
    logger.setAgentName(adapter.name);
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
    // Handle special case where adapter name already includes 'codemie-' prefix (built-in agent)
    const programName = this.adapter.name.startsWith('codemie-')
      ? this.adapter.name
      : `codemie-${this.adapter.name}`;

    this.program
      .name(programName)
      .description(`CodeMie ${this.adapter.displayName} - ${this.adapter.description}`)
      .version(this.version)
      .option('--profile <name>', 'Use specific provider profile')
      .option('--provider <provider>', 'Override provider (ai-run-sso, litellm, ollama)')
      .option('-m, --model <model>', 'Override model')
      .option('--api-key <key>', 'Override API key')
      .option('--base-url <url>', 'Override base URL')
      .option('--timeout <seconds>', 'Override timeout (in seconds)', parseInt)
      .option('--task <prompt>', 'Execute a single task (agent-specific flag mapping)')
      .allowUnknownOption()
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

    // Add init command for frameworks (skip for built-in agent and deepagents)
    if (this.adapter.name !== BUILTIN_AGENT_NAME && this.adapter.name !== 'deepagents') {
      this.program
        .command('init')
        .description('Initialize development framework')
        .argument('[framework]', 'Framework to initialize (speckit, bmad)')
        .option('-l, --list', 'List available frameworks')
        .option('--force', 'Force re-initialization')
        .option('--project-name <name>', 'Project name for framework initialization')
        .action(async (framework, options) => {
          await this.handleInit(framework, options);
        });
    }
  }

  /**
   * Handle main run action
   */
  private async handleRun(args: string[], options: Record<string, unknown>): Promise<void> {
    try {
      // Check if agent is installed
      if (!(await this.adapter.isInstalled())) {
        console.log(chalk.red(`\n✗ ${this.adapter.displayName} is not installed\n`));
        console.log(chalk.white('Install it with:\n'));
        console.log(chalk.cyan(`  codemie install ${this.adapter.name}\n`));
        process.exit(1);
      }

      // Load configuration with CLI overrides
      const config = await ConfigLoader.load(process.cwd(), {
        name: options.profile as string | undefined,  // Profile selection
        provider: options.provider as string | undefined,
        model: options.model as string | undefined,
        apiKey: options.apiKey as string | undefined,
        baseUrl: options.baseUrl as string | undefined,
        timeout: options.timeout as number | undefined
      });

      // Validate essential configuration
      const missingFields: string[] = [];
      if (!config.baseUrl) missingFields.push('baseUrl');
      if (!config.model) missingFields.push('model');

      // Only validate apiKey for providers that require authentication
      const { ProviderRegistry } = await import('../../providers/core/registry.js');
      const provider = config.provider ? ProviderRegistry.getProvider(config.provider) : null;
      const requiresAuth = provider?.requiresAuth ?? true; // Default to true for safety

      if (requiresAuth && !config.apiKey) {
        missingFields.push('apiKey');
      }

      if (missingFields.length > 0) {
        console.log(chalk.yellow('\n⚠️  Configuration incomplete'));
        console.log(chalk.white('Missing: ') + chalk.red(missingFields.join(', ')));
        console.log(chalk.white('Run ') + chalk.cyan('codemie setup') + chalk.white(' to configure your AI provider.\n'));
        process.exit(1);
      }

      // NEW: Auth validation via provider plugin
      try {
        // Check if provider implements auth validation
        const setupSteps = provider ? ProviderRegistry.getSetupSteps(config.provider || '') : null;

        if (setupSteps?.validateAuth) {
          const validationResult = await setupSteps.validateAuth(config);

          if (!validationResult.valid) {
            const { handleAuthValidationFailure } = await import('../../providers/core/auth-validation.js');
            const reauthed = await handleAuthValidationFailure(validationResult, setupSteps, config);

            if (!reauthed) {
              console.log(chalk.yellow('\n⚠️  Authentication required\n'));
              process.exit(1);
            }
          }
        }
      } catch (error) {
        logger.error('Auth validation failed:', error);
        console.log(chalk.red('\n✗ Authentication check failed\n'));
        process.exit(1);
      }

      // Validate provider and model compatibility
      if (!this.validateCompatibility(config)) {
        process.exit(1);
      }

      const providerEnv = ConfigLoader.exportProviderEnvVars(config);

      // Pass config info for welcome message display
      providerEnv.CODEMIE_PROFILE_NAME = config.name || 'default';
      providerEnv.CODEMIE_CLI_VERSION = this.version;

      // Serialize full profile config for proxy plugins (read once at CLI level)
      providerEnv.CODEMIE_PROFILE_CONFIG = JSON.stringify(config);

      // Set profile name in logger for log formatting
      logger.setProfileName(config.name || 'default');

      // Collect all arguments to pass to the agent
      const agentArgs = this.collectPassThroughArgs(args, options);

      // Run the agent (welcome message will be shown inside)
      await this.adapter.run(agentArgs, providerEnv);
    } catch (error) {
      // Show user-friendly error message in console first
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(chalk.red(`\n✗ Failed to run ${this.adapter.displayName}\n`));
      console.error(chalk.white(errorMessage));
      console.error('');

      // Log detailed error for debugging
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
        console.log(chalk.red(`\n✗ ${this.adapter.displayName} is not installed\n`));
        console.log(chalk.white('Install it with:\n'));
        console.log(chalk.cyan(`  codemie install ${this.adapter.name}\n`));
        process.exit(1);
      }
    } catch (error) {
      logger.error('Health check failed:', error);
      process.exit(1);
    }
  }

  /**
   * Handle framework initialization command
   */
  private async handleInit(framework: string | undefined, options: Record<string, unknown>): Promise<void> {
    try {
      // Import framework registry
      const { FrameworkRegistry } = await import('../../frameworks/index.js');

      // Handle --list flag
      if (options.list) {
        const frameworks = FrameworkRegistry.getFrameworksForAgent(this.adapter.name);

        if (frameworks.length === 0) {
          console.log(chalk.yellow('\n⚠️  No frameworks available for this agent\n'));
          return;
        }

        console.log(chalk.bold('\n📦 Available Frameworks:\n'));
        for (const fw of frameworks) {
          console.log(chalk.cyan(`  ${fw.metadata.name}`) + chalk.white(` - ${fw.metadata.description}`));
          if (fw.metadata.docsUrl) {
            console.log(chalk.gray(`    Docs: ${fw.metadata.docsUrl}`));
          }
        }
        console.log('');
        return;
      }

      // Framework name is required if not listing
      if (!framework) {
        console.log(chalk.red('\n✗ Framework name is required\n'));
        console.log(chalk.white('Usage:\n'));
        console.log(chalk.cyan(`  codemie-${this.adapter.name} init <framework>\n`));
        console.log(chalk.white('List available frameworks:\n'));
        console.log(chalk.cyan(`  codemie-${this.adapter.name} init --list\n`));
        process.exit(1);
      }

      // Get framework adapter
      const frameworkAdapter = FrameworkRegistry.getFramework(framework);
      if (!frameworkAdapter) {
        console.log(chalk.red(`\n✗ Unknown framework '${framework}'\n`));
        console.log(chalk.white('List available frameworks:\n'));
        console.log(chalk.cyan(`  codemie-${this.adapter.name} init --list\n`));
        process.exit(1);
      }

      // Check if agent is supported by framework
      const agentMapping = frameworkAdapter.getAgentMapping(this.adapter.name);
      if (!agentMapping) {
        console.log(chalk.red(`\n✗ Framework '${framework}' does not support agent '${this.adapter.name}'\n`));
        const supportedAgents = frameworkAdapter.metadata.supportedAgents || [];
        if (supportedAgents.length > 0) {
          console.log(chalk.white(`Supported agents: ${supportedAgents.join(', ')}\n`));
        }
        process.exit(1);
      }

      // Initialize framework
      await frameworkAdapter.init(this.adapter.name, {
        force: options.force as boolean | undefined,
        projectName: options.projectName as string | undefined,
        cwd: process.cwd()
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(chalk.red(`\n✗ Framework initialization failed\n`));
      console.error(chalk.white(errorMessage));
      console.error('');
      logger.error('Framework initialization failed:', error);
      process.exit(1);
    }
  }


  /**
   * Collect pass-through arguments from Commander options
   */
  private collectPassThroughArgs(
    args: string[],
    options: Record<string, unknown>
  ): string[] {
    const agentArgs = [...args];
    // Config-only options (not passed to agent, handled by CodeMie CLI)
    const configOnlyOptions = ['profile', 'provider', 'apiKey', 'baseUrl', 'timeout'];

    for (const [key, value] of Object.entries(options)) {
      // Skip config-only options (handled by CodeMie CLI layer)
      if (configOnlyOptions.includes(key)) continue;

      // Build flag key (--task or -t)
      const flagKey = key.length === 1 ? `-${key}` : `--${key}`;

      // Include all remaining options:
      // 1. Options with flagMappings (will be transformed in BaseAgentAdapter)
      // 2. Unknown options (allowUnknownOption enabled, pass through as-is)
      agentArgs.push(flagKey);

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
      [BUILTIN_AGENT_NAME]: CodeMieCodePluginMetadata,
      'gemini': GeminiPluginMetadata,
      'deepagents': DeepAgentsPluginMetadata
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
      console.log(chalk.white(`\nSupported providers: ${metadata.supportedProviders.join(', ')}`));
      console.log(chalk.white('\nOptions:'));
      console.log(chalk.white('  1. Run setup to choose a different provider: ') + chalk.cyan('codemie setup'));
      return false;
    }

    // Check model compatibility
    const blockedPatterns = metadata.blockedModelPatterns || [];
    const isBlocked = blockedPatterns.some(pattern => pattern.test(model));

    if (isBlocked) {
      logger.error(`Model '${model}' is not compatible with ${this.adapter.displayName}`);
      console.log(chalk.white('\nOptions:'));

      // Get recommended models from agent metadata
      const recommendedModels = metadata.recommendedModels;

      if (recommendedModels && recommendedModels.length > 0) {
        const modelExamples = recommendedModels.slice(0, 3).join(', ');
        const suggestedModel = recommendedModels[0];
        const command = this.adapter.name.startsWith('codemie-') ? this.adapter.name : `codemie-${this.adapter.name}`;

        console.log(chalk.white(`  1. ${this.adapter.displayName} requires compatible models (e.g., ${modelExamples})`));
        console.log(chalk.white('  2. Update profile: ') + chalk.cyan('codemie setup'));
        console.log(chalk.white(`  3. Override for this session: ${command} --model ${suggestedModel}`));
      } else {
        console.log(chalk.white('  1. Update profile: ') + chalk.cyan('codemie setup'));
      }

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
