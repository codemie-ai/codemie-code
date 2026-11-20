/**
 * Claude Code analytics on an oauth2-proxy SSO login — CLI contract tests (EPMCDME-16776)
 *
 * An oauth2-proxy login stores only the `_oauth2_proxy` cookie: no token carries the user's email.
 * The hook must learn the owner from the backend's own `GET /v1/user` answer, stamp it on every
 * event and let the proxy daemon deliver the session. While the owner is unknown (an expired
 * session redirects to the IdP) the events are held for that login, never sent unowned and never
 * dropped, and are replayed once the backend answers.
 *
 * Drives the built `bin/codemie.js hook --agent claude-code-otlp` and the real detached proxy
 * daemon in an isolated temp home, against a local mock backend. No network, no LLM.
 *
 * Requires dist/ built. Run: npx vitest run --project cli tests/integration/analytics-oauth2-proxy-owner.test.ts
 */

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  DAEMON_DIST,
  createCliHome,
  deliveredHookEvents,
  disposeCliHome,
  fileLog,
  recordProxyConnection,
  runHookSession,
  startMockBackend,
  startServer,
  storeSsoLogin,
  waitFor,
  waitForDeliveredSession,
  writeGlobalConfig,
  type HookEvent,
  type MockBackend,
} from '../helpers/otlp-hook-session.js';

const PROFILE = 'oauth2-proxy-login';
const PROJECT = 'owner-project';
const SESSION_ID = 'agent-session-oauth2-owner';
// Fixed fake cookie (not a real credential).
const OAUTH2_COOKIE = { _oauth2_proxy: 'oauth2-proxy-cookie-value' };
const OWNER = {
  userId: 'owner-id',
  name: 'Session Owner',
  username: 'owner-login',
  email: 'owner@example.com',
  applications: [PROJECT],
  applications_admin: [],
};
// A failed owner lookup is retried after OWNER_LOOKUP_COOLDOWN_MS (30 s), then on the next delivery tick.
const DELIVERY_TIMEOUT_MS = 75_000;
// Delivery ticks every 3 s (OTLP_SEND_INTERVAL_MINUTES in the hook environment): several pass in this window.
const SEVERAL_TICKS_MS = 10_000;
// Each test chains hook processes and waits on the daemon's delivery, so it outlives the `cli` project's 30s default.
const TEST_TIMEOUT_MS = DELIVERY_TIMEOUT_MS + 60_000;

describe.skipIf(!existsSync(DAEMON_DIST))('Claude Code analytics on an oauth2-proxy SSO login', () => {
  const homes: string[] = [];
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const home of homes.splice(0)) disposeCliHome(home);
    for (const close of closers.splice(0)) await close();
  });

  /** A home whose only profile is an SSO login to the backend, holding an oauth2-proxy cookie and nothing else. */
  function oauth2ProxyHome(backend: MockBackend): string {
    const home = createCliHome(homes);
    writeGlobalConfig(home, PROFILE, {
      [PROFILE]: { baseUrl: backend.url, codeMieUrl: backend.url, codeMieProject: PROJECT },
    });
    recordProxyConnection(home, PROFILE);
    // Stored the way `codemie setup` stores an oauth2-proxy login: cookies only, no codemie_access_token.
    storeSsoLogin(home, backend.url, OAUTH2_COOKIE);
    return home;
  }

  async function startSession(home: string): Promise<void> {
    for (const run of await runHookSession(home, SESSION_ID)) {
      expect(run.code).toBe(0);
      expect(run.stdout).toBe('');
      expect(run.stderr).toBe('');
    }
  }

  function heldEvents(home: string): string[] {
    const dir = join(home, 'analytics', 'state', 'owner-pending');
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  }

  function expectOwnedSession(events: HookEvent[]): void {
    expect(events.map((e) => e.hook_event_name).filter(Boolean)).toEqual(
      expect.arrayContaining(['SessionStart', 'UserPromptSubmit'])
    );
    for (const event of events) {
      expect(event.session_id).toBe(SESSION_ID);
      // The email from /v1/user, never its `username`.
      expect(event.user_email).toBe(OWNER.email);
    }
    expect(JSON.stringify(events)).not.toContain(OWNER.username);
  }

  // The bug of EPMCDME-16776: an oauth2-proxy login has no token claim, so its events went out with no owner and were dropped.
  it(
    'learns the owner from GET /v1/user with the oauth2-proxy cookie and delivers the session stamped with that email',
    async () => {
      const backend = await startMockBackend(OWNER);
      closers.push(backend.close);
      const home = oauth2ProxyHome(backend);

      await startSession(home);

      expectOwnedSession(await waitForDeliveredSession(backend, DELIVERY_TIMEOUT_MS, 'the session hooks to reach the backend'));

      const ownerLookups = backend.requests.filter((r) => r.path === '/v1/user');
      expect(ownerLookups.length).toBeGreaterThan(0);
      for (const lookup of ownerLookups) {
        expect(lookup.method).toBe('GET');
        expect(lookup.cookie).toBe(`_oauth2_proxy=${OAUTH2_COOKIE._oauth2_proxy}`);
      }
      for (const delivery of backend.requests.filter((r) => r.method === 'POST')) {
        expect(delivery.project).toBe(PROJECT);
      }

      expect(heldEvents(home)).toEqual([]);
      expect(fileLog(home)).not.toContain('owner not resolved yet');
      expect(fileLog(home)).not.toContain('analytics paused');
      expect(existsSync(join(home, 'proxy', 'otlp-spool', `${SESSION_ID}.hooks.ndjson`))).toBe(true);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'holds the events while /v1/user redirects to the IdP, never follows the redirect, and replays them once the owner is known',
    async () => {
      const idp = await startServer(() => ({ status: 200, body: { page: 'sign in' } }));
      closers.push(idp.close);
      const backend = await startMockBackend(OWNER);
      closers.push(backend.close);
      // An expired oauth2-proxy session: the API answers with a redirect to the identity provider.
      backend.userInfo.status = 302;
      backend.userInfo.location = `${idp.url}/oauth2/sign_in`;
      const home = oauth2ProxyHome(backend);

      await startSession(home);

      expect(heldEvents(home).length).toBeGreaterThan(0);
      expect(fileLog(home)).toMatch(/owner not resolved yet; \d+ event\(s\) held for this login/);
      // Several delivery ticks pass: nothing is sent without an owner.
      await new Promise((r) => setTimeout(r, SEVERAL_TICKS_MS));
      expect(deliveredHookEvents(backend)).toEqual([]);
      expect(idp.requests).toEqual([]);

      // The session comes back: the next owner lookup succeeds and the held events are sent.
      backend.userInfo.status = 200;
      delete backend.userInfo.location;

      expectOwnedSession(
        await waitForDeliveredSession(backend, DELIVERY_TIMEOUT_MS, 'the held session hooks to be replayed to the backend')
      );
      expect(idp.requests).toEqual([]);
      await waitFor(() => (heldEvents(home).length === 0 ? true : undefined), 10_000, 'the held events to be cleared');
      expect(fileLog(home)).not.toContain('analytics paused');
    },
    TEST_TIMEOUT_MS
  );
});
