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
import {
  ConfigurationError,
  PartialRegistrationError,
  RegistrationItemNotFoundError,
} from '@/utils/errors.js';
import { StorageScope } from '@/env/types.js';
import { ACTIONS } from '@/cli/commands/assistants/constants.js';
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
    loadAssistantsByScope: vi.fn(),
    saveAssistantsToProjectConfig: vi.fn(),
    getConfigLocationLabel: vi.fn(),
  },
  loadRegisteredAssistants: vi.fn(),
}));

vi.mock('@/cli/commands/shared/helpers.js', async () => {
  const actual = await vi.importActual<typeof import('@/cli/commands/shared/helpers.js')>(
    '@/cli/commands/shared/helpers.js'
  );
  return {
    ...actual,
    // Rethrow instead of process.exit(1) so the command action is testable.
    handleSetupError: vi.fn((error: unknown) => {
      throw error;
    }),
  };
});

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
    makeAssistant('id-3', 'Assistant Three', 'assistant-three'),
  ];

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(ConfigLoader.getActiveProfileName).mockResolvedValue('default');
    vi.mocked(ConfigLoader.load).mockResolvedValue({ codemieAssistants: [] } as any);
    vi.mocked(ConfigLoader.loadAssistantsByScope).mockResolvedValue([]);
    vi.mocked(ConfigLoader.saveAssistantsToProjectConfig).mockResolvedValue(undefined);
    vi.mocked(ConfigLoader.getConfigLocationLabel).mockReturnValue('Global (~/.codemie/)');
    vi.mocked(loadRegisteredAssistants).mockResolvedValue([]);
    vi.mocked(getAuthenticatedClient).mockResolvedValue({} as any);
    vi.mocked(createDataFetcher).mockReturnValue({
      fetchAssistants: vi.fn(),
      fetchAssistantsByIds: vi.fn(),
      fetchAllVisibleAssistants: vi.fn().mockResolvedValue(catalog),
    });
    vi.mocked(registerAssistant).mockImplementation(
      async (assistant: any, mode: any, _scope?: any, _workingDir?: any, target: any = ['claude']) => ({
        id: assistant.id,
        name: assistant.name,
        slug: assistant.slug,
        description: assistant.description,
        project: assistant.project,
        registeredAt: '2026-01-01T00:00:00.000Z',
        registrationMode: mode,
        agentTargets: target,
      })
    );
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

  it('is purely additive: an already-registered assistant not named in --assistant is never unregistered and survives the save', async () => {
    const untouched = {
      id: 'id-9',
      name: 'Assistant Nine',
      slug: 'assistant-nine',
      description: 'Assistant Nine description',
      project: 'proj',
      registeredAt: '2025-01-01T00:00:00.000Z',
      registrationMode: 'skill',
      agentTargets: ['claude'],
    };
    vi.mocked(ConfigLoader.loadAssistantsByScope).mockResolvedValue([untouched] as any);

    const { setupAssistantsHeadless } = await import('../index.js');

    await setupAssistantsHeadless({ ...fullOptions, assistant: 'id-1' });

    expect(unregisterAssistant).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'id-9' }),
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
    expect(ConfigLoader.saveAssistantsToProjectConfig).toHaveBeenCalledWith(
      expect.any(String),
      StorageScope.GLOBAL,
      expect.arrayContaining([expect.objectContaining({ id: 'id-9' })])
    );
  });

  it('reads only the scope it writes, so a globally-registered assistant is never copied into the project config', async () => {
    // Arrange: the cross-scope merged view would hand the global entry to the local
    // save, which overwrites that scope's list wholesale.
    const globalOnly = {
      id: 'global-1',
      name: 'Global Only',
      slug: 'global-only',
      description: 'Registered globally',
      project: 'proj',
      registeredAt: '2025-01-01T00:00:00.000Z',
      registrationMode: 'agent',
      agentTargets: ['claude'],
    };
    vi.mocked(loadRegisteredAssistants).mockResolvedValue([globalOnly] as any);
    vi.mocked(ConfigLoader.loadAssistantsByScope).mockResolvedValue([]);

    const { setupAssistantsHeadless } = await import('../index.js');

    await setupAssistantsHeadless({ ...fullOptions, assistant: 'id-1', scope: 'local' });

    expect(ConfigLoader.loadAssistantsByScope).toHaveBeenCalledWith(StorageScope.LOCAL, expect.any(String));
    expect(loadRegisteredAssistants).not.toHaveBeenCalled();

    const saved = vi.mocked(ConfigLoader.saveAssistantsToProjectConfig).mock.calls[0]![2];
    expect(saved.map(assistant => assistant.id)).toEqual(['id-1']);
  });

  it('accepts the hosting agent in place of --agent and registers for it', async () => {
    const { agent: _agent, ...options } = fullOptions;
    const { setupAssistantsHeadless } = await import('../index.js');

    await setupAssistantsHeadless(options, 'claude');

    expect(registerAssistant).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'id-1' }),
      'agent',
      StorageScope.GLOBAL,
      expect.any(String),
      ['claude']
    );
  });

  it('passes every --agent target through to the writers and persists them', async () => {
    const { setupAssistantsHeadless } = await import('../index.js');

    await setupAssistantsHeadless({ ...fullOptions, assistant: 'id-1', agent: 'codex,gemini' });

    expect(registerAssistant).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'id-1' }),
      'agent',
      StorageScope.GLOBAL,
      expect.any(String),
      ['codex', 'gemini']
    );
    expect(ConfigLoader.saveAssistantsToProjectConfig).toHaveBeenCalledWith(
      expect.any(String),
      StorageScope.GLOBAL,
      [expect.objectContaining({ id: 'id-1', agentTargets: ['codex', 'gemini'] })]
    );
  });

  it('registers in skill mode and persists registrationMode: skill when --mode skill is given', async () => {
    const { setupAssistantsHeadless } = await import('../index.js');

    await setupAssistantsHeadless({ ...fullOptions, assistant: 'id-1', mode: 'skill' });

    expect(registerAssistant).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'id-1' }),
      'skill',
      StorageScope.GLOBAL,
      expect.any(String),
      ['claude']
    );
    expect(ConfigLoader.saveAssistantsToProjectConfig).toHaveBeenCalledWith(
      expect.any(String),
      StorageScope.GLOBAL,
      [expect.objectContaining({ id: 'id-1', registrationMode: 'skill' })]
    );
  });

  it('records the assistants already written when a later write in the batch fails', async () => {
    // Arrange: the second of three writes rejects. The first assistant's files are
    // on disk, so the config must name it — an unrecorded artifact can neither be
    // listed nor unregistered.
    vi.mocked(registerAssistant).mockImplementation(async (assistant: any, mode: any) => {
      if (assistant.id === 'id-2') {
        throw new Error('generator exploded');
      }
      return {
        id: assistant.id,
        name: assistant.name,
        slug: assistant.slug,
        description: assistant.description,
        project: assistant.project,
        registeredAt: '2026-01-01T00:00:00.000Z',
        registrationMode: mode,
        agentTargets: ['claude'],
      } as any;
    });

    const { setupAssistantsHeadless } = await import('../index.js');

    await expect(
      setupAssistantsHeadless({ ...fullOptions, assistant: 'id-1,id-2,id-3' })
    ).rejects.toBeInstanceOf(PartialRegistrationError);

    expect(ConfigLoader.saveAssistantsToProjectConfig).toHaveBeenCalledWith(
      expect.any(String),
      StorageScope.GLOBAL,
      [expect.objectContaining({ id: 'id-1' })]
    );
  });

  it('rejects --project/--all-projects before authenticating, instead of silently ignoring the filter', async () => {
    const { setupAssistantsHeadless } = await import('../index.js');

    await expect(
      setupAssistantsHeadless({ ...fullOptions, project: 'other-project' })
    ).rejects.toBeInstanceOf(ConfigurationError);
    await expect(
      setupAssistantsHeadless({ ...fullOptions, allProjects: true })
    ).rejects.toBeInstanceOf(ConfigurationError);
    expect(getAuthenticatedClient).not.toHaveBeenCalled();
  });

  it('forbids the interactive re-auth prompt by authenticating non-interactively', async () => {
    const { setupAssistantsHeadless } = await import('../index.js');

    await setupAssistantsHeadless(fullOptions);

    expect(getAuthenticatedClient).toHaveBeenCalledWith(expect.anything(), { nonInteractive: true });
  });

  it('still runs the wizard at a TTY when only the pre-existing --agent flag is given', async () => {
    // Regression: --agent shipped as a wizard preselector. Treating it as a headless
    // trigger made `codemie setup assistants --agent claude` fail on a missing
    // --assistant instead of opening the selection UI.
    const originalIsTty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    vi.mocked(promptAssistantSelection).mockResolvedValue({ selectedIds: [], action: ACTIONS.CANCEL } as any);

    try {
      const { createAssistantsSetupCommand } = await import('../index.js');

      await createAssistantsSetupCommand().parseAsync(['--agent', 'claude'], { from: 'user' });

      expect(promptAssistantSelection).toHaveBeenCalled();
      expect(registerAssistant).not.toHaveBeenCalled();
      expect(ConfigLoader.saveAssistantsToProjectConfig).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTty, configurable: true });
    }
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
