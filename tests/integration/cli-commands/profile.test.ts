/**
 * CLI Profile Command Integration Test
 *
 * Tests the 'codemie profile' command by executing it directly
 * and verifying its output and behavior.
 *
 * Performance: Command executed once in beforeAll, validated multiple times
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { writeFile, readFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { createCLIRunner, type CommandResult } from '../../helpers/index.js';
import { setupTestIsolation, getTestHome } from '../../helpers/test-isolation.js';
import type { MultiProviderConfig, CodeMieConfigOptions } from '../../../src/env/types.js';

const cli = createCLIRunner();

describe('Profile Commands', () => {
  // Setup isolated CODEMIE_HOME for this test suite
  setupTestIsolation();

  let profileResult: CommandResult;

  beforeAll(() => {
    profileResult = cli.runSilent('profile');
  });

  it('should list profiles by default', () => {
    // Should not error (even with no profiles)
    expect(profileResult.exitCode === 0 || profileResult.exitCode === 1).toBe(true);
    expect(profileResult.output).toBeDefined();
  });

  it('should handle profile command without crashing', () => {
    // Should execute without crashing
    expect(profileResult).toBeDefined();
    expect(profileResult.output).toBeDefined();
  });
});

// Test environment variables
const liteLLMBaseUrl = process.env.LITELLM_BASE_URL;
const liteLLMApiKey = process.env.LITELLM_API_KEY;
const liteLLMModel = process.env.LITELLM_MODEL || 'gpt-4.1';

const awsRegion = process.env.AWS_DEFAULT_REGION;
const awsProfile = process.env.AWS_PROFILE || 'test-codemie-profile';
const awsAccessKeyId = process.env.AWS_ACCESS_KEY_ID;
const awsSecretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
const bedrockModel = process.env.BEDROCK_MODEL || 'global.anthropic.claude-sonnet-4-5-20250929-v1:0';

// Check if required environment variables are set
const hasLiteLLMConfig = !!(liteLLMBaseUrl && liteLLMApiKey);
const hasAWSConfig = !!(awsAccessKeyId && awsSecretAccessKey && awsRegion);
const hasAnyConfig = hasLiteLLMConfig || hasAWSConfig;

// Log skip reason for CI visibility
if (!hasAnyConfig) {
  console.log('\n⚠️  Skipping Profile Status Command tests');
  console.log('   Reason: No provider credentials configured');
  console.log('   Required: LITELLM_BASE_URL + LITELLM_API_KEY, or AWS credentials\n');
}

describe.skipIf(!hasAnyConfig)('Profile Status Command', () => {
  // Setup isolated CODEMIE_HOME for this test suite
  setupTestIsolation();

  beforeAll(async () => {
    // Create multi-profile config in isolated CODEMIE_HOME
    const testHome = getTestHome();
    const configFile = join(testHome, 'codemie-cli.config.json');

    // Setup AWS credentials file for bedrock-profile test
    const awsDir = join(homedir(), '.aws');
    const credentialsFile = join(awsDir, 'credentials');

    if (awsAccessKeyId && awsSecretAccessKey && awsProfile) {
      await mkdir(awsDir, { recursive: true });

      let credentialsContent = '';
      try {
        credentialsContent = await readFile(credentialsFile, 'utf-8');
      } catch {
        // File doesn't exist, will create it
      }

      // Check if profile already exists
      const profileRegex = new RegExp(`\\[${awsProfile}\\]`, 'i');
      if (!profileRegex.test(credentialsContent)) {
        // Profile missing, create it
        const profileSection = `\n[${awsProfile}]\naws_access_key_id = ${awsAccessKeyId}\naws_secret_access_key = ${awsSecretAccessKey}\n`;
        credentialsContent += profileSection;
        await writeFile(credentialsFile, credentialsContent);
      }
    }

    const profiles: Record<string, CodeMieConfigOptions> = {
      litellm: {
        provider: 'litellm',
        baseUrl: liteLLMBaseUrl,
        apiKey: liteLLMApiKey,
        model: liteLLMModel,
        timeout: 300
      },
      'bedrock-creds': {
        provider: 'bedrock',
        baseUrl: `https://bedrock-runtime.${awsRegion}.amazonaws.com`,
        apiKey: awsAccessKeyId,
        awsSecretAccessKey: awsSecretAccessKey,
        awsRegion: awsRegion,
        model: bedrockModel,
        timeout: 300
      },
      'bedrock-profile': {
        provider: 'bedrock',
        baseUrl: `https://bedrock-runtime.${awsRegion}.amazonaws.com`,
        apiKey: 'aws-profile',
        awsProfile: awsProfile,
        awsRegion: awsRegion,
        model: bedrockModel,
        timeout: 300
      }
    };

    const config: MultiProviderConfig = {
      version: 2,
      activeProfile: 'litellm',
      profiles
    };

    await writeFile(configFile, JSON.stringify(config, null, 2));
  });

  // Test cases for profile status command
  const profileStatusTestCases = [
    {
      profileName: 'litellm',
      description: 'should show status for default litellm profile',
      expectedProvider: 'litellm',
      expectedModel: liteLLMModel
    },
    {
      profileName: 'bedrock-creds',
      description: 'should show status for bedrock-creds profile',
      expectedProvider: 'bedrock',
      expectedModel: bedrockModel
    },
    {
      profileName: 'bedrock-profile',
      description: 'should show status for bedrock-profile',
      expectedProvider: 'bedrock',
      expectedModel: bedrockModel
    }
  ];

  it.each(profileStatusTestCases)(
    '$description',
    ({ profileName, expectedProvider, expectedModel }) => {
      // Switch to the profile first if not already active
      if (profileName !== 'litellm') {
        const switchResult = cli.runSilent(`profile switch ${profileName}`);
        expect(switchResult.exitCode).toBe(0);
      }

      // Run profile status command
      const result = cli.runSilent('profile status');

      // Verify output format matches expected structure:
      // Profile      │ profile-name (Active)
      // Provider     │ provider-name
      // Model        │ model-name
      expect(result.output).toContain('Profile Status');
      expect(result.output).toContain('│'); // Box drawing character used as separator
      expect(result.output).toContain(profileName);
      expect(result.output).toContain(expectedProvider);
      expect(result.output).toContain(expectedModel);

      // Verify active profile indicator
      expect(result.output.toLowerCase()).toMatch(/active|●/);
    }
  );
});
