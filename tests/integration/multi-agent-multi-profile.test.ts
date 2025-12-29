/**
 * Multi-Agent Multi-Profile E2E Integration Test
 *
 * Tests the complete user flow with multiple profiles where LiteLLM is the default.
 * Tests codemie-code (built-in), codemie-claude, and codemie-gemini (external) agents.
 *
 * PREREQUISITES:
 * - Run `npm run build && npm link` before running tests to ensure local wrappers are installed
 * - Ensure 4 profiles are configured in ~/.codemie/config.json:
 *   - litellm (default)
 *   - gemini-profile
 *   - bedrock-creds
 *   - bedrock-profile
 *
 * Test scenarios:
 * 1. codemie-code: default profile, model override, profile override, both overrides
 * 2. codemie-claude: default profile, model override, multiple profile overrides (litellm, bedrock-creds, bedrock-profile), both overrides
 * 3. codemie-gemini: default profile with gemini model, model override, profile override, both overrides
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
 *
 * For Bedrock (AWS Profile Auth):
 * - AWS_PROFILE: AWS profile name (default: test-codemie-profile)
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
  const testCases = [
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
      model: 'gpt-4o-mini'
    },
    {
      agent: 'codemie-code',
      description: 'should override profile to gemini-profile',
      profile: 'gemini-profile',
      model: undefined
    },
    {
      agent: 'codemie-code',
      description: 'should override both profile and model',
      profile: 'gemini-profile',
      model: 'claude-haiku-4-5-20251001'
    },
    // ==================== codemie-claude tests ====================
    {
      agent: 'codemie-claude',
      description: 'should use default litellm profile without profile flag',
      profile: undefined,
      model: undefined
    },
    {
      agent: 'codemie-claude',
      description: 'should override model while using default profile',
      profile: undefined,
      model: 'claude-haiku-4-5-20251001'
    },
    {
      agent: 'codemie-claude',
      description: 'should override profile to gemini-profile',
      profile: 'gemini-profile',
      model: undefined
    },
    {
      agent: 'codemie-claude',
      description: 'should override profile to gemini-profile with model override',
      profile: 'gemini-profile',
      model: 'claude-haiku-4-5-20251001'
    },
    {
      agent: 'codemie-claude',
      description: 'should override profile to bedrock-creds',
      profile: 'bedrock-creds',
      model: undefined
    },
    {
      agent: 'codemie-claude',
      description: 'should override profile to bedrock-creds with model override',
      profile: 'bedrock-creds',
      model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0'
    },
    {
      agent: 'codemie-claude',
      description: 'should override profile to bedrock-profile',
      profile: 'bedrock-profile',
      model: undefined
    },
    {
      agent: 'codemie-claude',
      description: 'should override profile to bedrock-profile with model override',
      profile: 'bedrock-profile',
      model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0'
    },
    // ==================== codemie-gemini tests ====================
    {
      agent: 'codemie-gemini',
      description: 'should override model while using default profile',
      profile: undefined,
      model: 'gemini-3-pro'
    },
    {
      agent: 'codemie-gemini',
      description: 'should override profile to gemini-profile',
      profile: 'gemini-profile',
      model: undefined
    },
    {
      agent: 'codemie-gemini',
      description: 'should override both profile and model',
      profile: 'gemini-profile',
      model: 'gemini-3-pro'
    }
  ];

  it.each(testCases)(
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
});
