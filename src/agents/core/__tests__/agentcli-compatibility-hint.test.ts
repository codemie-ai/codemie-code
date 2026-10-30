/**
 * Unit tests for AgentCLI's validateCompatibility() model-switch hint
 * (src/agents/core/AgentCLI.ts).
 *
 * When a blocked model is caught, the existing "codemie models list" /
 * "--model <model-id>" suggestions are joined by a `codemie models switch`
 * hint — but only when the launching agent has 2+ models on the profile.
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

  it('prints no "codemie models switch" line for a single-model profile', () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = validate(cfg({ provider: 'ai-run-sso', model: 'gpt-x' }));

    expect(result).toBe(false);
    expect(logs()).not.toContain('codemie models switch');
  });

  it('prints the agent-scoped "codemie models switch" line when the agent has 2+ models', () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = validate(cfg({
      provider: 'ai-run-sso',
      model: 'gpt-x',
      agentModels: { gemini: { models: ['gpt-x', 'gpt-y'], model: 'gpt-x' } },
    }));

    expect(result).toBe(false);
    expect(logs()).toContain('codemie models switch --agent gemini');
  });

  it('suggests the switch for an agent that always runs on its active model, even with one model', () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = validate(cfg({
      provider: 'ai-run-sso',
      model: 'gpt-x',
      agentModels: {
        gemini: { models: ['gpt-x'], model: 'gpt-x' },
        codex: { models: ['gpt-x', 'gpt-y'], model: 'gpt-x' },
      },
    }));

    // Gemini has no in-session model menu: the switch offers it the live catalog, not a saved list.
    expect(result).toBe(false);
    expect(logs()).toContain('codemie models switch --agent gemini');
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

  it('blocks a per-agent profile whose agent active model is incompatible, naming its compatible models', () => {
    const result = validate(
      cfg({
        provider: 'ai-run-sso',
        model: 'claude-sonnet-4-5',
        agentModels: { codex: { models: ['claude-sonnet-4-5', 'gpt-5.4'], model: 'claude-sonnet-4-5' } },
      }),
      codex()
    );

    expect(result).toBe(false);
    expect(output()).toContain('gpt-5.4');
    expect(output()).toContain('codemie models switch --agent codex');
  });

  it('blocks an agent the per-agent profile does not configure when the top-level model is incompatible', () => {
    const result = validate(
      cfg({ provider: 'ai-run-sso', model: 'claude-sonnet-4-5', agentModels: {} }),
      codex()
    );

    expect(result).toBe(false);
    expect(output()).toContain('codemie setup');
  });

  it('points to codemie setup when the profile has no compatible model', () => {
    const result = validate(
      cfg({
        provider: 'ai-run-sso',
        model: 'claude-sonnet-4-5',
        agentModels: { codex: { models: ['claude-sonnet-4-5'], model: 'claude-sonnet-4-5' } },
      }),
      codex()
    );

    expect(result).toBe(false);
    expect(output()).toContain('codemie setup');
    expect(output()).not.toContain('codemie models switch');
  });

  it('only warns and continues for a legacy profile (no agentModels) with the same mismatch', () => {
    const result = validate(
      cfg({ provider: 'ai-run-sso', model: 'claude-sonnet-4-5' }),
      codex()
    );

    expect(result).toBe(true);
    expect(output()).toContain('claude-sonnet-4-5');
    expect(output()).toContain('Codex');
    expect(output()).toContain('codemie setup');
  });

  it('keeps stdout clean on the legacy warning path (ACP/SDK callers parse stdout)', () => {
    validate(
      cfg({ provider: 'ai-run-sso', model: 'claude-sonnet-4-5' }),
      codex()
    );

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('skips the check when the model was set by --model or CODEMIE_MODEL', () => {
    const config = cfg({
      provider: 'ai-run-sso',
      model: 'claude-sonnet-4-5',
      agentModels: { codex: { models: ['gpt-5.4'], model: 'gpt-5.4' } },
    });

    expect(validate(config, codex(), true)).toBe(true);
    expect(output()).toBe('');
  });

  it('prints nothing for a compatible model, an unverified model, or an unrestricted agent', () => {
    const codexSet = (model: string, extra: Record<string, unknown> = {}) =>
      cfg({ provider: 'ai-run-sso', model, agentModels: { codex: { models: [model], model, ...extra } } });

    expect(validate(codexSet('gpt-5.4'), codex())).toBe(true);
    expect(validate(codexSet('sy-router'), codex())).toBe(true);
    expect(validate(codexSet('claude-sonnet-4-5', { confirmedModels: ['claude-sonnet-4-5'] }), codex())).toBe(true);
    expect(validate(
      cfg({
        provider: 'ai-run-sso',
        model: 'claude-sonnet-4-5',
        agentModels: { opencode: { models: ['claude-sonnet-4-5'], model: 'claude-sonnet-4-5' } },
      }),
      createAdapter('opencode', 'OpenCode')
    )).toBe(true);
    expect(output()).toBe('');
  });
});

