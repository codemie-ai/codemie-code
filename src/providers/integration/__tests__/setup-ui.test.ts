import { describe, expect, it } from 'vitest';
import type { ProviderTemplate } from '../../core/types.js';
import { getAllProviderChoices } from '../setup-ui.js';

describe('setup-ui', () => {
  describe('getAllProviderChoices', () => {
    it('sorts providers by priority and keeps Anthropic Subscription before Ollama', () => {
      const providers: ProviderTemplate[] = [
        {
          name: 'ollama',
          displayName: 'Ollama',
          description: 'Local models',
          defaultBaseUrl: 'http://localhost:11434',
          requiresAuth: false,
          authType: 'none',
          recommendedModels: ['qwen2.5-coder'],
          capabilities: ['streaming'],
          supportsModelInstallation: true,
        },
        {
          name: 'anthropic-subscription',
          displayName: 'Anthropic Subscription',
          description: 'Native Claude Code authentication',
          defaultBaseUrl: 'https://api.anthropic.com',
          requiresAuth: false,
          authType: 'none',
          priority: 16,
          recommendedModels: ['claude-sonnet-4-6'],
          capabilities: ['streaming', 'tools'],
          supportsModelInstallation: false,
        },
        {
          name: 'ai-run-sso',
          displayName: 'CodeMie SSO',
          description: 'Enterprise SSO Authentication',
          defaultBaseUrl: 'https://codemie.lab.epam.com',
          requiresAuth: true,
          authType: 'sso',
          priority: 0,
          recommendedModels: ['claude-sonnet-4-6'],
          capabilities: ['streaming', 'tools', 'sso-auth'],
          supportsModelInstallation: false,
        }
      ];

      const choices = getAllProviderChoices(providers);

      expect(choices.map(choice => choice.value)).toEqual([
        'ai-run-sso',
        'anthropic-subscription',
        'ollama',
      ]);
    });
  });
});
