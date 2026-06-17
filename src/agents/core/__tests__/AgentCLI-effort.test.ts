import { describe, it, expect } from 'vitest';
import { ConfigLoader } from '../../../utils/config.js';

describe('exportProviderEnvVars — reasoningEffort', () => {
  it('emits CODEMIE_REASONING_EFFORT when config.reasoningEffort is set', () => {
    const env = ConfigLoader.exportProviderEnvVars({
      provider: 'openai',
      baseUrl: 'https://example.com',
      apiKey: 'test-key',
      model: 'gpt-4o',
      reasoningEffort: 'high',
    });
    expect(env.CODEMIE_REASONING_EFFORT).toBe('high');
  });

  it('does not emit CODEMIE_REASONING_EFFORT when not set', () => {
    const env = ConfigLoader.exportProviderEnvVars({
      provider: 'openai',
      baseUrl: 'https://example.com',
      apiKey: 'test-key',
      model: 'gpt-4o',
    });
    expect(env.CODEMIE_REASONING_EFFORT).toBeUndefined();
  });
});
