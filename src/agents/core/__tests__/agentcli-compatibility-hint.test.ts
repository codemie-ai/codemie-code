/**
 * Unit tests for AgentCLI's validateCompatibility() model-switch hint
 * (src/agents/core/AgentCLI.ts).
 *
 * When a blocked model is caught, the existing "codemie models list" /
 * "--model <model-id>" suggestions are joined by a `codemie models switch`
 * hint — but only when the active profile resolves to 2+ models.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { AgentCLI } from '../AgentCLI.js';
import type { AgentAdapter } from '../types.js';
import type { CodeMieConfigOptions } from '../../../utils/config.js';

function createGeminiAdapter(): AgentAdapter {
  return {
    name: 'gemini',
    displayName: 'Gemini CLI',
    description: 'Test adapter',
    metadata: {
      name: 'gemini',
      displayName: 'Gemini CLI',
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

function validate(config: CodeMieConfigOptions): boolean {
  const cli = new AgentCLI(createGeminiAdapter()) as unknown as {
    validateCompatibility: (config: CodeMieConfigOptions) => boolean;
  };
  return cli.validateCompatibility(config);
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
