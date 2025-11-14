import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { AgentRegistry } from '../../agents/registry.js';
import { logger } from '../../utils/logger.js';
import { AgentNotFoundError } from '../../utils/errors.js';
import { ConfigLoader, CodeMieConfigOptions } from '../../utils/config-loader.js';
import { fetchAvailableModels, filterModelsByAgent, categorizeModels } from '../../utils/model-fetcher.js';
import { validateProviderCompatibility as checkProviderCompatibility, displayCompatibilityError } from '../../utils/agent-compatibility.js';

/**
 * Model compatibility rules for agents
 */
interface AgentModelRules {
  allowedProviders: string[];
  blockedPatterns: RegExp[];
  fallbackModels: string[]; // Used if API fetch fails
  defaultModel?: string;
}

const AGENT_MODEL_RULES: Record<string, AgentModelRules> = {
  'codex': {
    // Codex only supports OpenAI models
    allowedProviders: ['openai', 'azure', 'litellm'],
    blockedPatterns: [
      /^claude/i,           // Block any Claude models
      /bedrock.*claude/i    // Block Bedrock Claude models
    ],
    fallbackModels: [],   // No fallback - must fetch from API
    defaultModel: undefined  // Will be auto-detected from available models
  },
  'claude': {
    // Claude supports both Claude and GPT models
    allowedProviders: ['bedrock', 'openai', 'azure', 'litellm'],
    blockedPatterns: [],  // No restrictions
    fallbackModels: [],   // No fallback - must fetch from API
    defaultModel: undefined  // Will be auto-detected from available models
  },
  'codemie-code': {
    // CodeMie Native supports all providers and models via LangChain
    allowedProviders: ['bedrock', 'openai', 'azure', 'litellm', 'ai-run-sso'],
    blockedPatterns: [],  // No restrictions - supports all models
    fallbackModels: [],   // No fallback - must fetch from API
    defaultModel: undefined  // Will be auto-detected from available models
  }
};

export function createRunCommand(): Command {
  const command = new Command('run');

  command
    .description('Run an agent with your configured settings (prefer direct shortcuts: codemie-claude, codemie-codex, codemie-code)')
    .argument('<agent>', 'Agent name to run (e.g., claude, codex, codemie-code)')
    .argument('[args...]', 'Additional arguments to pass to the agent')
    .option('-m, --model <model>', 'Override model')
    .option('-p, --provider <provider>', 'Override provider')
    .option('--api-key <key>', 'Override API key')
    .option('--base-url <url>', 'Override base URL')
    .option('--timeout <seconds>', 'Override timeout (in seconds)', parseInt)
    .option('--no-prompt', 'Disable interactive prompts (fail if config missing)')
    .allowUnknownOption() // Allow passing unknown options to the agent
    .passThroughOptions() // Pass through options to the agent
    .action(async (agentName: string, args: string[], options) => {
      try {
        const agent = AgentRegistry.getAgent(agentName);

        if (!agent) {
          throw new AgentNotFoundError(agentName);
        }

        // Check if installed
        if (!(await agent.isInstalled())) {
          logger.error(`${agent.displayName} is not installed. Install it first with: codemie install ${agentName}`);
          process.exit(1);
        }

        // Load configuration with CLI overrides
        let config = await ConfigLoader.load(process.cwd(), {
          model: options.model,
          provider: options.provider,
          apiKey: options.apiKey,
          baseUrl: options.baseUrl,
          timeout: options.timeout
        });

        // Validate configuration
        const validationResult = await validateAndPromptConfig(
          config,
          options.prompt !== false
        );

        if (!validationResult.valid) {
          logger.error('Configuration incomplete. Run: codemie setup');
          process.exit(1);
        }

        // Use validated config
        config = validationResult.config;

        // Validate provider compatibility
        const providerResult = checkProviderCompatibility(agentName, config);
        if (!providerResult.valid) {
          displayCompatibilityError(providerResult, logger);
          process.exit(1);
        }

        // Validate model compatibility for this agent
        const modelValidation = await validateModelCompatibility(
          agentName,
          config,
          options.prompt !== false
        );

        if (!modelValidation.valid) {
          logger.error(`Model '${config.model}' is not compatible with ${agent.displayName}`);
          process.exit(1);
        }

        // Use validated model
        config.model = modelValidation.model;

        // Export provider-specific environment variables
        const providerEnv = ConfigLoader.exportProviderEnvVars(config);

        // Collect all arguments to pass to the agent
        const agentArgs = [...args];

        // Add back unknown options that were parsed
        const knownOptions = ['model', 'provider', 'apiKey', 'baseUrl', 'timeout', 'prompt'];
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

        // Run the agent
        logger.info(`Starting ${agent.displayName} with model ${chalk.cyan(config.model)}...`);
        await agent.run(agentArgs, providerEnv);
      } catch (error: unknown) {
        logger.error('Failed to run agent:', error);
        process.exit(1);
      }
    });

  return command;
}

/**
 * Validate model compatibility with agent and offer alternatives
 */
async function validateModelCompatibility(
  agentName: string,
  config: CodeMieConfigOptions,
  allowPrompt: boolean
): Promise<{ valid: boolean; model: string }> {
  const rules = AGENT_MODEL_RULES[agentName];

  // If no rules defined for this agent, allow any model
  if (!rules) {
    return { valid: true, model: config.model! };
  }

  const currentModel = config.model!;

  // Check if model matches any blocked pattern
  const isBlocked = rules.blockedPatterns.some(pattern => pattern.test(currentModel));

  if (!isBlocked) {
    // Model is compatible
    return { valid: true, model: currentModel };
  }

  // Model is incompatible
  logger.warn(`${chalk.yellow('⚠')}  Model '${chalk.cyan(currentModel)}' is not compatible with ${agentName}`);
  console.log(chalk.dim(`   ${agentName} requires OpenAI-compatible models (e.g., gpt-5, gpt-4o)`));
  console.log(chalk.dim(`   Claude models are not supported due to API incompatibilities\n`));

  if (!allowPrompt) {
    return { valid: false, model: currentModel };
  }

  // Fetch available models from provider
  logger.info('Fetching available models from provider...');
  let availableModels = await fetchAvailableModels(config);

  // Filter to compatible models only
  const compatibleModels = filterModelsByAgent(availableModels, agentName, rules.blockedPatterns);

  // If API fetch failed or returned no compatible models, error out
  if (compatibleModels.length === 0) {
    logger.error('Failed to fetch compatible models from provider');
    console.log(chalk.dim('\nPossible reasons:'));
    console.log(chalk.dim('  • Provider API is unreachable'));
    console.log(chalk.dim('  • Invalid API key or permissions'));
    console.log(chalk.dim('  • No compatible models available on this provider'));
    console.log(chalk.yellow('\nPlease verify your configuration or specify a model manually:'));
    console.log(chalk.cyan(`  codemie-${agentName} --model <model-name>\n`));
    return { valid: false, model: currentModel };
  }

  availableModels = compatibleModels;

  // Categorize into recommended and other
  const { recommended, other } = categorizeModels(availableModels);

  // Auto-detect best default model
  const autoDefaultModel = recommended.length > 0 ? recommended[0] : availableModels[0];

  // Offer to switch to compatible model
  const { action } = await inquirer.prompt([
    {
      type: 'list',
      name: 'action',
      message: 'How would you like to proceed?',
      choices: [
        {
          name: `Switch to recommended model (${chalk.cyan(autoDefaultModel)})`,
          value: 'switch-default'
        },
        {
          name: `Choose from available models (${availableModels.length} found)`,
          value: 'choose'
        },
        {
          name: 'Cancel',
          value: 'cancel'
        }
      ]
    }
  ]);

  if (action === 'cancel') {
    return { valid: false, model: currentModel };
  }

  let selectedModel: string;

  if (action === 'switch-default') {
    selectedModel = autoDefaultModel;
  } else {
    // Build choices with sections
    const choices: any[] = [];

    if (recommended.length > 0) {
      choices.push(new inquirer.Separator('─── Recommended ───'));
      choices.push(...recommended);
    }

    if (other.length > 0) {
      choices.push(new inquirer.Separator('─── Other Available ───'));
      choices.push(...other);
    }

    // Let user choose from available models
    const { model } = await inquirer.prompt([
      {
        type: 'list',
        name: 'model',
        message: 'Choose a compatible model:',
        choices,
        pageSize: 15
      }
    ]);
    selectedModel = model;
  }

  // Ask if they want to save this as default
  const { saveAsDefault } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'saveAsDefault',
      message: `Save ${chalk.cyan(selectedModel)} as your default model?`,
      default: false
    }
  ]);

  if (saveAsDefault) {
    await ConfigLoader.saveGlobalConfig({
      ...config,
      model: selectedModel
    });
    logger.success(`Configuration updated: default model set to ${chalk.cyan(selectedModel)}`);
  } else {
    logger.info(`Using ${chalk.cyan(selectedModel)} for this session only`);
  }

  return { valid: true, model: selectedModel };
}

/**
 * Validate configuration and prompt for missing values if needed
 */
async function validateAndPromptConfig(
  config: CodeMieConfigOptions,
  allowPrompt: boolean
): Promise<{ valid: boolean; config: CodeMieConfigOptions }> {
  const missing: string[] = [];

  // Check required fields
  if (!config.baseUrl) missing.push('baseUrl');
  if (!config.apiKey) missing.push('apiKey');
  if (!config.model) missing.push('model');

  // If nothing is missing, return success
  if (missing.length === 0) {
    return { valid: true, config };
  }

  // If prompts are disabled, fail
  if (!allowPrompt) {
    return { valid: false, config };
  }

  // Show what's missing
  console.log(chalk.yellow('\n⚠  Configuration incomplete:\n'));
  console.log(chalk.dim(`   Missing: ${missing.join(', ')}\n`));

  const { shouldConfigure } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'shouldConfigure',
      message: 'Would you like to configure now?',
      default: true
    }
  ]);

  if (!shouldConfigure) {
    return { valid: false, config };
  }

  // Prompt for missing values
  const prompts: any[] = [];

  if (!config.provider) {
    prompts.push({
      type: 'list',
      name: 'provider',
      message: 'Choose provider:',
      choices: ['litellm', 'openai', 'azure', 'bedrock'],
      default: 'litellm'
    });
  }

  if (!config.baseUrl) {
    prompts.push({
      type: 'input',
      name: 'baseUrl',
      message: 'Enter API base URL:',
      validate: (input: string) => input.trim() !== '' || 'Base URL is required'
    });
  }

  if (!config.apiKey) {
    prompts.push({
      type: 'password',
      name: 'apiKey',
      message: 'Enter API key:',
      mask: '*',
      validate: (input: string) => input.trim() !== '' || 'API key is required'
    });
  }

  if (!config.model) {
    prompts.push({
      type: 'input',
      name: 'model',
      message: 'Enter model name:',
      default: 'claude-4-5-sonnet',
      validate: (input: string) => input.trim() !== '' || 'Model is required'
    });
  }

  const answers = await inquirer.prompt(prompts);

  // Update config with answers
  Object.assign(config, answers);

  // Save to global config
  const { saveConfig } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'saveConfig',
      message: 'Save this configuration globally?',
      default: true
    }
  ]);

  if (saveConfig) {
    await ConfigLoader.saveGlobalConfig({
      provider: config.provider,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      timeout: config.timeout
    });
    logger.success('Configuration saved to ~/.codemie/config.json');
  }

  return { valid: true, config };
}
