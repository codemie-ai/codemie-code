import { describe, it, expect } from 'vitest';
import { MoonshotSubscriptionTemplate } from '../moonshot-subscription.template.js';

describe('MoonshotSubscriptionTemplate', () => {
  it('should require no authentication', () => {
    expect(MoonshotSubscriptionTemplate.requiresAuth).toBe(false);
    expect(MoonshotSubscriptionTemplate.authType).toBe('none');
  });

  it('should export CodeMie env vars with empty API key and optional analytics values', () => {
    const codeMieUrl = 'https://codemie.example.com';
    const codeMieProject = 'my-project';

    const env = MoonshotSubscriptionTemplate.exportEnvVars!({
      provider: 'moonshot-subscription',
      codeMieUrl,
      codeMieProject
    });

    expect(env.CODEMIE_API_KEY).toBe('');
    expect(env.CODEMIE_URL).toBe(codeMieUrl);
    expect(env.CODEMIE_SYNC_API_URL).toBe(`${codeMieUrl}/code-assistant-api`);
    expect(env.CODEMIE_PROJECT).toBe(codeMieProject);
  });

  it('should recommend at least one model', () => {
    expect(MoonshotSubscriptionTemplate.recommendedModels.length).toBeGreaterThan(0);
  });
});
