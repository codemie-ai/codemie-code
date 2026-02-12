/**
 * Test model tier configuration flow
 * Verifies that haikuModel, sonnetModel, opusModel are correctly propagated
 * from profile config to agent-specific environment variables
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AgentMetadata } from '../types.js';
import { BaseAgentAdapter } from '../BaseAgentAdapter.js';
import type { SessionAdapter } from '../session/BaseSessionAdapter.js';

// Mock session adapter
class MockSessionAdapter implements SessionAdapter {
  discoverSessions = vi.fn();
  parseSessionFile = vi.fn();
  processSession = vi.fn();
}

// Test agent that extends BaseAgentAdapter
class TestAgentAdapter extends BaseAgentAdapter {
  private sessionAdapter: SessionAdapter;

  constructor(metadata: AgentMetadata) {
    super(metadata);
    this.sessionAdapter = new MockSessionAdapter();
  }

  getSessionAdapter(): SessionAdapter {
    return this.sessionAdapter;
  }

  // Expose transformEnvVars for testing
  public testTransformEnvVars(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return this.transformEnvVars(env);
  }
}

describe('Model Tier Configuration', () => {
  let adapter: TestAgentAdapter;

  beforeEach(() => {
    const metadata: AgentMetadata = {
      name: 'test-claude',
      displayName: 'Test Claude',
      description: 'Test agent for model tier config',
      cliCommand: 'test-claude',
      dataPaths: {
        home: '.test-claude',
      },
      envMapping: {
        baseUrl: ['ANTHROPIC_BASE_URL'],
        apiKey: ['ANTHROPIC_AUTH_TOKEN'],
        model: ['ANTHROPIC_MODEL'],
        haikuModel: ['ANTHROPIC_DEFAULT_HAIKU_MODEL'],
        sonnetModel: ['ANTHROPIC_DEFAULT_SONNET_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL'],
        opusModel: ['ANTHROPIC_DEFAULT_OPUS_MODEL'],
      },
    };

    adapter = new TestAgentAdapter(metadata);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should transform CODEMIE_HAIKU_MODEL to ANTHROPIC_DEFAULT_HAIKU_MODEL', () => {
    const env: NodeJS.ProcessEnv = {
      CODEMIE_HAIKU_MODEL: 'claude-haiku-4-5-20251001',
    };

    const result = adapter.testTransformEnvVars(env);

    expect(result.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('claude-haiku-4-5-20251001');
    expect(result.CODEMIE_HAIKU_MODEL).toBe('claude-haiku-4-5-20251001'); // Original preserved
  });

  it('should transform CODEMIE_SONNET_MODEL to multiple target variables', () => {
    const env: NodeJS.ProcessEnv = {
      CODEMIE_SONNET_MODEL: 'claude-4-5-sonnet',
    };

    const result = adapter.testTransformEnvVars(env);

    expect(result.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('claude-4-5-sonnet');
    expect(result.CLAUDE_CODE_SUBAGENT_MODEL).toBe('claude-4-5-sonnet');
    expect(result.CODEMIE_SONNET_MODEL).toBe('claude-4-5-sonnet'); // Original preserved
  });

  it('should transform CODEMIE_OPUS_MODEL to ANTHROPIC_DEFAULT_OPUS_MODEL', () => {
    const env: NodeJS.ProcessEnv = {
      CODEMIE_OPUS_MODEL: 'claude-opus-4-6-20260205',
    };

    const result = adapter.testTransformEnvVars(env);

    expect(result.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('claude-opus-4-6-20260205');
    expect(result.CODEMIE_OPUS_MODEL).toBe('claude-opus-4-6-20260205'); // Original preserved
  });

  it('should transform all model tiers together', () => {
    const env: NodeJS.ProcessEnv = {
      CODEMIE_MODEL: 'claude-4-5-sonnet',
      CODEMIE_HAIKU_MODEL: 'claude-haiku-4-5-20251001',
      CODEMIE_SONNET_MODEL: 'claude-4-5-sonnet',
      CODEMIE_OPUS_MODEL: 'claude-opus-4-6-20260205',
      CODEMIE_BASE_URL: 'https://api.anthropic.com',
      CODEMIE_API_KEY: 'test-key-123',
    };

    const result = adapter.testTransformEnvVars(env);

    // Verify all transformations
    expect(result.ANTHROPIC_MODEL).toBe('claude-4-5-sonnet');
    expect(result.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('claude-haiku-4-5-20251001');
    expect(result.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('claude-4-5-sonnet');
    expect(result.CLAUDE_CODE_SUBAGENT_MODEL).toBe('claude-4-5-sonnet');
    expect(result.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('claude-opus-4-6-20260205');
    expect(result.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com');
    expect(result.ANTHROPIC_AUTH_TOKEN).toBe('test-key-123');

    // Verify originals preserved
    expect(result.CODEMIE_MODEL).toBe('claude-4-5-sonnet');
    expect(result.CODEMIE_HAIKU_MODEL).toBe('claude-haiku-4-5-20251001');
    expect(result.CODEMIE_SONNET_MODEL).toBe('claude-4-5-sonnet');
    expect(result.CODEMIE_OPUS_MODEL).toBe('claude-opus-4-6-20260205');
  });

  it('should clear previous agent-specific vars before setting new ones', () => {
    // Simulate environment contamination from previous shell session
    const env: NodeJS.ProcessEnv = {
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'old-haiku-model',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'old-sonnet-model',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'old-opus-model',
      CODEMIE_HAIKU_MODEL: 'claude-haiku-4-5-20251001',
      CODEMIE_SONNET_MODEL: 'claude-4-5-sonnet',
      CODEMIE_OPUS_MODEL: 'claude-opus-4-6-20260205',
    };

    const result = adapter.testTransformEnvVars(env);

    // New values should replace old ones
    expect(result.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('claude-haiku-4-5-20251001');
    expect(result.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('claude-4-5-sonnet');
    expect(result.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('claude-opus-4-6-20260205');
  });

  it('should not set tier vars if CODEMIE_*_MODEL not provided', () => {
    const env: NodeJS.ProcessEnv = {
      CODEMIE_MODEL: 'claude-4-5-sonnet',
    };

    const result = adapter.testTransformEnvVars(env);

    // Main model should be set
    expect(result.ANTHROPIC_MODEL).toBe('claude-4-5-sonnet');

    // Tier models should not be set
    expect(result.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
    expect(result.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
    expect(result.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
  });

  it('should handle partial tier configuration', () => {
    const env: NodeJS.ProcessEnv = {
      CODEMIE_HAIKU_MODEL: 'claude-haiku-4-5-20251001',
      // sonnetModel and opusModel not provided
    };

    const result = adapter.testTransformEnvVars(env);

    // Only haiku should be set
    expect(result.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('claude-haiku-4-5-20251001');
    expect(result.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
    expect(result.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
  });

  it('should handle agent with no envMapping', () => {
    const metadataNoMapping: AgentMetadata = {
      name: 'test-agent-no-mapping',
      displayName: 'Test Agent No Mapping',
      description: 'Test agent without env mapping',
      cliCommand: 'test-agent',
      dataPaths: {
        home: '.test-agent',
      },
      // No envMapping defined
    };

    const adapterNoMapping = new TestAgentAdapter(metadataNoMapping);
    const env: NodeJS.ProcessEnv = {
      CODEMIE_HAIKU_MODEL: 'claude-haiku-4-5-20251001',
    };

    const result = adapterNoMapping.testTransformEnvVars(env);

    // No transformation should occur
    expect(result.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
    expect(result.CODEMIE_HAIKU_MODEL).toBe('claude-haiku-4-5-20251001'); // Original preserved
  });
});

describe('ConfigLoader.exportProviderEnvVars', () => {
  it('should export model tier config from profile', async () => {
    const { ConfigLoader } = await import('../../../utils/config.js');

    const config = {
      provider: 'ai-run-sso',
      baseUrl: 'https://codemie.lab.epam.com/code-assistant-api',
      apiKey: 'test-key',
      model: 'claude-4-5-sonnet',
      haikuModel: 'claude-haiku-4-5-20251001',
      sonnetModel: 'claude-4-5-sonnet',
      opusModel: 'claude-opus-4-6-20260205',
    };

    const env = ConfigLoader.exportProviderEnvVars(config);

    expect(env.CODEMIE_MODEL).toBe('claude-4-5-sonnet');
    expect(env.CODEMIE_HAIKU_MODEL).toBe('claude-haiku-4-5-20251001');
    expect(env.CODEMIE_SONNET_MODEL).toBe('claude-4-5-sonnet');
    expect(env.CODEMIE_OPUS_MODEL).toBe('claude-opus-4-6-20260205');
  });

  it('should handle missing tier config gracefully', async () => {
    const { ConfigLoader } = await import('../../../utils/config.js');

    const config = {
      provider: 'ai-run-sso',
      baseUrl: 'https://codemie.lab.epam.com/code-assistant-api',
      apiKey: 'test-key',
      model: 'claude-4-5-sonnet',
      // No tier models provided
    };

    const env = ConfigLoader.exportProviderEnvVars(config);

    expect(env.CODEMIE_MODEL).toBe('claude-4-5-sonnet');
    expect(env.CODEMIE_HAIKU_MODEL).toBeUndefined();
    expect(env.CODEMIE_SONNET_MODEL).toBeUndefined();
    expect(env.CODEMIE_OPUS_MODEL).toBeUndefined();
  });
});
