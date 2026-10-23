/**
 * Unit tests for runModelsSwitch (src/cli/commands/models.ts).
 *
 * `codemie models switch` only ever touches the active profile's own model
 * list (never the full provider catalog): an unknown arg fails loudly, a
 * single-model profile is a no-op, and a valid switch writes through
 * ConfigLoader.switchActiveProfileModel.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('chalk', () => {
  const id = (s: string): string => s;
  const proxy = new Proxy(id, { get: () => id });
  return { default: proxy };
});

const configMock = vi.hoisted(() => ({
  getActiveProfileName: vi.fn(),
  getProfile: vi.fn(),
  switchActiveProfileModel: vi.fn(),
  load: vi.fn().mockResolvedValue({})
}));
vi.mock('../../../utils/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/config.js')>();
  return { ...actual, ConfigLoader: configMock };
});

const agentRegistryMock = vi.hoisted(() => ({ getAgent: vi.fn().mockReturnValue(undefined) }));
vi.mock('../../../agents/registry.js', () => ({ AgentRegistry: agentRegistryMock }));

const loggerMock = vi.hoisted(() => ({ warn: vi.fn(), debug: vi.fn(), error: vi.fn(), success: vi.fn() }));
vi.mock('../../../utils/logger.js', () => ({ logger: loggerMock }));

const promptModelSwitchSelectionMock = vi.hoisted(() => vi.fn());
vi.mock('../models-switch-prompt.js', () => ({
  promptModelSwitchSelection: promptModelSwitchSelectionMock
}));

import { runModelsSwitch } from '../models.js';
import { ProviderRegistry } from '../../../providers/core/registry.js';

describe('runModelsSwitch', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    configMock.switchActiveProfileModel.mockResolvedValue({ profileName: 'default' });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function allLogs(spy: ReturnType<typeof vi.spyOn>): string {
    return spy.mock.calls.map(call => call.join(' ')).join('\n');
  }

  it('writes without prompting when the arg matches a profile model', async () => {
    configMock.getActiveProfileName.mockResolvedValue('default');
    configMock.getProfile.mockResolvedValue({ provider: 'openai', model: 'a', models: ['a', 'b'] });

    await runModelsSwitch('b', '/work');

    expect(promptModelSwitchSelectionMock).not.toHaveBeenCalled();
    expect(configMock.switchActiveProfileModel).toHaveBeenCalledWith('b', '/work', undefined);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(allLogs(logSpy)).toContain('Switched');
  });

  it('fails loudly, lists the real models, and writes nothing when the arg is unknown', async () => {
    configMock.getActiveProfileName.mockResolvedValue('default');
    configMock.getProfile.mockResolvedValue({ provider: 'openai', model: 'a', models: ['a', 'b'] });

    await runModelsSwitch('does-not-exist', '/work');

    expect(configMock.switchActiveProfileModel).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    const errText = allLogs(errorSpy);
    expect(errText).toContain('a');
    expect(errText).toContain('b');
    expect(errText).toContain('codemie setup');
  });

  it('prompts via promptModelSwitchSelection and writes its answer when no arg is given', async () => {
    configMock.getActiveProfileName.mockResolvedValue('default');
    configMock.getProfile.mockResolvedValue({ provider: 'openai', model: 'a', models: ['a', 'b'] });
    promptModelSwitchSelectionMock.mockResolvedValue('b');

    await runModelsSwitch(undefined, '/work');

    expect(promptModelSwitchSelectionMock).toHaveBeenCalledWith(['a', 'b'], 'a');
    expect(configMock.switchActiveProfileModel).toHaveBeenCalledWith('b', '/work', undefined);
  });

  it('prints the single-model message and writes nothing for a single-model profile', async () => {
    configMock.getActiveProfileName.mockResolvedValue('default');
    configMock.getProfile.mockResolvedValue({ provider: 'openai', model: 'a' });

    await runModelsSwitch(undefined, '/work');

    expect(configMock.switchActiveProfileModel).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(allLogs(logSpy)).toContain('single model');
  });

  it('prints the subscription-provider wording for an anthropic-subscription single-model profile', async () => {
    configMock.getActiveProfileName.mockResolvedValue('default');
    configMock.getProfile.mockResolvedValue({ provider: 'anthropic-subscription', model: 'claude-x' });

    await runModelsSwitch(undefined, '/work');

    expect(configMock.switchActiveProfileModel).not.toHaveBeenCalled();
    expect(allLogs(logSpy)).toContain("doesn't support multiple models");
  });

  // CR-006: the Claude tier-refresh block (proxy.fetchModels -> autoSelectModelTiers)
  // talks to the network; a failure there must not deny a switch that is
  // otherwise a pure local config write.
  it('still completes the switch when the Claude tier-refresh network call throws (CR-006)', async () => {
    configMock.getActiveProfileName.mockResolvedValue('default');
    configMock.getProfile.mockResolvedValue({ provider: 'litellm', model: 'a', models: ['a', 'b'] });
    agentRegistryMock.getAgent.mockReturnValue({ metadata: { supportedProviders: ['litellm'] } });
    const fetchModels = vi.fn().mockRejectedValue(new Error('network down'));
    vi.spyOn(ProviderRegistry, 'getModelProxy').mockReturnValue({ fetchModels } as never);

    await runModelsSwitch('b', '/work');

    expect(fetchModels).toHaveBeenCalledTimes(1);
    expect(loggerMock.warn).toHaveBeenCalled();
    expect(configMock.switchActiveProfileModel).toHaveBeenCalledWith('b', '/work', undefined);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(allLogs(logSpy)).toContain('Switched');
  });
});
