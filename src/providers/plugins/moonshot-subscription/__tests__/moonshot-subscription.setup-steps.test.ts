import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MoonshotSubscriptionSetupSteps } from '../moonshot-subscription.setup-steps.js';
import { MoonshotSubscriptionTemplate } from '../moonshot-subscription.template.js';
import { ConfigurationError } from '../../../../utils/errors.js';

const { mockCommandExists, mockPrompt, mockAuthenticateWithCodeMie, mockSelectCodeMieProject, mockPromptForCodeMieUrl } = vi.hoisted(() => ({
  mockCommandExists: vi.fn(),
  mockPrompt: vi.fn(),
  mockAuthenticateWithCodeMie: vi.fn(),
  mockSelectCodeMieProject: vi.fn(),
  mockPromptForCodeMieUrl: vi.fn(),
}));

vi.mock('inquirer', () => ({
  default: { prompt: mockPrompt },
}));

vi.mock('../../../../utils/processes.js', () => ({
  commandExists: mockCommandExists,
}));

vi.mock('../../../../utils/logger.js', () => ({
  logger: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../core/registry.js', () => ({
  ProviderRegistry: { registerSetupSteps: vi.fn() },
}));

vi.mock('@/providers/core/codemie-auth-helpers.js', () => ({
  DEFAULT_CODEMIE_BASE_URL: 'https://codemie.example.com',
  authenticateWithCodeMie: mockAuthenticateWithCodeMie,
  promptForCodeMieUrl: mockPromptForCodeMieUrl,
  selectCodeMieProject: mockSelectCodeMieProject,
}));

describe('MoonshotSubscriptionSetupSteps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCommandExists.mockResolvedValue(true);
  });

  describe('getCredentials', () => {
    it('throws ConfigurationError when kimi is not on PATH', async () => {
      mockCommandExists.mockResolvedValue(false);

      await expect(MoonshotSubscriptionSetupSteps.getCredentials(false)).rejects.toThrow(ConfigurationError);
      await expect(MoonshotSubscriptionSetupSteps.getCredentials(false)).rejects.toThrow(
        'Kimi Code CLI (kimi) was not found on PATH'
      );
    });

    it('returns credentials with empty apiKey and manual authMethod when analytics is disabled', async () => {
      mockPrompt.mockResolvedValue({ enableCodeMieAnalytics: false });

      const credentials = await MoonshotSubscriptionSetupSteps.getCredentials(false);

      expect(credentials.baseUrl).toBe(MoonshotSubscriptionTemplate.defaultBaseUrl);
      expect(credentials.apiKey).toBe('');
      expect(credentials.additionalConfig).toEqual({
        authMethod: 'manual',
        codeMieUrl: undefined,
        codeMieProject: undefined,
        userEmail: undefined,
      });
    });

    it('authenticates and selects project when analytics is enabled', async () => {
      mockPrompt.mockResolvedValue({ enableCodeMieAnalytics: true });
      mockPromptForCodeMieUrl.mockResolvedValue('https://codemie.lab.epam.com');
      mockAuthenticateWithCodeMie.mockResolvedValue({
        success: true,
        apiUrl: 'https://codemie.lab.epam.com/code-assistant-api',
        cookies: { session: 'abc' },
      });
      mockSelectCodeMieProject.mockResolvedValue({ project: 'my-project', userEmail: 'user@example.com' });

      const credentials = await MoonshotSubscriptionSetupSteps.getCredentials(false);

      expect(mockPromptForCodeMieUrl).toHaveBeenCalledWith(
        'https://codemie.example.com',
        'CodeMie platform URL for analytics sync:'
      );
      expect(mockAuthenticateWithCodeMie).toHaveBeenCalledWith('https://codemie.lab.epam.com', 120000);
      expect(mockSelectCodeMieProject).toHaveBeenCalled();
      expect(credentials.additionalConfig).toEqual({
        authMethod: 'manual',
        codeMieUrl: 'https://codemie.lab.epam.com',
        codeMieProject: 'my-project',
        userEmail: 'user@example.com',
      });
    });
  });

  describe('fetchModels', () => {
    it('returns the template recommended models list', async () => {
      const models = await MoonshotSubscriptionSetupSteps.fetchModels({});

      expect(models).toEqual(MoonshotSubscriptionTemplate.recommendedModels);
    });
  });

  describe('selectModel', () => {
    it('returns the first model when codeMieUrl is present', async () => {
      const selectedModel = await MoonshotSubscriptionSetupSteps.selectModel?.(
        { additionalConfig: { codeMieUrl: 'https://codemie.lab.epam.com' } },
        ['kimi-for-coding', 'kimi-k2']
      );

      expect(selectedModel).toBe('kimi-for-coding');
    });

    it('returns null when codeMieUrl is not present', async () => {
      const selectedModel = await MoonshotSubscriptionSetupSteps.selectModel?.(
        { additionalConfig: {} },
        ['kimi-for-coding', 'kimi-k2']
      );

      expect(selectedModel).toBeNull();
    });

    it('falls back to template recommended model when models list is empty and codeMieUrl is set', async () => {
      const selectedModel = await MoonshotSubscriptionSetupSteps.selectModel?.(
        { additionalConfig: { codeMieUrl: 'https://codemie.lab.epam.com' } },
        []
      );

      expect(selectedModel).toBe(MoonshotSubscriptionTemplate.recommendedModels[0]);
    });
  });

  describe('buildConfig', () => {
    it('returns expected CodeMieConfigOptions shape', () => {
      const config = MoonshotSubscriptionSetupSteps.buildConfig(
        {
          baseUrl: MoonshotSubscriptionTemplate.defaultBaseUrl,
          apiKey: '',
          additionalConfig: {
            authMethod: 'manual',
            codeMieUrl: 'https://codemie.lab.epam.com',
            codeMieProject: 'my-project',
          },
        },
        'kimi-for-coding'
      );

      expect(config.provider).toBe('moonshot-subscription');
      expect(config.baseUrl).toBe(MoonshotSubscriptionTemplate.defaultBaseUrl);
      expect(config.apiKey).toBe('');
      expect(config.model).toBe('kimi-for-coding');
      expect(config.authMethod).toBe('manual');
      expect(config.codeMieUrl).toBe('https://codemie.lab.epam.com');
      expect(config.codeMieProject).toBe('my-project');
    });

    it('falls back to template defaultBaseUrl when credentials have no baseUrl', () => {
      const config = MoonshotSubscriptionSetupSteps.buildConfig(
        { additionalConfig: { authMethod: 'manual' } },
        'kimi-k2'
      );

      expect(config.baseUrl).toBe(MoonshotSubscriptionTemplate.defaultBaseUrl);
    });

    it('omits codeMieUrl and codeMieProject when analytics is not enabled', () => {
      const config = MoonshotSubscriptionSetupSteps.buildConfig(
        {
          baseUrl: MoonshotSubscriptionTemplate.defaultBaseUrl,
          apiKey: '',
          additionalConfig: { authMethod: 'manual' },
        },
        'kimi-for-coding'
      );

      expect(config.codeMieUrl).toBeUndefined();
      expect(config.codeMieProject).toBeUndefined();
    });
  });
});
