import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SetupContext } from '../../../core/types.js';
import { LiteLLMSetupSteps } from '../litellm.setup-steps.js';

vi.mock('inquirer', () => ({
  default: {
    prompt: vi.fn().mockResolvedValue({ baseUrl: 'http://localhost:4000', apiKey: '' })
  }
}));

vi.mock('chalk', () => ({
  default: {
    cyan: (s: string) => s,
    dim: (s: string) => s
  }
}));

describe('SetupContext type', () => {
  it('is accepted by getCredentials without breaking the normal call', async () => {
    const inquirer = await import('inquirer');
    vi.mocked(inquirer.default.prompt).mockResolvedValueOnce({ baseUrl: 'http://localhost:4000', apiKey: '' });

    const context: SetupContext = {};
    const result = await LiteLLMSetupSteps.getCredentials(false, context);
    expect(result.baseUrl).toBe('http://localhost:4000');
  });
});

describe('LiteLLMSetupSteps.getCredentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('normal mode (no context)', () => {
    it('allows empty API key — defaults to "not-required"', async () => {
      const inquirer = await import('inquirer');
      vi.mocked(inquirer.default.prompt).mockResolvedValueOnce({
        baseUrl: 'http://localhost:4000',
        apiKey: ''
      });

      const result = await LiteLLMSetupSteps.getCredentials();
      expect(result.apiKey).toBe('not-required');
    });

    it('preserves a provided API key', async () => {
      const inquirer = await import('inquirer');
      vi.mocked(inquirer.default.prompt).mockResolvedValueOnce({
        baseUrl: 'http://localhost:4000',
        apiKey: 'sk-abc123'
      });

      const result = await LiteLLMSetupSteps.getCredentials();
      expect(result.apiKey).toBe('sk-abc123');
    });
  });

  describe('enforcement mode (context.enforcedIntegration set)', () => {
    const enforcedContext: SetupContext = {
      enforcedIntegration: {
        id: 'int-1',
        alias: 'my-integration',
        codeMieUrl: 'https://codemie.example.com'
      }
    };

    it('returns credentials with provided key when key is non-empty', async () => {
      const inquirer = await import('inquirer');
      vi.mocked(inquirer.default.prompt).mockResolvedValueOnce({
        baseUrl: 'http://proxy.example.com',
        apiKey: 'sk-enforced-key'
      });

      const result = await LiteLLMSetupSteps.getCredentials(false, enforcedContext);
      expect(result.apiKey).toBe('sk-enforced-key');
      expect(result.baseUrl).toBe('http://proxy.example.com');
    });

    it('does not fall back to "not-required" in enforcement mode', async () => {
      const inquirer = await import('inquirer');
      vi.mocked(inquirer.default.prompt).mockResolvedValueOnce({
        baseUrl: 'http://proxy.example.com',
        apiKey: 'required-key'
      });

      const result = await LiteLLMSetupSteps.getCredentials(false, enforcedContext);
      expect(result.apiKey).not.toBe('not-required');
      expect(result.apiKey).toBe('required-key');
    });
  });
});
