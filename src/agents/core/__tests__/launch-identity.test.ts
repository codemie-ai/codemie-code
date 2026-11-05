/**
 * Launch identity policy (EPMCDME-15411): prompt-or-warn for unowned profiles,
 * binding export, inherited identity clearing. AC4, AC5, AC6, AC7.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import { ConfigLoader } from '@/utils/config.js';
import * as paths from '@/utils/paths.js';
import { logger } from '@/utils/logger.js';
import type { MultiProviderConfig, ProviderProfile } from '@/env/types.js';
import {
  reportDaemonProfileIdentity,
  finalizeLaunchIdentity,
  resolveLaunchIdentity,
  unownedWarningText,
  type LaunchIdentity,
  type LaunchIdentityDeps,
} from '../launch-identity.js';

const TEST_DIR = path.join(process.cwd(), 'tmp-test-launch-identity');
const HOME = path.join(TEST_DIR, '.codemie');
const GLOBAL = path.join(HOME, 'codemie-cli.config.json');
const WORKING_DIR = path.join(TEST_DIR, 'work');
const ENV_KEYS = [
  'CODEMIE_PROJECT', 'CODEMIE_URL', 'CODEMIE_INTEGRATION_ID', 'CODEMIE_INTEGRATION_ALIAS',
  'CODEMIE_SYNC_API_URL', 'CODEMIE_PROJECT_BINDING', 'CODEMIE_PROFILE_CONFIG',
];

const sso = (extra: Partial<ProviderProfile> = {}): ProviderProfile => ({
  provider: 'ai-run-sso',
  baseUrl: 'https://codemie.example.com/code-assistant-api',
  model: 'm',
  apiKey: 'sso-provided',
  ...extra,
});

async function writeGlobal(activeProfile: string, profiles: Record<string, ProviderProfile>): Promise<void> {
  const config: MultiProviderConfig = {
    version: 2,
    activeProfile,
    profiles,
    workspace: { codeMieUrl: 'https://codemie.example.com', codeMieProject: 'shared-proj', codeMieIntegration: { id: 'si', alias: 's' } },
  };
  await fs.writeFile(GLOBAL, JSON.stringify(config));
}

const readGlobal = async (): Promise<MultiProviderConfig> => JSON.parse(await fs.readFile(GLOBAL, 'utf-8'));

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f]/;

const cookieAuth = { apiUrl: 'https://codemie.example.com/code-assistant-api', cookies: { s: '1' } };

describe('launch identity policy', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    await fs.mkdir(HOME, { recursive: true });
    await fs.mkdir(WORKING_DIR, { recursive: true });
    vi.spyOn(paths, 'getCodemieHome').mockReturnValue(HOME);
    vi.spyOn(paths, 'getCodemiePath').mockImplementation((p: string) => path.join(HOME, p));
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    await logger.close();
    await fs.rm(TEST_DIR, { recursive: true, force: true });
    vi.restoreAllMocks();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  describe('resolveLaunchIdentity', () => {
    it('an own profile is neither prompted nor warned', async () => {
      await writeGlobal('a', { a: sso({ codeMieProject: 'pa' }), b: sso() });
      const prompt = vi.fn();
      const config = await ConfigLoader.load(WORKING_DIR, { name: 'a' });
      const launch = await resolveLaunchIdentity(config, { workingDir: WORKING_DIR, canPrompt: true, surface: 'agent' }, { prompt });
      expect(launch).toMatchObject({ state: 'own', needsWarning: false });
      expect(prompt).not.toHaveBeenCalled();
    });

    it('a cannot-prompt unowned launch warns and keeps the shared project (AC5)', async () => {
      await writeGlobal('a', { a: sso(), b: sso({ codeMieProject: 'pb' }) });
      const prompt = vi.fn();
      const config = await ConfigLoader.load(WORKING_DIR, { name: 'a' });
      const launch = await resolveLaunchIdentity(config, { workingDir: WORKING_DIR, canPrompt: false, surface: 'agent' }, { prompt });
      expect(launch).toMatchObject({ state: 'unowned', needsWarning: true, profileName: 'a' });
      expect(prompt).not.toHaveBeenCalled();
      expect(config.codeMieProject).toBe('shared-proj');
    });

    it('an interactive pick bills the pick, saves only this profile and is never asked again (AC4)', async () => {
      await writeGlobal('a', { a: sso(), b: sso() });
      const deps: LaunchIdentityDeps = {
        resolveAuth: vi.fn(async () => cookieAuth),
        prompt: vi.fn(async () => ({ kind: 'picked' as const, project: 'mine', integration: { id: 'mi', alias: 'm' } })),
      };
      const config = await ConfigLoader.load(WORKING_DIR, { name: 'a' });
      const launch = await resolveLaunchIdentity(config, { workingDir: WORKING_DIR, canPrompt: true, surface: 'agent' }, deps);

      expect(launch).toMatchObject({ state: 'own', needsWarning: false });
      expect(config.codeMieProject).toBe('mine');
      expect(config.codeMieIntegration).toEqual({ id: 'mi', alias: 'm' });
      const stored = await readGlobal();
      expect(stored.profiles.a).toMatchObject({ codeMieProject: 'mine', codeMieUrl: 'https://codemie.example.com', codeMieIntegration: { id: 'mi' } });
      expect(stored.profiles.b.codeMieProject).toBeUndefined();
      expect(stored.workspace?.codeMieProject).toBe('shared-proj');

      const again = await resolveLaunchIdentity(await ConfigLoader.load(WORKING_DIR, { name: 'a' }),
        { workingDir: WORKING_DIR, canPrompt: true, surface: 'agent' }, deps);
      expect(again.state).toBe('own');
      expect(deps.prompt).toHaveBeenCalledTimes(1);
    });

    describe('saved URL is the host that served the project list (PR #758 review, finding 2)', () => {
      const pick: LaunchIdentityDeps['prompt'] = async () => ({ kind: 'picked', project: 'mine' });
      const listedFrom = (resolveAuth: ReturnType<typeof vi.fn>): string =>
        new URL((resolveAuth.mock.calls[0][0] as { baseUrl: string }).baseUrl).host;

      it('a profile on env A with the shared URL on env B saves A, not B', async () => {
        await writeGlobal('a', { a: sso({ baseUrl: 'https://codemie-preview.example.com/code-assistant-api' }) });
        const resolveAuth = vi.fn(async (c: { baseUrl?: string }) => ({ apiUrl: c.baseUrl!, cookies: { s: '1' } }));
        const config = await ConfigLoader.load(WORKING_DIR, { name: 'a' });
        expect(config.codeMieUrl).toBe('https://codemie.example.com'); // merged shared URL before the pick

        await resolveLaunchIdentity(config, { workingDir: WORKING_DIR, canPrompt: true, surface: 'agent' }, { resolveAuth, prompt: pick });

        expect(listedFrom(resolveAuth)).toBe('codemie-preview.example.com');
        expect((await readGlobal()).profiles.a.codeMieUrl).toBe('https://codemie-preview.example.com');
        expect(config.codeMieUrl).toBe('https://codemie-preview.example.com');
        const next = await ConfigLoader.resolveProfileIdentity(WORKING_DIR, 'a');
        expect(next).toMatchObject({ state: 'own', identity: { codeMieUrl: 'https://codemie-preview.example.com', codeMieProject: 'mine' } });
      });

      it('an exported CODEMIE_URL on an active unowned profile (no --profile) is not saved', async () => {
        await writeGlobal('a', { a: sso() });
        process.env.CODEMIE_URL = 'https://exported.example.com';
        const config = await ConfigLoader.load(WORKING_DIR);
        expect(config.codeMieUrl).toBe('https://exported.example.com');

        await resolveLaunchIdentity(config, { workingDir: WORKING_DIR, canPrompt: true, surface: 'agent' }, {
          resolveAuth: async () => cookieAuth,
          prompt: pick,
        });

        expect((await readGlobal()).profiles.a.codeMieUrl).toBe('https://codemie.example.com');
      });

      it("an unowned profile's own stored URL is kept", async () => {
        await writeGlobal('a', { a: sso({ codeMieUrl: 'https://own.example.com' }) });
        const config = await ConfigLoader.load(WORKING_DIR, { name: 'a' });
        await resolveLaunchIdentity(config, { workingDir: WORKING_DIR, canPrompt: true, surface: 'agent' }, {
          resolveAuth: async () => cookieAuth,
          prompt: pick,
        });
        expect((await readGlobal()).profiles.a.codeMieUrl).toBe('https://own.example.com');
      });

      it('a subscription profile lists and saves with the persisted shared URL, never an exported one', async () => {
        await writeGlobal('p', { p: { provider: 'anthropic-subscription', model: 'sonnet' } });
        process.env.CODEMIE_URL = 'https://exported.example.com';
        const resolveAuth = vi.fn(async () => cookieAuth);
        const config = await ConfigLoader.load(WORKING_DIR);
        expect(config.codeMieUrl).toBe('https://exported.example.com');

        await resolveLaunchIdentity(config, { workingDir: WORKING_DIR, canPrompt: true, surface: 'agent' }, { resolveAuth, prompt: pick });

        expect(resolveAuth.mock.calls[0][0]).toMatchObject({ codeMieUrl: 'https://codemie.example.com' });
        expect((await readGlobal()).profiles.p.codeMieUrl).toBe('https://codemie.example.com');
      });
    });

    it('the shared integration is not kept when the pick has no integration', async () => {
      await writeGlobal('a', { a: sso(), b: sso() });
      const config = await ConfigLoader.load(WORKING_DIR, { name: 'a' });
      expect(config.codeMieIntegration).toEqual({ id: 'si', alias: 's' });
      await resolveLaunchIdentity(config, { workingDir: WORKING_DIR, canPrompt: true, surface: 'agent' }, {
        resolveAuth: async () => cookieAuth,
        prompt: async () => ({ kind: 'picked', project: 'mine' }),
      });
      expect(config.codeMieIntegration).toBeUndefined();
      expect((await readGlobal()).profiles.a.codeMieIntegration).toBeUndefined();
    });

    it('"Keep this profile off CodeMie" saves null and drops identity from this session (AC4/AC6)', async () => {
      await writeGlobal('p', {
        p: { provider: 'anthropic-subscription', model: 'sonnet', codeMieUrl: 'https://codemie.example.com' },
        w: sso({ codeMieProject: 'w' }),
      });
      const config = await ConfigLoader.load(WORKING_DIR, { name: 'p' });
      const launch = await resolveLaunchIdentity(config, { workingDir: WORKING_DIR, canPrompt: true, surface: 'agent' }, {
        resolveAuth: async () => cookieAuth,
        prompt: async () => ({ kind: 'off' }),
      });
      expect(launch.state).toBe('none');
      expect(config.codeMieUrl).toBeUndefined();
      expect(config.codeMieProject).toBeUndefined();
      const env = ConfigLoader.exportProviderEnvVars(config);
      expect(env.CODEMIE_URL).toBeUndefined();
      expect(env.CODEMIE_SYNC_API_URL).toBeUndefined();
      expect((await readGlobal()).profiles.p).toMatchObject({ codeMieProject: null });
      expect((await readGlobal()).profiles.p.codeMieUrl).toBeUndefined();
    });

    it('a fetch failure (unavailable) saves nothing and takes the warning path', async () => {
      await writeGlobal('a', { a: sso(), b: sso() });
      const before = await fs.readFile(GLOBAL, 'utf-8');
      const config = await ConfigLoader.load(WORKING_DIR, { name: 'a' });
      const launch = await resolveLaunchIdentity(config, { workingDir: WORKING_DIR, canPrompt: true, surface: 'agent' }, {
        resolveAuth: async () => cookieAuth,
        prompt: async () => ({ kind: 'unavailable', reason: 'integration-list-failed' }),
      });
      expect(launch).toMatchObject({ state: 'unowned', needsWarning: true });
      expect(await fs.readFile(GLOBAL, 'utf-8')).toBe(before);
    });

    it('no credential for the profile host: no prompt, warning path', async () => {
      await writeGlobal('a', { a: sso(), b: sso() });
      const prompt = vi.fn();
      const config = await ConfigLoader.load(WORKING_DIR, { name: 'a' });
      const launch = await resolveLaunchIdentity(config, { workingDir: WORKING_DIR, canPrompt: true, surface: 'agent' }, {
        resolveAuth: async () => undefined,
        prompt,
      });
      expect(launch.needsWarning).toBe(true);
      expect(prompt).not.toHaveBeenCalled();
    });

    it('proxy and hook surfaces never prompt', async () => {
      await writeGlobal('a', { a: sso(), b: sso() });
      const prompt = vi.fn();
      for (const surface of ['proxy', 'hook'] as const) {
        const config = await ConfigLoader.load(WORKING_DIR, { name: 'a' });
        const launch = await resolveLaunchIdentity(config, { workingDir: WORKING_DIR, canPrompt: true, surface }, { prompt });
        expect(launch.needsWarning).toBe(true);
      }
      expect(prompt).not.toHaveBeenCalled();
    });

    it('litellm / bedrock / ollama: not-applicable, no prompt and no warning (AC7)', async () => {
      await writeGlobal('l', { l: { provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'q' }, b: sso() });
      const config = await ConfigLoader.load(WORKING_DIR, { name: 'l' });
      const launch = await resolveLaunchIdentity(config, { workingDir: WORKING_DIR, canPrompt: true, surface: 'agent' });
      expect(launch).toMatchObject({ state: 'not-applicable', needsWarning: false });
    });
  });

  describe('reportDaemonProfileIdentity (proxy connect/start/restart, hook cold start)', () => {
    it('proxy: an unowned profile warns once on stderr naming the shared project; nothing is saved', async () => {
      await writeGlobal('a', { a: sso(), b: sso() });
      const before = await fs.readFile(GLOBAL, 'utf-8');
      const writes: string[] = [];
      const config = await ConfigLoader.load(WORKING_DIR, { name: 'a' });
      const state = await reportDaemonProfileIdentity(config, 'proxy', WORKING_DIR, { writeStderr: (t) => writes.push(t) });
      expect(state).toBe('unowned');
      expect(writes).toHaveLength(1);
      expect(writes[0]).toContain('"shared-proj"');
      expect(await fs.readFile(GLOBAL, 'utf-8')).toBe(before);
    });

    it('proxy: an own profile does not warn and its project is the daemon project', async () => {
      await writeGlobal('a', { a: sso({ codeMieProject: 'mine' }), b: sso() });
      const writes: string[] = [];
      const config = await ConfigLoader.load(WORKING_DIR, { name: 'a' });
      expect(await reportDaemonProfileIdentity(config, 'proxy', WORKING_DIR, { writeStderr: (t) => writes.push(t) })).toBe('own');
      expect(config.codeMieProject).toBe('mine');
      expect(writes).toHaveLength(0);
    });

    it('hook: only logs, never writes to stderr', async () => {
      await writeGlobal('a', { a: sso(), b: sso() });
      const writes: string[] = [];
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const config = await ConfigLoader.load(WORKING_DIR, { name: 'a' });
      await reportDaemonProfileIdentity(config, 'hook', WORKING_DIR, { writeStderr: (t) => writes.push(t) });
      expect(writes).toHaveLength(0);
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });

  describe('finalizeLaunchIdentity', () => {
    const launch = (state: LaunchIdentity['state'], needsWarning = false): LaunchIdentity => ({
      state, needsWarning, profileName: 'mtlx-csd', surface: 'agent', isJwt: false,
    });

    it('exports the binding and overwrites an inherited one', () => {
      const env: NodeJS.ProcessEnv = { CODEMIE_PROJECT_BINDING: 'own' };
      const providerEnv: Record<string, string> = {};
      finalizeLaunchIdentity(launch('unowned'), providerEnv, {}, env);
      expect(providerEnv.CODEMIE_PROJECT_BINDING).toBe('unowned');
      expect(env.CODEMIE_PROJECT_BINDING).toBeUndefined();
    });

    it('an own profile never receives an inherited CODEMIE_PROJECT or integration (AC7)', () => {
      const env: NodeJS.ProcessEnv = {
        CODEMIE_PROJECT: 'inherited', CODEMIE_INTEGRATION_ID: 'inh', CODEMIE_URL: 'https://inh', CODEMIE_SYNC_API_URL: 'https://inh/api',
      };
      const providerEnv: Record<string, string> = { CODEMIE_PROJECT: 'mine', CODEMIE_URL: 'https://mine' };
      finalizeLaunchIdentity(launch('own'), providerEnv, {}, env);
      expect(env.CODEMIE_PROJECT).toBe('inherited'); // overridden by providerEnv when merged
      expect(env.CODEMIE_INTEGRATION_ID).toBeUndefined();
      expect(env.CODEMIE_SYNC_API_URL).toBeUndefined();
      const merged = { ...env, ...providerEnv };
      expect(merged.CODEMIE_PROJECT).toBe('mine');
      expect(merged.CODEMIE_URL).toBe('https://mine');
    });

    it('a none profile exports no project, URL, integration or sync URL even when inherited (AC6)', () => {
      const env: NodeJS.ProcessEnv = {
        CODEMIE_PROJECT: 'x', CODEMIE_URL: 'https://x', CODEMIE_INTEGRATION_ID: 'x', CODEMIE_INTEGRATION_ALIAS: 'x', CODEMIE_SYNC_API_URL: 'https://x',
      };
      finalizeLaunchIdentity(launch('none'), {}, {}, env);
      for (const key of ['CODEMIE_PROJECT', 'CODEMIE_URL', 'CODEMIE_INTEGRATION_ID', 'CODEMIE_INTEGRATION_ALIAS', 'CODEMIE_SYNC_API_URL']) {
        expect(env[key]).toBeUndefined();
      }
    });

    it('an unowned profile keeps the pass-through and writes exactly one stderr warning naming the project used (AC5)', () => {
      const writes: string[] = [];
      const env: NodeJS.ProcessEnv = {};
      finalizeLaunchIdentity(launch('unowned', true), { CODEMIE_PROJECT: 'shared-proj' }, { writeStderr: (t) => writes.push(t) }, env);
      expect(writes).toHaveLength(1);
      expect(writes[0]).toContain('"mtlx-csd"');
      expect(writes[0]).toContain('"shared-proj"');
      expect(writes[0]).toContain('launch this profile once in a terminal, or run `codemie setup`');
    });

    it('names the inherited project, or none, when the profile resolves no project', () => {
      const writes: string[] = [];
      finalizeLaunchIdentity(launch('unowned', true), {}, { writeStderr: (t) => writes.push(t) }, { CODEMIE_PROJECT: 'from-shell' });
      finalizeLaunchIdentity(launch('unowned', true), {}, { writeStderr: (t) => writes.push(t) }, {});
      expect(writes[0]).toContain('"from-shell"');
      expect(writes[1]).toContain('uses project none');
    });

    it('a JWT profile gets the token-specific fix', () => {
      expect(unownedWarningText('ci', 'p', true)).toContain('run `codemie setup` with your token available');
    });

    it('the hook surface only logs', () => {
      const writes: string[] = [];
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      finalizeLaunchIdentity({ ...launch('unowned', true), surface: 'hook' }, {}, { writeStderr: (t) => writes.push(t) }, {});
      expect(writes).toHaveLength(0);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('strips control characters from names in the warning', () => {
      expect(unownedWarningText('a\u001b[2Jb', 'p\u0007', false).trimEnd()).not.toMatch(CONTROL_CHARS);
    });
  });
});
