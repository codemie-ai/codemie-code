/**
 * Per-profile CodeMie identity for global profiles (EPMCDME-15411 / EPMCDME-16519).
 *
 * Every case uses at least two global profiles, on the same CodeMie URL and on
 * different URLs, because the reported defect was one profile billing another
 * profile's project.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import { ConfigLoader } from '../config.js';
import type { MultiProviderConfig, ProviderProfile, WorkspaceConfig } from '../../env/types.js';
import * as paths from '../paths.js';
import { logger } from '../logger.js';

const TEST_DIR = path.join(process.cwd(), 'tmp-test-per-profile-identity');
const GLOBAL_CONFIG_DIR = path.join(TEST_DIR, '.codemie');
const GLOBAL_CONFIG_PATH = path.join(GLOBAL_CONFIG_DIR, 'codemie-cli.config.json');
const WORKING_DIR = path.join(TEST_DIR, 'project');
const LOCAL_CONFIG_PATH = path.join(WORKING_DIR, '.codemie', 'codemie-cli.config.json');

const IDENTITY_ENV = [
  'CODEMIE_URL',
  'CODEMIE_INTEGRATION_ID',
  'CODEMIE_INTEGRATION_ALIAS',
  'CODEMIE_PROJECT',
  'CODEMIE_PROVIDER',
  'CODEMIE_MODEL',
  'CODEMIE_BASE_URL',
  'CODEMIE_API_KEY',
  'CODEMIE_PROFILE_CONFIG',
];

const SHARED: WorkspaceConfig = {
  codeMieUrl: 'https://codemie.example.com',
  codeMieProject: 'mtlx-amsd',
  codeMieIntegration: { id: 'int-amsd', alias: 'amsd' },
};

async function writeGlobal(
  activeProfile: string,
  profiles: Record<string, ProviderProfile>,
  workspace: WorkspaceConfig | undefined = SHARED
): Promise<void> {
  const config: MultiProviderConfig = { version: 2, activeProfile, profiles, ...(workspace ? { workspace } : {}) };
  await fs.writeFile(GLOBAL_CONFIG_PATH, JSON.stringify(config, null, 2));
}

async function readGlobal(): Promise<MultiProviderConfig> {
  return JSON.parse(await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8')) as MultiProviderConfig;
}

const sso = (extra: Partial<ProviderProfile> = {}): ProviderProfile => ({
  provider: 'ai-run-sso',
  baseUrl: 'https://codemie.example.com/code-assistant-api',
  model: 'claude-sonnet-4-6',
  apiKey: 'sso-provided',
  ...extra,
});

describe('ConfigLoader — per-profile CodeMie identity (EPMCDME-15411)', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    await fs.mkdir(GLOBAL_CONFIG_DIR, { recursive: true });
    await fs.mkdir(path.dirname(LOCAL_CONFIG_PATH), { recursive: true });
    vi.spyOn(paths, 'getCodemieHome').mockReturnValue(GLOBAL_CONFIG_DIR);
    vi.spyOn(paths, 'getCodemiePath').mockImplementation((subpath: string) => path.join(GLOBAL_CONFIG_DIR, subpath));
    for (const key of IDENTITY_ENV) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(async () => {
    await logger.close();
    await fs.rm(TEST_DIR, { recursive: true, force: true });
    vi.restoreAllMocks();
    for (const key of IDENTITY_ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  describe('AC1 — two global profiles on the same URL', () => {
    beforeEach(async () => {
      await writeGlobal('mtlx-amsd', {
        'mtlx-amsd': sso({ codeMieUrl: SHARED.codeMieUrl, codeMieProject: 'mtlx-amsd', codeMieIntegration: { id: 'int-amsd', alias: 'amsd' } }),
        'mtlx-csd': sso({ codeMieUrl: SHARED.codeMieUrl, codeMieProject: 'mtlx-csd', codeMieIntegration: { id: 'int-csd', alias: 'csd' } }),
      });
    });

    it('each profile resolves and exports its own project via --profile', async () => {
      const csd = await ConfigLoader.load(WORKING_DIR, { name: 'mtlx-csd' });
      expect(csd.codeMieProject).toBe('mtlx-csd');
      expect(csd.codeMieIntegration).toEqual({ id: 'int-csd', alias: 'csd' });
      expect(ConfigLoader.exportProviderEnvVars(csd).CODEMIE_PROJECT).toBe('mtlx-csd');
      expect(ConfigLoader.exportProviderEnvVars(csd).CODEMIE_INTEGRATION_ID).toBe('int-csd');

      const amsd = await ConfigLoader.load(WORKING_DIR, { name: 'mtlx-amsd' });
      expect(amsd.codeMieProject).toBe('mtlx-amsd');
      expect(ConfigLoader.exportProviderEnvVars(amsd).CODEMIE_PROJECT).toBe('mtlx-amsd');
    });

    it('the active profile without --profile resolves its own project too', async () => {
      const active = await ConfigLoader.load(WORKING_DIR);
      expect(active.name).toBe('mtlx-amsd');
      expect(active.codeMieProject).toBe('mtlx-amsd');
    });

    it('saving A never changes B, and switching A → B → A restores A', async () => {
      await ConfigLoader.saveProfile('mtlx-amsd', sso({
        codeMieUrl: SHARED.codeMieUrl,
        codeMieProject: 'mtlx-amsd-2',
        codeMieIntegration: { id: 'int-amsd-2', alias: 'amsd2' },
      }));
      const after = await readGlobal();
      expect(after.profiles['mtlx-csd'].codeMieProject).toBe('mtlx-csd');
      expect(after.profiles['mtlx-csd'].codeMieIntegration).toEqual({ id: 'int-csd', alias: 'csd' });
      // The shared workspace identity is frozen: never written, never deleted.
      expect(after.workspace).toEqual(SHARED);

      await ConfigLoader.switchProfile('mtlx-csd', WORKING_DIR);
      expect((await ConfigLoader.load(WORKING_DIR)).codeMieProject).toBe('mtlx-csd');
      await ConfigLoader.switchProfile('mtlx-amsd', WORKING_DIR);
      expect((await ConfigLoader.load(WORKING_DIR)).codeMieProject).toBe('mtlx-amsd-2');
    });

    it('an update that omits identity keeps the stored values', async () => {
      await ConfigLoader.saveProfile('mtlx-csd', sso({ model: 'claude-opus-4-6', codeMieProject: undefined }));
      const stored = (await readGlobal()).profiles['mtlx-csd'];
      expect(stored.model).toBe('claude-opus-4-6');
      expect(stored.codeMieProject).toBe('mtlx-csd');
      expect(stored.codeMieUrl).toBe(SHARED.codeMieUrl);
      expect(stored.codeMieIntegration).toEqual({ id: 'int-csd', alias: 'csd' });
    });

    it('an update that supplies identity replaces the trio atomically (no stale integration)', async () => {
      await ConfigLoader.saveProfile('mtlx-csd', sso({ codeMieUrl: SHARED.codeMieUrl, codeMieProject: 'other' }));
      const stored = (await readGlobal()).profiles['mtlx-csd'];
      expect(stored.codeMieProject).toBe('other');
      expect(stored.codeMieIntegration).toBeUndefined();
    });
  });

  describe('AC2 — two global profiles on different URLs', () => {
    it('URL, project and integration all resolve per profile', async () => {
      await writeGlobal('prod', {
        prod: sso({ codeMieUrl: 'https://prod.example.com', codeMieProject: 'p-prod', codeMieIntegration: { id: 'i-prod', alias: 'prod' } }),
        dev: sso({ baseUrl: 'https://dev.example.com/code-assistant-api', codeMieUrl: 'https://dev.example.com', codeMieProject: 'p-dev' }),
      });

      const prod = await ConfigLoader.load(WORKING_DIR, { name: 'prod' });
      expect(prod).toMatchObject({ codeMieUrl: 'https://prod.example.com', codeMieProject: 'p-prod', codeMieIntegration: { id: 'i-prod' } });

      const dev = await ConfigLoader.load(WORKING_DIR, { name: 'dev' });
      expect(dev.codeMieUrl).toBe('https://dev.example.com');
      expect(dev.codeMieProject).toBe('p-dev');
      // An `own` profile never inherits the shared integration.
      expect(dev.codeMieIntegration).toBeUndefined();
    });

    it('an own profile without a URL of its own takes the shared URL only', async () => {
      await writeGlobal('a', { a: sso({ codeMieProject: 'pa' }), b: sso({ codeMieProject: 'pb' }) });
      const a = await ConfigLoader.resolveProfileIdentity(WORKING_DIR, 'a');
      expect(a.state).toBe('own');
      expect(a.identity).toEqual({ codeMieUrl: SHARED.codeMieUrl, codeMieProject: 'pa' });
    });
  });

  describe('AC3 — upgraded profiles are unowned, none gets the shared project as its own', () => {
    it('every project-carrying profile without its own project is unowned (including a sole one)', async () => {
      await writeGlobal('a', { a: sso(), b: sso() });
      for (const name of ['a', 'b']) {
        const r = await ConfigLoader.resolveProfileIdentity(WORKING_DIR, name);
        expect(r.state).toBe('unowned');
        expect(r.identity.codeMieProject).toBe('mtlx-amsd');
      }
      // Reading never writes a project onto a profile.
      const stored = await readGlobal();
      expect(stored.profiles.a.codeMieProject).toBeUndefined();
      expect(stored.profiles.b.codeMieProject).toBeUndefined();

      await writeGlobal('solo', { solo: sso() });
      expect((await ConfigLoader.resolveProfileIdentity(WORKING_DIR, 'solo')).state).toBe('unowned');
    });
  });

  describe('AC6 — a none profile stays off CodeMie', () => {
    it('exports no project, integration or URL even when its record still holds a URL', async () => {
      await writeGlobal('personal', {
        personal: { provider: 'anthropic-subscription', model: 'sonnet', codeMieProject: null, codeMieUrl: 'https://stale.example.com' },
        work: sso({ codeMieProject: 'work' }),
      });
      const config = await ConfigLoader.load(WORKING_DIR, { name: 'personal' });
      expect('codeMieProject' in config).toBe(false);
      expect(config.codeMieUrl).toBeUndefined();
      expect(config.codeMieIntegration).toBeUndefined();
      const env = ConfigLoader.exportProviderEnvVars(config);
      expect(env.CODEMIE_PROJECT).toBeUndefined();
      expect(env.CODEMIE_URL).toBeUndefined();
      expect(env.CODEMIE_SYNC_API_URL).toBeUndefined();
      expect(JSON.parse(JSON.stringify(config))).not.toHaveProperty('codeMieProject');
    });

    it('ignores an exported CODEMIE_URL / CODEMIE_INTEGRATION_ID for the active none profile (no --profile)', async () => {
      await writeGlobal('personal', {
        personal: { provider: 'anthropic-subscription', model: 'sonnet', codeMieProject: null },
        work: sso({ codeMieProject: 'work' }),
      });
      process.env.CODEMIE_URL = 'https://inherited.example.com';
      process.env.CODEMIE_INTEGRATION_ID = 'inherited';
      const config = await ConfigLoader.load(WORKING_DIR);
      expect(config.name).toBe('personal');
      expect(config.codeMieUrl).toBeUndefined();
      expect(config.codeMieIntegration).toBeUndefined();
    });

    it('a null save drops the stored URL and integration', async () => {
      await writeGlobal('a', { a: sso({ codeMieProject: 'pa', codeMieUrl: 'https://x', codeMieIntegration: { id: 'i', alias: 'a' } }), b: sso() });
      await ConfigLoader.saveProfileIdentity('a', null);
      expect((await readGlobal()).profiles.a).toMatchObject({ codeMieProject: null });
      expect((await readGlobal()).profiles.a.codeMieUrl).toBeUndefined();
      expect((await readGlobal()).profiles.a.codeMieIntegration).toBeUndefined();
    });
  });

  describe('AC7 — inherited identity and providers without a project', () => {
    it('an own profile never receives an inherited CODEMIE_INTEGRATION_ID or CODEMIE_URL (active profile)', async () => {
      await writeGlobal('dev', {
        dev: sso({ codeMieUrl: 'https://dev.example.com', codeMieProject: 'p-dev' }),
        prod: sso({ codeMieProject: 'p-prod' }),
      });
      process.env.CODEMIE_URL = 'https://other.example.com';
      process.env.CODEMIE_INTEGRATION_ID = 'int-other';
      const config = await ConfigLoader.load(WORKING_DIR);
      expect(config.codeMieUrl).toBe('https://dev.example.com');
      expect(config.codeMieIntegration).toBeUndefined();
    });

    it('litellm/bedrock/ollama resolve the shared identity as before (not-applicable)', async () => {
      await writeGlobal('lite', {
        lite: { provider: 'litellm', baseUrl: 'http://localhost:4000', model: 'gpt' },
        work: sso({ codeMieProject: 'work' }),
      });
      const r = await ConfigLoader.resolveProfileIdentity(WORKING_DIR, 'lite');
      expect(r.state).toBe('not-applicable');
      expect(r.identity.codeMieProject).toBe('mtlx-amsd');
      expect((await ConfigLoader.load(WORKING_DIR, { name: 'lite' })).codeMieProject).toBe('mtlx-amsd');
    });
  });

  describe('AC9 — local profiles and repo-local workspace are unchanged', () => {
    it('a local profile with a local workspace project keeps the repository identity', async () => {
      await writeGlobal('g', { g: sso({ codeMieProject: 'global-own' }), h: sso() });
      await fs.writeFile(LOCAL_CONFIG_PATH, JSON.stringify({
        version: 2,
        activeProfile: 'team',
        profiles: { team: sso() },
        workspace: { codeMieProject: 'repo-proj', codeMieUrl: 'https://repo.example.com' },
      }));
      const r = await ConfigLoader.resolveProfileIdentity(WORKING_DIR);
      expect(r.state).toBe('local');
      const config = await ConfigLoader.load(WORKING_DIR);
      expect(config.codeMieProject).toBe('repo-proj');
      expect(config.codeMieUrl).toBe('https://repo.example.com');
    });

    it('a global profile beside a repo-local workspace keeps its own project', async () => {
      await writeGlobal('g', { g: sso({ codeMieProject: 'global-own' }), h: sso() });
      await fs.writeFile(LOCAL_CONFIG_PATH, JSON.stringify({
        version: 2,
        activeProfile: 'team',
        profiles: { team: sso() },
        workspace: { codeMieProject: 'repo-proj' },
      }));
      expect((await ConfigLoader.load(WORKING_DIR, { name: 'g' })).codeMieProject).toBe('global-own');
    });

    it('a same-named global own profile supplies identity when the local scope has no project', async () => {
      await writeGlobal('g', { g: sso({ codeMieProject: 'global-own', codeMieIntegration: { id: 'gi', alias: 'g' } }), h: sso() });
      await fs.writeFile(LOCAL_CONFIG_PATH, JSON.stringify({
        version: 2,
        activeProfile: 'g',
        profiles: { g: sso({ model: 'local-model' }) },
      }));
      const config = await ConfigLoader.load(WORKING_DIR);
      expect(config.model).toBe('local-model');
      expect(config.codeMieProject).toBe('global-own');
      expect(config.codeMieIntegration).toEqual({ id: 'gi', alias: 'g' });
    });

    it('regression: active-profile load() callers without a profile name see an own/none profile identity', async () => {
      await writeGlobal('b', { a: sso({ codeMieProject: 'pa' }), b: sso({ codeMieProject: 'pb' }) });
      const config = await ConfigLoader.load(WORKING_DIR);
      expect(config.name).toBe('b');
      expect(config.codeMieProject).toBe('pb');
    });
  });

  describe('profile status --show-sources', () => {
    it('labels an own profile identity with the profile source', async () => {
      await writeGlobal('a', { a: sso({ codeMieProject: 'pa' }), b: sso() });
      const { sources } = await ConfigLoader.loadWithSources(WORKING_DIR);
      expect(sources.codeMieProject).toEqual({ value: 'pa', source: 'profile' });
    });

    it('labels an unowned profile identity with the global (shared) source', async () => {
      await writeGlobal('b', { a: sso({ codeMieProject: 'pa' }), b: sso() });
      const { sources } = await ConfigLoader.loadWithSources(WORKING_DIR);
      expect(sources.codeMieProject).toEqual({ value: 'mtlx-amsd', source: 'global' });
    });
  });

  describe('global config writes', () => {
    it('a saved config always carries a workspace key, so migration 007 never re-runs over it', async () => {
      await ConfigLoader.saveProfile('fresh', sso({ codeMieProject: 'p' }));
      expect((await readGlobal()).workspace).toEqual({});
    });

    it('saveProfileIdentity does nothing when the profile is gone', async () => {
      await writeGlobal('a', { a: sso() });
      expect(await ConfigLoader.saveProfileIdentity('missing', { codeMieProject: 'x' })).toBe(false);
      expect(Object.keys((await readGlobal()).profiles)).toEqual(['a']);
    });

    it('refuses to overwrite an unparsable global config', async () => {
      await fs.writeFile(GLOBAL_CONFIG_PATH, '{ not json');
      await expect(ConfigLoader.saveProfile('a', sso())).rejects.toThrow(/not valid JSON/);
      expect(await fs.readFile(GLOBAL_CONFIG_PATH, 'utf-8')).toBe('{ not json');
    });

    it('keeps the existing file mode and leaves no temp file', async () => {
      await writeGlobal('a', { a: sso() });
      if (process.platform !== 'win32') await fs.chmod(GLOBAL_CONFIG_PATH, 0o600);
      await ConfigLoader.saveProfileIdentity('a', { codeMieProject: 'pa' });
      if (process.platform !== 'win32') {
        expect((await fs.stat(GLOBAL_CONFIG_PATH)).mode & 0o777).toBe(0o600);
      }
      expect((await fs.readdir(GLOBAL_CONFIG_DIR)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    });
  });
});
