import { Command } from 'commander';
import { AgentRegistry } from '../../agents/registry';
import { logger } from '../../utils/logger';
import { AgentNotFoundError } from '../../utils/errors';
import { ConfigLoader } from '../../utils/config-loader.js';

export function createRunCommand(): Command {
  const command = new Command('run');

  command
    .description('Run an agent')
    .argument('<agent>', 'Agent name to run')
    .argument('[args...]', 'Additional arguments to pass to the agent')
    .option('-m, --model <model>', 'Override model')
    .option('-p, --provider <provider>', 'Override provider')
    .option('--api-key <key>', 'Override API key')
    .option('--base-url <url>', 'Override base URL')
    .option('--timeout <seconds>', 'Override timeout', parseInt)
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
        const config = await ConfigLoader.load(process.cwd(), {
          model: options.model,
          provider: options.provider,
          apiKey: options.apiKey,
          baseUrl: options.baseUrl,
          timeout: options.timeout
        });

        // Export provider-specific environment variables
        const providerEnv = ConfigLoader.exportProviderEnvVars(config);

        // Collect all arguments to pass to the agent
        // This includes both positional args and any unknown options
        const agentArgs = [...args];

        // Add back unknown options that were parsed
        // Commander.js stores unknown options in the options object
        // We need to reconstruct them as command-line arguments
        const knownOptions = ['model', 'provider', 'apiKey', 'baseUrl', 'timeout'];
        for (const [key, value] of Object.entries(options)) {
          // Skip known CodeMie options
          if (knownOptions.includes(key)) continue;

          // Reconstruct the option format
          if (key.length === 1) {
            // Single character option: -p
            agentArgs.push(`-${key}`);
          } else {
            // Multi-character option: --prompt
            agentArgs.push(`--${key}`);
          }

          // Add the value if it's not a boolean flag
          if (value !== true && value !== undefined) {
            agentArgs.push(String(value));
          }
        }

        // Run the agent with all collected arguments and provider environment
        await agent.run(agentArgs, providerEnv);
      } catch (error: unknown) {
        logger.error('Failed to run agent:', error);
        process.exit(1);
      }
    });

  return command;
}
