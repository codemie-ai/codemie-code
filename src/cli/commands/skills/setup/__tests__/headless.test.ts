/**
 * Unit tests for the headless (non-interactive) branch of `codemie setup skills`.
 *
 * Mirrors `assistants/setup/__tests__/headless.test.ts`: flag validation fails fast
 * naming the missing flag, an unresolvable identifier aborts before any write
 * happens, every interactive prompt (including the raw-mode disclaimer gate and
 * agent auto-detection) stays unreachable, and both wiring sites
 * (`createSkillsSetupCommand()` / `createSkillsSetupCommand('claude')`) expose the
 * same flag surface.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SkillListItem } from 'codemie-sdk';
import {
  ConfigurationError,
  PartialRegistrationError,
  RegistrationItemNotFoundError,
} from '@/utils/errors.js';
import { StorageScope } from '@/env/types.js';
import { ACTION_TYPE } from '../constants.js';
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
    loadSkillsByScope: vi.fn(),
    saveSkillsToProjectConfig: vi.fn(),
    getConfigLocationLabel: vi.fn(),
  },
}));

vi.mock('@/utils/auth.js', () => ({
  getAuthenticatedClient: vi.fn(),
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

vi.mock('../data.js', () => ({
  createSkillDataFetcher: vi.fn(),
}));

vi.mock('../selection/index.js', () => ({
  promptSkillSelection: vi.fn(),
}));

vi.mock('@/cli/commands/shared/prompts/storage-scope.js', () => ({
  promptStorageScope: vi.fn(),
}));

vi.mock('../helpers.js', async () => {
  const actual = await vi.importActual<typeof import('../helpers.js')>('../helpers.js');
  return {
    ...actual,
    registerSkill: vi.fn(),
    unregisterSkill: vi.fn(),
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

import { ConfigLoader } from '@/utils/config.js';
import { getAuthenticatedClient } from '@/utils/auth.js';
import { createSkillDataFetcher } from '../data.js';
import { promptSkillSelection } from '../selection/index.js';
import { promptStorageScope } from '@/cli/commands/shared/prompts/storage-scope.js';
import { resolveAgentSetupTargets } from '@/cli/commands/shared/agent-targets.js';
import { registerSkill, unregisterSkill } from '../helpers.js';

function makeSkill(id: string, name: string): SkillListItem {
  return { id, name, description: `${name} description`, project: 'proj' } as SkillListItem;
}

describe('setupSkillsHeadless', () => {
  const catalog = [
    makeSkill('id-1', 'Skill One'),
    makeSkill('id-2', 'Skill Two'),
    makeSkill('id-3', 'Skill Three'),
  ];

  let setRawModeSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    setRawModeSpy = vi.fn();
    process.stdin.setRawMode = setRawModeSpy as unknown as typeof process.stdin.setRawMode;

    vi.mocked(ConfigLoader.getActiveProfileName).mockResolvedValue('default');
    vi.mocked(ConfigLoader.load).mockResolvedValue({} as any);
    vi.mocked(ConfigLoader.loadSkillsByScope).mockResolvedValue([]);
    vi.mocked(ConfigLoader.saveSkillsToProjectConfig).mockResolvedValue(undefined);
    vi.mocked(ConfigLoader.getConfigLocationLabel).mockReturnValue('Global (~/.codemie/)');
    vi.mocked(getAuthenticatedClient).mockResolvedValue({} as any);
    vi.mocked(createSkillDataFetcher).mockReturnValue({
      fetchSkills: vi.fn(),
      fetchSkillById: vi.fn().mockImplementation(async (id: string) => {
        const skill = catalog.find((s) => s.id === id)!;
        return { ...skill, content: 'skill body', toolkits: [], mcp_servers: [] };
      }),
      fetchSkillsByIds: vi.fn(),
      fetchAllVisibleSkills: vi.fn().mockResolvedValue(catalog),
    });
    vi.mocked(registerSkill).mockImplementation(
      async (skill: any, _scope?: any, _workingDir?: any, target: any = ['claude']) => ({
        id: skill.id,
        name: skill.name,
        slug: skill.name.toLowerCase().replace(/\s+/g, '-'),
        description: skill.description,
        project: skill.project,
        registeredAt: '2026-01-01T00:00:00.000Z',
        agentTargets: target,
      })
    );
    vi.mocked(unregisterSkill).mockResolvedValue(undefined);
  });

  const fullOptions: SetupCommandOptions = {
    skill: 'id-1,id-2',
    scope: 'global',
    agent: 'claude',
    yes: true,
  };

  it('registers every requested skill and never touches an interactive prompt or raw mode', async () => {
    const { setupSkillsHeadless } = await import('../index.js');

    await setupSkillsHeadless(fullOptions);

    expect(registerSkill).toHaveBeenCalledTimes(2);
    expect(ConfigLoader.saveSkillsToProjectConfig).toHaveBeenCalledWith(
      expect.any(String),
      StorageScope.GLOBAL,
      expect.arrayContaining([
        expect.objectContaining({ id: 'id-1' }),
        expect.objectContaining({ id: 'id-2' }),
      ])
    );

    expect(promptSkillSelection).not.toHaveBeenCalled();
    expect(promptStorageScope).not.toHaveBeenCalled();
    expect(resolveAgentSetupTargets).not.toHaveBeenCalled();
    expect(setRawModeSpy).not.toHaveBeenCalled();
  });

  it('prints the skills notice through console.log without gating on a keypress', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { setupSkillsHeadless } = await import('../index.js');
    await setupSkillsHeadless(fullOptions);

    const loggedText = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(loggedText).toContain('Skills are installed without tools or MCP servers');
    expect(setRawModeSpy).not.toHaveBeenCalled();

    logSpy.mockRestore();
  });

  async function expectConfigurationError(
    options: SetupCommandOptions,
    flagSubstring: string
  ): Promise<void> {
    const { setupSkillsHeadless } = await import('../index.js');

    const error: unknown = await setupSkillsHeadless(options).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as Error).message).toContain(flagSubstring);
    expect(getAuthenticatedClient).not.toHaveBeenCalled();
  }

  it('rejects with a ConfigurationError naming --skill when skill is missing', async () => {
    const { skill: _skill, ...options } = fullOptions;
    await expectConfigurationError(options, '--skill');
  });

  it('rejects with a ConfigurationError naming --scope when scope is missing', async () => {
    const { scope: _scope, ...options } = fullOptions;
    await expectConfigurationError(options, '--scope');
  });

  it('rejects with a ConfigurationError naming --agent when agent is missing', async () => {
    const { agent: _agent, ...options } = fullOptions;
    await expectConfigurationError(options, '--agent');
  });

  it('aborts with RegistrationItemNotFoundError before any write when an identifier is unresolvable, and never saves', async () => {
    const { setupSkillsHeadless } = await import('../index.js');

    await expect(
      setupSkillsHeadless({ ...fullOptions, skill: 'id-1,does-not-exist' })
    ).rejects.toBeInstanceOf(RegistrationItemNotFoundError);

    expect(getAuthenticatedClient).toHaveBeenCalled();
    const fetcher = vi.mocked(createSkillDataFetcher).mock.results[0]!.value;
    expect(fetcher.fetchAllVisibleSkills).toHaveBeenCalled();

    expect(registerSkill).not.toHaveBeenCalled();
    expect(unregisterSkill).not.toHaveBeenCalled();
    expect(ConfigLoader.saveSkillsToProjectConfig).not.toHaveBeenCalled();
  });

  it('is purely additive: an already-registered skill not named in --skill is never unregistered and survives the save', async () => {
    const untouched = {
      id: 'id-3',
      name: 'Skill Three',
      slug: 'skill-three',
      description: 'Skill Three description',
      project: 'proj',
      registeredAt: '2025-01-01T00:00:00.000Z',
      agentTargets: ['claude'],
    };
    vi.mocked(ConfigLoader.loadSkillsByScope).mockResolvedValue([untouched] as any);

    const { setupSkillsHeadless } = await import('../index.js');

    await setupSkillsHeadless({ ...fullOptions, skill: 'id-1' });

    expect(unregisterSkill).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'id-3' }),
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
    expect(ConfigLoader.saveSkillsToProjectConfig).toHaveBeenCalledWith(
      expect.any(String),
      StorageScope.GLOBAL,
      expect.arrayContaining([expect.objectContaining({ id: 'id-3' })])
    );
  });

  it('accepts the hosting agent in place of --agent and registers for it', async () => {
    const { agent: _agent, ...options } = fullOptions;
    const { setupSkillsHeadless } = await import('../index.js');

    await setupSkillsHeadless({ ...options, skill: 'id-1' }, 'claude');

    expect(registerSkill).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'id-1' }),
      StorageScope.GLOBAL,
      expect.any(String),
      ['claude']
    );
  });

  it('passes every --agent target through to the writers and persists them', async () => {
    const { setupSkillsHeadless } = await import('../index.js');

    await setupSkillsHeadless({ ...fullOptions, skill: 'id-1', agent: 'codex,gemini' });

    expect(registerSkill).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'id-1' }),
      StorageScope.GLOBAL,
      expect.any(String),
      ['codex', 'gemini']
    );
    expect(ConfigLoader.saveSkillsToProjectConfig).toHaveBeenCalledWith(
      expect.any(String),
      StorageScope.GLOBAL,
      [expect.objectContaining({ id: 'id-1', agentTargets: ['codex', 'gemini'] })]
    );
  });

  it('proves every skill is readable before the first artifact is written', async () => {
    // Arrange: the detail fetch is what proves access. When the last skill of the
    // batch is unreadable, nothing at all may have been written.
    const fetcher = {
      fetchSkills: vi.fn(),
      fetchSkillById: vi.fn().mockImplementation(async (id: string) => {
        if (id === 'id-3') {
          throw new Error('403 forbidden');
        }
        const skill = catalog.find((s) => s.id === id)!;
        return { ...skill, content: 'skill body', toolkits: [], mcp_servers: [] };
      }),
      fetchSkillsByIds: vi.fn(),
      fetchAllVisibleSkills: vi.fn().mockResolvedValue(catalog),
    };
    vi.mocked(createSkillDataFetcher).mockReturnValue(fetcher);

    const { setupSkillsHeadless } = await import('../index.js');

    await expect(
      setupSkillsHeadless({ ...fullOptions, skill: 'id-1,id-2,id-3' })
    ).rejects.toThrow(/403 forbidden/);

    expect(registerSkill).not.toHaveBeenCalled();
    expect(unregisterSkill).not.toHaveBeenCalled();
    expect(ConfigLoader.saveSkillsToProjectConfig).not.toHaveBeenCalled();
  });

  it('records the skills already written when a later write in the batch fails', async () => {
    vi.mocked(registerSkill).mockImplementation(async (skill: any) => {
      if (skill.id === 'id-2') {
        throw new Error('generator exploded');
      }
      return {
        id: skill.id,
        name: skill.name,
        slug: skill.name.toLowerCase().replace(/\s+/g, '-'),
        description: skill.description,
        project: skill.project,
        registeredAt: '2026-01-01T00:00:00.000Z',
        agentTargets: ['claude'],
      } as any;
    });

    const { setupSkillsHeadless } = await import('../index.js');

    await expect(
      setupSkillsHeadless({ ...fullOptions, skill: 'id-1,id-2,id-3' })
    ).rejects.toBeInstanceOf(PartialRegistrationError);

    expect(ConfigLoader.saveSkillsToProjectConfig).toHaveBeenCalledWith(
      expect.any(String),
      StorageScope.GLOBAL,
      [expect.objectContaining({ id: 'id-1' })]
    );
  });

  it('forbids the interactive re-auth prompt by authenticating non-interactively', async () => {
    const { setupSkillsHeadless } = await import('../index.js');

    await setupSkillsHeadless(fullOptions);

    expect(getAuthenticatedClient).toHaveBeenCalledWith(expect.anything(), { nonInteractive: true });
  });

  it('still runs the wizard at a TTY when only the pre-existing --agent flag is given', async () => {
    // Regression: --agent shipped as a wizard preselector, so it must not divert a
    // TTY invocation into the headless branch and fail on a missing --skill.
    const originalIsTty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    vi.mocked(promptStorageScope).mockResolvedValue(StorageScope.GLOBAL);
    vi.mocked(promptSkillSelection).mockResolvedValue({ selectedIds: [], action: ACTION_TYPE.CANCEL } as any);
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    try {
      const { createSkillsSetupCommand } = await import('../index.js');

      const run = createSkillsSetupCommand().parseAsync(['--agent', 'claude'], { from: 'user' });
      // The interactive disclaimer gate is reached, which is the proof the wizard ran.
      await vi.waitFor(() => expect(setRawModeSpy).toHaveBeenCalledWith(true));
      process.stdin.emit('data', '\r');
      await run;

      expect(promptSkillSelection).toHaveBeenCalled();
      expect(resolveAgentSetupTargets).toHaveBeenCalledWith('claude', undefined);
      expect(registerSkill).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTty, configurable: true });
    }
  });

  it('exposes an identical option-name set for both wiring sites', async () => {
    const { createSkillsSetupCommand } = await import('../index.js');

    const defaultOptionNames = createSkillsSetupCommand().options.map(opt => opt.long).sort();
    const claudeOptionNames = createSkillsSetupCommand('claude').options.map(opt => opt.long).sort();

    expect(claudeOptionNames).toEqual(defaultOptionNames);
    expect(defaultOptionNames).toEqual(
      expect.arrayContaining(['--skill', '--scope', '--yes', '--agent'])
    );
  });
});
