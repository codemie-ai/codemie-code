/**
 * Multi-Agent Multi-Profile E2E Integration Test
 *
 * Tests the complete user flow with multiple profiles where LiteLLM is the default.
 * Tests codemie-code (built-in), codemie-claude, and codemie-gemini (external) agents.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'path';
import { homedir } from 'os';
import { mkdir, writeFile, readFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { execSync } from 'child_process';
import type { MultiProviderConfig, CodeMieConfigOptions } from '../../src/env/types';

describe('Multi-Agent Multi-Profile E2E', () => {
  let testConfigDir: string;
  let testConfigFile: string;
  let awsDir: string;
  let credentialsFile: string;

  // Test environment variables
  const liteLLMBaseUrl = process.env.LITELLM_BASE_URL;
  const liteLLMApiKey = process.env.LITELLM_API_KEY;
  const liteLLMModel = process.env.LITELLM_MODEL || 'gpt-4.1';

  const awsAccessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const awsSecretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const awsRegion = process.env.AWS_DEFAULT_REGION;
  const awsProfile = process.env.AWS_PROFILE;
  const bedrockModel = process.env.BEDROCK_MODEL || 'global.anthropic.claude-sonnet-4-5-20250929-v1:0';

  beforeAll(async () => {
    // Setup paths
    testConfigDir = join(homedir(), '.codemie');
    testConfigFile = join(testConfigDir, 'config.json');
    awsDir = join(homedir(), '.aws');
    credentialsFile = join(awsDir, 'credentials');

    // Ensure directory exists
    await mkdir(testConfigDir, { recursive: true });
    await mkdir(awsDir, { recursive: true });

    // Clear config file before suite (start with clean slate)
    if (existsSync(testConfigFile)) {
      await rm(testConfigFile);
    }

    // Setup AWS credentials file for bedrock-profile
    if (awsAccessKeyId && awsSecretAccessKey) {
      let credentialsContent = '';
      if (existsSync(credentialsFile)) {
        credentialsContent = await readFile(credentialsFile, 'utf-8');
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

    // Create 4 profiles with litellm as default
    const profiles: Record<string, CodeMieConfigOptions> = {
      litellm: {
        provider: 'litellm',
        baseUrl: liteLLMBaseUrl,
        apiKey: liteLLMApiKey,
        model: liteLLMModel,
        timeout: 300
      },
      'gemini-profile': {
        provider: 'litellm',
        baseUrl: liteLLMBaseUrl,
        apiKey: liteLLMApiKey,
        model: 'gemini-2.5-pro', // Gemini model for gemini CLI testing
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

    await writeFile(testConfigFile, JSON.stringify(config, null, 2));

    // Verify config was created
    expect(existsSync(testConfigFile)).toBe(true);
    const writtenConfig = JSON.parse(await readFile(testConfigFile, 'utf-8'));
    expect(writtenConfig.version).toBe(2);
    expect(writtenConfig.activeProfile).toBe('litellm');
    expect(Object.keys(writtenConfig.profiles)).toHaveLength(4);
  });

  afterAll(async () => {
    // Clean up test config after all tests complete
    if (existsSync(testConfigFile)) {
      await rm(testConfigFile);
    }
  });

  // Parametrized test cases
  const chatTestCases = [
    // ==================== codemie-code tests ====================
    {
      agent: 'codemie-code',
      description: 'should use default litellm profile without profile flag',
      profile: undefined,
      model: undefined
    },
    {
      agent: 'codemie-code',
      description: 'should override model while using default profile',
      profile: undefined,
      model: 'gpt-5-nano-2025-08-07'
    },

    // ==================== codemie-claude (External agent + profile switching) ====================
    {
      agent: 'codemie-claude',
      description: 'should override profile to gemini-profile',
      profile: 'gemini-profile',
      model: undefined
    },
    {
      agent: 'codemie-claude',
      description: 'should override profile to bedrock-creds',
      profile: 'bedrock-creds',
      model: undefined
    },

    // ==================== codemie-gemini (Different external agent) ====================
    {
      agent: 'codemie-gemini',
      description: 'should override model while using default profile',
      profile: undefined,
      model: 'gemini-2.5-flash'
    },
  ];

  it.each(chatTestCases)(
    '$agent: $description',
    async ({ agent, profile, model }) => {
      // Build command parts
      const parts: string[] = [];

      if (profile) {
        parts.push(`--profile ${profile}`);
      }

      if (model) {
        parts.push(`--model ${model}`);
      }

      // All agents support --task flag through their flagMappings
      parts.push(`--task "Just say one word: 'Hello'"`);

      const argsString = parts.join(' ');

      // Determine the correct bin file for each agent
      const binFile = agent === 'codemie-code'
        ? './bin/agent-executor.js'
        : `./bin/${agent}.js`;

      const output = execSync(`node ${binFile} ${argsString}`, {
        encoding: 'utf-8',
        env: { ...process.env },
        timeout: 60000
      });

      expect(output.toLowerCase()).toContain('hello');
    }
  );

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
    async ({ profileName, expectedProvider, expectedModel }) => {
      // Switch to the profile first if not already active
      const currentConfig = JSON.parse(await readFile(testConfigFile, 'utf-8'));

      if (currentConfig.activeProfile !== profileName) {
        execSync(`node ./bin/codemie.js profile switch ${profileName}`, {
          encoding: 'utf-8',
          env: { ...process.env },
          timeout: 10000
        });
      }

      // Run profile status command
      const output = execSync('node ./bin/codemie.js profile status', {
        encoding: 'utf-8',
        env: { ...process.env },
        timeout: 10000
      });

      // Verify output format matches expected structure:
      // Profile      │ profile-name (Active)
      // Provider     │ provider-name
      // Model        │ model-name
      expect(output).toContain('Profile Status');
      expect(output).toContain('│'); // Box drawing character used as separator
      expect(output).toContain(profileName);
      expect(output).toContain(expectedProvider);
      expect(output).toContain(expectedModel);

      // Verify active profile indicator
      expect(output.toLowerCase()).toMatch(/active|●/);
    }
  );
});
