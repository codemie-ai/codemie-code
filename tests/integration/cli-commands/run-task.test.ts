/**
 * Multi-Agent Multi-Profile E2E Integration Test
 *
 * Tests the complete user flow with multiple profiles where LiteLLM is the default.
 * Tests codemie-code (built-in), codemie-claude, and codemie-gemini (external) agents.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { writeFile, readFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { setupTestIsolation, getTestHome } from '../../helpers/test-isolation.js';
import type { MultiProviderConfig, CodeMieConfigOptions } from '../../../src/env/types.js';

// Test environment variables
const liteLLMBaseUrl = process.env.LITELLM_BASE_URL;
const liteLLMApiKey = process.env.LITELLM_API_KEY;
const liteLLMModel = process.env.LITELLM_MODEL || 'gpt-4.1';

const awsAccessKeyId = process.env.AWS_ACCESS_KEY_ID;
const awsSecretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
const awsRegion = process.env.AWS_DEFAULT_REGION;
const awsProfile = process.env.AWS_PROFILE || 'test-codemie-profile';
const bedrockModel = process.env.BEDROCK_MODEL || 'global.anthropic.claude-sonnet-4-5-20250929-v1:0';

// Check if required environment variables are set
const hasLiteLLMConfig = !!(liteLLMBaseUrl && liteLLMApiKey);
const hasAWSConfig = !!(awsAccessKeyId && awsSecretAccessKey && awsRegion);
const hasAnyConfig = hasLiteLLMConfig || hasAWSConfig;

// Log skip reason for CI visibility
if (!hasAnyConfig) {
  console.log('\n⚠️  Skipping Multi-Agent Multi-Profile E2E tests');
  console.log('   Reason: No provider credentials configured');
  console.log('   Required: LITELLM_BASE_URL + LITELLM_API_KEY, or AWS credentials\n');
}

// Conditional describe - skip if no configuration available
describe.skipIf(!hasAnyConfig)('Multi-Agent Multi-Profile E2E', () => {
  // Setup isolated CODEMIE_HOME for this test suite
  setupTestIsolation();

  let testConfigFile: string;

  beforeAll(async () => {
    // Get isolated test home and setup config
    const testHome = getTestHome();
    testConfigFile = join(testHome, 'codemie-cli.config.json');

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
      'gemini-profile': {
        provider: 'litellm',
        baseUrl: liteLLMBaseUrl,
        apiKey: liteLLMApiKey,
        model: 'gemini-2.5-pro',
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
    const writtenConfig = JSON.parse(await readFile(testConfigFile, 'utf-8'));
    expect(writtenConfig.version).toBe(2);
    expect(writtenConfig.activeProfile).toBe('litellm');
    expect(Object.keys(writtenConfig.profiles)).toHaveLength(4);
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

  it.concurrent.each(chatTestCases)(
    '$agent: $description',
    async ({ agent, profile, model }) => {
      // Skip external agent tests if TEST_AGENT_FILTER is set
      const agentFilter = process.env.TEST_AGENT_FILTER;
      if (agentFilter && agent !== agentFilter) {
        console.log(`Skipping ${agent} test (filter: ${agentFilter})`);
        return;
      }

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
