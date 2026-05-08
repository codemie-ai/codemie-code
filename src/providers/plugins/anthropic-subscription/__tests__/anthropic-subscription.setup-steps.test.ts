import { describe, expect, it } from 'vitest';
import { AnthropicSubscriptionSetupSteps } from '../anthropic-subscription.setup-steps.js';
import { AnthropicSubscriptionTemplate } from '../anthropic-subscription.template.js';

describe('AnthropicSubscriptionSetupSteps', () => {
  describe('selectModel', () => {
    it('auto-selects the first model when CodeMie analytics is enabled', async () => {
      const selectedModel = await AnthropicSubscriptionSetupSteps.selectModel?.(
        {
          additionalConfig: {
            codeMieUrl: 'https://codemie.lab.epam.com'
          }
        },
        ['claude-sonnet-4-6', 'claude-opus-4-6']
      );

      expect(selectedModel).toBe('claude-sonnet-4-6');
    });

    it('keeps interactive model selection when CodeMie analytics is not enabled', async () => {
      const selectedModel = await AnthropicSubscriptionSetupSteps.selectModel?.(
        {
          additionalConfig: {}
        },
        ['claude-sonnet-4-6', 'claude-opus-4-6']
      );

      expect(selectedModel).toBeNull();
    });

    it('falls back to template recommended model when models list is empty and CodeMie URL is set', async () => {
      const selectedModel = await AnthropicSubscriptionSetupSteps.selectModel?.(
        { additionalConfig: { codeMieUrl: 'https://codemie.lab.epam.com' } },
        []
      );

      expect(selectedModel).toBe(AnthropicSubscriptionTemplate.recommendedModels[0]);
    });
  });

  describe('fetchModels', () => {
    it('returns the template recommended models list', async () => {
      const models = await AnthropicSubscriptionSetupSteps.fetchModels({});

      expect(models).toEqual(AnthropicSubscriptionTemplate.recommendedModels);
    });
  });

  describe('buildConfig', () => {
    it('builds config with provider and model when no CodeMie URL is configured', () => {
      const config = AnthropicSubscriptionSetupSteps.buildConfig(
        {
          baseUrl: 'https://api.anthropic.com',
          apiKey: '',
          additionalConfig: { authMethod: 'manual' }
        },
        'claude-sonnet-4-6'
      );

      expect(config.provider).toBe('anthropic-subscription');
      expect(config.model).toBe('claude-sonnet-4-6');
      expect(config.apiKey).toBe('');
      expect(config.authMethod).toBe('manual');
      expect(config.codeMieUrl).toBeUndefined();
      expect(config.codeMieProject).toBeUndefined();
    });

    it('includes codeMieUrl and codeMieProject when CodeMie analytics is enabled', () => {
      const config = AnthropicSubscriptionSetupSteps.buildConfig(
        {
          baseUrl: 'https://api.anthropic.com',
          apiKey: '',
          additionalConfig: {
            authMethod: 'manual',
            codeMieUrl: 'https://codemie.lab.epam.com',
            codeMieProject: 'my-project'
          }
        },
        'claude-opus-4-6'
      );

      expect(config.provider).toBe('anthropic-subscription');
      expect(config.model).toBe('claude-opus-4-6');
      expect(config.codeMieUrl).toBe('https://codemie.lab.epam.com');
      expect(config.codeMieProject).toBe('my-project');
    });

    it('falls back to template defaultBaseUrl when credentials have no baseUrl', () => {
      const config = AnthropicSubscriptionSetupSteps.buildConfig(
        { additionalConfig: { authMethod: 'manual' } },
        'claude-sonnet-4-6'
      );

      expect(config.baseUrl).toBe(AnthropicSubscriptionTemplate.defaultBaseUrl);
    });
  });
});
