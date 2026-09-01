import { describe, it, expect } from 'vitest';
import { AzureOpenAITemplate } from '../azure-openai.template.js';

function makeEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    CODEMIE_PROVIDER: 'azure-openai',
    CODEMIE_BASE_URL: 'https://my-azure-openai.example.com',
    CODEMIE_AZURE_OPENAI_BASE_URL: 'https://my-azure-openai.example.com',
    CODEMIE_API_KEY: 'PLACEHOLDER-KEY-FOR-TESTING-ONLY',
    CODEMIE_MODEL: 'anthropic.claude-sonnet-4-6',
    AZURE_OPENAI_API_KEY: 'PLACEHOLDER-KEY-FOR-TESTING-ONLY', // set by wildcard hook first
    ANTHROPIC_BASE_URL: 'https://my-azure-openai.example.com',
    ANTHROPIC_AUTH_TOKEN: 'PLACEHOLDER-KEY-FOR-TESTING-ONLY',
    ...overrides,
  };
}

async function runWildcardBeforeRunHook(env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const wildcardHook = AzureOpenAITemplate.agentHooks?.['*']?.beforeRun;
  if (!wildcardHook) {
    throw new Error('wildcard beforeRun hook not found in AzureOpenAITemplate');
  }
  return wildcardHook(env, { agent: 'codemie-code', agentDisplayName: 'CodeMie Code' } as any);
}

describe('AzureOpenAITemplate — generic provider hook', () => {
  it('exports Azure endpoint, API version, deployment, and key', async () => {
    const result = await runWildcardBeforeRunHook(makeEnv({
      CODEMIE_MODEL: 'deployment-a',
    }));

    expect(result.AZURE_OPENAI_ENDPOINT).toBe('https://my-azure-openai.example.com');
    expect(result.AZURE_OPENAI_API_VERSION).toBe('2025-04-01-preview');
    expect(result.AZURE_OPENAI_DEPLOYMENT).toBe('deployment-a');
    expect(result.AZURE_OPENAI_API_KEY).toBe('PLACEHOLDER-KEY-FOR-TESTING-ONLY');
  });

  it('preserves the Azure endpoint when CODEMIE_BASE_URL is the local proxy', async () => {
    const result = await runWildcardBeforeRunHook(makeEnv({
      CODEMIE_BASE_URL: 'http://localhost:3001',
      CODEMIE_AZURE_OPENAI_BASE_URL: 'https://real-azure-openai.example.com',
    }));

    expect(result.AZURE_OPENAI_ENDPOINT).toBe('https://real-azure-openai.example.com');
  });

  it('does not expose a direct Claude-specific Azure hook', () => {
    expect(AzureOpenAITemplate.agentHooks?.['claude']).toBeUndefined();
  });
});
