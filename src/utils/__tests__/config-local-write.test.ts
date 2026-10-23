/**
 * Local config write-safety tests
 *
 * Every write to <cwd>/.codemie/codemie-cli.config.json must keep keys it does
 * not change, and must refuse (never overwrite) files it cannot understand.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import { ConfigLoader } from '../config.js';
import { ConfigurationError } from '../errors.js';
import { StorageScope, type MultiProviderConfig } from '../../env/types.js';
import * as paths from '../paths.js';
import { logger } from '../logger.js';
import chalk from 'chalk';

// The real logger keeps a write stream open under the mocked CODEMIE home,
// which blocks deleting TEST_DIR on Windows (EPERM) and breaks later tests.
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}));

const TEST_DIR = path.join(process.cwd(), 'tmp-test-local-write');
const GLOBAL_CONFIG_DIR = path.join(TEST_DIR, '.codemie');
const GLOBAL_CONFIG_PATH = path.join(GLOBAL_CONFIG_DIR, 'codemie-cli.config.json');
const WORKING_DIR = path.join(TEST_DIR, 'project');
const LOCAL_CONFIG_PATH = path.join(WORKING_DIR, '.codemie', 'codemie-cli.config.json');

const GLOBAL_CONFIG: MultiProviderConfig = {
  version: 2,
  activeProfile: 'work',
  profiles: {
    work: { provider: 'litellm', baseUrl: 'http://localhost:4000', model: 'gpt' },
    personal: { provider: 'litellm', baseUrl: 'http://localhost:4001', model: 'claude' }
  }
};

async function writeGlobal(config: unknown): Promise<void> {
  await fs.writeFile(GLOBAL_CONFIG_PATH, JSON.stringify(config, null, 2));
}

async function writeLocalRaw(content: string): Promise<void> {
  await fs.writeFile(LOCAL_CONFIG_PATH, content);
}

async function writeLocal(config: unknown): Promise<void> {
  await writeLocalRaw(JSON.stringify(config, null, 2));
}

async function readLocal(): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(LOCAL_CONFIG_PATH, 'utf-8'));
}

describe('ConfigLoader local config writes', () => {
  beforeEach(async () => {
    await fs.mkdir(GLOBAL_CONFIG_DIR, { recursive: true });
    await fs.mkdir(path.dirname(LOCAL_CONFIG_PATH), { recursive: true });
    vi.spyOn(paths, 'getCodemieHome').mockReturnValue(GLOBAL_CONFIG_DIR);
    vi.spyOn(paths, 'getCodemiePath').mockImplementation((subpath: string) => path.join(GLOBAL_CONFIG_DIR, subpath));
    delete process.env.CODEMIE_DEBUG;
    delete process.env.CODEMIE_PROVIDER;
    delete process.env.CODEMIE_MODEL;
    delete process.env.CODEMIE_BASE_URL;
    delete process.env.CODEMIE_API_KEY;
    await writeGlobal(GLOBAL_CONFIG);
  });

  afterEach(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('updateLocalConfig', () => {
    it('keeps every other key of a valid v2 file', async () => {
      const original = {
        version: 2,
        activeProfile: 'a',
        profiles: { a: { provider: 'sso' } },
        codemieAssistants: [{ slug: 'jira' }],
        codemieSkills: [{ slug: 's' }],
        workspace: { codeMieProject: 'philips' },
        custom: 1
      };
      await writeLocal(original);

      await ConfigLoader.updateLocalConfig(WORKING_DIR, config => {
        config.activeProfile = 'b';
      });

      expect(await readLocal()).toEqual({ ...original, activeProfile: 'b' });
    });

    it('fills a versionless assistants/workspace-only file', async () => {
      await writeLocal({ codemieAssistants: [{ slug: 'jira' }], workspace: { codeMieProject: 'philips' } });

      await ConfigLoader.updateLocalConfig(WORKING_DIR, config => {
        config.activeProfile = 'work';
      });

      expect(await readLocal()).toEqual({
        version: 2,
        activeProfile: 'work',
        profiles: {},
        codemieAssistants: [{ slug: 'jira' }],
        workspace: { codeMieProject: 'philips' }
      });
    });

    it('accepts a BOM + CRLF file', async () => {
      const config = { version: 2, activeProfile: 'a', profiles: { a: { provider: 'sso' } }, custom: true };
      await writeLocalRaw(String.fromCharCode(0xfeff) + JSON.stringify(config, null, 2).replace(/\n/g, '\r\n'));

      await ConfigLoader.updateLocalConfig(WORKING_DIR, c => {
        c.activeProfile = 'work';
      });

      expect(await readLocal()).toEqual({ ...config, activeProfile: 'work' });
    });

    it.each([
      ['unparseable JSON', '{not json'],
      ['a non-object', '[]'],
      ['a legacy v1 config', JSON.stringify({ provider: 'openai', model: 'gpt' })],
      ['an unknown version', JSON.stringify({ version: 3, profiles: {} })],
      ['profiles as an array', JSON.stringify({ version: 2, profiles: [], activeProfile: '' })],
      ['a null profile entry', JSON.stringify({ version: 2, profiles: { a: null }, activeProfile: '' })],
      ['a non-string activeProfile', JSON.stringify({ version: 2, profiles: {}, activeProfile: 5 })]
    ])('refuses %s and leaves the file byte-identical', async (_label, content) => {
      await writeLocalRaw(content);

      const update = ConfigLoader.updateLocalConfig(WORKING_DIR, c => {
        c.activeProfile = 'work';
      });

      await expect(update).rejects.toThrow(ConfigurationError);
      await expect(update).rejects.toThrow(LOCAL_CONFIG_PATH);
      await expect(update).rejects.toThrow('left unchanged');
      expect(await fs.readFile(LOCAL_CONFIG_PATH, 'utf-8')).toBe(content);
    });

    it('creates a missing file with activeProfile ""', async () => {
      await fs.rm(LOCAL_CONFIG_PATH, { force: true });

      await ConfigLoader.updateLocalConfig(WORKING_DIR, c => {
        c.codemieSkills = [];
      });

      expect(await readLocal()).toEqual({ version: 2, activeProfile: '', profiles: {}, codemieSkills: [] });
    });

    it('local skill registration in a fresh dir does not select a profile', async () => {
      await fs.rm(LOCAL_CONFIG_PATH, { force: true });

      await ConfigLoader.saveSkillsToProjectConfig(WORKING_DIR, StorageScope.LOCAL, []);

      expect((await readLocal()).activeProfile).toBe('');
      expect(await ConfigLoader.getActiveProfileName(WORKING_DIR)).toBe('work');
    });
  });

  describe('profile ops keep local data', () => {
    it('switch keeps codemieAssistants/workspace for a fill-shape file', async () => {
      await writeLocal({ codemieAssistants: [{ slug: 'jira' }], workspace: { codeMieProject: 'p' } });

      await expect(ConfigLoader.switchProfile('work', WORKING_DIR)).resolves.toBe(StorageScope.LOCAL);

      expect(await readLocal()).toEqual({
        version: 2,
        activeProfile: 'work',
        profiles: {},
        codemieAssistants: [{ slug: 'jira' }],
        workspace: { codeMieProject: 'p' }
      });
    });

    it('switch refuses a legacy local file and leaves it byte-identical', async () => {
      const content = JSON.stringify({ provider: 'openai', model: 'gpt' });
      await writeLocalRaw(content);

      await expect(ConfigLoader.switchProfile('work', WORKING_DIR)).rejects.toThrow(ConfigurationError);

      expect(await fs.readFile(LOCAL_CONFIG_PATH, 'utf-8')).toBe(content);
    });

    it('deleting the last local profile writes activeProfile "" and keeps other keys', async () => {
      await writeLocal({
        version: 2,
        activeProfile: 'team',
        profiles: { team: { provider: 'sso' } },
        codemieSkills: [{ slug: 's' }],
        workspace: { codeMieProject: 'p' }
      });

      await expect(ConfigLoader.deleteProfile('team', WORKING_DIR)).resolves.toBe(StorageScope.LOCAL);

      expect(await readLocal()).toEqual({
        version: 2,
        activeProfile: '',
        profiles: {},
        codemieSkills: [{ slug: 's' }],
        workspace: { codeMieProject: 'p' }
      });
      expect(await ConfigLoader.getActiveProfileName(WORKING_DIR)).toBe('work');
    });

    it('after deleting the last local profile, deleting a global profile succeeds', async () => {
      await writeLocal({ version: 2, activeProfile: 'team', profiles: { team: { provider: 'sso' } } });

      await ConfigLoader.deleteProfile('team', WORKING_DIR);
      await expect(ConfigLoader.deleteProfile('personal', WORKING_DIR)).resolves.toBe(StorageScope.GLOBAL);

      const global = JSON.parse(await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8')) as MultiProviderConfig;
      expect(global.profiles.personal).toBeUndefined();
      expect(global.activeProfile).toBe('work');
    });

    it('deleting the global profile the local active points to, with no local profiles, writes ""', async () => {
      await writeLocal({ version: 2, activeProfile: 'work', profiles: {}, workspace: { codeMieProject: 'p' } });

      await expect(ConfigLoader.deleteProfile('work', WORKING_DIR)).resolves.toBe(StorageScope.GLOBAL);

      expect(await readLocal()).toEqual({
        version: 2,
        activeProfile: '',
        profiles: {},
        workspace: { codeMieProject: 'p' }
      });
    });

    it('listProfiles marks the global active profile when the local active is dangling', async () => {
      await writeLocal({ version: 2, activeProfile: 'gone', profiles: {} });

      const profiles = await ConfigLoader.listProfiles(WORKING_DIR);

      expect(profiles.filter(p => p.active).map(p => p.name)).toEqual(['work']);
    });
  });

  describe('saveLocalProfile', () => {
    const TEAM_LOCAL = {
      version: 2,
      activeProfile: 'team',
      profiles: {
        team: { name: 'team', provider: 'sso', model: 'a' },
        other: { name: 'other', provider: 'litellm', model: 'b' }
      },
      codemieAssistants: [{ slug: 'jira' }],
      codemieSkills: [{ slug: 's' }],
      workspace: { codeMieProject: 'p', hooks: { x: 1 } }
    };

    it('update keeps other profiles, keys and the active profile', async () => {
      await writeLocal(TEAM_LOCAL);

      const result = await ConfigLoader.saveLocalProfile(
        WORKING_DIR,
        'other',
        { provider: 'litellm', model: 'm', codeMieProject: 'q' },
        { isUpdate: true }
      );

      const local = await readLocal() as typeof TEAM_LOCAL;
      expect(result).toEqual({ activated: false });
      expect(local.profiles.team).toEqual(TEAM_LOCAL.profiles.team);
      expect(local.profiles.other).toEqual({ name: 'other', provider: 'litellm', model: 'm' });
      expect(local.workspace).toEqual({ codeMieProject: 'q', hooks: { x: 1 } });
      expect(local.activeProfile).toBe('team');
      expect(local.codemieAssistants).toEqual(TEAM_LOCAL.codemieAssistants);
      expect(local.codemieSkills).toEqual(TEAM_LOCAL.codemieSkills);
    });

    it('add when other local profiles exist does not activate', async () => {
      await writeLocal(TEAM_LOCAL);

      const result = await ConfigLoader.saveLocalProfile(
        WORKING_DIR,
        'third',
        { provider: 'litellm', model: 'c' },
        { isUpdate: false }
      );

      const local = await readLocal() as typeof TEAM_LOCAL;
      expect(result).toEqual({ activated: false });
      expect(local.activeProfile).toBe('team');
      expect(Object.keys(local.profiles)).toEqual(['team', 'other', 'third']);
    });

    it('add as the only local profile activates', async () => {
      await fs.rm(LOCAL_CONFIG_PATH, { force: true });

      const result = await ConfigLoader.saveLocalProfile(
        WORKING_DIR,
        'solo',
        { provider: 'litellm', model: 'c' },
        { isUpdate: false }
      );

      expect(result).toEqual({ activated: true });
      expect(await readLocal()).toEqual({
        version: 2,
        activeProfile: 'solo',
        profiles: { solo: { name: 'solo', provider: 'litellm', model: 'c' } }
      });
    });

    it('update activates when the local active is dangling', async () => {
      await writeLocal({ ...TEAM_LOCAL, activeProfile: 'gone' });

      const result = await ConfigLoader.saveLocalProfile(
        WORKING_DIR,
        'other',
        { provider: 'litellm', model: 'm' },
        { isUpdate: true }
      );

      expect(result).toEqual({ activated: true });
      expect((await readLocal()).activeProfile).toBe('other');
    });

    it('update does not activate when the local active is a valid global profile', async () => {
      await writeLocal({ ...TEAM_LOCAL, activeProfile: 'personal' });

      const result = await ConfigLoader.saveLocalProfile(
        WORKING_DIR,
        'other',
        { provider: 'litellm', model: 'm' },
        { isUpdate: true }
      );

      expect(result).toEqual({ activated: false });
      expect((await readLocal()).activeProfile).toBe('personal');
    });

    it('add into a fill-shape file keeps assistants/workspace', async () => {
      await writeLocal({ codemieAssistants: [{ slug: 'jira' }], workspace: { codeMieProject: 'p' } });

      const result = await ConfigLoader.saveLocalProfile(
        WORKING_DIR,
        'team',
        { provider: 'sso', model: 'a' },
        { isUpdate: false }
      );

      expect(result).toEqual({ activated: true });
      expect(await readLocal()).toEqual({
        version: 2,
        activeProfile: 'team',
        profiles: { team: { name: 'team', provider: 'sso', model: 'a' } },
        codemieAssistants: [{ slug: 'jira' }],
        workspace: { codeMieProject: 'p' }
      });
    });

    it('strips codemieSkills/codemieAssistants from the profile entry', async () => {
      await fs.rm(LOCAL_CONFIG_PATH, { force: true });

      await ConfigLoader.saveLocalProfile(
        WORKING_DIR,
        'solo',
        { provider: 'sso', codemieSkills: [], codemieAssistants: [] } as never,
        { isUpdate: false }
      );

      expect((await readLocal() as typeof TEAM_LOCAL).profiles.solo).toEqual({ name: 'solo', provider: 'sso' });
    });
  });

  describe('renameProfile', () => {
    it('renames a local-only profile, keeps other keys, updates the local activeProfile', async () => {
      await writeLocal({
        version: 2,
        activeProfile: 'team',
        profiles: { team: { name: 'team', provider: 'sso' }, other: { provider: 'sso' } },
        codemieAssistants: [{ slug: 'jira' }]
      });

      await expect(ConfigLoader.renameProfile('team', 'squad', WORKING_DIR)).resolves.toBe(StorageScope.LOCAL);

      expect(await readLocal()).toEqual({
        version: 2,
        activeProfile: 'squad',
        profiles: { other: { provider: 'sso' }, squad: { name: 'squad', provider: 'sso' } },
        codemieAssistants: [{ slug: 'jira' }]
      });
      const global = JSON.parse(await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8')) as MultiProviderConfig;
      expect(global).toEqual(GLOBAL_CONFIG);
    });

    it('renames a global profile and repairs the cwd local activeProfile reference', async () => {
      await writeLocal({ version: 2, activeProfile: 'work', profiles: {}, workspace: { codeMieProject: 'p' } });

      await expect(ConfigLoader.renameProfile('work', 'job', WORKING_DIR)).resolves.toBe(StorageScope.GLOBAL);

      const global = JSON.parse(await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8')) as MultiProviderConfig;
      expect(Object.keys(global.profiles).sort()).toEqual(['job', 'personal']);
      expect(global.profiles.job).toEqual({ ...GLOBAL_CONFIG.profiles.work, name: 'job' });
      expect(global.activeProfile).toBe('job');
      expect(await readLocal()).toEqual({
        version: 2,
        activeProfile: 'job',
        profiles: {},
        workspace: { codeMieProject: 'p' }
      });
    });

    it('renames a global profile without a local file and creates none', async () => {
      await fs.rm(LOCAL_CONFIG_PATH, { force: true });

      await expect(ConfigLoader.renameProfile('personal', 'home', WORKING_DIR)).resolves.toBe(StorageScope.GLOBAL);

      await expect(fs.access(LOCAL_CONFIG_PATH)).rejects.toThrow();
    });

    it('rejects a new name that exists in the other scope and leaves both files unchanged', async () => {
      const local = JSON.stringify({ version: 2, activeProfile: 'team', profiles: { team: { provider: 'sso' } } });
      await writeLocalRaw(local);
      const global = await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8');

      await expect(ConfigLoader.renameProfile('work', 'team', WORKING_DIR))
        .rejects.toThrow('Profile "team" already exists in local config');
      await expect(ConfigLoader.renameProfile('team', 'personal', WORKING_DIR))
        .rejects.toThrow('Profile "personal" already exists in global config');

      expect(await fs.readFile(LOCAL_CONFIG_PATH, 'utf-8')).toBe(local);
      expect(await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8')).toBe(global);
    });

    it('rejects rename onto the same name', async () => {
      await expect(ConfigLoader.renameProfile('work', 'work', WORKING_DIR))
        .rejects.toThrow('Profile "work" already exists in global config');
    });

    it('rejects an unknown old name and lists the available profiles', async () => {
      await expect(ConfigLoader.renameProfile('nope', 'x', WORKING_DIR))
        .rejects.toThrow('Profile "nope" not found. Available profiles: work, personal');
    });
  });

  describe('fallback warning', () => {
    const originalIsTTY = process.stderr.isTTY;
    const WARNING = `⚠ Local profile "gone" not found in ${LOCAL_CONFIG_PATH}; using global profile "work". Run: codemie profile switch`;
    let consoleError: ReturnType<typeof vi.spyOn>;
    let loggerWarn: ReturnType<typeof vi.spyOn>;

    function setStderrTTY(value: boolean): void {
      Object.defineProperty(process.stderr, 'isTTY', { value, configurable: true });
    }

    beforeEach(async () => {
      ConfigLoader.resetFallbackWarningForTests();
      consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.mocked(logger.warn).mockClear();
      loggerWarn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      setStderrTTY(true);
      await writeLocal({ version: 2, activeProfile: 'gone', profiles: {} });
    });

    afterEach(() => {
      Object.defineProperty(process.stderr, 'isTTY', { value: originalIsTTY, configurable: true });
      ConfigLoader.resetFallbackWarningForTests();
    });

    function printedWarnings(): string[] {
      return consoleError.mock.calls.map(args => String(args[0])).filter(text => text.includes('Local profile'));
    }

    it('prints the warning exactly once on a TTY when enabled', async () => {
      ConfigLoader.enableFallbackWarning();

      await ConfigLoader.listProfiles(WORKING_DIR);
      await ConfigLoader.load(WORKING_DIR);
      await ConfigLoader.getActiveProfileName(WORKING_DIR);

      expect(printedWarnings()).toEqual([chalk.yellow(WARNING)]);
      expect(loggerWarn).toHaveBeenCalledWith(WARNING);
    });

    it('does not print when stderr is not a TTY, but still logs', async () => {
      setStderrTTY(false);
      ConfigLoader.enableFallbackWarning();

      await ConfigLoader.getActiveProfileName(WORKING_DIR);

      expect(printedWarnings()).toEqual([]);
      expect(loggerWarn).toHaveBeenCalledWith(WARNING);
    });

    it('does not print when not enabled', async () => {
      await ConfigLoader.getActiveProfileName(WORKING_DIR);

      expect(printedWarnings()).toEqual([]);
      expect(loggerWarn).toHaveBeenCalledWith(WARNING);
    });

    it('does not warn for activeProfile ""', async () => {
      await writeLocal({ version: 2, activeProfile: '', profiles: {} });
      ConfigLoader.enableFallbackWarning();

      await ConfigLoader.getActiveProfileName(WORKING_DIR);

      expect(printedWarnings()).toEqual([]);
      expect(loggerWarn).not.toHaveBeenCalled();
    });

    it('does not warn with an explicit profile', async () => {
      ConfigLoader.enableFallbackWarning();

      await ConfigLoader.load(WORKING_DIR, { name: 'work' });

      expect(printedWarnings()).toEqual([]);
      expect(loggerWarn).not.toHaveBeenCalled();
    });

    it('uses the no-global-active wording when the global has no valid active profile', async () => {
      await writeGlobal({ ...GLOBAL_CONFIG, activeProfile: 'missing' });
      ConfigLoader.enableFallbackWarning();

      await ConfigLoader.getActiveProfileName(WORKING_DIR);

      expect(printedWarnings()).toEqual([
        chalk.yellow(`⚠ Local profile "gone" not found in ${LOCAL_CONFIG_PATH} and no global profile is active. Run: codemie setup`)
      ]);
    });
  });
});

describe('ConfigLoader global config writes', () => {
  const HOME_DIR = path.join(TEST_DIR, '.codemie');
  const GLOBAL_PATH = path.join(HOME_DIR, 'codemie-cli.config.json');
  const NO_LOCAL_DIR = path.join(TEST_DIR, 'no-local');

  beforeEach(async () => {
    await fs.mkdir(HOME_DIR, { recursive: true });
    await fs.mkdir(NO_LOCAL_DIR, { recursive: true });
    vi.spyOn(paths, 'getCodemieHome').mockReturnValue(HOME_DIR);
    vi.spyOn(paths, 'getCodemiePath').mockImplementation((subpath: string) => path.join(HOME_DIR, subpath));
  });

  afterEach(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it.each([
    ['a null profile entry', JSON.stringify({ version: 2, activeProfile: 'work', profiles: { work: { provider: 'sso' }, broken: null } })],
    ['a non-string activeProfile', JSON.stringify({ version: 2, activeProfile: 1, profiles: { work: { provider: 'sso' } } })],
    ['an unknown version', JSON.stringify({ version: 3, activeProfile: 'work', profiles: { work: { provider: 'sso' } } })],
    ['unparseable JSON', '{"version":2,'],
    ['a UTF-8 BOM', String.fromCharCode(0xfeff) + JSON.stringify(GLOBAL_CONFIG)]
  ])('refuses to overwrite a global file with %s and leaves it byte-identical', async (_label, content) => {
    await fs.writeFile(GLOBAL_PATH, content);

    await expect(ConfigLoader.saveProfile('new', { provider: 'sso' } as never)).rejects.toThrow(ConfigurationError);
    await expect(ConfigLoader.switchProfile('work', NO_LOCAL_DIR)).rejects.toThrow();

    expect(await fs.readFile(GLOBAL_PATH, 'utf-8')).toBe(content);
  });

  it('names the global file and says it was left unchanged', async () => {
    await fs.writeFile(GLOBAL_PATH, JSON.stringify({ version: 2, activeProfile: 'work', profiles: { broken: null } }));

    await expect(ConfigLoader.saveProfile('new', { provider: 'sso' } as never))
      .rejects.toThrow(`Global config ${GLOBAL_PATH} has an unsupported format`);
  });

  it('still creates a missing global file', async () => {
    await ConfigLoader.saveProfile('new', { provider: 'sso' } as never);

    const saved = JSON.parse(await fs.readFile(GLOBAL_PATH, 'utf-8')) as MultiProviderConfig;
    expect(saved.activeProfile).toBe('new');
  });

  it('still migrates a legacy global file to v2 on save', async () => {
    await fs.writeFile(GLOBAL_PATH, JSON.stringify({ provider: 'openai', model: 'gpt' }));

    await ConfigLoader.saveProfile('new', { provider: 'sso' } as never);

    const saved = JSON.parse(await fs.readFile(GLOBAL_PATH, 'utf-8')) as MultiProviderConfig;
    expect(Object.keys(saved.profiles).sort()).toEqual(['default', 'new']);
  });
});

describe('local config migrations', () => {
  const HOME_DIR = path.join(TEST_DIR, '.codemie');
  const DIR = path.join(TEST_DIR, 'project');
  const LOCAL_PATH = path.join(DIR, '.codemie', 'codemie-cli.config.json');

  beforeEach(async () => {
    await fs.mkdir(HOME_DIR, { recursive: true });
    await fs.mkdir(path.dirname(LOCAL_PATH), { recursive: true });
    vi.spyOn(paths, 'getCodemieHome').mockReturnValue(HOME_DIR);
    vi.spyOn(paths, 'getCodemiePath').mockImplementation((subpath: string) => path.join(HOME_DIR, subpath));
    vi.spyOn(process, 'cwd').mockReturnValue(DIR);
    await fs.writeFile(path.join(HOME_DIR, 'codemie-cli.config.json'), JSON.stringify(GLOBAL_CONFIG));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  });

  it('loadLocalMultiProviderConfig refuses an unparseable local file', async () => {
    await fs.writeFile(LOCAL_PATH, '{not json');

    await expect(ConfigLoader.loadLocalMultiProviderConfig(DIR)).rejects.toThrow(ConfigurationError);
  });

  it('loadLocalMultiProviderConfig reads a BOM-prefixed v2 file', async () => {
    const config = { version: 2, activeProfile: 'a', profiles: { a: { provider: 'sso' } } };
    await fs.writeFile(LOCAL_PATH, String.fromCharCode(0xfeff) + JSON.stringify(config));

    await expect(ConfigLoader.loadLocalMultiProviderConfig(DIR)).resolves.toEqual(config);
  });

  it('migration 004 leaves an unparseable local file byte-identical', async () => {
    const content = '{"version":2,"profiles":{"team":{"provider":"sso"}},';
    await fs.writeFile(LOCAL_PATH, content);
    const { SkillsAssistantsTopLevelMigration } = await import('../../migrations/004-skills-assistants-top-level.migration.js');

    await new SkillsAssistantsTopLevelMigration().up().catch(() => undefined);

    expect(await fs.readFile(LOCAL_PATH, 'utf-8')).toBe(content);
  });
});
