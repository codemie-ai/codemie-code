/**
 * Unit tests for handlePluginSetup (src/cli/commands/setup.ts).
 *
 * handlePluginSetup is the plugin-based setup flow driven by ProviderSetupSteps.
 * This file pins the multi-model wiring added on top of it: the install loop now
 * runs once per selected model, the saved config carries `models` (array or
 * undefined) alongside the unchanged `model`, and an update pre-checks the
 * existing profile's models in the (mocked) checkbox prompt.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const promptMock = vi.hoisted(() => vi.fn());
vi.mock('inquirer', () => ({ default: { prompt: promptMock } }));

vi.mock('chalk', () => {
  const id = (s: string): string => s;
  const proxy = new Proxy(id, { get: () => id });
  return { default: proxy };
});

vi.mock('ora', () => ({
  default: () => ({
    start: () => ({ succeed: () => {}, warn: () => {}, fail: () => {}, stop: () => {} })
  })
}));

const configMock = vi.hoisted(() => ({
  saveProfile: vi.fn().mockResolvedValue(undefined),
  saveUserEmail: vi.fn().mockResolvedValue(undefined),
  initProjectConfig: vi.fn().mockResolvedValue(undefined),
  listProfiles: vi.fn().mockResolvedValue([]),
  getActiveProfileName: vi.fn().mockResolvedValue(null),
  switchProfile: vi.fn().mockResolvedValue(undefined),
  getProfile: vi.fn().mockResolvedValue(null)
}));
vi.mock('../../../utils/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/config.js')>();
  return { ...actual, ConfigLoader: configMock };
});

const providerRegistryMock = vi.hoisted(() => ({
  getProvider: vi.fn(),
  getAllProviders: vi.fn().mockReturnValue([]),
  getSetupSteps: vi.fn(),
  getModelProxy: vi.fn()
}));
vi.mock('../../../providers/index.js', () => ({ ProviderRegistry: providerRegistryMock }));

const agentRegistryMock = vi.hoisted(() => ({ getAgent: vi.fn().mockReturnValue(undefined) }));
vi.mock('../../../agents/registry.js', () => ({ AgentRegistry: agentRegistryMock }));

vi.mock('../../../utils/logger.js', () => ({
  logger: { success: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() }
}));

vi.mock('../../first-time.js', () => ({ FirstTimeExperience: { showEcosystemIntro: vi.fn() } }));

vi.mock('../../../providers/integration/setup-ui.js', () => ({
  getAllProviderChoices: vi.fn().mockReturnValue([]),
  displaySetupSuccess: vi.fn(),
  displaySetupError: vi.fn(),
  getAllModelChoices: (models: string[]) => models.map(m => ({ name: m, value: m }))
}));

import { handlePluginSetup } from '../setup.js';

describe('handlePluginSetup (multi-model wiring)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configMock.saveProfile.mockResolvedValue(undefined);
    configMock.getProfile.mockResolvedValue(null);
    providerRegistryMock.getProvider.mockReturnValue(undefined);
    agentRegistryMock.getAgent.mockReturnValue(undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('installs once per selected model and persists models + model on a new-profile setup', async () => {
    providerRegistryMock.getProvider.mockReturnValue({ supportsModelInstallation: true });
    const setupSteps = {
      getCredentials: vi.fn().mockResolvedValue({}),
      fetchModels: vi.fn().mockResolvedValue(['a', 'b', 'c']),
      buildConfig: vi.fn((_credentials: unknown, model: string) => ({ provider: 'test', model })),
      installModel: vi.fn().mockResolvedValue(undefined)
    };

    promptMock
      .mockResolvedValueOnce({ selectedModels: ['a', 'b'] })
      .mockResolvedValueOnce({ activeModel: 'a' });

    await handlePluginSetup('test-provider', setupSteps, 'test-profile', true, 'global');

    expect(setupSteps.installModel).toHaveBeenCalledTimes(2);
    expect(setupSteps.installModel).toHaveBeenNthCalledWith(1, {}, 'a', ['a', 'b', 'c']);
    expect(setupSteps.installModel).toHaveBeenNthCalledWith(2, {}, 'b', ['a', 'b', 'c']);

    expect(configMock.saveProfile).toHaveBeenCalledTimes(1);
    const [, savedConfig] = configMock.saveProfile.mock.calls[0];
    expect(savedConfig.model).toBe('a');
    expect(savedConfig.models).toEqual(['a', 'b']);
  });

  it('pre-checks the checkbox choices from the existing profile models on an update', async () => {
    configMock.getProfile.mockResolvedValue({ model: 'x', models: ['x', 'y'] });
    const setupSteps = {
      getCredentials: vi.fn().mockResolvedValue({}),
      fetchModels: vi.fn().mockResolvedValue(['x', 'y', 'z']),
      buildConfig: vi.fn((_credentials: unknown, model: string) => ({ provider: 'test', model }))
    };

    promptMock
      .mockResolvedValueOnce({ selectedModels: ['x', 'y'] })
      .mockResolvedValueOnce({ activeModel: 'x' });

    await handlePluginSetup('test-provider', setupSteps, 'test-profile', true, 'global');

    const checkboxQuestion = promptMock.mock.calls[0][0][0] as {
      choices: Array<{ value: string; checked?: boolean }>;
    };
    const choiceX = checkboxQuestion.choices.find(c => c.value === 'x');
    const choiceY = checkboxQuestion.choices.find(c => c.value === 'y');
    const choiceZ = checkboxQuestion.choices.find(c => c.value === 'z');
    expect(choiceX?.checked).toBe(true);
    expect(choiceY?.checked).toBe(true);
    expect(choiceZ?.checked).toBeFalsy();

    const [, savedConfig] = configMock.saveProfile.mock.calls[0];
    expect(savedConfig.model).toBe('x');
    expect(savedConfig.models).toEqual(['x', 'y']);
  });

  // CR-010: the active-model follow-up's default must be the profile's actual
  // active model (profile.model), not just the first still-checked stored id.
  it('defaults the active-model follow-up to the profile\'s actual active model even when it is not first in models (CR-010)', async () => {
    configMock.getProfile.mockResolvedValue({ model: 'y', models: ['x', 'y'] });
    const setupSteps = {
      getCredentials: vi.fn().mockResolvedValue({}),
      fetchModels: vi.fn().mockResolvedValue(['x', 'y', 'z']),
      buildConfig: vi.fn((_credentials: unknown, model: string) => ({ provider: 'test', model }))
    };

    promptMock
      .mockResolvedValueOnce({ selectedModels: ['x', 'y'] })
      .mockResolvedValueOnce({ activeModel: 'y' });

    await handlePluginSetup('test-provider', setupSteps, 'test-profile', true, 'global');

    const activeModelQuestion = promptMock.mock.calls[1][0][0] as { default?: string };
    expect(activeModelQuestion.default).toBe('y');
  });

  // CR-007: a failure installing one of several selected models must not abort
  // the whole setup - the profile should still be saved with the models that
  // succeeded, and the failure surfaced via a warning.
  it('isolates a per-model install failure, saving the profile with only the models that succeeded (CR-007)', async () => {
    providerRegistryMock.getProvider.mockReturnValue({ supportsModelInstallation: true });
    const setupSteps = {
      getCredentials: vi.fn().mockResolvedValue({}),
      fetchModels: vi.fn().mockResolvedValue(['a', 'b', 'c']),
      buildConfig: vi.fn((_credentials: unknown, model: string) => ({ provider: 'test', model })),
      installModel: vi.fn()
        .mockResolvedValueOnce(undefined) // a
        .mockRejectedValueOnce(new Error('pull failed')) // b
        .mockResolvedValueOnce(undefined) // c
    };

    promptMock
      .mockResolvedValueOnce({ selectedModels: ['a', 'b', 'c'] })
      .mockResolvedValueOnce({ activeModel: 'a' });

    const { logger } = await import('../../../utils/logger.js');

    await handlePluginSetup('test-provider', setupSteps, 'test-profile', true, 'global');

    expect(setupSteps.installModel).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalled();

    expect(configMock.saveProfile).toHaveBeenCalledTimes(1);
    const [, savedConfig] = configMock.saveProfile.mock.calls[0];
    expect(savedConfig.model).toBe('a');
    expect(savedConfig.models).toEqual(['a', 'c']);
  });
});
