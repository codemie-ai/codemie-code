/**
 * Per-profile CodeMie identity of global profiles — CLI contract tests (EPMCDME-15411, EPMCDME-16519)
 *
 * EPMCDME-15411: global profiles shared one CodeMie URL and project, the one the last `codemie setup`
 * saved, so a session on another profile billed and reported analytics to the wrong environment.
 * EPMCDME-16519: the first fix's upgrade copied that last saved project into every global profile.
 *
 * Drives the built `bin/codemie.js` in isolated temp homes: `codemie profile` and `profile switch`
 * read and write the real config files, and a Claude Code hook session cold-starts the real proxy
 * daemon, which delivers to local mock backends. No network, no LLM.
 *
 * Requires dist/ built. Run: npx vitest run --project cli tests/integration/profile-own-codemie-project.test.ts
 */

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import {
  DAEMON_DIST,
  createCliHome,
  disposeCliHome,
  fileLog,
  readGlobalConfig,
  recordProxyConnection,
  runCli,
  runHookSession,
  startMockBackend,
  storeSsoLogin,
  waitForDeliveredSession,
  writeGlobalConfig,
  type GlobalProfile,
} from '../helpers/otlp-hook-session.js';

const PR701_MIGRATION_ID = '008-isolate-global-profile-identity';
const CLEAR_CLONES_MIGRATION_ID = '010-clear-cloned-profile-identity';
const OWNER = {
  userId: 'owner-id',
  name: 'Session Owner',
  username: 'owner-login',
  email: 'owner@example.com',
  applications: ['project-a', 'project-b'],
  applications_admin: [],
};
const DELIVERY_TIMEOUT_MS = 45_000;
// Chains CLI and hook processes and waits on the daemon's delivery, so it outlives the `cli` project's 30s default.
const TEST_TIMEOUT_MS = DELIVERY_TIMEOUT_MS + 30_000;

interface ProfileCard {
  url?: string;
  project?: string;
}

// eslint-disable-next-line no-control-regex
const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '');

/** The CodeMie URL and Project rows `codemie profile` prints for each profile. */
function profileCards(output: string): Record<string, ProfileCard> {
  const cards: Record<string, ProfileCard> = {};
  for (const block of stripAnsi(output).split(/^Profile\s+│\s*/m).slice(1)) {
    const name = block.split(/\s/)[0];
    const row = (label: string) => block.match(new RegExp(`^${label}\\s+│\\s*(.+)$`, 'm'))?.[1].trim();
    cards[name] = { url: row('CodeMie URL'), project: row('Project') };
  }
  return cards;
}

describe.skipIf(!existsSync(DAEMON_DIST))('per-profile CodeMie identity of global profiles', () => {
  const homes: string[] = [];
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const home of homes.splice(0)) disposeCliHome(home);
    for (const close of closers.splice(0)) await close();
  });

  async function showProfiles(home: string): Promise<Record<string, ProfileCard>> {
    const run = await runCli(home, ['profile']);
    expect(run.code).toBe(0);
    return profileCards(run.stdout);
  }

  describe('each global profile keeps its own URL and project (EPMCDME-15411)', () => {
    const PROFILES: Record<string, GlobalProfile> = {
      'profile-a': { baseUrl: 'http://127.0.0.1:9/env-a', codeMieUrl: 'http://127.0.0.1:9/env-a', codeMieProject: 'project-a' },
      'profile-b': { baseUrl: 'http://127.0.0.1:9/env-b', codeMieUrl: 'http://127.0.0.1:9/env-b', codeMieProject: 'project-b' },
    };

    // The bug of EPMCDME-15411: every global profile resolved the URL and project the last setup saved.
    it('shows each profile with its own URL and project, and switching A → B → A changes neither', async () => {
      const home = createCliHome(homes);
      // The shared identity holds what the last setup saved, for profile B.
      writeGlobalConfig(home, 'profile-a', PROFILES, { codeMieUrl: 'http://127.0.0.1:9/env-b', codeMieProject: 'project-b' });
      const before = readGlobalConfig(home).profiles;

      expect(await showProfiles(home)).toEqual({
        'profile-a': { url: 'http://127.0.0.1:9/env-a', project: 'project-a' },
        'profile-b': { url: 'http://127.0.0.1:9/env-b', project: 'project-b' },
      });

      for (const target of ['profile-b', 'profile-a']) {
        const run = await runCli(home, ['profile', 'switch', target]);
        expect(run.code).toBe(0);
        expect(readGlobalConfig(home).activeProfile).toBe(target);
      }

      expect(readGlobalConfig(home).profiles).toEqual(before);
      expect(await showProfiles(home)).toEqual({
        'profile-a': { url: 'http://127.0.0.1:9/env-a', project: 'project-a' },
        'profile-b': { url: 'http://127.0.0.1:9/env-b', project: 'project-b' },
      });
    });

    it(
      'after switching to profile B, delivers a session to B\'s CodeMie with B\'s project, not the one the last setup saved',
      async () => {
        const backendA = await startMockBackend(OWNER);
        closers.push(backendA.close);
        const backendB = await startMockBackend(OWNER);
        closers.push(backendB.close);
        const home = createCliHome(homes);
        writeGlobalConfig(
          home,
          'profile-a',
          {
            'profile-a': { baseUrl: backendA.url, codeMieUrl: backendA.url, codeMieProject: 'project-a' },
            'profile-b': { baseUrl: backendB.url, codeMieUrl: backendB.url, codeMieProject: 'project-b' },
          },
          // The last setup saved profile A: the shared identity points at A.
          { codeMieUrl: backendA.url, codeMieProject: 'project-a' }
        );
        // Fixed fake cookies (not real credentials).
        storeSsoLogin(home, backendA.url, { _oauth2_proxy: 'cookie-a' });
        storeSsoLogin(home, backendB.url, { _oauth2_proxy: 'cookie-b' });
        const switched = await runCli(home, ['profile', 'switch', 'profile-b']);
        expect(switched.code).toBe(0);
        // Claude Code is connected through profile B.
        recordProxyConnection(home, 'profile-b');

        for (const run of await runHookSession(home, 'agent-session-profile-b')) {
          expect(run.code).toBe(0);
          expect(run.stdout).toBe('');
          expect(run.stderr).toBe('');
        }

        const events = await waitForDeliveredSession(backendB, DELIVERY_TIMEOUT_MS, 'the session to reach profile B\'s CodeMie');
        for (const event of events) expect(event.session_id).toBe('agent-session-profile-b');
        const deliveries = backendB.requests.filter((r) => r.method === 'POST');
        expect(deliveries.length).toBeGreaterThan(0);
        for (const delivery of deliveries) {
          expect(delivery.project).toBe('project-b');
          expect(delivery.cookie).toBe('_oauth2_proxy=cookie-b');
        }
        expect(backendA.requests).toEqual([]);
        expect(fileLog(home)).not.toContain('has no project of its own');
        expect(fileLog(home)).not.toContain('analytics paused');
      },
      TEST_TIMEOUT_MS
    );
  });

  describe('an upgrade gives the last saved project to no profile (EPMCDME-16519)', () => {
    // The bug of EPMCDME-16519: the upgrade wrote the last saved project into every global profile.
    it('leaves profiles saved before per-profile projects without a project, each on the shared fallback', async () => {
      // An install from before per-profile projects: the migration that repairs the first fix has not run.
      const home = createCliHome(homes, { dropMigrations: [CLEAR_CLONES_MIGRATION_ID] });
      writeGlobalConfig(
        home,
        'project-profile',
        {
          'project-profile': { baseUrl: 'http://127.0.0.1:9/env' },
          'personal-profile': { baseUrl: 'http://127.0.0.1:9/env' },
        },
        // The project of the last setup, which was for personal-profile.
        { codeMieUrl: 'http://127.0.0.1:9/env', codeMieProject: 'personal-project' }
      );

      const cards = await showProfiles(home);

      const after = readGlobalConfig(home);
      for (const name of ['project-profile', 'personal-profile']) {
        expect(after.profiles[name]).not.toHaveProperty('codeMieProject');
        expect(after.profiles[name]).not.toHaveProperty('codeMieUrl');
        expect(cards[name].project).toBe('personal-project (shared fallback)');
      }
      expect(after.workspace).toMatchObject({ codeMieProject: 'personal-project' });
    });

    it('clears the project the first fix copied onto every profile and keeps a profile\'s own different project', async () => {
      // An install that ran the reverted first fix (#701), which copied the shared identity into every profile.
      const home = createCliHome(homes, {
        dropMigrations: [CLEAR_CLONES_MIGRATION_ID],
        addMigrations: [PR701_MIGRATION_ID],
      });
      const shared = { codeMieUrl: 'http://127.0.0.1:9/env', codeMieProject: 'personal-project' };
      writeGlobalConfig(
        home,
        'project-profile',
        {
          'project-profile': { baseUrl: 'http://127.0.0.1:9/env', ...shared },
          'personal-profile': { baseUrl: 'http://127.0.0.1:9/env', ...shared },
          'other-profile': { baseUrl: 'http://127.0.0.1:9/env', codeMieUrl: shared.codeMieUrl, codeMieProject: 'other-project' },
        },
        shared
      );

      const cards = await showProfiles(home);

      const after = readGlobalConfig(home);
      for (const name of ['project-profile', 'personal-profile']) {
        expect(after.profiles[name]).not.toHaveProperty('codeMieProject');
        expect(after.profiles[name]).not.toHaveProperty('codeMieUrl');
        expect(cards[name].project).toBe('personal-project (shared fallback)');
      }
      expect(after.profiles['other-profile']).toMatchObject({ codeMieProject: 'other-project' });
      expect(cards['other-profile'].project).toBe('other-project');
    });
  });
});
