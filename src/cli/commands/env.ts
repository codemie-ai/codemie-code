import { Command } from 'commander';
import { FirstTimeExperience } from '../../utils/first-time.js';

export function createEnvCommand(): Command {
  const command = new Command('env');

  command
    .description('Show required environment variables for manual configuration')
    .argument('[provider]', 'Provider: ai-run, bedrock, anthropic, azure', 'ai-run')
    .action((provider: string) => {
      const validProviders = ['ai-run', 'bedrock', 'anthropic', 'azure'];

      if (!validProviders.includes(provider)) {
        console.error(`Invalid provider: ${provider}`);
        console.error(`Valid providers: ${validProviders.join(', ')}`);
        process.exit(1);
      }

      FirstTimeExperience.showManualSetup(provider as 'ai-run' | 'bedrock' | 'anthropic' | 'azure');
    });

  return command;
}
