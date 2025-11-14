import { Command } from 'commander';
import { FirstTimeExperience } from '../../utils/first-time.js';

export function createEnvCommand(): Command {
  const command = new Command('env');

  command
    .description('Show complete manual configuration guide with environment variables and setup commands')
    .argument('[provider]', 'Provider: litellm, bedrock, azure', 'litellm')
    .action((provider: string) => {
      const validProviders = ['litellm', 'bedrock', 'azure'];

      if (!validProviders.includes(provider)) {
        console.error(`Invalid provider: ${provider}`);
        console.error(`Valid providers: ${validProviders.join(', ')}`);
        process.exit(1);
      }

      FirstTimeExperience.showManualSetup(provider as 'litellm' | 'bedrock' | 'azure');
    });

  return command;
}
