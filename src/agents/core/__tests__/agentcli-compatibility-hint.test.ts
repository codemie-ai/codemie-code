/**
 * Unit tests for AgentCLI's validateCompatibility() model-switch hint
 * (src/agents/core/AgentCLI.ts).
 *
 * When a blocked model is caught, the existing "codemie models list" /
 * "--model <model-id>" suggestions are joined by a `codemie models switch`
 * hint — but only when the active profile resolves to 2+ models.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentCLI } from '../AgentCLI.js';
import type { AgentAdapter } from '../types.js';
import type { CodeMieConfigOptions } from '../../../utils/config.js';

function createAdapter(name = 'gemini', displayName = 'Gemini CLI'): AgentAdapter {
  return {
    name,
    displayName,
    description: 'Test adapter',
    metadata: {
      name,
      displayName,
      description: 'Test adapter',
      npmPackage: null,
      cliCommand: 'gemini',
      envMapping: {},
      supportedProviders: [],
    },
    install: async () => {},
    uninstall: async () => {},
    isInstalled: async () => true,
    run: async () => {},
    getVersion: async () => null,
    getMetricsConfig: () => undefined,
  };
}

function cfg(partial: Record<string, unknown>): CodeMieConfigOptions {
  return partial as unknown as CodeMieConfigOptions;
}

function validate(
  config: CodeMieConfigOptions,
  adapter: AgentAdapter = createAdapter(),
  modelOverridden?: boolean
): boolean {
  const cli = new AgentCLI(adapter) as unknown as {
    validateCompatibility: (config: CodeMieConfigOptions, modelOverridden?: boolean) => boolean;
  };
  return cli.validateCompatibility(config, modelOverridden);
}

describe('AgentCLI.validateCompatibility — models switch hint', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function logs(): string {
    return logSpy.mock.calls.map(call => call.join(' ')).join('\n');
  }

  it('prints no "codemie models switch" line for a single-model profile (models has 1 entry)', () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = validate(cfg({ provider: 'ai-run-sso', model: 'gpt-x', models: ['gpt-x'] }));

    expect(result).toBe(false);
    expect(logs()).not.toContain('codemie models switch');
  });

  it('prints the "codemie models switch" line when the active profile has 2+ models', () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = validate(cfg({ provider: 'ai-run-sso', model: 'gpt-x', models: ['gpt-x', 'gpt-y'] }));

    expect(result).toBe(false);
    expect(logs()).toContain('codemie models switch');
  });
});

describe('AgentCLI.validateCompatibility — persisted active model vs launching harness (EPMCDME-15641)', () => {
  const codex = (): AgentAdapter => createAdapter('codex', 'Codex');
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function output(): string {
    return [...logSpy.mock.calls, ...errorSpy.mock.calls].map(call => call.join(' ')).join('\n');
  }

  it('blocks a profile with harnesses whose active model is incompatible, naming compatible siblings', () => {
    const result = validate(
      cfg({ provider: 'ai-run-sso', model: 'claude-sonnet-4-5', models: ['claude-sonnet-4-5', 'gpt-5.4'], harnesses: ['claude', 'codex'] }),
      codex()
    );

    expect(result).toBe(false);
    expect(output()).toContain('gpt-5.4');
    expect(output()).toContain('codemie models switch');
  });

  it('points to codemie setup when the profile has no compatible model', () => {
    const result = validate(
      cfg({ provider: 'ai-run-sso', model: 'claude-sonnet-4-5', harnesses: ['claude'] }),
      codex()
    );

    expect(result).toBe(false);
    expect(output()).toContain('codemie setup');
    expect(output()).not.toContain('codemie models switch');
  });

  it('only warns and continues for a legacy profile (no harnesses) with the same mismatch', () => {
    const result = validate(
      cfg({ provider: 'ai-run-sso', model: 'claude-sonnet-4-5', models: ['claude-sonnet-4-5', 'gpt-5.4'] }),
      codex()
    );

    expect(result).toBe(true);
    expect(output()).toContain('claude-sonnet-4-5');
    expect(output()).toContain('Codex');
    expect(output()).toContain('codemie models switch');
  });

  it('skips the check when the model was set by --model or CODEMIE_MODEL', () => {
    const config = cfg({ provider: 'ai-run-sso', model: 'claude-sonnet-4-5', harnesses: ['codex'] });

    expect(validate(config, codex(), true)).toBe(true);
    expect(output()).toBe('');
  });

  it('prints nothing for a compatible model, an unverified model, or an unrestricted agent', () => {
    expect(validate(cfg({ provider: 'ai-run-sso', model: 'gpt-5.4', harnesses: ['codex'] }), codex())).toBe(true);
    expect(validate(cfg({ provider: 'ai-run-sso', model: 'sy-router', harnesses: ['codex'] }), codex())).toBe(true);
    expect(validate(
      cfg({ provider: 'ai-run-sso', model: 'claude-sonnet-4-5', harnesses: ['codex'], confirmedModels: ['claude-sonnet-4-5'] }),
      codex()
    )).toBe(true);
    expect(validate(
      cfg({ provider: 'ai-run-sso', model: 'claude-sonnet-4-5', harnesses: ['opencode'] }),
      createAdapter('opencode', 'OpenCode')
    )).toBe(true);
    expect(output()).toBe('');
  });
});

