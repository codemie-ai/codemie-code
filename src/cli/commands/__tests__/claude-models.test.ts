/**
 * `codemie-claude models list|add|remove`: per-profile non-Claude models for the Claude clients.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmModel } from '../../../providers/plugins/sso/sso.http-client.js';

const mocks = vi.hoisted(() => ({
  profiles: {} as Record<string, { codeMieProject?: string; claudeExtraModels?: string[] }>,
  catalog: [] as LlmModel[],
  fetchCatalog: vi.fn(),
  updateProfile: vi.fn(),
}));

vi.mock('../../../utils/config.js', () => ({
  ConfigLoader: {
    getActiveProfileName: vi.fn(async () => 'active'),
    getProfile: vi.fn(async (name: string) => mocks.profiles[name]),
    load: vi.fn(async (_cwd: string, overrides: { name: string }) => ({
      name: overrides.name,
      codeMieProject: mocks.profiles[overrides.name]?.codeMieProject,
    })),
    exportProviderEnvVars: vi.fn(() => ({})),
    updateProfile: mocks.updateProfile,
  },
}));
vi.mock('../../../providers/plugins/sso/sso.catalog.js', () => ({ fetchCodeMieCatalogForEnv: mocks.fetchCatalog }));

import { createClaudeModelsCommand } from '../claude-models.js';

function model(id: string, label: string): LlmModel {
  return { base_name: id, deployment_name: id, label, enabled: true };
}

async function run(...args: string[]): Promise<void> {
  await createClaudeModelsCommand().parseAsync(args, { from: 'user' });
}

describe('codemie-claude models', () => {
  let exit: ReturnType<typeof vi.spyOn>;
  let errors: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mocks.profiles = {
      active: { codeMieProject: 'active-project' },
      demo: { codeMieProject: 'router-demo', claudeExtraModels: ['gemini-3.1-pro'] },
    };
    mocks.catalog = [
      model('claude-sonnet-5', 'Claude Sonnet 5'),
      model('grok-4.6', 'Grok 4.6'),
      model('gemini-3.1-pro', 'Gemini 3.1 Pro'),
    ];
    mocks.fetchCatalog.mockReset().mockImplementation(async () => mocks.catalog);
    mocks.updateProfile.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('--profile', () => {
    it('reads the named profile and its project catalog, not the active one', async () => {
      await run('list', '--profile', 'demo');

      const env = mocks.fetchCatalog.mock.calls[0][0] as NodeJS.ProcessEnv;
      expect(env.CODEMIE_PROJECT).toBe('router-demo');
    });

    it('falls back to the active profile', async () => {
      await run('list');

      expect((mocks.fetchCatalog.mock.calls[0][0] as NodeJS.ProcessEnv).CODEMIE_PROJECT).toBe('active-project');
    });

    it('fails for a profile that does not exist', async () => {
      await expect(run('list', '--profile', 'nope')).rejects.toThrow('exit 1');
      expect(String(errors.mock.calls[0][0])).toContain('Profile "nope" not found');
    });
  });

  describe('add', () => {
    it('appends a catalog model by ID, keeping what was selected', async () => {
      await run('add', 'grok-4.6', '--profile', 'demo');

      expect(mocks.updateProfile).toHaveBeenCalledWith('demo', { claudeExtraModels: ['gemini-3.1-pro', 'grok-4.6'] });
    });

    it('accepts a model by its name, case-insensitively, and stores its ID', async () => {
      await run('add', 'GROK 4.6', '--profile', 'demo');

      expect(mocks.updateProfile).toHaveBeenCalledWith('demo', { claudeExtraModels: ['gemini-3.1-pro', 'grok-4.6'] });
    });

    it('does not save when the model is already selected', async () => {
      await run('add', 'gemini-3.1-pro', '--profile', 'demo');

      expect(mocks.updateProfile).not.toHaveBeenCalled();
    });

    it('does not add a Claude model, since Claude models are always offered', async () => {
      await run('add', 'claude-sonnet-5', '--profile', 'demo');

      expect(mocks.updateProfile).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();
    });

    it('rejects a model the project catalog does not serve and saves nothing', async () => {
      await expect(run('add', 'grok-4.6', 'gpt-99', '--profile', 'demo')).rejects.toThrow('exit 1');

      expect(mocks.updateProfile).not.toHaveBeenCalled();
      expect(String(errors.mock.calls[0][0])).toContain('gpt-99');
    });
  });

  describe('remove', () => {
    it('removes a selected model and clears the field when none is left', async () => {
      await run('remove', 'gemini-3.1-pro', '--profile', 'demo');

      expect(mocks.updateProfile).toHaveBeenCalledWith('demo', { claudeExtraModels: undefined });
    });

    it('works without the catalog, so a model the project dropped can still be removed', async () => {
      await run('remove', 'gemini-3.1-pro', '--profile', 'demo');

      expect(mocks.fetchCatalog).not.toHaveBeenCalled();
    });

    it('does not save when the model was not selected', async () => {
      await run('remove', 'grok-4.6', '--profile', 'demo');

      expect(mocks.updateProfile).not.toHaveBeenCalled();
    });
  });
});
