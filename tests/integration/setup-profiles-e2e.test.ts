/**
 * Setup to Doctor to Profile - E2E Integration Test (Parametrized)
 *
 * Tests the complete user flow with REAL HTTP connections for multiple providers:
 * 1. Setup a profile from environment variables
 * 2. Run doctor health checks (makes actual HTTP requests)
 * 3. Verify profile status
 *
 * REQUIRED ENVIRONMENT VARIABLES:
 *
 * For LiteLLM:
 * - LITELLM_BASE_URL: LiteLLM server URL (e.g., http://localhost:4000)
 * - LITELLM_API_KEY: LiteLLM API key
 * - LITELLM_MODEL: Model to test (default: gpt-4.1)
 *
 * For Bedrock (Direct Auth):
 * - AWS_ACCESS_KEY_ID: AWS Access Key ID
 * - AWS_SECRET_ACCESS_KEY: AWS Secret Access Key
 * - AWS_DEFAULT_REGION: AWS region (e.g., us-east-1, us-west-2)
 * - BEDROCK_MODEL: Model to test (default: global.anthropic.claude-sonnet-4-5-20250929-v1:0)
 * Note: Base URL is automatically constructed from the region
 *
 * For Bedrock (AWS Profile Auth):
 * - AWS_ACCESS_KEY_ID: AWS Access Key ID (used to create AWS profile)
 * - AWS_SECRET_ACCESS_KEY: AWS Secret Access Key (used to create AWS profile)
 * - AWS_DEFAULT_REGION: AWS region (e.g., us-east-1, us-west-2)
 * - AWS_PROFILE: AWS profile name (default: test-codemie-profile)
 * - BEDROCK_MODEL: Model to test (default: global.anthropic.claude-sonnet-4-5-20250929-v1:0)
 * Note: Creates ~/.aws/credentials with the specified profile
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'path';
import { homedir } from 'os';
import { mkdir, writeFile, readFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { execSync } from 'child_process';
import { createCLIRunner, type CommandResult } from '../helpers/index.js';
import type { MultiProviderConfig, CodeMieConfigOptions } from '../../src/env/types.js';

// Test data structure for each provider
interface ProviderTestData {
  name: string;
  profileName: string;
  expectedProvider?: string; // Expected provider type (defaults to profileName if not specified)
  envVars: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    secretKey?: string;
    accessKey?: string;
    region?: string;
    awsProfile?: string;
  };
  buildProfile: (data: ProviderTestData) => CodeMieConfigOptions;
  setupAwsProfile?: (data: ProviderTestData) => Promise<void>;
}

// Define test cases for each provider
const providerTestCases: ProviderTestData[] = [
  {
    name: 'LiteLLM',
    profileName: 'litellm',
    envVars: {
      baseUrl: process.env.LITELLM_BASE_URL,
      apiKey: process.env.LITELLM_API_KEY,
      model: process.env.LITELLM_MODEL || 'gpt-4.1'
    },
    buildProfile: (data) => ({
      provider: 'litellm',
      baseUrl: data.envVars.baseUrl!,
      apiKey: data.envVars.apiKey!,
      model: data.envVars.model!,
      timeout: 300
    })
  },
  // {
  //   name: 'Bedrock',
  //   profileName: 'bedrock',
  //   envVars: {
  //     accessKey: process.env.AWS_ACCESS_KEY_ID,
  //     secretKey: process.env.AWS_SECRET_ACCESS_KEY,
  //     region: process.env.AWS_DEFAULT_REGION,
  //     model: process.env.BEDROCK_MODEL || 'global.anthropic.claude-sonnet-4-5-20250929-v1:0'
  //   },
  //   buildProfile: (data) => ({
  //     provider: 'bedrock',
  //     baseUrl: `https://bedrock-runtime.${data.envVars.region}.amazonaws.com`,
  //     apiKey: data.envVars.accessKey!,
  //     awsSecretAccessKey: data.envVars.secretKey!,
  //     awsRegion: data.envVars.region!,
  //     model: data.envVars.model,
  //     timeout: 300,
  //     debug: false,
  //     name: data.profileName
  //   })
  // },
  // {
  //   name: 'Bedrock (AWS Profile)',
  //   profileName: 'bedrock-profile',
  //   expectedProvider: 'bedrock', // Provider type is 'bedrock', not 'bedrock-profile'
  //   envVars: {
  //     accessKey: process.env.AWS_ACCESS_KEY_ID,
  //     secretKey: process.env.AWS_SECRET_ACCESS_KEY,
  //     region: process.env.AWS_DEFAULT_REGION,
  //     model: process.env.BEDROCK_MODEL || 'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
  //     awsProfile: process.env.AWS_PROFILE || 'test-codemie-profile'
  //   },
  //   buildProfile: (data) => ({
  //     provider: 'bedrock',
  //     baseUrl: `https://bedrock-runtime.${data.envVars.region}.amazonaws.com`,
  //     apiKey: 'aws-profile',
  //     awsProfile: data.envVars.awsProfile!,
  //     awsRegion: data.envVars.region!,
  //     model: data.envVars.model,
  //     timeout: 300,
  //     debug: false,
  //     name: data.profileName
  //   }),
  //   setupAwsProfile: async (data) => {
  //     // Create AWS credentials file
  //     const awsDir = join(homedir(), '.aws');
  //     const credentialsFile = join(awsDir, 'credentials');
  //
  //     await mkdir(awsDir, { recursive: true });
  //
  //     // Read existing credentials or start fresh
  //     let credentialsContent = '';
  //     if (existsSync(credentialsFile)) {
  //       credentialsContent = await readFile(credentialsFile, 'utf-8');
  //     }
  //
  //     // Check if profile already exists
  //     const profileRegex = new RegExp(`\\[${data.envVars.awsProfile}\\]`, 'i');
  //     if (profileRegex.test(credentialsContent)) {
  //       // Profile exists, use it without changes
  //       return;
  //     }
  //
  //     // Profile missing, create it
  //     const profileSection = `\n[${data.envVars.awsProfile}]\naws_access_key_id = ${data.envVars.accessKey}\naws_secret_access_key = ${data.envVars.secretKey}\n`;
  //     credentialsContent += profileSection;
  //
  //     await writeFile(credentialsFile, credentialsContent);
  //   }
  // }
];

describe('Setup profile - run codemie doctor - run codemie profile', () => {
  const cli = createCLIRunner();
  let testConfigDir: string;
  let testConfigFile: string;

  beforeEach(async () => {
    // Setup paths
    testConfigDir = join(homedir(), '.codemie');
    testConfigFile = join(testConfigDir, 'config.json');

    // Ensure directory exists
    await mkdir(testConfigDir, { recursive: true });

    // Clear config file before test (start with clean slate)
    if (existsSync(testConfigFile)) {
      await rm(testConfigFile);
    }
  });

  // Run parametrized tests for each provider
  providerTestCases.forEach((testCase) => {
    it(`should setup ${testCase.name} profile, run doctor with real connection, and check profile status`, async () => {

      // Step 0: Setup AWS profile if needed (for profile-based auth)
      if (testCase.setupAwsProfile) {
        await testCase.setupAwsProfile(testCase);
      }

      // Step 1: Create profile from environment variables
      const profileConfig = testCase.buildProfile(testCase);
      const config: MultiProviderConfig = {
        version: 2,
        activeProfile: testCase.profileName,
        profiles: {
          [testCase.profileName]: profileConfig
        }
      };

      await writeFile(testConfigFile, JSON.stringify(config, null, 2));

      // Verify config was created
      expect(existsSync(testConfigFile)).toBe(true);
      const writtenConfig = JSON.parse(await readFile(testConfigFile, 'utf-8'));
      expect(writtenConfig.version).toBe(2);
      expect(writtenConfig.activeProfile).toBe(testCase.profileName);

      // Verify provider (use expectedProvider if specified, otherwise use profileName)
      const expectedProvider = testCase.expectedProvider || testCase.profileName;
      expect(writtenConfig.profiles[testCase.profileName].provider).toBe(expectedProvider);

      // Verify baseUrl (construct expected URL for Bedrock)
      const expectedBaseUrl = testCase.envVars.baseUrl ||
        (expectedProvider === 'bedrock' ? `https://bedrock-runtime.${testCase.envVars.region}.amazonaws.com` : undefined);
      expect(writtenConfig.profiles[testCase.profileName].baseUrl).toBe(expectedBaseUrl);

      // Step 2: Run 'codemie doctor'
      const doctorResult: CommandResult = cli.runSilent('doctor');

      // Verify health check header
      expect(doctorResult.output).toMatch(/CodeMie Code Health Check/i);

      // Verify system dependencies sections
      expect(doctorResult.output).toMatch(/Node\.js:/i);
      expect(doctorResult.output).toMatch(/✓.*Version.*v\d+/); // Node.js version

      expect(doctorResult.output).toMatch(/npm:/i);
      expect(doctorResult.output).toMatch(/✓.*Version.*\d+/); // npm version

      expect(doctorResult.output).toMatch(/Python:/i);
      expect(doctorResult.output).toMatch(/✓.*Version.*\d+/); // Python version

      expect(doctorResult.output).toMatch(/uv:/i);
      expect(doctorResult.output).toMatch(/✓.*Version/); // uv version

      expect(doctorResult.output).toMatch(/AWS CLI:/i);
      expect(doctorResult.output).toMatch(/✓.*Version.*aws-cli/); // AWS CLI version

      // Verify Active Profile section with exact format
      expect(doctorResult.output).toMatch(/Active Profile:/i);
      expect(doctorResult.output).toContain(`○ Active Profile: ${testCase.profileName}`);
      expect(doctorResult.output).toContain(`✓ Provider: ${expectedProvider}`);
      expect(doctorResult.output).toContain(`✓ Base URL: ${expectedBaseUrl}`);

      // Verify model if provided
      if (testCase.envVars.model) {
        expect(doctorResult.output).toContain(`✓ Model: ${testCase.envVars.model}`);
      }

      // Provider-specific health checks
      if (expectedProvider === 'bedrock') {
        // Verify AWS Bedrock Provider section
        expect(doctorResult.output).toMatch(/AWS Bedrock Provider:/i);
        expect(doctorResult.output).toMatch(/✓.*AWS Bedrock is accessible with \d+ model\(s\) available/i);
        expect(doctorResult.output).toMatch(/○.*Version:.*Region:/i);

        // Verify model availability check if model is specified
        if (testCase.envVars.model) {
          expect(doctorResult.output).toMatch(new RegExp(`✓.*Model '.*${testCase.envVars.model}.*' available`, 'i'));
        }
      } else if (expectedProvider === 'litellm') {
        // LiteLLM-specific checks (if any)
        // Can add LiteLLM provider section checks here
      }

      // Verify Installed Agents section
      expect(doctorResult.output).toMatch(/Installed Agents:/i);
      expect(doctorResult.output).toMatch(/✓.*CodeMie Native/i);
      expect(doctorResult.output).toMatch(/.*Claude Code/i);
      expect(doctorResult.output).toMatch(/.*Codex/i);
      expect(doctorResult.output).toMatch(/.*Gemini CLI/i);

      // Verify Repository & Workflows section
      expect(doctorResult.output).toMatch(/Repository & Workflows:/i);

      // Verify final status message
      expect(doctorResult.output).toMatch(/✓.*All checks passed!/i);

      // Step 3: Run 'codemie profile' (default action shows status)
      const profileResult: CommandResult = cli.runSilent('profile');

      // Verify exit code
      expect(profileResult.exitCode).toBe(0);

      // Verify profile list format
      expect(profileResult.output).toContain('All Profiles:');
      expect(profileResult.output).toMatch(new RegExp(`Profile\\s+│\\s+${testCase.profileName}\\s+\\(Active\\)`));
      expect(profileResult.output).toMatch(new RegExp(`Provider\\s+│\\s+${expectedProvider}`));

      // Verify model if provided
      if (testCase.envVars.model) {
        expect(profileResult.output).toMatch(new RegExp(`Model\\s+│\\s+${testCase.envVars.model}`));
      }

      // Verify separator line
      expect(profileResult.output).toMatch(/─{40,}/);

      // Verify Next Steps section
      expect(profileResult.output).toContain('Next Steps:');
      expect(profileResult.output).toContain('codemie profile switch');
      expect(profileResult.output).toContain('codemie profile status');
      expect(profileResult.output).toContain('codemie setup');
      expect(profileResult.output).toContain('codemie profile delete');

      // Step 4 & 5: Test agent execution with LLM (only for LiteLLM)
      if (testCase.profileName === 'litellm') {
        // Step 4: Run codemie-code with simple task
        const codemieCodeResult = execSync(
          'node ./bin/agent-executor.js --task "Just say one word: \'Hello\'"',
          {
            encoding: 'utf-8',
            env: {
              ...process.env,
              _: 'codemie-code',
            },
            timeout: 60000, // 60 second timeout
          }
        );

        // Verify codemie-code output contains "Hello"
        expect(codemieCodeResult.toLowerCase()).toContain('hello');

        // Step 5: Run codemie-claude with explicit task
        const codemieclaudeResult = execSync(
          'node ./bin/agent-executor.js --task "Just say one word: \'Hello\'"',
          {
            encoding: 'utf-8',
            env: {
              ...process.env,
              _: 'codemie-claude',
            },
            timeout: 60000, // 60 second timeout
          }
        );

        // Verify codemie-claude output contains "Hello"
        expect(codemieclaudeResult.toLowerCase()).toContain('hello');
      }
    });
  });
});
