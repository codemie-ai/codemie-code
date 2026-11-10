import { describe, expect, it, vi, afterEach } from 'vitest';
import type { ProviderTemplate } from '../../core/types.js';
import { displaySetupSuccess, getAllProviderChoices } from '../setup-ui.js';

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

describe('displaySetupSuccess', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function capture(run: () => void): string {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    run();
    return logSpy.mock.calls.map(call => call.join(' ')).join('\n');
  }

  it('lists each agent models instead of the top-level model for a per-agent profile', () => {
    const output = capture(() => displaySetupSuccess('team', 'ai-run-sso', 'claude-x', [
      { agent: 'Claude Code', model: 'claude-x', otherModels: ['claude-y'] },
      { agent: 'OpenAI Codex CLI', model: 'gpt-5.4', otherModels: [] },
    ]));

    expect(output).toContain('Agent models:');
    expect(output).toContain('Claude Code: claude-x (active), claude-y');
    expect(output).toContain('OpenAI Codex CLI: gpt-5.4 (active)');
    expect(output).not.toContain('Model: claude-x');
  });

  it('shows the single Model line for a profile without per-agent models', () => {
    const output = capture(() => displaySetupSuccess('team', 'anthropic-subscription', 'claude-x'));

    expect(output).toContain('Model: claude-x');
    expect(output).not.toContain('Agent models');
  });
});
