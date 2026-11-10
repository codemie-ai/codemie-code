/**
 * resolveHookAuthProfile - which profile the hook SSO gate checks (EPMCDME-16308).
 *
 * Uses the real ConfigLoader against temp dirs: a global config whose active profile is a
 * Preview environment, and a repo-local config holding the Production profile the session
 * was launched with.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigLoader } from '@/utils/config.js';
import * as paths from '@/utils/paths.js';
import { logger } from '@/utils/logger.js';
import { resolveHookAuthProfile } from '../hook-auth-profile.js';

const PROD_BASE_URL = 'https://prod.example/code-assistant-api';
const PROD_SSO_URL = 'https://prod.example';
const PREVIEW_BASE_URL = 'https://preview.example/code-assistant-api';
const PREVIEW_SSO_URL = 'https://preview.example';

const PROD_PROFILE = { provider: 'ai-run-sso', baseUrl: PROD_BASE_URL, codeMieUrl: PROD_SSO_URL };
const PREVIEW_PROFILE = { provider: 'ai-run-sso', baseUrl: PREVIEW_BASE_URL, codeMieUrl: PREVIEW_SSO_URL };

describe('resolveHookAuthProfile', () => {
  let tempBase: string;
  let globalHome: string;
  let repoRoot: string;
  let nestedDir: string;
  let outsideDir: string;

  async function writeConfig(dir: string, activeProfile: string, profiles: Record<string, unknown>): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'codemie-cli.config.json'),
      JSON.stringify({ version: 2, activeProfile, profiles }, null, 2)
    );
  }

  beforeEach(async () => {
    tempBase = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-auth-profile-'));
    globalHome = path.join(tempBase, 'home', '.codemie');
    repoRoot = path.join(tempBase, 'repo');
    nestedDir = path.join(repoRoot, 'tools', 'cli-analytics-smoke');
    // A directory with no local config in it or in any ancestor below the temp root.
    outsideDir = path.join(tempBase, 'outside');
    await fs.mkdir(nestedDir, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });

    // The walk-up would otherwise climb out of the temp dir into the real home directory and treat the
    // developer's real ~/.codemie config as a local one.
    const realHasLocalConfig = ConfigLoader.hasLocalConfig.bind(ConfigLoader);
    vi.spyOn(ConfigLoader, 'hasLocalConfig').mockImplementation(
      async (dir?: string) => Boolean(dir?.startsWith(tempBase)) && realHasLocalConfig(dir)
    );
    vi.spyOn(paths, 'getCodemieHome').mockReturnValue(globalHome);
    vi.spyOn(paths, 'getCodemiePath').mockImplementation((subpath: string) => path.join(globalHome, subpath));
    // Tests may run inside a codemie session whose env (loopback CODEMIE_BASE_URL, CODEMIE_URL, ...)
    // ConfigLoader would apply on top of the configs seeded below.
    for (const name of Object.keys(process.env).filter((key) => key.startsWith('CODEMIE_'))) {
      vi.stubEnv(name, '');
      delete process.env[name];
    }

    await writeConfig(globalHome, 'standalone-qa', { 'standalone-qa': PREVIEW_PROFILE });
    await writeConfig(path.join(repoRoot, '.codemie'), 'control plane', { 'control plane': PROD_PROFILE });
  });

  afterEach(async () => {
    await fs.rm(tempBase, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe('launch profile from env', () => {
    it('returns provider, baseUrl and ssoUrl from CODEMIE_PROFILE_CONFIG regardless of cwd', async () => {
      const env = { CODEMIE_PROFILE_CONFIG: JSON.stringify(PROD_PROFILE) };
      // Outside the repo, so the only config cwd can see is the global Preview profile.

      const profile = await resolveHookAuthProfile(env, outsideDir);

      expect(profile).toEqual({ provider: 'ai-run-sso', baseUrl: PROD_BASE_URL, ssoUrl: PROD_SSO_URL });
    });

    it('uses baseUrl as ssoUrl when the profile has no codeMieUrl', async () => {
      const env = { CODEMIE_PROFILE_CONFIG: JSON.stringify({ provider: 'ai-run-sso', baseUrl: PROD_BASE_URL }) };

      const profile = await resolveHookAuthProfile(env, nestedDir);

      expect(profile.ssoUrl).toBe(PROD_BASE_URL);
    });

    it('returns non-SSO profiles unchanged', async () => {
      const env = { CODEMIE_PROFILE_CONFIG: JSON.stringify({ provider: 'litellm', baseUrl: 'https://litellm.example' }) };

      const profile = await resolveHookAuthProfile(env, nestedDir);

      expect(profile).toEqual({ provider: 'litellm', baseUrl: 'https://litellm.example', ssoUrl: 'https://litellm.example' });
    });

    it('falls back to config resolution when CODEMIE_PROFILE_CONFIG is malformed JSON', async () => {
      const profile = await resolveHookAuthProfile({ CODEMIE_PROFILE_CONFIG: '{not json' }, nestedDir);

      expect(profile.baseUrl).toBe(PROD_BASE_URL);
    });

    it('does not log any part of a malformed CODEMIE_PROFILE_CONFIG', async () => {
      // V8's JSON.parse error quotes the start of the offending input ("sk-secret-"...); the config can carry credentials.
      const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});

      await resolveHookAuthProfile({ CODEMIE_PROFILE_CONFIG: 'sk-secret-123 not json' }, nestedDir);

      expect(debug).toHaveBeenCalled();
      expect(JSON.stringify(debug.mock.calls)).not.toContain('sk-secret');
    });

    it('falls back to config resolution when CODEMIE_PROFILE_CONFIG has no provider or baseUrl', async () => {
      const profile = await resolveHookAuthProfile({ CODEMIE_PROFILE_CONFIG: '{}' }, nestedDir);

      expect(profile.baseUrl).toBe(PROD_BASE_URL);
    });
  });

  describe('fallback without launch env', () => {
    it('walks up from a nested cwd to the nearest local config', async () => {
      const profile = await resolveHookAuthProfile({}, nestedDir);

      expect(profile).toEqual({ provider: 'ai-run-sso', baseUrl: PROD_BASE_URL, ssoUrl: PROD_SSO_URL });
    });

    it('prefers CLAUDE_PROJECT_DIR over cwd as the walk-up start', async () => {
      const profile = await resolveHookAuthProfile({ CLAUDE_PROJECT_DIR: nestedDir }, outsideDir);

      expect(profile.baseUrl).toBe(PROD_BASE_URL);
    });

    it('uses the global profile when no ancestor has a local config', async () => {
      const profile = await resolveHookAuthProfile({}, outsideDir);

      expect(profile.baseUrl).toBe(PREVIEW_BASE_URL);
    });

    it('propagates ConfigLoader.load failures', async () => {
      vi.spyOn(ConfigLoader, 'load').mockRejectedValueOnce(new Error('disk full'));

      await expect(resolveHookAuthProfile({}, nestedDir)).rejects.toThrow('disk full');
    });
  });

  describe('nested directory with differing local and global profiles', () => {
    // @case production-claude-code-session-opens_TC_001
    it('keeps the session profile and never selects the global Preview profile', async () => {
      const expected = { provider: 'ai-run-sso', baseUrl: PROD_BASE_URL, ssoUrl: PROD_SSO_URL };

      // Launch profile wins from a nested cwd.
      const fromLaunchEnv = await resolveHookAuthProfile(
        { CODEMIE_PROFILE_CONFIG: JSON.stringify(PROD_PROFILE) },
        nestedDir
      );
      expect(fromLaunchEnv).toEqual(expected);

      // No launch env: nearest ancestor local config is used, from cwd and from CLAUDE_PROJECT_DIR.
      const fromAncestorCwd = await resolveHookAuthProfile({}, nestedDir);
      expect(fromAncestorCwd).toEqual(expected);
      const fromProjectDir = await resolveHookAuthProfile({ CLAUDE_PROJECT_DIR: repoRoot }, nestedDir);
      expect(fromProjectDir).toEqual(expected);

      // Malformed launch value is ignored and the ancestor config is used.
      const fromMalformed = await resolveHookAuthProfile({ CODEMIE_PROFILE_CONFIG: '{not json' }, nestedDir);
      expect(fromMalformed).toEqual(expected);

      for (const profile of [fromLaunchEnv, fromAncestorCwd, fromProjectDir, fromMalformed]) {
        expect(profile.baseUrl).not.toBe(PREVIEW_BASE_URL);
        expect(profile.ssoUrl).not.toBe(PREVIEW_SSO_URL);
      }
    });
  });
});
