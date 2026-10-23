/**
 * Unit tests for runModelsSwitch (src/cli/commands/models.ts).
 *
 * `codemie models switch` only ever touches the active profile's own model
 * list (never the full provider catalog): an unknown arg fails loudly, a
 * single-model profile is a no-op, and a valid switch writes through
 * ConfigLoader.switchActiveProfileModel. On a per-agent profile it switches
 * one agent's active model, picked by --agent, by the model id, or by prompt.
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
const promptAgentSwitchSelectionMock = vi.hoisted(() => vi.fn());
vi.mock('../models-switch-prompt.js', () => ({
  promptModelSwitchSelection: promptModelSwitchSelectionMock,
  promptAgentSwitchSelection: promptAgentSwitchSelectionMock
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

  const oneAgent = { provider: 'openai', model: 'a', agentModels: { claude: { models: ['a', 'b'], model: 'a' } } };
  const twoAgents = {
    provider: 'litellm',
    model: 'a',
    agentModels: {
      claude: { models: ['a', 'b'], model: 'a' },
      codex: { models: ['b', 'c'], model: 'c' },
    },
  };

  it('writes without prompting when the arg matches the only agent model', async () => {
    configMock.getActiveProfileName.mockResolvedValue('default');
    configMock.getProfile.mockResolvedValue(oneAgent);

    await runModelsSwitch('b', '/work');

    expect(promptModelSwitchSelectionMock).not.toHaveBeenCalled();
    expect(promptAgentSwitchSelectionMock).not.toHaveBeenCalled();
    expect(configMock.switchActiveProfileModel).toHaveBeenCalledWith('b', '/work', undefined, 'claude');
    expect(exitSpy).not.toHaveBeenCalled();
    expect(allLogs(logSpy)).toContain('Switched');
  });

  it('fails loudly and writes nothing when no agent has the arg', async () => {
    configMock.getActiveProfileName.mockResolvedValue('default');
    configMock.getProfile.mockResolvedValue(oneAgent);

    await runModelsSwitch('does-not-exist', '/work');

    expect(configMock.switchActiveProfileModel).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(allLogs(errorSpy)).toContain('codemie setup');
  });

  it('prompts for the only agent model and writes its answer when no arg is given', async () => {
    configMock.getActiveProfileName.mockResolvedValue('default');
    configMock.getProfile.mockResolvedValue(oneAgent);
    promptModelSwitchSelectionMock.mockResolvedValue('b');

    await runModelsSwitch(undefined, '/work');

    expect(promptModelSwitchSelectionMock).toHaveBeenCalledWith(
      ['a', 'b'],
      'a',
      { a: ['claude'], b: ['claude'] },
      expect.stringContaining('active model')
    );
    expect(configMock.switchActiveProfileModel).toHaveBeenCalledWith('b', '/work', undefined, 'claude');
  });

  it('asks for the agent first when several agents are configured, then lists only its models', async () => {
    configMock.getActiveProfileName.mockResolvedValue('default');
    configMock.getProfile.mockResolvedValue(twoAgents);
    promptAgentSwitchSelectionMock.mockResolvedValue('codex');
    promptModelSwitchSelectionMock.mockResolvedValue('b');

    await runModelsSwitch(undefined, '/work');

    expect(promptAgentSwitchSelectionMock).toHaveBeenCalledWith([
      { name: 'claude', displayName: 'claude', model: 'a' },
      { name: 'codex', displayName: 'codex', model: 'c' },
    ]);
    expect(promptModelSwitchSelectionMock).toHaveBeenCalledWith(['b', 'c'], 'c', expect.any(Object), expect.any(String));
    expect(configMock.switchActiveProfileModel).toHaveBeenCalledWith('b', '/work', undefined, 'codex');
  });

  it('offers only the agents that have the model when the arg is shared', async () => {
    configMock.getActiveProfileName.mockResolvedValue('default');
    configMock.getProfile.mockResolvedValue(twoAgents);
    promptAgentSwitchSelectionMock.mockResolvedValue('claude');

    await runModelsSwitch('b', '/work');

    expect(promptAgentSwitchSelectionMock).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'claude' }),
      expect.objectContaining({ name: 'codex' }),
    ]);
    expect(configMock.switchActiveProfileModel).toHaveBeenCalledWith('b', '/work', undefined, 'claude');
  });

  it('skips the agent prompt with --agent and does not refresh Claude tiers for another agent', async () => {
    configMock.getActiveProfileName.mockResolvedValue('default');
    configMock.getProfile.mockResolvedValue(twoAgents);
    agentRegistryMock.getAgent.mockReturnValue({ metadata: { supportedProviders: ['litellm'] } });
    const fetchModels = vi.fn().mockResolvedValue([]);
    vi.spyOn(ProviderRegistry, 'getModelProxy').mockReturnValue({ fetchModels } as never);

    await runModelsSwitch('b', '/work', 'codex-acp');

    expect(promptAgentSwitchSelectionMock).not.toHaveBeenCalled();
    expect(fetchModels).not.toHaveBeenCalled();
    expect(configMock.switchActiveProfileModel).toHaveBeenCalledWith('b', '/work', undefined, 'codex');
  });

  it('fails loudly for an --agent the profile does not configure, naming the configured ones', async () => {
    configMock.getActiveProfileName.mockResolvedValue('default');
    configMock.getProfile.mockResolvedValue(twoAgents);

    await runModelsSwitch(undefined, '/work', 'pi');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(allLogs(errorSpy)).toContain('claude, codex');
    expect(configMock.switchActiveProfileModel).not.toHaveBeenCalled();
  });

  it('fails loudly for a model outside the --agent list', async () => {
    configMock.getActiveProfileName.mockResolvedValue('default');
    configMock.getProfile.mockResolvedValue(twoAgents);

    await runModelsSwitch('a', '/work', 'codex');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(allLogs(errorSpy)).toContain('b, c');
    expect(configMock.switchActiveProfileModel).not.toHaveBeenCalled();
  });

  it('rejects --agent on a legacy profile', async () => {
    configMock.getActiveProfileName.mockResolvedValue('default');
    configMock.getProfile.mockResolvedValue({ provider: 'openai', model: 'a' });

    await runModelsSwitch(undefined, '/work', 'claude');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(configMock.switchActiveProfileModel).not.toHaveBeenCalled();
  });

  it('prints the single-model message for an agent with one model', async () => {
    configMock.getActiveProfileName.mockResolvedValue('default');
    configMock.getProfile.mockResolvedValue({
      provider: 'openai',
      model: 'a',
      agentModels: { claude: { models: ['a'], model: 'a' } },
    });

    await runModelsSwitch(undefined, '/work');

    expect(configMock.switchActiveProfileModel).not.toHaveBeenCalled();
    expect(allLogs(logSpy)).toContain('single model');
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
    configMock.getProfile.mockResolvedValue({ ...oneAgent, provider: 'litellm' });
    agentRegistryMock.getAgent.mockReturnValue({ metadata: { supportedProviders: ['litellm'] } });
    const fetchModels = vi.fn().mockRejectedValue(new Error('network down'));
    vi.spyOn(ProviderRegistry, 'getModelProxy').mockReturnValue({ fetchModels } as never);

    await runModelsSwitch('b', '/work');

    expect(fetchModels).toHaveBeenCalledTimes(1);
    expect(loggerMock.warn).toHaveBeenCalled();
    expect(configMock.switchActiveProfileModel).toHaveBeenCalledWith('b', '/work', undefined, 'claude');
    expect(exitSpy).not.toHaveBeenCalled();
    expect(allLogs(logSpy)).toContain('Switched');
  });
});
