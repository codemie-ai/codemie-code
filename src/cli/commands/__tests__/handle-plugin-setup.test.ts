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

// Fake agents: claude/codex classify by name (via the real shared rule), opencode is unrestricted.
const fakeAgents = vi.hoisted(() => {
  const mk = (name: string, family?: RegExp, supportedProviders: string[] = []) => ({
    name,
    metadata: {
      name,
      displayName: `Display ${name}`,
      supportedProviders,
      ...(family ? { classifyModel: { family } } : {})
    }
  });
  return [mk('claude', /claude/i), mk('codex', /gpt/i), mk('opencode')];
});
const agentRegistryMock = vi.hoisted(() => ({
  getAgent: vi.fn(),
  getAllAgents: vi.fn()
}));
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

import { classifyWithPredicate } from '../../../agents/core/model-classify.js';
import { handlePluginSetup } from '../setup.js';
import { ConfigurationError } from '../../../utils/errors.js';

function installFakeAgents(supportedProviders: Record<string, string[]> = {}): void {
  const agents = fakeAgents.map(a => {
    const family = (a.metadata as { classifyModel?: { family: RegExp } }).classifyModel?.family;
    return {
      ...a,
      metadata: {
        ...a.metadata,
        supportedProviders: supportedProviders[a.name] ?? a.metadata.supportedProviders,
        classifyModel: family
          ? (id: string, ctx?: { isRouter?: boolean }) => classifyWithPredicate(i => family.test(i), id, ctx)
          : undefined
      }
    };
  });
  agentRegistryMock.getAgent.mockImplementation((n: string) => agents.find(a => a.name === n));
  agentRegistryMock.getAllAgents.mockReturnValue(agents);
}

describe('handlePluginSetup (multi-model wiring)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configMock.saveProfile.mockResolvedValue(undefined);
    configMock.getProfile.mockResolvedValue(null);
    providerRegistryMock.getProvider.mockReturnValue(undefined);
    installFakeAgents();
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
      .mockResolvedValueOnce({ harnesses: ['opencode'] })
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
      .mockResolvedValueOnce({ harnesses: ['opencode'] })
      .mockResolvedValueOnce({ selectedModels: ['x', 'y'] })
      .mockResolvedValueOnce({ activeModel: 'x' });

    await handlePluginSetup('test-provider', setupSteps, 'test-profile', true, 'global');

    const checkboxQuestion = promptMock.mock.calls[1][0][0] as {
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
      .mockResolvedValueOnce({ harnesses: ['opencode'] })
      .mockResolvedValueOnce({ selectedModels: ['x', 'y'] })
      .mockResolvedValueOnce({ activeModel: 'y' });

    await handlePluginSetup('test-provider', setupSteps, 'test-profile', true, 'global');

    const activeModelQuestion = promptMock.mock.calls[2][0][0] as { default?: string };
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
      .mockResolvedValueOnce({ harnesses: ['opencode'] })
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

describe('handlePluginSetup (harness-compatible models, EPMCDME-15641)', () => {
  const baseSteps = (models: string[]) => ({
    getCredentials: vi.fn().mockResolvedValue({}),
    fetchModels: vi.fn().mockResolvedValue(models),
    buildConfig: vi.fn((_credentials: unknown, model: string) => ({ provider: 'test', model }))
  });
  type Q = { name: string; message?: string; choices?: Array<{ name: string; value: string }> };
  const questionOf = (call: number): Q => promptMock.mock.calls[call][0][0] as Q;

  beforeEach(() => {
    vi.clearAllMocks();
    configMock.saveProfile.mockResolvedValue(undefined);
    configMock.getProfile.mockResolvedValue(null);
    providerRegistryMock.getProvider.mockReturnValue(undefined);
    installFakeAgents();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('offers the registry agents as a required harness checkbox before the model step', async () => {
    promptMock
      .mockResolvedValueOnce({ harnesses: ['opencode'] })
      .mockResolvedValueOnce({ selectedModels: ['a'] });

    await handlePluginSetup('test-provider', baseSteps(['a', 'b']), 'p', true, 'global');

    const q = questionOf(0) as Q & { type?: string; validate?: (v: string[]) => unknown };
    expect(q.name).toBe('harnesses');
    expect(q.type).toBe('checkbox');
    expect(q.choices?.map(c => c.value)).toEqual(['claude', 'codex', 'opencode']);
    expect(q.validate?.([])).not.toBe(true);
    expect(q.validate?.(['claude'])).toBe(true);
  });

  it('hides models incompatible with every selected harness and labels the rest', async () => {
    promptMock
      .mockResolvedValueOnce({ harnesses: ['codex'] })
      .mockResolvedValueOnce({ selectedModels: ['gpt-5.4'] });

    await handlePluginSetup('test-provider', baseSteps(['claude-sonnet-4', 'gpt-5.4']), 'p', true, 'global');

    const choices = questionOf(1).choices ?? [];
    expect(choices.map(c => c.value)).toEqual(['gpt-5.4', 'custom']);
    expect(choices[0].name).toContain('codex');

    const [, saved] = configMock.saveProfile.mock.calls[0];
    expect(saved.harnesses).toEqual(['codex']);
    expect(saved.model).toBe('gpt-5.4');
  });

  it('keeps every model and skips the gate when only unrestricted harnesses are selected', async () => {
    promptMock
      .mockResolvedValueOnce({ harnesses: ['opencode'] })
      .mockResolvedValueOnce({ selectedModels: ['claude-sonnet-4'] });

    await handlePluginSetup('test-provider', baseSteps(['claude-sonnet-4', 'gpt-5.4']), 'p', true, 'global');

    expect((questionOf(1).choices ?? []).map(c => c.value)).toEqual(['claude-sonnet-4', 'gpt-5.4', 'custom']);
    const [, saved] = configMock.saveProfile.mock.calls[0];
    expect(saved.harnesses).toEqual(['opencode']);
    expect(saved.confirmedModels).toBeUndefined();
  });

  it('persists harnesses even for a single-model profile', async () => {
    promptMock
      .mockResolvedValueOnce({ harnesses: ['claude'] })
      .mockResolvedValueOnce({ selectedModels: ['claude-sonnet-4'] });

    await handlePluginSetup('test-provider', baseSteps(['claude-sonnet-4']), 'p', true, 'global');

    const [, saved] = configMock.saveProfile.mock.calls[0];
    expect(saved.models).toBeUndefined();
    expect(saved.harnesses).toEqual(['claude']);
  });

  it('skips the harness step and saves no harnesses when the provider auto-selects the model', async () => {
    const steps = { ...baseSteps(['claude-sonnet-4']), selectModel: vi.fn().mockResolvedValue('claude-sonnet-4') };

    await handlePluginSetup('test-provider', steps, 'p', true, 'global');

    expect(promptMock).not.toHaveBeenCalled();
    const [, saved] = configMock.saveProfile.mock.calls[0];
    expect(saved.harnesses).toBeUndefined();
  });

  it('pre-selects the existing profile harnesses on an update', async () => {
    configMock.getProfile.mockResolvedValue({ model: 'gpt-5.4', harnesses: ['codex'] });
    promptMock
      .mockResolvedValueOnce({ harnesses: ['codex'] })
      .mockResolvedValueOnce({ selectedModels: ['gpt-5.4'] });

    await handlePluginSetup('test-provider', baseSteps(['gpt-5.4']), 'p', true, 'global');

    const checked = (questionOf(0).choices as Array<{ value: string; checked?: boolean }>)
      .filter(c => c.checked).map(c => c.value);
    expect(checked).toEqual(['codex']);
  });

  it('warns on a custom model incompatible with every harness, and stores a confirmed id in confirmedModels', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    promptMock
      .mockResolvedValueOnce({ harnesses: ['codex'] })
      .mockResolvedValueOnce({ selectedModels: ['gpt-5.4', 'custom'] })
      .mockResolvedValueOnce({ customModel: 'claude-x' })
      .mockResolvedValueOnce({ confirmIncompatible: true })
      .mockResolvedValueOnce({ selectedModels: ['gpt-5.4', 'claude-x'] })
      .mockResolvedValueOnce({ activeModel: 'gpt-5.4' });

    await handlePluginSetup('test-provider', baseSteps(['gpt-5.4']), 'p', true, 'global');

    expect(logSpy.mock.calls.flat().join('\n')).toMatch(/claude-x[\s\S]*codex/);
    const [, saved] = configMock.saveProfile.mock.calls[0];
    expect(saved.models).toEqual(['gpt-5.4', 'claude-x']);
    expect(saved.confirmedModels).toEqual(['claude-x']);
  });

  it('drops a custom model the user does not confirm', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    promptMock
      .mockResolvedValueOnce({ harnesses: ['codex'] })
      .mockResolvedValueOnce({ selectedModels: ['gpt-5.4', 'custom'] })
      .mockResolvedValueOnce({ customModel: 'claude-x' })
      .mockResolvedValueOnce({ confirmIncompatible: false })
      .mockResolvedValueOnce({ selectedModels: ['gpt-5.4'] });

    await handlePluginSetup('test-provider', baseSteps(['gpt-5.4']), 'p', true, 'global');

    const [, saved] = configMock.saveProfile.mock.calls[0];
    expect(saved.models).toBeUndefined();
    expect(saved.confirmedModels).toBeUndefined();
  });

  it('refuses an update that removes the only model for a harness, naming that harness', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    configMock.getProfile.mockResolvedValue({
      model: 'gpt-5.4', models: ['gpt-5.4', 'claude-sonnet-4'], harnesses: ['codex', 'claude']
    });
    promptMock
      .mockResolvedValueOnce({ harnesses: ['codex', 'claude'] })
      .mockResolvedValueOnce({ selectedModels: ['claude-sonnet-4'] })
      .mockResolvedValueOnce({ selectedModels: ['gpt-5.4', 'claude-sonnet-4'] })
      .mockResolvedValueOnce({ activeModel: 'claude-sonnet-4' });

    await handlePluginSetup('test-provider', baseSteps(['gpt-5.4', 'claude-sonnet-4']), 'p', true, 'global');

    expect(logSpy.mock.calls.flat().join('\n')).toContain('codex');
    expect(configMock.saveProfile).toHaveBeenCalledTimes(1);
    const [, saved] = configMock.saveProfile.mock.calls[0];
    expect(saved.models).toEqual(['gpt-5.4', 'claude-sonnet-4']);
  });

  it('refuses to save when a harness has no compatible model at all, and lets the user change harnesses', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    promptMock
      .mockResolvedValueOnce({ harnesses: ['codex'] })
      .mockResolvedValueOnce({ action: 'cancel' });

    await handlePluginSetup('test-provider', baseSteps(['claude-sonnet-4']), 'p', true, 'global');

    expect(logSpy.mock.calls.flat().join('\n')).toContain('codex');
    expect(configMock.saveProfile).not.toHaveBeenCalled();
  });

  it('loops back to the harness step when the user chooses to change harnesses', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    promptMock
      .mockResolvedValueOnce({ harnesses: ['codex'] })
      .mockResolvedValueOnce({ action: 'change' })
      .mockResolvedValueOnce({ harnesses: ['claude'] })
      .mockResolvedValueOnce({ selectedModels: ['claude-sonnet-4'] });

    await handlePluginSetup('test-provider', baseSteps(['claude-sonnet-4']), 'p', true, 'global');

    const [, saved] = configMock.saveProfile.mock.calls[0];
    expect(saved.harnesses).toEqual(['claude']);
  });

  it('treats a provider outside a harness supportedProviders as having no compatible model', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    installFakeAgents({ codex: ['litellm'] });
    promptMock
      .mockResolvedValueOnce({ harnesses: ['codex'] })
      .mockResolvedValueOnce({ action: 'cancel' });

    await handlePluginSetup('other-provider', baseSteps(['gpt-5.4']), 'p', true, 'global');

    expect(configMock.saveProfile).not.toHaveBeenCalled();
  });

  it('throws a ConfigurationError when failed installs leave a harness without a model', async () => {
    providerRegistryMock.getProvider.mockReturnValue({ supportsModelInstallation: true });
    const steps = {
      ...baseSteps(['gpt-5.4', 'claude-sonnet-4']),
      installModel: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('pull failed'))
    };
    promptMock
      .mockResolvedValueOnce({ harnesses: ['codex', 'claude'] })
      .mockResolvedValueOnce({ selectedModels: ['gpt-5.4', 'claude-sonnet-4'] })
      .mockResolvedValueOnce({ activeModel: 'gpt-5.4' });

    await expect(handlePluginSetup('test-provider', steps, 'p', true, 'global'))
      .rejects.toBeInstanceOf(ConfigurationError);
    expect(configMock.saveProfile).not.toHaveBeenCalled();
  });

  it('explains the dead end instead of looping when a catalog-less provider is unsupported by a harness', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    installFakeAgents({ codex: ['litellm'] });
    promptMock
      .mockResolvedValueOnce({ harnesses: ['codex'] })
      .mockResolvedValueOnce({ action: 'cancel' });

    await handlePluginSetup('other-provider', baseSteps([]), 'p', true, 'global');

    expect(promptMock).toHaveBeenCalledTimes(2);
    expect(configMock.saveProfile).not.toHaveBeenCalled();
  });

  it('flags a classifier-less harness whose supportedProviders exclude the provider as a dead end', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    installFakeAgents({ opencode: ['litellm'] });
    promptMock
      .mockResolvedValueOnce({ harnesses: ['opencode'] })
      .mockResolvedValueOnce({ action: 'cancel' });

    await handlePluginSetup('other-provider', baseSteps(['gpt-5.4']), 'p', true, 'global');

    expect(promptMock).toHaveBeenCalledTimes(2);
    expect(configMock.saveProfile).not.toHaveBeenCalled();
  });

  it('names every provider-unsupported and every uncovered agent in the dead-end warning', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    installFakeAgents({ codex: ['litellm'], opencode: ['litellm'] });
    promptMock
      .mockResolvedValueOnce({ harnesses: ['claude', 'codex', 'opencode'] })
      .mockResolvedValueOnce({ action: 'cancel' });

    await handlePluginSetup('other-provider', baseSteps(['gpt-5.4']), 'p', true, 'global');

    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('is not supported by "codex", "opencode"');
    expect(output).toContain('offers no model that works with "claude"');
  });

  it('explains why the manual model prompt repeats while an agent is still uncovered', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    promptMock
      .mockResolvedValueOnce({ harnesses: ['claude', 'codex'] })
      .mockResolvedValueOnce({ manualModel: 'claude-sonnet-4' })
      .mockResolvedValueOnce({ manualModel: 'gpt-5.4' })
      .mockResolvedValueOnce({ activeModel: 'gpt-5.4' });

    await handlePluginSetup('test-provider', baseSteps([]), 'p', true, 'global');

    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('No entered model works with "codex"');
    expect(output.match(/No entered model works with/g)).toHaveLength(1);
  });

  it('tells the user which agents have no model rules before the agent step', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    promptMock
      .mockResolvedValueOnce({ harnesses: ['opencode'] })
      .mockResolvedValueOnce({ selectedModels: ['gpt-5.4'] });

    await handlePluginSetup('test-provider', baseSteps(['gpt-5.4', 'claude-sonnet-4']), 'p', true, 'global');

    expect(log.mock.calls.flat().join('\n')).toContain('No model rules for: opencode');
  });

  it('offers a catalog-flagged router alias and persists it so launch reports it unverified', async () => {
    const steps = {
      ...baseSteps(['gpt-5.4', 'sy-signal-terra-luna']),
      fetchRouterModels: vi.fn().mockResolvedValue(['sy-signal-terra-luna'])
    };
    promptMock
      .mockResolvedValueOnce({ harnesses: ['codex'] })
      .mockResolvedValueOnce({ selectedModels: ['gpt-5.4', 'sy-signal-terra-luna'] })
      .mockResolvedValueOnce({ activeModel: 'gpt-5.4' });

    await handlePluginSetup('test-provider', steps, 'p', true, 'global');

    expect((questionOf(1).choices ?? []).map(c => c.value)).toContain('sy-signal-terra-luna');
    const [, saved] = configMock.saveProfile.mock.calls[0];
    expect(saved.models).toEqual(['gpt-5.4', 'sy-signal-terra-luna']);
    expect(saved.confirmedModels).toEqual(['sy-signal-terra-luna']);
  });

  it('carries on without router hints when the router lookup fails', async () => {
    const steps = {
      ...baseSteps(['gpt-5.4']),
      fetchRouterModels: vi.fn().mockRejectedValue(new Error('boom'))
    };
    promptMock
      .mockResolvedValueOnce({ harnesses: ['codex'] })
      .mockResolvedValueOnce({ selectedModels: ['gpt-5.4'] });

    await handlePluginSetup('test-provider', steps, 'p', true, 'global');

    expect(configMock.saveProfile).toHaveBeenCalledTimes(1);
  });
});

