/**
 * Unit tests for handlePluginSetup (src/cli/commands/setup.ts).
 *
 * handlePluginSetup is the plugin-based setup flow driven by ProviderSetupSteps.
 * Model selection runs in the per-agent wizard (EPMCDME-15641, mocked here):
 * this file pins what setup hands the wizard, how its per-agent result is
 * saved (`agentModels`, top-level `model`, Claude tiers), the per-model
 * install loop, and the cancel / auto-selected paths.
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

const agentRegistryMock = vi.hoisted(() => ({
  getAgent: vi.fn(),
  getAllAgents: vi.fn().mockReturnValue([])
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

const wizardMock = vi.hoisted(() => vi.fn());
vi.mock('../setup-wizard/index.js', () => ({ runAgentModelsWizard: wizardMock }));

import { handlePluginSetup, withoutModels } from '../setup.js';
import { displaySetupSuccess } from '../../../providers/integration/setup-ui.js';
import { ConfigurationError } from '../../../utils/errors.js';

function steps(catalog: string[], extra: Record<string, unknown> = {}) {
  return {
    getCredentials: vi.fn().mockResolvedValue({}),
    fetchModels: vi.fn().mockResolvedValue(catalog),
    buildConfig: vi.fn((_credentials: unknown, model: string) => ({ provider: 'test', model })),
    ...extra
  };
}

function savedConfig(): Record<string, any> {
  expect(configMock.saveProfile).toHaveBeenCalledTimes(1);
  return configMock.saveProfile.mock.calls[0][1];
}

describe('handlePluginSetup (per-agent models, EPMCDME-15641)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    configMock.saveProfile.mockResolvedValue(undefined);
    configMock.getProfile.mockResolvedValue(null);
    providerRegistryMock.getProvider.mockReturnValue(undefined);
    agentRegistryMock.getAgent.mockReturnValue(undefined);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hands the wizard the catalog, provider, router lookup, recommendations and search', async () => {
    const searchModel = vi.fn().mockResolvedValue('found');
    const setupSteps = steps(['a', 'sy-alias'], {
      fetchRouterModels: vi.fn().mockResolvedValue(['sy-alias']),
      getRecommendedModels: vi.fn().mockResolvedValue(['a']),
      searchModel
    });
    wizardMock.mockResolvedValue({ opencode: { models: ['a'], model: 'a' } });

    await handlePluginSetup('test-provider', setupSteps, 'test-profile', true, 'global');

    const input = wizardMock.mock.calls[0][0];
    expect(input.models).toEqual(['a', 'sy-alias']);
    expect(input.provider).toBe('test-provider');
    expect(input.isRouter('sy-alias')).toBe(true);
    expect(input.isRouter('a')).toBe(false);
    expect([...input.recommendedIds]).toEqual(['a']);
    expect(input.existing).toBeUndefined();
    await input.searchModel();
    expect(searchModel).toHaveBeenCalledWith({});
  });

  it('passes the existing profile on an update so the wizard can preselect it', async () => {
    const existing = { provider: 'test', model: 'a', agentModels: { claude: { models: ['a'], model: 'a' } } };
    configMock.getProfile.mockResolvedValue(existing);
    wizardMock.mockResolvedValue({ claude: { models: ['a'], model: 'a' } });

    await handlePluginSetup('test-provider', steps(['a']), 'test-profile', true, 'global');

    expect(wizardMock.mock.calls[0][0].existing).toBe(existing);
  });

  it('carries on without router hints or recommendations when those lookups fail', async () => {
    const setupSteps = steps(['a'], {
      fetchRouterModels: vi.fn().mockRejectedValue(new Error('boom')),
      getRecommendedModels: vi.fn().mockRejectedValue(new Error('boom'))
    });
    wizardMock.mockResolvedValue({ opencode: { models: ['a'], model: 'a' } });

    await handlePluginSetup('test-provider', setupSteps, 'test-profile', true, 'global');

    expect(wizardMock.mock.calls[0][0].isRouter).toBeUndefined();
    expect(wizardMock.mock.calls[0][0].recommendedIds).toBeUndefined();
    expect(savedConfig().agentModels).toEqual({ opencode: { models: ['a'], model: 'a' } });
  });

  it('saves agentModels and mirrors the first agent active model at the top level', async () => {
    const agentModels = {
      claude: { models: ['claude-x', 'claude-y'], model: 'claude-y' },
      codex: { models: ['gpt-5.4'], model: 'gpt-5.4', confirmedModels: ['gpt-5.4'] }
    };
    wizardMock.mockResolvedValue(agentModels);

    await handlePluginSetup('test-provider', steps(['claude-x', 'claude-y', 'gpt-5.4']), 'test-profile', true, 'global');

    const saved = savedConfig();
    expect(saved.agentModels).toEqual(agentModels);
    expect(saved.model).toBe('claude-y');
    expect(saved).not.toHaveProperty('models');
    expect(saved).not.toHaveProperty('harnesses');
    expect(displaySetupSuccess).toHaveBeenCalledWith('test-profile', 'test-provider', 'claude-y', [
      { agent: 'claude', model: 'claude-y', otherModels: ['claude-x'] },
      { agent: 'codex', model: 'gpt-5.4', otherModels: [] },
    ]);
  });

  it('saves nothing when the wizard is cancelled', async () => {
    wizardMock.mockResolvedValue(null);

    await handlePluginSetup('test-provider', steps(['a']), 'test-profile', true, 'global');

    expect(configMock.saveProfile).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.flat().join(' ')).toContain('nothing was saved');
  });

  it('skips the wizard and saves no agentModels when the provider auto-selects the model', async () => {
    const setupSteps = steps(['a'], { selectModel: vi.fn().mockResolvedValue('a') });

    await handlePluginSetup('test-provider', setupSteps, 'test-profile', true, 'global');

    expect(wizardMock).not.toHaveBeenCalled();
    expect(savedConfig().model).toBe('a');
    expect(savedConfig().agentModels).toBeUndefined();
    expect(displaySetupSuccess).toHaveBeenCalledWith('test-profile', 'test-provider', 'a', undefined);
  });

  it('derives Claude tiers from Claude own active model, not the first agent model', async () => {
    agentRegistryMock.getAgent.mockImplementation((name: string) =>
      name === 'claude' ? { metadata: { supportedProviders: ['test-provider'] } } : undefined
    );
    wizardMock.mockResolvedValue({
      codex: { models: ['gpt-5.4'], model: 'gpt-5.4' },
      claude: { models: ['claude-sonnet-4-5'], model: 'claude-sonnet-4-5' }
    });

    await handlePluginSetup(
      'test-provider',
      steps(['claude-sonnet-4-5', 'claude-sonnet-4-6', 'gpt-5.4']),
      'test-profile',
      true,
      'global'
    );

    expect(savedConfig().model).toBe('gpt-5.4');
    expect(savedConfig().sonnetModel).toBe('claude-sonnet-4-5');
  });

  it('installs each model once across agents', async () => {
    providerRegistryMock.getProvider.mockReturnValue({ supportsModelInstallation: true });
    const installModel = vi.fn().mockResolvedValue(undefined);
    wizardMock.mockResolvedValue({
      claude: { models: ['a', 'b'], model: 'a' },
      opencode: { models: ['b', 'c'], model: 'c' }
    });

    await handlePluginSetup('test-provider', steps(['a', 'b', 'c'], { installModel }), 'test-profile', true, 'global');

    expect(installModel.mock.calls.map(call => call[1])).toEqual(['a', 'b', 'c']);
  });

  it('isolates a per-model install failure, dropping it from every agent (CR-007)', async () => {
    providerRegistryMock.getProvider.mockReturnValue({ supportsModelInstallation: true });
    const installModel = vi.fn((_c: unknown, id: string) =>
      id === 'b' ? Promise.reject(new Error('pull failed')) : Promise.resolve()
    );
    wizardMock.mockResolvedValue({
      claude: { models: ['a', 'b'], model: 'b' },
      opencode: { models: ['b', 'c'], model: 'c' }
    });

    await handlePluginSetup('test-provider', steps(['a', 'b', 'c'], { installModel }), 'test-profile', true, 'global');

    const saved = savedConfig();
    expect(saved.agentModels).toEqual({
      claude: { models: ['a'], model: 'a' },
      opencode: { models: ['c'], model: 'c' }
    });
    expect(saved.model).toBe('a');
  });

  it('throws a ConfigurationError naming the agent a failed install leaves without a model', async () => {
    providerRegistryMock.getProvider.mockReturnValue({ supportsModelInstallation: true });
    const installModel = vi.fn((_c: unknown, id: string) =>
      id === 'b' ? Promise.reject(new Error('pull failed')) : Promise.resolve()
    );
    wizardMock.mockResolvedValue({
      claude: { models: ['a'], model: 'a' },
      codex: { models: ['b'], model: 'b' }
    });

    await expect(
      handlePluginSetup('test-provider', steps(['a', 'b'], { installModel }), 'test-profile', true, 'global')
    ).rejects.toThrow(/"codex"/);
    expect(configMock.saveProfile).not.toHaveBeenCalled();
  });
});

describe('withoutModels', () => {
  it('keeps confirmed ids only for models that remain', () => {
    expect(withoutModels(
      { codex: { models: ['x', 'y'], model: 'x', confirmedModels: ['x', 'y'] } },
      ['x']
    )).toEqual({ codex: { models: ['y'], model: 'y', confirmedModels: ['y'] } });
  });

  it('throws a ConfigurationError when an agent loses every model', () => {
    expect(() => withoutModels({ codex: { models: ['x'], model: 'x' } }, ['x'])).toThrow(ConfigurationError);
  });
});
