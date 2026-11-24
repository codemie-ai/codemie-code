/**
 * Claude Code hooks when the proxy daemon cannot start — CLI contract tests (EPMCDME-15369)
 *
 * The claude-code-otlp hook starts the analytics proxy daemon when none runs. That start is
 * best effort: when the daemon cannot come up, the hook logs the failure and carries on, with exit
 * code 0 and nothing on stdout or stderr, so Claude Code's hook lifecycle is untouched, and the
 * failed start leaves nothing behind that stops a later hook from starting the daemon.
 *
 * Drives the built `bin/codemie.js hook --agent claude-code-otlp` in an isolated temp home against
 * a local mock backend. The daemon is made to crash at startup by a module the hook passes on to
 * it through NODE_OPTIONS. No network, no LLM.
 *
 * Requires dist/ built. Run: npx vitest run --project cli tests/integration/hook-proxy-start-failure.test.ts
 */

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DAEMON_DIST,
  createCliHome,
  deliveredHookEvents,
  disposeCliHome,
  fileLog,
  hookEnv,
  importFlag,
  recordProxyConnection,
  runHookSession,
  startMockBackend,
  storeSsoLogin,
  waitForDeliveredSession,
  writeGlobalConfig,
  type CliRunOptions,
} from '../helpers/otlp-hook-session.js';

const PROFILE = 'sso-profile';
const PROJECT = 'start-failure-project';
const SESSION_ID = 'agent-session-daemon-start-failure';
const NEXT_SESSION_ID = 'agent-session-after-start-failure';
// Fixed fake cookie (not a real credential).
const COOKIE = { _oauth2_proxy: 'start-failure-session-cookie' };
const OWNER = {
  userId: 'owner-id',
  name: 'Session Owner',
  username: 'owner-login',
  email: 'owner@example.com',
  applications: [PROJECT],
  applications_admin: [],
};
const CRASH_DAEMON_MODULE = 'crash-proxy-daemon.mjs';
const DELIVERY_TIMEOUT_MS = 45_000;
// Each failed start waits out the 5 s readiness timeout and the recovery waits on the daemon's delivery,
// so the test outlives the `cli` project's 30s default.
const TEST_TIMEOUT_MS = DELIVERY_TIMEOUT_MS + 60_000;

describe.skipIf(!existsSync(DAEMON_DIST))('Claude Code hooks when the proxy daemon cannot start', () => {
  const homes: string[] = [];
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const home of homes.splice(0)) disposeCliHome(home);
    for (const close of closers.splice(0)) await close();
  });

  /** Hook options under which the daemon the hook spawns exits before it is ready. */
  function daemonCrashes(home: string): CliRunOptions {
    writeFileSync(
      join(home, CRASH_DAEMON_MODULE),
      "if (process.argv[1]?.endsWith('proxy-daemon.js')) process.exit(1);\n",
      'utf-8'
    );
    return { env: { NODE_OPTIONS: `${hookEnv(home).NODE_OPTIONS} ${importFlag(home, CRASH_DAEMON_MODULE)}` } };
  }

  // The bug of EPMCDME-15369: the daemon start error reached the hook, which printed it and exited with code 1.
  it(
    'exits 0 with no output when the daemon fails to start, logs the failure, and the next session starts the daemon and delivers',
    async () => {
      const backend = await startMockBackend(OWNER);
      closers.push(backend.close);
      const home = createCliHome(homes);
      writeGlobalConfig(home, PROFILE, {
        [PROFILE]: { baseUrl: backend.url, codeMieUrl: backend.url, codeMieProject: PROJECT },
      });
      recordProxyConnection(home, PROFILE);
      storeSsoLogin(home, backend.url, COOKIE);
      const crashing = daemonCrashes(home);

      for (const run of await runHookSession(home, SESSION_ID, crashing)) {
        expect(run.code).toBe(0);
        expect(run.stdout).toBe('');
        expect(run.stderr).toBe('');
      }

      expect(existsSync(join(home, 'proxy-daemon.json'))).toBe(false);
      expect(fileLog(home)).toContain('ensureOtlpProxy failed (non-blocking): Tool proxy-daemon failed: Daemon failed to start');
      expect(deliveredHookEvents(backend)).toEqual([]);

      // The daemon can start again: the failed start left nothing that stops the next session from starting it.
      for (const run of await runHookSession(home, NEXT_SESSION_ID)) {
        expect(run.code).toBe(0);
        expect(run.stdout).toBe('');
        expect(run.stderr).toBe('');
      }

      const events = await waitForDeliveredSession(backend, DELIVERY_TIMEOUT_MS, 'the next session to be delivered');
      expect(events.filter((e) => e.session_id === NEXT_SESSION_ID).map((e) => e.hook_event_name)).toEqual(
        expect.arrayContaining(['SessionStart', 'UserPromptSubmit'])
      );
      expect(existsSync(join(home, 'proxy-daemon.json'))).toBe(true);
      for (const delivery of backend.requests.filter((r) => r.method === 'POST')) {
        expect(delivery.project).toBe(PROJECT);
      }
    },
    TEST_TIMEOUT_MS
  );
});
