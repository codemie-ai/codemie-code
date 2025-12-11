/**
 * AWS Bedrock Provider Setup Steps
 *
 * Implements setup flow for AWS Bedrock.
 * Supports both AWS profile and direct credentials (access key + secret key).
 */

import type {
  ProviderSetupSteps,
  ProviderCredentials
} from '../../core/types.js';
import type { CodeMieConfigOptions } from '../../../env/types.js';
import { ProviderRegistry } from '../../core/registry.js';
import { BedrockTemplate } from './bedrock.template.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Check if AWS CLI is installed
 */
async function isAwsCliInstalled(): Promise<boolean> {
  try {
    await execAsync('aws --version');
    return true;
  } catch {
    return false;
  }
}

/**
 * List available AWS profiles from ~/.aws/credentials
 */
async function listAwsProfiles(): Promise<string[]> {
  try {
    const { stdout } = await execAsync('aws configure list-profiles');
    return stdout
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);
  } catch {
    return [];
  }
}

/**
 * Get profile details (region, access key ID prefix)
 */
async function getProfileDetails(profile: string): Promise<{ region: string; accessKeyId?: string }> {
  try {
    const [regionResult, accessKeyResult] = await Promise.allSettled([
      execAsync(`aws configure get region --profile ${profile}`),
      execAsync(`aws configure get aws_access_key_id --profile ${profile}`)
    ]);

    const region = regionResult.status === 'fulfilled' ? regionResult.value.stdout.trim() || 'us-east-1' : 'us-east-1';
    const accessKeyId = accessKeyResult.status === 'fulfilled' ? accessKeyResult.value.stdout.trim() : undefined;

    return { region, accessKeyId };
  } catch {
    return { region: 'us-east-1' };
  }
}

/**
 * Create new AWS profile
 */
async function createAwsProfile(profileName: string, accessKeyId: string, secretAccessKey: string, region: string): Promise<void> {
  await execAsync(`aws configure set aws_access_key_id ${accessKeyId} --profile ${profileName}`);
  await execAsync(`aws configure set aws_secret_access_key ${secretAccessKey} --profile ${profileName}`);
  await execAsync(`aws configure set region ${region} --profile ${profileName}`);
}

/**
 * Generate unique profile name by adding incremental index if name exists
 * Similar to CodeMie profile naming (profile, profile-2, profile-3, etc.)
 */
function generateUniqueProfileName(baseName: string, existingProfiles: string[]): string {
  if (!existingProfiles.includes(baseName)) {
    return baseName;
  }

  let index = 2;
  let candidateName = `${baseName}-${index}`;

  while (existingProfiles.includes(candidateName)) {
    index++;
    candidateName = `${baseName}-${index}`;
  }

  return candidateName;
}

/**
 * AWS Bedrock setup steps implementation
 */
export const BedrockSetupSteps: ProviderSetupSteps = {
  name: 'bedrock',

  /**
   * Get credentials for AWS Bedrock
   * Supports both AWS profile and direct credentials
   */
  async getCredentials(): Promise<ProviderCredentials> {
    const inquirer = (await import('inquirer')).default;
    const chalk = (await import('chalk')).default;

    // Check if AWS CLI is installed
    const hasAwsCli = await isAwsCliInstalled();

    console.log(chalk.cyan('\n📦 AWS Bedrock Configuration\n'));

    if (hasAwsCli) {
      console.log(chalk.green('✓ AWS CLI detected\n'));
    } else {
      console.log(chalk.yellow('⚠ AWS CLI not detected (install from: https://aws.amazon.com/cli/)\n'));
      console.log(chalk.dim('  You can still configure Bedrock using access keys\n'));
    }

    // Ask for authentication method
    const authChoices = [
      { name: 'AWS Profile (recommended)', value: 'profile', disabled: !hasAwsCli },
      { name: 'Access Key + Secret Key', value: 'keys' }
    ];

    const { authMethod } = await inquirer.prompt([
      {
        type: 'list',
        name: 'authMethod',
        message: 'Authentication method:',
        choices: authChoices
      }
    ]);

    let awsProfile: string | undefined;
    let accessKeyId: string | undefined;
    let secretAccessKey: string | undefined;
    let region: string;

    if (authMethod === 'profile') {
      // List available profiles
      const profiles = await listAwsProfiles();

      // Show detected profiles
      if (profiles.length > 0) {
        console.log(chalk.cyan(`\nDetected ${profiles.length} AWS profile(s):\n`));

        for (const profile of profiles) {
          const details = await getProfileDetails(profile);
          const keyPrefix = details.accessKeyId ? `${details.accessKeyId.substring(0, 8)}...` : 'not configured';
          console.log(chalk.dim(`  • ${profile}`));
          console.log(chalk.dim(`    Region: ${details.region}`));
          console.log(chalk.dim(`    Access Key: ${keyPrefix}\n`));
        }
      }

      // Add option to create new profile
      const profileChoices = [
        ...profiles,
        new inquirer.Separator(),
        { name: '+ Create new AWS profile', value: '__create_new__' }
      ];

      // Ask user to select profile or create new
      const { profile: selectedProfile } = await inquirer.prompt([
        {
          type: 'list',
          name: 'profile',
          message: 'Select AWS profile:',
          choices: profileChoices
        }
      ]);

      if (selectedProfile === '__create_new__') {
        // Create new profile flow
        console.log(chalk.cyan('\n📝 Create New AWS Profile\n'));

        // Generate unique default profile name
        const defaultProfileName = generateUniqueProfileName('bedrock', profiles);

        // Gather profile name and credentials
        const newProfileAnswer = await inquirer.prompt([
          {
            type: 'input',
            name: 'profileName',
            message: 'Profile name:',
            default: defaultProfileName,
            validate: (input: string) => input.trim() !== '' || 'Profile name is required'
          },
          {
            type: 'input',
            name: 'accessKeyId',
            message: 'AWS Access Key ID:',
            validate: (input: string) => input.trim() !== '' || 'Access Key ID is required'
          },
          {
            type: 'password',
            name: 'secretAccessKey',
            message: 'AWS Secret Access Key:',
            validate: (input: string) => input.trim() !== '' || 'Secret Access Key is required'
          },
          {
            type: 'input',
            name: 'region',
            message: 'AWS Region:',
            default: 'us-east-1',
            validate: (input: string) => input.trim() !== '' || 'Region is required'
          }
        ]);

        const finalProfileName = newProfileAnswer.profileName.trim();

        // Create the profile using AWS CLI (will overwrite if exists)
        try {
          await createAwsProfile(
            finalProfileName,
            newProfileAnswer.accessKeyId,
            newProfileAnswer.secretAccessKey,
            newProfileAnswer.region
          );

          // Verify profile was created successfully
          const verifyProfiles = await listAwsProfiles();
          if (!verifyProfiles.includes(finalProfileName)) {
            throw new Error('Profile was not created successfully');
          }

          console.log(chalk.green(`\n✓ AWS profile "${finalProfileName}" created successfully\n`));

          awsProfile = finalProfileName;
          region = newProfileAnswer.region;
        } catch (error) {
          console.log(chalk.red(`\n✗ Failed to create AWS profile: ${error instanceof Error ? error.message : 'Unknown error'}`));
          console.log(chalk.yellow('\nFalling back to direct credential input...\n'));

          // Fallback to using credentials directly instead of profile
          awsProfile = undefined;
          accessKeyId = newProfileAnswer.accessKeyId;
          secretAccessKey = newProfileAnswer.secretAccessKey;
          region = newProfileAnswer.region;
        }
      } else {
        // Use existing profile
        awsProfile = selectedProfile;

        // Get region for this profile
        const details = await getProfileDetails(awsProfile || '');
        region = details.region;

        console.log(chalk.dim(`\nUsing profile: ${awsProfile}`));
        console.log(chalk.dim(`Region: ${region}\n`));
      }
    } else {
      // Direct credentials
      const credentialsAnswer = await inquirer.prompt([
        {
          type: 'input',
          name: 'accessKeyId',
          message: 'AWS Access Key ID:',
          validate: (input: string) => input.trim() !== '' || 'Access Key ID is required'
        },
        {
          type: 'password',
          name: 'secretAccessKey',
          message: 'AWS Secret Access Key:',
          validate: (input: string) => input.trim() !== '' || 'Secret Access Key is required'
        },
        {
          type: 'input',
          name: 'region',
          message: 'AWS Region:',
          default: 'us-east-1',
          validate: (input: string) => input.trim() !== '' || 'Region is required'
        }
      ]);

      accessKeyId = credentialsAnswer.accessKeyId;
      secretAccessKey = credentialsAnswer.secretAccessKey;
      region = credentialsAnswer.region;
    }

    // Construct base URL with region
    const baseUrl = `https://bedrock-runtime.${region}.amazonaws.com`;

    return {
      baseUrl,
      apiKey: accessKeyId || '', // Store access key in apiKey field
      additionalConfig: {
        awsProfile,
        awsRegion: region,
        awsSecretAccessKey: secretAccessKey
      }
    };
  },

  /**
   * Fetch available models from AWS Bedrock
   */
  async fetchModels(credentials: ProviderCredentials): Promise<string[]> {
    const { BedrockModelProxy } = await import('./bedrock.models.js');

    const modelProxy = new BedrockModelProxy(
      credentials.baseUrl!,
      credentials.apiKey,
      credentials.additionalConfig?.awsSecretAccessKey as string | undefined,
      credentials.additionalConfig?.awsProfile as string | undefined,
      credentials.additionalConfig?.awsRegion as string | undefined
    );

    try {
      const models = await modelProxy.fetchModels({
        provider: 'bedrock',
        baseUrl: credentials.baseUrl!,
        apiKey: credentials.apiKey,
        model: 'temp',
        timeout: 300
      });

      return models.map(m => m.id);
    } catch (error) {
      const chalk = (await import('chalk')).default;
      console.log(chalk.yellow('\n⚠ Could not fetch models from Bedrock'));
      console.log(chalk.dim(`  Error: ${error instanceof Error ? error.message : 'Unknown error'}`));
      console.log(chalk.dim('  Using recommended models instead\n'));

      // Fallback to recommended models
      return BedrockTemplate.recommendedModels;
    }
  },

  /**
   * Build configuration for AWS Bedrock
   */
  buildConfig(credentials: ProviderCredentials, model: string): Partial<CodeMieConfigOptions> {
    const config: Partial<CodeMieConfigOptions> = {
      provider: 'bedrock',
      baseUrl: credentials.baseUrl,
      model,
      timeout: 300,
      debug: false
    };

    // Store AWS credentials
    if (credentials.additionalConfig?.awsProfile) {
      // Using AWS profile
      config.awsProfile = credentials.additionalConfig.awsProfile as string;
      // Add placeholder apiKey to pass validation (not used, credentials come from AWS profile)
      config.apiKey = 'aws-profile';
    } else {
      // Using direct credentials
      config.apiKey = credentials.apiKey;
      config.awsSecretAccessKey = credentials.additionalConfig?.awsSecretAccessKey as string;
    }

    config.awsRegion = credentials.additionalConfig?.awsRegion as string;

    return config;
  }
};

// Auto-register setup steps
ProviderRegistry.registerSetupSteps('bedrock', BedrockSetupSteps);
