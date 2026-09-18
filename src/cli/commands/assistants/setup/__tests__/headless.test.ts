/**
 * Unit tests for the headless (non-interactive) branch of `codemie setup assistants`.
 *
 * Verifies: flag validation fails fast naming the missing flag, an unresolvable
 * identifier aborts before any write happens, every interactive prompt (and
 * agent auto-detection) stays unreachable, and both wiring sites
 * (`createAssistantsSetupCommand()` / `createAssistantsSetupCommand('claude')`)
 * expose the same flag surface.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AssistantBase } from 'codemie-sdk';
import { ConfigurationError, RegistrationItemNotFoundError } from '@/utils/errors.js';
import { StorageScope } from '@/env/types.js';
import type { SetupCommandOptions } from '../index.js';

vi.mock('@/utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('@/utils/config.js', () => ({
  ConfigLoader: {
    getActiveProfileName: vi.fn(),
    load: vi.fn(),
    saveAssistantsToProjectConfig: vi.fn(),
    getConfigLocationLabel: vi.fn(),
  },
  loadRegisteredAssistants: vi.fn(),
}));

vi.mock('@/utils/auth.js', () => ({
  getAuthenticatedClient: vi.fn(),
}));

vi.mock('@/cli/commands/assistants/setup/data.js', () => ({
  createDataFetcher: vi.fn(),
}));

vi.mock('@/cli/commands/assistants/setup/selection/index.js', () => ({
  promptAssistantSelection: vi.fn(),
}));

vi.mock('@/cli/commands/assistants/setup/configuration/index.js', () => ({
  promptModeSelection: vi.fn(),
  CONFIGURATION_CHOICE: { SUBAGENTS: 'subagents', SKILLS: 'skills', MANUAL: 'manual' },
}));

vi.mock('@/cli/commands/assistants/setup/manualConfiguration/index.js', () => ({
  promptManualConfiguration: vi.fn(),
}));

vi.mock('@/cli/commands/shared/prompts/storage-scope.js', () => ({
  promptStorageScope: vi.fn(),
}));

vi.mock('@/cli/commands/assistants/setup/helpers.js', async () => {
  const actual = await vi.importActual<typeof import('../helpers.js')>('../helpers.js');
  return {
    ...actual,
    registerAssistant: vi.fn(),
    unregisterAssistant: vi.fn(),
  };
});

vi.mock('@/cli/commands/shared/agent-targets.js', async () => {
  const actual = await vi.importActual<typeof import('@/cli/commands/shared/agent-targets.js')>(
    '@/cli/commands/shared/agent-targets.js'
  );
  return {
    ...actual,
    resolveAgentSetupTargets: vi.fn(),
  };
});

vi.mock('@/cli/commands/assistants/setup/summary/index.js', () => ({
  displaySummary: vi.fn(),
}));

import { ConfigLoader, loadRegisteredAssistants } from '@/utils/config.js';
import { getAuthenticatedClient } from '@/utils/auth.js';
import { createDataFetcher } from '@/cli/commands/assistants/setup/data.js';
import { promptAssistantSelection } from '@/cli/commands/assistants/setup/selection/index.js';
import { promptModeSelection } from '@/cli/commands/assistants/setup/configuration/index.js';
import { promptManualConfiguration } from '@/cli/commands/assistants/setup/manualConfiguration/index.js';
import { promptStorageScope } from '@/cli/commands/shared/prompts/storage-scope.js';
import { resolveAgentSetupTargets } from '@/cli/commands/shared/agent-targets.js';
import { registerAssistant, unregisterAssistant } from '@/cli/commands/assistants/setup/helpers.js';
import { displaySummary } from '@/cli/commands/assistants/setup/summary/index.js';

function makeAssistant(id: string, name: string, slug: string): AssistantBase {
  return { id, name, description: `${name} description`, slug, project: 'proj' } as AssistantBase;
}

describe('setupAssistantsHeadless', () => {
  const catalog = [
    makeAssistant('id-1', 'Assistant One', 'assistant-one'),
    makeAssistant('id-2', 'Assistant Two', 'assistant-two'),
  ];

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(ConfigLoader.getActiveProfileName).mockResolvedValue('default');
    vi.mocked(ConfigLoader.load).mockResolvedValue({ codemieAssistants: [] } as any);
    vi.mocked(ConfigLoader.saveAssistantsToProjectConfig).mockResolvedValue(undefined);
    vi.mocked(ConfigLoader.getConfigLocationLabel).mockReturnValue('Global (~/.codemie/)');
    vi.mocked(loadRegisteredAssistants).mockResolvedValue([]);
    vi.mocked(getAuthenticatedClient).mockResolvedValue({} as any);
    vi.mocked(createDataFetcher).mockReturnValue({
      fetchAssistants: vi.fn(),
      fetchAssistantsByIds: vi.fn(),
      fetchAllVisibleAssistants: vi.fn().mockResolvedValue(catalog),
    });
    vi.mocked(registerAssistant).mockImplementation(async (assistant: any, mode: any) => ({
      id: assistant.id,
      name: assistant.name,
      slug: assistant.slug,
      description: assistant.description,
      project: assistant.project,
      registeredAt: '2026-01-01T00:00:00.000Z',
      registrationMode: mode,
      agentTargets: ['claude'],
    }));
    vi.mocked(unregisterAssistant).mockResolvedValue(undefined);
  });

  const fullOptions: SetupCommandOptions = {
    assistant: 'id-1,id-2',
    scope: 'global',
    agent: 'claude',
    mode: 'agent',
    yes: true,
  };

  it('registers every requested assistant and never touches an interactive prompt', async () => {
    const { setupAssistantsHeadless } = await import('../index.js');

    await setupAssistantsHeadless(fullOptions);

    expect(registerAssistant).toHaveBeenCalledTimes(2);
    expect(ConfigLoader.saveAssistantsToProjectConfig).toHaveBeenCalledWith(
      expect.any(String),
      StorageScope.GLOBAL,
      expect.arrayContaining([
        expect.objectContaining({ id: 'id-1' }),
        expect.objectContaining({ id: 'id-2' }),
      ])
    );

    expect(promptAssistantSelection).not.toHaveBeenCalled();
    expect(promptModeSelection).not.toHaveBeenCalled();
    expect(promptManualConfiguration).not.toHaveBeenCalled();
    expect(promptStorageScope).not.toHaveBeenCalled();
    expect(resolveAgentSetupTargets).not.toHaveBeenCalled();
  });

  async function expectConfigurationError(
    options: SetupCommandOptions,
    flagSubstring: string
  ): Promise<void> {
    const { setupAssistantsHeadless } = await import('../index.js');

    const error: unknown = await setupAssistantsHeadless(options).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as Error).message).toContain(flagSubstring);
    expect(getAuthenticatedClient).not.toHaveBeenCalled();
  }

  it('rejects with a ConfigurationError naming --scope when scope is missing', async () => {
    const { scope: _scope, ...options } = fullOptions;
    await expectConfigurationError(options, '--scope');
  });

  it('rejects with a ConfigurationError naming --agent when agent is missing', async () => {
    const { agent: _agent, ...options } = fullOptions;
    await expectConfigurationError(options, '--agent');
  });

  it('rejects with a ConfigurationError naming --mode when mode is missing', async () => {
    const { mode: _mode, ...options } = fullOptions;
    await expectConfigurationError(options, '--mode');
  });

  it('rejects with a ConfigurationError naming --mode when mode is invalid', async () => {
    await expectConfigurationError({ ...fullOptions, mode: 'bogus' }, '--mode');
  });

  it('aborts with RegistrationItemNotFoundError before any write when an identifier is unresolvable, and never saves', async () => {
    const { setupAssistantsHeadless } = await import('../index.js');

    await expect(
      setupAssistantsHeadless({ ...fullOptions, assistant: 'id-1,does-not-exist' })
    ).rejects.toBeInstanceOf(RegistrationItemNotFoundError);

    expect(getAuthenticatedClient).toHaveBeenCalled();
    const fetcher = vi.mocked(createDataFetcher).mock.results[0]!.value;
    expect(fetcher.fetchAllVisibleAssistants).toHaveBeenCalled();

    expect(registerAssistant).not.toHaveBeenCalled();
    expect(unregisterAssistant).not.toHaveBeenCalled();
    expect(ConfigLoader.saveAssistantsToProjectConfig).not.toHaveBeenCalled();
    expect(displaySummary).not.toHaveBeenCalled();
  });

  it('exposes an identical option-name set for both wiring sites', async () => {
    const { createAssistantsSetupCommand } = await import('../index.js');

    const defaultOptionNames = createAssistantsSetupCommand().options.map(opt => opt.long).sort();
    const claudeOptionNames = createAssistantsSetupCommand('claude').options.map(opt => opt.long).sort();

    expect(claudeOptionNames).toEqual(defaultOptionNames);
    expect(defaultOptionNames).toEqual(
      expect.arrayContaining(['--assistant', '--scope', '--mode', '--yes', '--agent'])
    );
  });
});
