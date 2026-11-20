/**
 * Analytics delivery after SSO re-authentication — CLI contract tests (EPMCDME-16085)
 *
 * When the backend rejects the proxy daemon's SSO session, Claude Code analytics stay in the local
 * spool. Once the user signs in again, the running daemon must pick up the new login and deliver
 * the backlog and new activity, without a daemon restart.
 *
 * Drives the built `bin/codemie.js hook --agent claude-code-otlp` and the real detached proxy
 * daemon in an isolated temp home, against a local mock backend that answers 401 to the expired
 * session. The re-login is written to the credential store the way `codemie profile login` saves
 * it. No network, no LLM.
 *
 * Requires dist/ built. Run: npx vitest run --project cli tests/integration/analytics-delivery-after-sso-relogin.test.ts
 */

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EVENT_HOOKS_PATH,
  DAEMON_DIST,
  createCliHome,
  disposeCliHome,
  fileLog,
  recordProxyConnection,
  runHook,
  runHookSession,
  startMockBackend,
  storeSsoLogin,
  waitFor,
  writeGlobalConfig,
  type HookEvent,
  type MockBackend,
} from '../helpers/otlp-hook-session.js';

const PROFILE = 'sso-profile';
const PROJECT = 'relogin-project';
const SESSION_ID = 'agent-session-sso-relogin';
// Fixed fake cookies (not real credentials).
const EXPIRED = { _oauth2_proxy: 'expired-session-cookie' };
const FRESH = { _oauth2_proxy: 'fresh-session-cookie' };
const OWNER = {
  userId: 'owner-id',
  name: 'Session Owner',
  username: 'owner-login',
  email: 'owner@example.com',
  applications: [PROJECT],
  applications_admin: [],
};
const DELIVERY_TIMEOUT_MS = 45_000;
// Chains hook processes and three waits on the daemon's delivery, so it outlives the `cli` project's 30s default.
const TEST_TIMEOUT_MS = DELIVERY_TIMEOUT_MS * 3 + 30_000;

const cookieHeader = (cookies: Record<string, string>): string =>
  Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');

/** Hook events the backend received with `cookies`, one object per NDJSON line. */
function hookEventsSentWith(backend: MockBackend, cookies: Record<string, string>): HookEvent[] {
  return backend.requests
    .filter((r) => r.method === 'POST' && r.path === EVENT_HOOKS_PATH && r.cookie === cookieHeader(cookies))
    .flatMap((r) => r.body.split('\n').filter(Boolean).map((line) => JSON.parse(line) as HookEvent));
}

function prompts(events: HookEvent[]): unknown[] {
  return events.filter((e) => e.hook_event_name === 'UserPromptSubmit').map((e) => e.prompt);
}

describe.skipIf(!existsSync(DAEMON_DIST))('analytics delivery after SSO re-authentication', () => {
  const homes: string[] = [];
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const home of homes.splice(0)) disposeCliHome(home);
    for (const close of closers.splice(0)) await close();
  });

  // The bug of EPMCDME-16085: after a re-login, delivery stayed suspended until the daemon was restarted.
  it(
    'resumes delivery with the new login on the same daemon, sending the spooled backlog and new activity',
    async () => {
      const backend = await startMockBackend(OWNER);
      closers.push(backend.close);
      backend.rejectedCookies.add(cookieHeader(EXPIRED));
      const home = createCliHome(homes);
      writeGlobalConfig(home, PROFILE, {
        [PROFILE]: { baseUrl: backend.url, codeMieUrl: backend.url, codeMieProject: PROJECT },
      });
      recordProxyConnection(home, PROFILE);
      storeSsoLogin(home, backend.url, EXPIRED);

      for (const run of await runHookSession(home, SESSION_ID)) {
        expect(run.code).toBe(0);
        expect(run.stdout).toBe('');
        expect(run.stderr).toBe('');
      }

      // The backend rejects the expired session: the daemon suspends delivery and keeps the spool.
      await waitFor(
        () => (hookEventsSentWith(backend, EXPIRED).length > 0 ? true : undefined),
        DELIVERY_TIMEOUT_MS,
        'a delivery attempt with the expired session'
      );
      await waitFor(
        () => (fileLog(home).includes('analytics credentials rejected') ? true : undefined),
        10_000,
        'the daemon to mark its credentials as rejected'
      );
      const daemonPid = (JSON.parse(readFileSync(join(home, 'proxy-daemon.json'), 'utf-8')) as { pid: number }).pid;

      // The user signs in again; the daemon keeps running.
      storeSsoLogin(home, backend.url, FRESH);

      const backlog = await waitFor(
        () => {
          const events = hookEventsSentWith(backend, FRESH);
          return prompts(events).length > 0 ? events : undefined;
        },
        DELIVERY_TIMEOUT_MS,
        'the spooled session to be delivered with the new login'
      );
      expect(backlog.map((e) => e.hook_event_name)).toEqual(expect.arrayContaining(['SessionStart', 'UserPromptSubmit']));
      for (const event of backlog) expect(event.session_id).toBe(SESSION_ID);
      expect(fileLog(home)).toContain('analytics credentials refreshed');

      // Activity after the re-login is delivered too, by the same daemon.
      const next = await runHook(home, SESSION_ID, { hook_event_name: 'UserPromptSubmit', prompt: 'Second prompt.' });
      expect(next.code).toBe(0);
      expect(next.stdout).toBe('');
      expect(next.stderr).toBe('');
      await waitFor(
        () => (prompts(hookEventsSentWith(backend, FRESH)).includes('Second prompt.') ? true : undefined),
        DELIVERY_TIMEOUT_MS,
        'the prompt sent after the re-login to be delivered'
      );

      const daemon = JSON.parse(readFileSync(join(home, 'proxy-daemon.json'), 'utf-8')) as { pid: number };
      expect(daemon.pid).toBe(daemonPid);
      expect(() => process.kill(daemonPid, 0)).not.toThrow();
      expect(fileLog(home)).not.toContain('analytics paused');
      for (const delivery of backend.requests.filter((r) => r.method === 'POST' && r.cookie === cookieHeader(FRESH))) {
        expect(delivery.project).toBe(PROJECT);
      }
    },
    TEST_TIMEOUT_MS
  );
});
