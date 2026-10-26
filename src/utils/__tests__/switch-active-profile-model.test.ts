/**
 * Unit tests for ConfigLoader.switchActiveProfileModel (src/utils/config.ts).
 *
 * switchActiveProfileModel patches the active profile's `model` field (and,
 * optionally, the Claude tier fields) in place, writing to whichever scope
 * (local/global) the active profile already lives in. It must never touch
 * the model lists, `reasoningEffort`, credentials, or workspace, and must never
 * write to the scope the active profile does NOT live in.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import { ConfigLoader } from '../config.js';
import type { MultiProviderConfig } from '../../env/types.js';
import * as paths from '../paths.js';

const TEST_DIR = path.join(process.cwd(), 'tmp-test-switch-active-profile-model');
const GLOBAL_CONFIG_DIR = path.join(TEST_DIR, '.codemie');
const GLOBAL_CONFIG_PATH = path.join(GLOBAL_CONFIG_DIR, 'codemie-cli.config.json');
const PROJECT_DIR = path.join(TEST_DIR, 'project');
const LOCAL_CONFIG_PATH = path.join(PROJECT_DIR, '.codemie', 'codemie-cli.config.json');

async function writeGlobalConfig(config: MultiProviderConfig): Promise<void> {
  await fs.mkdir(GLOBAL_CONFIG_DIR, { recursive: true });
  await fs.writeFile(GLOBAL_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

async function writeLocalConfig(config: MultiProviderConfig): Promise<void> {
  await fs.mkdir(path.dirname(LOCAL_CONFIG_PATH), { recursive: true });
  await fs.writeFile(LOCAL_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

describe('ConfigLoader.switchActiveProfileModel', () => {
  beforeEach(async () => {
    await fs.mkdir(GLOBAL_CONFIG_DIR, { recursive: true });
    await fs.mkdir(path.dirname(LOCAL_CONFIG_PATH), { recursive: true });

    vi.spyOn(paths, 'getCodemieHome').mockReturnValue(GLOBAL_CONFIG_DIR);
    vi.spyOn(paths, 'getCodemiePath').mockImplementation((subpath: string) => {
      return path.join(GLOBAL_CONFIG_DIR, subpath);
    });
  });

  afterEach(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('switches the active model in place, leaving model lists/reasoningEffort untouched (global scope)', async () => {
    const config: MultiProviderConfig = {
      version: 2,
      activeProfile: 'default',
      profiles: {
        default: {
          name: 'default',
          provider: 'openai',
          model: 'a',
          agentModels: { claude: { models: ['a', 'b'], model: 'a' } },
          reasoningEffort: 'high'
        }
      }
    };
    await writeGlobalConfig(config);

    const result = await ConfigLoader.switchActiveProfileModel('b', PROJECT_DIR);
    expect(result.profileName).toBe('default');

    const reloaded = JSON.parse(await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8')) as MultiProviderConfig;
    expect(reloaded.profiles.default.model).toBe('b');
    expect(reloaded.profiles.default.agentModels).toEqual({ claude: { models: ['a', 'b'], model: 'a' } });
    expect(reloaded.profiles.default.reasoningEffort).toBe('high');
  });

  it('writes to local scope and leaves the global file untouched when the active profile lives locally', async () => {
    const globalConfig: MultiProviderConfig = {
      version: 2,
      activeProfile: 'other',
      profiles: {
        other: { name: 'other', provider: 'openai', model: 'z' }
      }
    };
    await writeGlobalConfig(globalConfig);
    const globalBefore = await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8');

    const localConfig: MultiProviderConfig = {
      version: 2,
      activeProfile: 'default',
      profiles: {
        default: {
          name: 'default',
          provider: 'openai',
          model: 'a',
          agentModels: { claude: { models: ['a', 'b'], model: 'a' } },
          reasoningEffort: 'high'
        }
      }
    };
    await writeLocalConfig(localConfig);

    const result = await ConfigLoader.switchActiveProfileModel('b', PROJECT_DIR);
    expect(result.profileName).toBe('default');

    const reloadedLocal = JSON.parse(await fs.readFile(LOCAL_CONFIG_PATH, 'utf-8')) as MultiProviderConfig;
    expect(reloadedLocal.profiles.default.model).toBe('b');
    expect(reloadedLocal.profiles.default.agentModels).toEqual({ claude: { models: ['a', 'b'], model: 'a' } });
    expect(reloadedLocal.profiles.default.reasoningEffort).toBe('high');

    const globalAfter = await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8');
    expect(globalAfter).toBe(globalBefore);
  });

  it('switches an agent in the global profile when the local copy has no agentModels', async () => {
    // load() overlays local onto global, so the global map is the one launches use.
    await writeGlobalConfig({
      version: 2,
      activeProfile: 'default',
      profiles: {
        default: { name: 'default', provider: 'openai', model: 'a', agentModels: { claude: { models: ['a', 'b'], model: 'a' } } },
      },
    });
    await writeLocalConfig({
      version: 2,
      activeProfile: 'default',
      profiles: { default: { name: 'default', provider: 'openai', model: 'a' } },
    });
    const localBefore = await fs.readFile(LOCAL_CONFIG_PATH, 'utf-8');

    await ConfigLoader.switchActiveProfileModel('b', PROJECT_DIR, undefined, 'claude');

    const reloadedGlobal = JSON.parse(await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8')) as MultiProviderConfig;
    expect(reloadedGlobal.profiles.default.agentModels?.claude.model).toBe('b');
    expect(await fs.readFile(LOCAL_CONFIG_PATH, 'utf-8')).toBe(localBefore);

    const profile = await ConfigLoader.getProfileForModelSwitch('default', PROJECT_DIR);
    expect(profile?.agentModels?.claude.model).toBe('b');
  });

  it('overwrites tier fields when tierOverrides is given, leaves them unchanged when omitted', async () => {
    const config: MultiProviderConfig = {
      version: 2,
      activeProfile: 'default',
      profiles: {
        default: {
          name: 'default',
          provider: 'claude',
          model: 'a',
          agentModels: { claude: { models: ['a', 'b'], model: 'a' } },
          haikuModel: 'old-haiku',
          sonnetModel: 'old-sonnet',
          opusModel: 'old-opus'
        }
      }
    };
    await writeGlobalConfig(config);

    await ConfigLoader.switchActiveProfileModel('b', PROJECT_DIR, {
      haikuModel: 'new-haiku',
      sonnetModel: 'new-sonnet',
      opusModel: 'new-opus'
    });

    const reloaded = JSON.parse(await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8')) as MultiProviderConfig;
    expect(reloaded.profiles.default.haikuModel).toBe('new-haiku');
    expect(reloaded.profiles.default.sonnetModel).toBe('new-sonnet');
    expect(reloaded.profiles.default.opusModel).toBe('new-opus');

    // Reset for the "omitted" half of this test.
    await writeGlobalConfig(config);
    await ConfigLoader.switchActiveProfileModel('b', PROJECT_DIR);

    const reloadedNoTiers = JSON.parse(await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8')) as MultiProviderConfig;
    expect(reloadedNoTiers.profiles.default.haikuModel).toBe('old-haiku');
    expect(reloadedNoTiers.profiles.default.sonnetModel).toBe('old-sonnet');
    expect(reloadedNoTiers.profiles.default.opusModel).toBe('old-opus');
  });

  it('throws when there is no active profile', async () => {
    const config: MultiProviderConfig = { version: 2, activeProfile: '', profiles: {} };
    await writeGlobalConfig(config);

    await expect(ConfigLoader.switchActiveProfileModel('b', PROJECT_DIR)).rejects.toThrow();
  });

  describe('with an agent on a per-agent profile', () => {
    const perAgent = (): MultiProviderConfig => ({
      version: 2,
      activeProfile: 'default',
      profiles: {
        default: {
          name: 'default',
          provider: 'litellm',
          model: 'claude-x',
          agentModels: {
            claude: { models: ['claude-x', 'claude-y'], model: 'claude-x' },
            codex: { models: ['gpt-a', 'gpt-b'], model: 'gpt-a' },
          },
        },
      },
    });

    it('switches only that agent active model, leaving the top-level model for a non-first agent', async () => {
      await writeGlobalConfig(perAgent());

      await ConfigLoader.switchActiveProfileModel('gpt-b', PROJECT_DIR, undefined, 'codex');

      const reloaded = JSON.parse(await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8')) as MultiProviderConfig;
      expect(reloaded.profiles.default.agentModels?.codex).toEqual({ models: ['gpt-a', 'gpt-b'], model: 'gpt-b' });
      expect(reloaded.profiles.default.agentModels?.claude.model).toBe('claude-x');
      expect(reloaded.profiles.default.model).toBe('claude-x');
    });

    it('keeps the top-level model in sync when the first agent switches, folding ACP names', async () => {
      await writeGlobalConfig(perAgent());

      await ConfigLoader.switchActiveProfileModel('claude-y', PROJECT_DIR, { sonnetModel: 'claude-y' }, 'claude-acp');

      const reloaded = JSON.parse(await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8')) as MultiProviderConfig;
      expect(reloaded.profiles.default.agentModels?.claude.model).toBe('claude-y');
      expect(reloaded.profiles.default.model).toBe('claude-y');
      expect(reloaded.profiles.default.sonnetModel).toBe('claude-y');
    });

    it('makes a model outside the agent list its only model, dropping stale confirmations', async () => {
      const config = perAgent();
      config.profiles.default.agentModels!.codex = { models: ['gpt-a'], model: 'gpt-a', confirmedModels: ['gpt-a'] };
      await writeGlobalConfig(config);

      await ConfigLoader.switchActiveProfileModel('gpt-new', PROJECT_DIR, undefined, 'codex');

      const reloaded = JSON.parse(await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8')) as MultiProviderConfig;
      expect(reloaded.profiles.default.agentModels?.codex).toEqual({ models: ['gpt-new'], model: 'gpt-new' });
    });
  });
});
