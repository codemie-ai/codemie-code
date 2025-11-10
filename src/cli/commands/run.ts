import { Command } from 'commander';
import { AgentRegistry } from '../../agents/registry';
import { logger } from '../../utils/logger';
import { AgentNotFoundError } from '../../utils/errors';

export function createRunCommand(): Command {
  const command = new Command('run');

  command
    .description('Run an agent')
    .argument('<agent>', 'Agent name to run')
    .argument('[args...]', 'Additional arguments to pass to the agent')
    .option('-m, --model <model>', 'Model to use (CodeMie option, not passed to agent)')
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

        // Set model environment variable if provided
        if (options.model) {
          const envVar = `${agentName.toUpperCase().replace('-', '_')}_MODEL`;
          process.env[envVar] = options.model;
        }

        // Collect all arguments to pass to the agent
        // This includes both positional args and any unknown options
        const agentArgs = [...args];

        // Add back unknown options that were parsed
        // Commander.js stores unknown options in the options object
        // We need to reconstruct them as command-line arguments
        for (const [key, value] of Object.entries(options)) {
          // Skip known CodeMie options
          if (key === 'model') continue;

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

        // Run the agent with all collected arguments
        await agent.run(agentArgs);
      } catch (error: unknown) {
        logger.error('Failed to run agent:', error);
        process.exit(1);
      }
    });

  return command;
}
